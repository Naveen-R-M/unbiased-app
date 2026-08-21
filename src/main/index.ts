import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  WebContentsView,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type { NativeImage } from "electron";
import { isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn as spawnProcess } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { get as httpGet } from "node:http";
import { EngineClient, engineVersionFromUserAgent, type EngineStatus } from "./engine";
import { spawn as ptySpawn, type IPty } from "@lydell/node-pty";

const engine = new EngineClient();
let win: BrowserWindow | null = null;
let lastStatus: EngineStatus = { state: "starting" };

// Conversation panes share one engine. "main" is the persistent,
// sidebar-listed conversation; "side:<n>" panes are scratch tabs on
// ephemeral threads (in-memory only — codex discards them at exit),
// created on demand by the renderer's side-chat tabs. Notifications carry
// threadId, so each pane's traffic routes cleanly.
type PaneId = string;
const panes: Record<string, { threadId: string | null; turnId: string | null }> = {
  main: { threadId: null, turnId: null },
};

function ensurePane(paneId: string): { threadId: string | null; turnId: string | null } {
  return (panes[paneId] ??= { threadId: null, turnId: null });
}

/** Drop every scratch pane — their ephemeral threads die with the context
 *  that spawned them (conversation switch, delete, engine restart). */
/** Answer any local approval waiting on this thread. A dynamic tool call is
 *  blocked on that promise and the engine is blocked on the tool call, so a
 *  torn-down pane would otherwise wedge the turn forever. */
function settleLocalApprovals(threadId: string | null | undefined): void {
  if (!threadId) return;
  for (const [reqId, pending] of pendingApprovals) {
    if (pending.kind !== "local" || pending.threadId !== threadId) continue;
    pendingApprovals.delete(reqId);
    pending.settle("decline");
  }
}

/** Forget a scratch pane AND stop whatever it was doing. Dropping the record
 *  alone left the ephemeral fork generating in the engine with no stream, no
 *  stop control and no way to reach it — tokens burning invisibly. */
function dropSidePane(paneId: string): void {
  const pane = panes[paneId];
  if (!pane) return;
  const threadId = pane.threadId;
  settleLocalApprovals(threadId);
  if (threadId) {
    const turnId = pane.turnId ?? runningTurns.get(threadId) ?? null;
    if (turnId) {
      void engine.request("turn/interrupt", { threadId, turnId }).catch(() => {
        // the turn may have just finished on its own
      });
      runningTurns.delete(threadId);
    }
    threadAccessModes.delete(threadId);
  }
  delete panes[paneId];
}

function resetSidePanes(): void {
  for (const k of Object.keys(panes)) {
    if (k !== "main") dropSidePane(k);
  }
}

/** Where chats outside any project live. NOT the home directory: the
 *  engine merges any `.codex/` config folder found at the cwd once the
 *  thread is trusted — and full-access/workspace-write threads self-trust
 *  their cwd at start. $HOME/.codex is the user's PERSONAL codex CLI
 *  config; running chats in ~ imported its model override, MCP servers,
 *  and freeform apply_patch tool, which the gateway rejects with
 *  'only "function" and "namespace" tools are supported (got "custom")'.
 *  A dedicated subfolder has no .codex anywhere on its cwd→root walk. */
function defaultChatDir(): string {
  const dir = join(app.getPath("home"), "Unbiased");
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return app.getPath("home");
  }
}

// ── Agent browser: model-driven browsing via dynamic tools ─────────────
// Wraps the `agent-browser` CLI (vercel-labs): each tool call shells out
// to one command, and the CLI keeps a background daemon holding the page
// session, so refs from browser_snapshot stay valid across calls. The
// tools ride thread/start's experimental dynamicTools and reach the
// gateway as plain function tools (which it supports). Registered only
// when the binary is installed (npm/brew/cargo).
// Consent state, keyed by the ROOT conversation. Plain browsing is gated
// only in "ask" mode (auto and full already permit network work); attaching
// to the user's own Chrome is gated in EVERY mode, because it hands the
// agent their signed-in sessions rather than public pages.
// The mode a thread STARTED under. codex takes approvalPolicy at thread/start,
// so the browser gate must too — otherwise flipping the global toggle for one
// conversation silently ungates a backgrounded one.
const threadAccessModes = new Map<string, AccessMode>();
const browserNetGrants = new Set<string>();
const browserConnectGrants = new Set<string>();
// Unbiased's own Chrome, launched on demand once the user approves session
// access. It CANNOT be their everyday profile: since Chrome 136 the browser
// refuses remote debugging on the default user-data-dir, so we keep a
// persistent profile of our own — signed into once, reused forever after.
const AGENT_CHROME_PORT = 9222;
function agentChromeProfile(): string {
  return join(app.getPath("home"), ".unbiased", "chrome-profile");
}
const CHROME_BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
let managedChrome: ChildProcess | null = null;
// Two threads can call browser_connect at once; without this both would spawn
// Chrome against the same profile, the loser would exit on Chrome's profile
// singleton, and its exit handler would wipe state belonging to the winner.
let chromeLaunch: Promise<{ ok: boolean; launched: boolean; firstRun: boolean; error?: string }> | null = null;

/** Is something speaking the DevTools protocol on this port? */
function cdpAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet({ host: "127.0.0.1", port, path: "/json/version", timeout: 1200 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 400);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attach target for browser_connect: an already-debuggable browser if one is
 *  listening (including one the user started themselves), otherwise our own
 *  Chrome, launched here so the user never has to run a terminal command. */
async function ensureAgentChrome(
  port: number,
): Promise<{ ok: boolean; launched: boolean; firstRun: boolean; error?: string }> {
  if (chromeLaunch) return chromeLaunch;
  chromeLaunch = launchAgentChrome(port).finally(() => {
    chromeLaunch = null;
  });
  return chromeLaunch;
}

async function launchAgentChrome(
  port: number,
): Promise<{ ok: boolean; launched: boolean; firstRun: boolean; error?: string }> {
  if (await cdpAlive(port)) return { ok: true, launched: false, firstRun: false };
  const bin = CHROME_BINARIES.find((b) => existsSync(b));
  if (!bin) {
    return {
      ok: false,
      launched: false,
      firstRun: false,
      error: "No Chrome/Chromium install found in /Applications.",
    };
  }
  const profile = agentChromeProfile();
  const firstRun = !existsSync(profile);
  try {
    mkdirSync(profile, { recursive: true });
  } catch (err) {
    return { ok: false, launched: false, firstRun, error: `Could not create ${profile}: ${String(err)}` };
  }
  // Visible on purpose: the user signs in here and watches the agent work.
  managedChrome = spawnProcess(
    bin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const child = managedChrome;
  child.on("exit", () => {
    // Only clear state if the process that died is still the current one.
    if (managedChrome === child) managedChrome = null;
  });
  for (let tries = 0; tries < 24; tries++) {
    await wait(500);
    if (await cdpAlive(port)) return { ok: true, launched: true, firstRun };
  }
  return { ok: false, launched: true, firstRun, error: `Chrome started but never opened port ${port}.` };
}

// Set when attached to a browser WE DID NOT LAUNCH: closing it would take
// down tabs that are not ours. A browser this app started is ours to close.
let browserAttachedExternal = false;

let agentBrowserBinCache: string | null | undefined;
function agentBrowserBin(): string | null {
  if (agentBrowserBinCache !== undefined) return agentBrowserBinCache;
  const home = app.getPath("home");
  const candidates = [
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "agent-browser")),
    "/opt/homebrew/bin/agent-browser",
    "/usr/local/bin/agent-browser",
    join(home, ".local", "bin", "agent-browser"),
    join(home, ".npm-global", "bin", "agent-browser"),
    join(home, ".cargo", "bin", "agent-browser"),
  ];
  agentBrowserBinCache = candidates.find((p) => existsSync(p)) ?? null;
  return agentBrowserBinCache;
}

// Gated sites (X, LinkedIn, Instagram, Reddit at times) return a SHORT page
// dominated by sign-in or verification copy. Detecting that and saying what
// to do next beats letting the model retry the same wall.
// Sign-in copy, bot checks, AND outright refusals: sites increasingly answer
// an automated browser with an HTTP error rather than a wall (x.com does),
// which is exactly when the model most needs to be told not to retry.
const BROWSER_WALL_SIGNALS =
  /(sign in|log in|log into|sign up|create account|join today|verify you are human|are you a robot|unusual traffic|captcha|complete the following challenge|enable javascript|access denied|403 forbidden|rate limit|too many requests|navigation failed|net::err_|http error)/i;
function browserWallHint(out: string): string {
  if (out.length > 2500 || !BROWSER_WALL_SIGNALS.test(out)) return "";
  return (
    "\n\n[note] This looks like a logged-out wall or a bot check rather than the real content. " +
    "Do not retry the same URL. Either use browser_search to find public sources that do not need an " +
    "account (Wikipedia, news coverage, the site's own about/help pages), or tell the user you need " +
    "their signed-in browser and ask whether to attach to it with browser_connect."
  );
}

// The host app's own instructions for every thread it starts (codex's
// developer_instructions channel; sub-agents inherit it). Kept short — it
// rides every request. Its one job is to stop the model asking for
// permission in prose when the APP is the thing that asks: without this the
// model reliably stalls on private-data requests ("go over my email") with a
// "shall I?" instead of calling the tool that triggers the real prompt.
const APP_DEVELOPER_INSTRUCTIONS = [
  "Permission in this app is handled by the app, not by you. When a tool needs the user's consent —",
  "network access, or a signed-in browser session — calling it shows the user a permission card they",
  "approve or deny. So call the tool directly and never ask the user in chat for permission first,",
  "never wait for a yes, and never re-describe what you are about to do instead of doing it. This",
  "applies to private data too (their email, messages, dashboards): the card covers it. The one case",
  "to stop and ask is when a tool result says the browser profile is new and not signed in yet — then",
  "tell the user to sign in in the window that opened, and never ask them for a password yourself.",
].join(" ");

const AGENT_BROWSER_TOOLS = [
  {
    type: "function",
    name: "browser_search",
    description:
      "Search the web and get back ranked results (title, URL, snippet). Use this FIRST for research questions instead of guessing URLs, and whenever a site blocks logged-out visitors — public sources (Wikipedia, news, official about/help pages) usually work when the site's own app does not. Follow up with browser_open on a result URL, or browser_snapshot the results page to click through. Prefer two or three independent sources over one.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for" } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "browser_open",
    description:
      "Open a URL in your browser and wait for it to load. Returns the page title. Note: many sites show an automated browser only a signup wall or a bot check — if what comes back looks like a login gate instead of content, do not retry it; search for public sources with browser_search, or ask the user about browser_connect.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    type: "function",
    name: "browser_snapshot",
    description:
      "Accessibility-tree snapshot of the current page with stable element refs (e.g. [ref=e7]). Call this after navigation to see the page; pass a ref like 'e7' to browser_click/browser_fill/browser_type.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "browser_read",
    description: "The current page as agent-readable text (markdown-ish). Good for articles; use browser_snapshot when you need to interact.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "browser_click",
    description: "Click an element by its snapshot ref.",
    inputSchema: { type: "object", properties: { ref: { type: "string", description: "Element ref from browser_snapshot, e.g. 'e7'" } }, required: ["ref"] },
  },
  {
    type: "function",
    name: "browser_fill",
    description: "Clear an input and fill it with text, by snapshot ref.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" } },
      required: ["ref", "text"],
    },
  },
  {
    type: "function",
    name: "browser_type",
    description: "Type text into an element (no clearing), by snapshot ref.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" } },
      required: ["ref", "text"],
    },
  },
  {
    type: "function",
    name: "browser_press",
    description: "Press a key or chord, e.g. 'Enter', 'Tab', 'Control+a'.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    type: "function",
    name: "browser_scroll",
    description: "Scroll the page.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        pixels: { type: "number" },
      },
      required: ["direction"],
    },
  },
  {
    type: "function",
    name: "browser_screenshot",
    description: "Screenshot the current page (returned to you as an image).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "browser_back",
    description: "Go back in browser history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "browser_connect",
    description:
      "Get a signed-in browser session, for tasks that need the user's OWN accounts: their email, their X timeline, a dashboard or admin panel — anything behind a login that no public page can answer. CALL THIS DIRECTLY as your first step for such a task. Do NOT ask the user in chat whether you may proceed and do not wait for their reply — that includes private data like their email, messages or bank pages: the app shows them its OWN permission prompt, which they approve or deny, and that prompt IS the consent step, so asking again in chat only wastes a round trip. On approval the app opens and attaches a browser window by itself. Example: a request like 'go over my email and find the message from X' means call browser_connect straight away. There is nothing for the user to run. If the result says the profile is new and not signed in yet, tell the user to sign in in that window and stop; otherwise keep browsing as them. Prefer browser_search for anything public. While attached, browser_close leaves the browser open.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "string", description: "CDP port or ws:// URL (default 9222)" } },
    },
  },
  {
    type: "function",
    name: "browser_close",
    description: "Close the automation browser when you are done. Never closes the user's own Chrome, even while attached to it.",
    inputSchema: { type: "object", properties: {} },
  },
];

function agentBrowserTools(): typeof AGENT_BROWSER_TOOLS | undefined {
  return agentBrowserBin() ? AGENT_BROWSER_TOOLS : undefined;
}

function runAgentBrowser(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  const bin = agentBrowserBin();
  if (!bin) return Promise.resolve({ ok: false, out: "agent-browser is not installed" });
  return new Promise((resolve) =>
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        out: [stdout, stderr].map((x) => String(x).trim()).filter(Boolean).join("\n") || (err ? String(err) : ""),
      }),
    ),
  );
}

// Bing is the one major engine that serves an automated Chrome real results
// (Google, Brave, Ecosia and DuckDuckGo's no-JS endpoints all answer with a
// bot challenge, which we neither solve nor work around). Result titles come
// from textContent — innerText reads empty in this context — and Bing's
// redirect wrappers are decoded back to the real destination so the model
// gets URLs it can actually open.
const BROWSER_SEARCH_EXTRACT = `(() => {
  const real = (href) => { try {
    const u = new URL(href).searchParams.get("u");
    if (!u) return href;
    const b = u.replace(/^a1/, "").replace(/-/g, "+").replace(/_/g, "/");
    const s = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
    return /^https?:/.test(s) ? s : href;
  } catch { return href; } };
  const txt = (el, sel) => (el.querySelector(sel)?.textContent || "").replace(/\\s+/g, " ").trim();
  const rows = Array.from(document.querySelectorAll("li.b_algo")).slice(0, 8).map((li) => {
    const a = li.querySelector("h2 a[href]") || li.querySelector("a[href]");
    return {
      title: txt(li, "h2") || txt(li, "a"),
      url: a ? real(a.href) : txt(li, "cite"),
      snippet: txt(li, ".b_caption p") || txt(li, "p"),
    };
  }).filter((r) => r.title || r.url);
  return JSON.stringify(rows);
})()`;

/** agent-browser prints eval results JSON-encoded, so a string return arrives
 *  double-encoded; unwrap until it parses to an array. */
function parseEvalJson(out: string): { title?: string; url?: string; snippet?: string }[] {
  let value: unknown = out.trim();
  for (let i = 0; i < 3; i++) {
    if (typeof value !== "string") break;
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? (value as { title?: string }[]) : [];
}

/** Consent gate. Returns null when the call may proceed, else the refusal to
 *  hand back to the model. */
async function ensureBrowserAllowed(tool: string, threadId: string | null, detail: string): Promise<string | null> {
  if (tool === "browser_close") return null; // cleanup only, no network
  const root = rootThreadOf(threadId);
  const attaching = tool === "browser_connect";
  if (attaching) {
    if (browserConnectGrants.has(root)) return null;
  } else if ((threadAccessModes.get(root) ?? accessMode) !== "ask" || browserNetGrants.has(root)) {
    return null;
  }
  const decision = await requestLocalApproval(
    threadId,
    attaching ? `Use a signed-in browser session (${detail})` : `Browse the web — ${detail}`,
    attaching
      ? "The agent wants a browser it can use as you — reading pages you are signed into (mail, X, dashboards, internal tools). Approving opens an Unbiased-managed Chrome window; anything you sign into there stays available to the agent. Allow only if you want it acting with those accounts."
      : "The agent wants to use the browser, which reaches the network. This conversation is in Ask-for-approval mode, so nothing goes out until you allow it.",
  );
  if (decision === "decline") {
    return attaching
      ? "The user declined access to their Chrome browser. Continue with public pages via browser_search instead."
      : "The user declined browser/network access for this conversation.";
  }
  if (decision === "acceptForSession") (attaching ? browserConnectGrants : browserNetGrants).add(root);
  return null;
}

/** Only real web pages. Without this the model can point browser_open at
 *  file:///… (verified reachable: /etc/hosts came back through browser_read)
 *  and exfiltrate local files to the gateway, which is the classic
 *  prompt-injection sink for a page-driving agent. */
function webUrlOrNull(raw: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A CDP endpoint browser_connect may attach to: a local port, or a ws/http
 *  URL on this machine. Remote hosts are refused — attaching to someone
 *  else's debugger is not a thing the model gets to choose. */
function cdpTargetOrNull(raw: string): { port: number } | { url: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return { port: AGENT_CHROME_PORT };
  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed);
    return port > 0 && port < 65_536 ? { port } : null;
  }
  try {
    const u = new URL(trimmed);
    if (!["ws:", "wss:", "http:", "https:"].includes(u.protocol)) return null;
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname)) return null;
    return { url: u.toString() };
  } catch {
    return null;
  }
}

/** A host we're willing to fetch a favicon from. The renderer's CSP forbids
 *  remote images, so main fetches them instead — which means a link inside a
 *  model-written message becomes an outbound request from this process. Public
 *  DNS names only: loopback and RFC1918 literals are refused so a rendered
 *  message cannot probe the user's LAN, and 169.254 keeps cloud metadata out
 *  of reach. Hostname-level only — a public name that RESOLVES to a private
 *  address still gets through; closing that needs a custom DNS lookup, and the
 *  request carries no credentials or cookies either way. */
function faviconHostOrNull(raw: string): string | null {
  const host = raw.trim().toLowerCase();
  if (!host || host.length > 253) return null;
  // No ports, paths, userinfo or IPv6 brackets — a bare name is all we take.
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  if (!host.includes(".") || host.endsWith(".local")) return null;
  if (host === "0.0.0.0" || /^127\./.test(host)) return null;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return null;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
  if (/^169\.254\./.test(host)) return null;
  return host;
}

/** Two hosts that are the same site for icon purposes. A leading `www.` on
 *  either side counts (anthropic.com serves its icon from www); nothing else
 *  does. */
function sameIconSite(a: string, b: string): boolean {
  return a.replace(/^www\./, "") === b.replace(/^www\./, "");
}

/** One favicon attempt: fetch https://<host><path> and hand it back as a data:
 *  URL, or null for anything we won't use. Never throws — a missing icon is
 *  not an error condition.
 *
 *  Redirects are walked by hand rather than with redirect:"follow", because
 *  `follow` would carry this request onto whatever a 302 names — including the
 *  loopback and LAN addresses faviconHostOrNull just refused. Checking the
 *  final URL afterwards is too late: the connection has already been made.
 *  Every hop is re-gated, must stay https, and must stay on the same site. */
async function fetchIcon(host: string, path: string): Promise<string | null> {
  let url = `https://${host}${path}`;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(3_000),
        redirect: "manual",
        headers: { accept: "image/*" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        const next = new URL(loc, url);
        // A downgrade to http is refused outright: no icon is worth turning a
        // TLS fetch into a cleartext one a network attacker can answer.
        if (next.protocol !== "https:") return null;
        const nextHost = faviconHostOrNull(next.hostname);
        if (!nextHost || !sameIconSite(nextHost, host)) return null;
        url = next.toString();
        continue;
      }
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!res.ok || !type.startsWith("image/")) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      // Anything this big is not a favicon. The bytes sit in renderer state for
      // the session, so an unbounded body is a memory bug waiting to happen.
      if (buf.length === 0 || buf.length > 100_000) return null;
      return `data:${type};base64,${buf.toString("base64")}`;
    }
    return null; // redirect loop
  } catch {
    return null; // timeout, DNS, TLS, abort
  }
}

/** agent-browser parses its global flags positionally, and one of them is
 *  `--executable-path` — so a model-controlled value starting with "-" in a
 *  fill/type argument is a flag, not text. Verified: filling a field with
 *  "--headed" relaunched the browser and destroyed the page. Text like that
 *  is written into the field in-page instead, with the events a framework
 *  listens for, so it can never reach the CLI's argument parser. */
async function fillFieldSafely(
  mode: "fill" | "type",
  refArg: string,
  value: string,
): Promise<{ ok: boolean; out: string }> {
  if (!value.startsWith("-")) return runAgentBrowser([mode, refArg, value]);
  const focused = await runAgentBrowser(["focus", refArg]);
  if (!focused.ok || /✗/.test(focused.out)) return focused;
  const js = `(() => {
  const el = document.activeElement;
  if (!el || !("value" in el)) return "not-a-field";
  const text = ${JSON.stringify(value)};
  const next = ${mode === "fill" ? "text" : '(el.value || "") + text'};
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(el, next);
  else el.value = next;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
})()`;
  const r = await runAgentBrowser(["eval", js]);
  if (!r.ok || !/ok/.test(r.out)) {
    return { ok: false, out: `Could not enter text starting with "-": ${r.out || "no detail"}` };
  }
  return { ok: true, out: "✓ entered (value set in-page: text beginning with a dash cannot be typed via the CLI)" };
}

const AGENT_BROWSER_OUTPUT_CAP = 30_000;
type DynamicToolResponse = {
  contentItems: ({ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string })[];
  success: boolean;
};
async function handleAgentBrowserCall(
  tool: string,
  rawArgs: unknown,
  threadId: string | null,
): Promise<DynamicToolResponse> {
  const a = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const ref = () => (str("ref").startsWith("@") ? str("ref") : `@${str("ref")}`);
  const text = (t: string, ok: boolean): DynamicToolResponse => ({
    contentItems: [{ type: "inputText", text: t.slice(0, AGENT_BROWSER_OUTPUT_CAP) || (ok ? "ok" : "failed") }],
    success: ok,
  });
  const gateDetail =
    tool === "browser_open"
      ? str("url")
      : tool === "browser_search"
        ? `search: ${str("query")}`
        : tool === "browser_connect"
          ? str("port") || `port ${AGENT_CHROME_PORT}`
          : tool.replace(/^browser_/, "");
  const refusal = await ensureBrowserAllowed(tool, threadId, gateDetail);
  if (refusal) return text(refusal, false);
  switch (tool) {
    case "browser_open": {
      const url = webUrlOrNull(str("url"));
      if (!url) {
        return text(
          `Refused: ${JSON.stringify(str("url"))} is not an http(s) web address. The browser only opens web ` +
            "pages — it cannot read local files or other schemes. Use the file tools for anything on disk.",
          false,
        );
      }
      const r = await runAgentBrowser(["open", url], 90_000);
      return text(r.out + browserWallHint(r.out), r.ok);
    }
    case "browser_snapshot": {
      const r = await runAgentBrowser(["snapshot"]);
      return text(r.out + browserWallHint(r.out), r.ok);
    }
    case "browser_read": {
      const r = await runAgentBrowser(["read"]);
      return text(r.out + browserWallHint(r.out), r.ok);
    }
    case "browser_search": {
      const query = str("query");
      if (!query) return text("query is required", false);
      const opened = await runAgentBrowser(
        ["open", `https://www.bing.com/search?q=${encodeURIComponent(query)}`],
        90_000,
      );
      if (!opened.ok) return text(opened.out, false);
      await runAgentBrowser(["wait", "1200"], 20_000);
      const evaluated = await runAgentBrowser(["eval", BROWSER_SEARCH_EXTRACT]);
      const rows = parseEvalJson(evaluated.out);
      if (rows.length === 0) {
        // Empty means a challenge page or a query with no hits — show the
        // model what is actually on screen so it can adapt.
        const page = await runAgentBrowser(["read"]);
        const seen = page.out.slice(0, 1200);
        return text(
          `No results could be extracted for ${JSON.stringify(query)}.\n\nWhat the page shows:\n${seen}` +
            (browserWallHint(seen) || "\n\n[note] Try a differently worded query, or open a known source directly."),
          false,
        );
      }
      const list = rows
        .map((r, i) => `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.url ?? ""}\n   ${r.snippet ?? ""}`.trimEnd())
        .join("\n\n");
      return text(
        `Results for ${JSON.stringify(query)}:\n\n${list}\n\n[next] browser_open one of these URLs to read it, ` +
          "or browser_snapshot this results page to click a link. Cross-check anything important against a second source.",
        true,
      );
    }
    case "browser_connect": {
      const target = cdpTargetOrNull(str("port"));
      if (!target) {
        return text(
          `Refused: ${JSON.stringify(str("port"))} is not a local debugging target. Pass a port number, or a ` +
            "ws://127.0.0.1 URL — attaching to a remote host is not allowed.",
          false,
        );
      }
      let launched = false;
      let firstRun = false;
      let connectArg: string;
      if ("url" in target) {
        connectArg = target.url; // someone else already serves this endpoint
      } else {
        // Approved above — now make a debuggable browser exist. Nothing for
        // the user to run: an already-listening browser is reused, otherwise
        // we start Unbiased's own Chrome and wait for its port.
        const ready = await ensureAgentChrome(target.port);
        if (!ready.ok) {
          return text(
            `Could not start a browser session: ${ready.error ?? "unknown error"}. ` +
              "Use browser_search and public pages instead.",
            false,
          );
        }
        launched = ready.launched;
        firstRun = ready.firstRun;
        connectArg = String(target.port);
      }
      const r = await runAgentBrowser(["connect", connectArg], 30_000);
      // `connect` exits 0 even when discovery fails, so read the output.
      if (!r.ok || /✗|failed|refused/i.test(r.out)) {
        // Don't leave a window open for a session that never attached.
        if (launched && managedChrome) {
          managedChrome.kill();
          managedChrome = null;
        }
        return text(`Attach failed on ${connectArg}: ${r.out || "no detail"}`, false);
      }
      // Only a browser we started is ours to close later.
      browserAttachedExternal = !launched;
      if (launched && firstRun) {
        return text(
          "Attached to a freshly created Unbiased Chrome profile — a browser window is now open on the " +
            "user's screen, but it is NOT signed into anything yet (Chrome refuses remote debugging on their " +
            "everyday profile, so this is a separate profile that persists for next time). Tell the user to " +
            "sign in to the site you need in that new window, then continue. Do not guess credentials or ask " +
            "them to type any password to you.",
          true,
        );
      }
      return text(
        (launched
          ? "Attached to Unbiased's Chrome (a window is open on the user's screen). It may already hold " +
            "sign-ins from earlier sessions."
          : "Attached to the browser already listening on that endpoint.") +
          " If a page comes back signed out, ask the user to sign in in that window rather than looking for " +
          "another way around it.",
        true,
      );
    }
    case "browser_click": {
      const r = await runAgentBrowser(["click", ref()]);
      return text(r.out, r.ok);
    }
    case "browser_fill": {
      const r = await fillFieldSafely("fill", ref(), str("text"));
      return text(r.out, r.ok);
    }
    case "browser_type": {
      const r = await fillFieldSafely("type", ref(), str("text"));
      return text(r.out, r.ok);
    }
    case "browser_press": {
      const key = str("key");
      // Key names and chords only — nothing that could read as a CLI flag.
      if (!/^[A-Za-z0-9+_]{1,40}$/.test(key)) {
        return text(`Refused: ${JSON.stringify(key)} is not a key name (try Enter, Tab, Control+a).`, false);
      }
      const r = await runAgentBrowser(["press", key]);
      return text(r.out, r.ok);
    }
    case "browser_scroll": {
      const px = typeof a.pixels === "number" && a.pixels > 0 ? [String(Math.round(a.pixels))] : [];
      const dir = str("direction") || "down";
      if (!["up", "down", "left", "right"].includes(dir)) {
        return text(`Refused: direction must be up, down, left or right (got ${JSON.stringify(dir)}).`, false);
      }
      const r = await runAgentBrowser(["scroll", dir, ...px]);
      return text(r.out, r.ok);
    }
    case "browser_back": {
      const r = await runAgentBrowser(["back"]);
      return text(r.out, r.ok);
    }
    case "browser_close": {
      if (browserAttachedExternal) {
        return text("Attached to a browser this app did not launch — leaving it open. Nothing to close.", true);
      }
      const r = await runAgentBrowser(["close"]);
      // A browser we launched goes down with the session, closing its
      // debugging port too — leaving that open all session is what let any
      // local process attach to the signed-in profile.
      if (managedChrome) {
        managedChrome.kill();
        managedChrome = null;
      }
      return text(r.out || "closed", r.ok);
    }
    case "browser_screenshot": {
      const file = join(app.getPath("temp"), `unbiased-shot-${Date.now()}.png`);
      const r = await runAgentBrowser(["screenshot", file], 90_000);
      if (!r.ok) return text(r.out, false);
      try {
        const b64 = readFileSync(file).toString("base64");
        return { contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${b64}` }], success: true };
      } catch (err) {
        return text(`screenshot unreadable: ${String(err)}`, false);
      } finally {
        rmSync(file, { force: true });
      }
    }
    default:
      return text(`unknown tool: ${tool}`, false);
  }
}

function paneForThread(threadId: unknown): PaneId | null {
  for (const [id, p] of Object.entries(panes)) {
    if (p.threadId === threadId) return id;
  }
  return null;
}

// Turns outlive the pane that started them: switching conversations leaves
// the engine turn running, so live turns are tracked by THREAD. That lets a
// backgrounded conversation be reopened mid-turn with its busy state, the
// partial assistant text, and any approval request the agent is blocked on.
const runningTurns = new Map<string, string>(); // threadId → turnId
// The in-flight assistant message per thread. Deltas reach the renderer only
// while a pane owns the thread, so this is the sole record of text streamed
// while a conversation was backgrounded. Cleared when the message completes.
const bgStream = new Map<string, string>();
// Approval requests that arrived for an unwatched thread. Never auto-decline
// these — the engine waits, and they replay when the thread is reopened.
const heldApprovals = new Map<string, Record<string, unknown>[]>();
// Failure of a backgrounded turn — the "⚠ Turn failed" entry is renderer-only,
// so without this a failure while away would vanish entirely.
const heldErrors = new Map<string, string>();

// Sub-agents (multi-agent v2): the engine runs them as separate threads and
// the PARENT's transcript only carries subAgentActivity markers. This map —
// subThreadId → parent + path + live status — is what lets the app group a
// sub-agent's traffic under its parent conversation, route its approval
// requests somewhere visible, and open its transcript on demand. In-memory
// only, matching the engine's own lifetime: spawned agents do not survive an
// engine restart. Note thread/list defaults to interactive sources, so sub
// threads never reach the sidebar in the first place.
type SubAgentInfo = {
  parent: string;
  path: string; // engine agent path, e.g. /root/haiku_writer
  name: string; // last path segment — the model-chosen task name
  status: "running" | "idle" | "failed" | "interrupted";
  // "Closed an agent" has fired for the current task (reset when the parent
  // messages it again) — sub turns also end between queued mails, and those
  // are not closures.
  closedAnnounced?: boolean;
};
const subAgents = new Map<string, SubAgentInfo>();

// Inter-agent mail TO a sub-agent, captured from rawResponseItem/completed
// notifications (the engine emits one for every recorded item — the only
// place the task text a sub-agent was given is visible to a client). Keyed
// by the sub-agent's thread id; merged into its transcript by time.
// preDelivered marks a copy captured from the SENDER's raw call while the
// engine still holds the mail queued; the drain-time copy consumes the flag
// instead of duplicating, and a genuinely repeated identical message keeps
// both entries.
type MailEntry = { at: number; author: string; text: string; preDelivered?: boolean };
const subAgentMail = new Map<string, MailEntry[]>();
const MAIL_CAP = 200;

// Spawn instructions captured from the parent's raw collaboration
// function_call, keyed by "parentThreadId:taskName" until the matching
// subAgentActivity names the sub thread.
const pendingSpawnPrompts = new Map<string, string>();

// Spawn call_id → parent thread, so the raw function_call_output (which
// carries the engine-assigned nickname) can be matched back. Raw items and
// subAgentActivity arrive in either order, so the nickname is stashed by
// "parentThreadId:taskName" when the sub isn't registered yet, and applied
// as a rename when it is.
const pendingSpawnCalls = new Map<string, string>();
const pendingNicknames = new Map<string, string>();

// send_message/followup_task text, keyed like the spawn prompts — feeds the
// "Messaged an agent" row's instructions AND the immediate mailbox delivery
// (the engine queues the mail until the sub's loop drains it, so nothing is
// recorded on the sub thread until then; the pane shouldn't wait).
const pendingMessagePrompts = new Map<string, string>();

/** Every in-memory sub-agent structure is scoped to one engine process:
 *  thread ids, queued approvals, and RPC ids all die with it. Called on
 *  every engine (re)start so a stale roster can't outlive its engine. */
function resetSubAgentState(): void {
  subAgents.clear();
  subAgentMail.clear();
  pendingSpawnPrompts.clear();
  pendingSpawnCalls.clear();
  pendingNicknames.clear();
  pendingMessagePrompts.clear();
  heldApprovals.clear();
  for (const pending of pendingApprovals.values()) {
    if (pending.kind === "local") pending.settle("decline");
  }
  pendingApprovals.clear();
  browserNetGrants.clear();
  browserConnectGrants.clear();
  threadAccessModes.clear();
  browserAttachedExternal = false;
}

/** Strip the engine's inter-agent envelope ("Message Type: …\nTask name: …\n
 *  Sender: …\nPayload:\n<text>") down to the payload. */
function interAgentPayload(text: string): { author: string | null; payload: string } {
  const m = /^Message Type: [^\n]*\nTask name: [^\n]*\nSender: ([^\n]*)\nPayload:\n([\s\S]*)$/.exec(text);
  return m ? { author: m[1], payload: m[2] } : { author: null, payload: text };
}

/** Locate a thread's rollout file under the engine home's sessions dir.
 *  Cached per thread — the filename embeds the thread id and never moves. */
const rolloutPathCache = new Map<string, string>();
// Misses are cached briefly too: before the engine's first flush (exactly
// when activity is densest) every lookup would otherwise walk the entire
// sessions tree, up to 4×/second from the debounced viewer refetch.
const rolloutMissAt = new Map<string, number>();
function findRolloutFile(threadId: string): string | null {
  const cached = rolloutPathCache.get(threadId);
  if (cached && existsSync(cached)) return cached;
  const missAt = rolloutMissAt.get(threadId);
  if (missAt !== undefined && Date.now() - missAt < 2000) return null;
  const engineHome =
    lastStatus.state === "connected"
      ? lastStatus.codexHome
      : join(app.getPath("home"), ".unbiased", "app-engine", "home");
  const walk = (dir: string): string | null => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      } else if (n.startsWith("rollout-") && n.endsWith(`${threadId}.jsonl`)) {
        return p;
      }
    }
    return null;
  };
  const found = walk(join(engineHome, "sessions"));
  if (found) {
    rolloutPathCache.set(threadId, found);
    rolloutMissAt.delete(threadId);
  } else {
    rolloutMissAt.set(threadId, Date.now());
  }
  return found;
}

/** Inter-agent mail addressed to a sub-agent, read from its rollout on disk.
 *  This is the restart-proof source: live raw notifications only flow for
 *  threads STARTED with experimentalRawEvents (resume/fork hardcode it off
 *  at 0.147.0), but the engine persists every agent_message to the rollout
 *  before emitting anything. */
const rolloutMailCache = new Map<string, { mtimeMs: number; size: number; mail: MailEntry[] }>();
function rolloutMail(threadId: string, path: string | null): MailEntry[] {
  const file = findRolloutFile(threadId);
  if (!file) return [];
  let st;
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  if (st.size > 4_000_000) return []; // sub-agent rollouts are small; huge = not worth parsing
  // The viewer refetches on every completed item; only re-parse when the
  // file actually changed.
  const cacheKey = `${file}::${path ?? ""}`;
  const cached = rolloutMailCache.get(cacheKey);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.mail.slice();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const all: { at: number; author: string; recipient: string; text: string; newTask: boolean }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"agent_message"')) continue;
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: string;
        type?: string;
        payload?: { type?: string; author?: string; recipient?: string; content?: { type?: string; text?: string }[] };
      };
      const pl = parsed.payload;
      if (parsed.type !== "response_item" || pl?.type !== "agent_message") continue;
      const text = (pl.content ?? [])
        .filter((c) => c?.type === "input_text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
      if (!text) continue;
      const { author, payload } = interAgentPayload(text);
      all.push({
        at: parsed.timestamp ? Date.parse(parsed.timestamp) / 1000 : 0,
        author: author ?? pl.author ?? "",
        recipient: pl.recipient ?? "",
        text: payload,
        newTask: text.startsWith("Message Type: NEW_TASK"),
      });
    } catch {
      // unparseable line — skip
    }
  }
  // Only mail TO this agent. After an app restart the registry is empty and
  // no path is known — but the spawn's NEW_TASK is addressed to this agent,
  // so its recipient recovers the path (without it, the agent's own
  // outbound reports would render as inbound bubbles).
  const recipient = path ?? all.find((m) => m.newTask)?.recipient ?? null;
  const mail: MailEntry[] = all
    .filter((m) => !recipient || m.recipient === recipient)
    .map(({ at, author, text }) => ({ at, author, text }));
  // Keep the NEWEST entries, matching the live mailbox's retention.
  const out = mail.slice(-MAIL_CAP);
  rolloutMailCache.set(cacheKey, { mtimeMs: st.mtimeMs, size: st.size, mail: out });
  return out.slice();
}

function subAgentsForParent(parent: string): { threadId: string; name: string; path: string; status: string }[] {
  return [...subAgents.entries()]
    .filter(([, a]) => a.parent === parent)
    .map(([threadId, a]) => ({ threadId, name: a.name, path: a.path, status: a.status }));
}

/** Push the parent's sub-agent roster to whichever pane owns it (if any). */
function pushSubAgents(parent: string): void {
  const paneId = paneForThread(parent);
  if (paneId) send("chat:subagents", { paneId, agents: subAgentsForParent(parent) });
}

// The active main conversation's working directory — file references in
// chat resolve against it. Kept in sync with thread starts/resumes.
let mainCwd: string | null = null;

// Where the NEXT fresh main chat's thread will live. null = home directory
// (a plain chat, listed under Recents). Set by the project picker or by
// clicking a project header; consumed when the lazy thread is created.
let pendingCwd: string | null = null;

// User-selectable access mode (Codex-style). Applied to every new thread
// AND sent as turn-level overrides, which per the protocol change "this
// turn and subsequent turns" — so switching applies mid-conversation.
type AccessMode = "ask" | "auto" | "full";
let accessMode: AccessMode = "ask";

const MODE_THREAD_POLICY: Record<AccessMode, { approvalPolicy: string; sandbox: string }> = {
  // NOT "untrusted": that policy forbids escalation outright — the model
  // can't even ASK to write, so no approval card ever appears. on-request
  // + read-only means reads run free and every write/network action
  // surfaces an approval request.
  ask: { approvalPolicy: "on-request", sandbox: "read-only" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  full: { approvalPolicy: "never", sandbox: "danger-full-access" },
};
const MODE_TURN_SANDBOX: Record<AccessMode, Record<string, unknown>> = {
  ask: { type: "readOnly" },
  // Network on + the Go caches writable: without these, every `go test`
  // (httptest's TCP listener, ~/Library/Caches/go-build) becomes an
  // escalation prompt, which defeats the point of an auto mode. The
  // trade-off is deliberate: networked commands run un-prompted here.
  auto: {
    type: "workspaceWrite",
    networkAccess: true,
    writableRoots: [
      join(homedir(), "Library/Caches/go-build"),
      join(homedir(), "go/pkg/mod"),
    ],
  },
  full: { type: "dangerFullAccess" },
};

function threadPolicy(): { approvalPolicy: string; sandbox: string } {
  return MODE_THREAD_POLICY[accessMode];
}

/** The turn's sandbox policy, worktree-aware: a git worktree's real repo
 *  data lives in the PARENT repo's .git, so without that as a writable
 *  root every `git commit`/`push` from a worktree conversation becomes
 *  an escalation prompt — defeating "Approve for me". */
function turnSandbox(cwd: string | null): Record<string, unknown> {
  const base = MODE_TURN_SANDBOX[accessMode];
  if (base.type !== "workspaceWrite" || !cwd) return base;
  const info = loadWorktrees()[cwd];
  if (!info) return base;
  return {
    ...base,
    writableRoots: [...((base.writableRoots as string[]) ?? []), join(info.project, ".git")],
  };
}

// Last known context usage per thread — lets the composer gauge appear
// immediately on resume instead of waiting for the next turn.
function ctxUsageFile(): string {
  return join(app.getPath("userData"), "context-usage.json");
}
let ctxUsageCache: Record<string, { used: number; window: number | null; percent: number | null }> | null = null;
function loadCtxUsage(): Record<string, { used: number; window: number | null; percent: number | null }> {
  if (!ctxUsageCache) {
    try {
      ctxUsageCache = JSON.parse(readFileSync(ctxUsageFile(), "utf8"));
    } catch {
      ctxUsageCache = {};
    }
  }
  return ctxUsageCache!;
}

// Plan mode: the agent researches read-only and proposes a plan instead
// of acting. Enforced two ways — a hard read-only sandbox override on
// every turn, plus a directive input item shaping the output.
let planMode = false;

const PLAN_DIRECTIVE =
  "PLAN MODE is active. Do not modify files, run mutating commands, or take " +
  "any action with side effects — research read-only. Produce a concrete " +
  "implementation plan: numbered steps, the files to change and how, risks, " +
  "and open questions. End by asking whether to proceed with the plan.";

// Work-in mode for NEW project chats: the live checkout, or an isolated
// git worktree created per conversation (agent works on its own branch,
// the user's checkout stays untouched).
let workMode: "local" | "worktree" | { existing: string } = "local";

// worktree dir → its parent project + branch. Used to group worktree
// conversations under their project in the sidebar.
function worktreesFile(): string {
  return join(app.getPath("userData"), "worktrees.json");
}

function loadWorktrees(): Record<string, { project: string; branch: string }> {
  try {
    const parsed = JSON.parse(readFileSync(worktreesFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Create a fresh worktree for a conversation; null = fall back to local. */
async function createWorktree(project: string): Promise<string | null> {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .slice(0, 15)
    .replace("T", "-");
  const dir = join(
    app.getPath("userData"),
    "worktrees",
    `${project.split("/").filter(Boolean).pop()}-${stamp}`,
  );
  const branch = `pareto/${stamp}`;
  mkdirSync(join(app.getPath("userData"), "worktrees"), { recursive: true });
  const result = await new Promise<{ code: number; err: string }>((resolve) => {
    execFile(
      "git",
      ["worktree", "add", dir, "-b", branch],
      { cwd: project, timeout: 30000 },
      (error, _out, stderr) => resolve({ code: error ? 1 : 0, err: (stderr ?? "").trim() }),
    );
  });
  if (result.code !== 0) {
    console.warn("[app] worktree add failed, falling back to local:", result.err);
    return null;
  }
  const map = loadWorktrees();
  map[dir] = { project, branch };
  writeFileSync(worktreesFile(), JSON.stringify(map, null, 2) + "\n");
  return dir;
}

type ThreadSummary = { id: string; title: string; createdAt?: string };
type WireItem = {
  id?: string;
  type?: string;
  text?: string;
  content?: unknown;
  command?: string;
  status?: string;
  exitCode?: number;
  aggregatedOutput?: string;
  kind?: string;
  agentThreadId?: string;
  agentPath?: string;
};
type WireThread = {
  id: string;
  name?: string | null;
  preview?: string;
  createdAt?: string;
  cwd?: string;
  turns?: { items?: WireItem[]; startedAt?: number }[];
};

// Projects the user has explicitly opened. Persisted so a project appears
// in the sidebar the moment it's chosen — before (and regardless of) any
// conversation existing in it. Thread cwds merge in at list time.
function projectsFile(): string {
  return join(app.getPath("userData"), "projects.json");
}

// App-side thread → project assignment. The engine pins a thread's cwd at
// creation, so "moving" a Recents chat into a project is a GROUPING override
// the app owns, not an engine mutation.
function threadProjectsFile(): string {
  return join(app.getPath("userData"), "thread-projects.json");
}

function loadThreadProjects(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(threadProjectsFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// A project is a display name + one or more source folders (chats whose cwd
// falls in ANY of them group under it), a primary folder (the cwd new chats
// start in), and an icon/color identity. Legacy projects.json was a bare
// path array — migrated on load.
type ProjectRecord = {
  name: string;
  folders: string[];
  primary: string;
  icon: string;
  color: string | null;
};

function recordFromPath(path: string): ProjectRecord {
  return {
    name: path.split("/").filter(Boolean).pop() ?? path,
    folders: [path],
    primary: path,
    icon: "folder",
    color: null,
  };
}

function loadProjects(): ProjectRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(projectsFile(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p) => {
        if (typeof p === "string") return recordFromPath(p); // legacy entry
        if (p && typeof p === "object" && Array.isArray(p.folders) && p.folders.length > 0) {
          return {
            name: typeof p.name === "string" && p.name ? p.name : recordFromPath(p.folders[0]).name,
            folders: p.folders.filter((f: unknown) => typeof f === "string"),
            primary: typeof p.primary === "string" && p.folders.includes(p.primary) ? p.primary : p.folders[0],
            icon: typeof p.icon === "string" ? p.icon : "folder",
            color: typeof p.color === "string" ? p.color : null,
          } as ProjectRecord;
        }
        return null;
      })
      .filter((p): p is ProjectRecord => p !== null && p.folders.length > 0);
  } catch {
    return [];
  }
}

function saveProjects(projects: ProjectRecord[]): void {
  writeFileSync(projectsFile(), JSON.stringify(projects, null, 2) + "\n");
}

function rememberProject(path: string): void {
  const projects = loadProjects();
  if (!projects.some((p) => p.folders.includes(path))) {
    projects.unshift(recordFromPath(path));
    saveProjects(projects);
  }
}

function threadTitle(t: WireThread): string {
  const name = t.name?.trim();
  if (name) return name;
  const preview = t.preview?.trim();
  if (preview) return preview.length > 48 ? preview.slice(0, 48) + "…" : preview;
  return "New chat";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : ((c as { text?: string })?.text ?? "")))
      .join("");
  }
  return "";
}

/** Flatten a resumed thread's turns into the renderer's entry list. */
function threadToEntries(thread: WireThread): unknown[] {
  const entries: unknown[] = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      switch (item.type) {
        case "userMessage":
          entries.push({ kind: "user", text: item.text ?? contentToText(item.content) });
          break;
        case "agentMessage":
          entries.push({ kind: "assistant", text: item.text ?? "" });
          break;
        case "commandExecution":
          entries.push({
            kind: "command",
            itemId: item.id ?? "unknown",
            command: item.command ?? "(command)",
            status: item.status ?? "completed",
            exitCode: item.exitCode,
            output: item.aggregatedOutput,
          });
          break;
        case "dynamicToolCall": {
          const d = item as { id?: string; tool?: string; arguments?: unknown; status?: string; success?: boolean };
          const args = d.arguments && typeof d.arguments === "object" ? d.arguments : {};
          const argsText = Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
          entries.push({
            kind: "command",
            itemId: d.id ?? "unknown",
            command: `${d.tool ?? "tool"}${argsText}`.slice(0, 400),
            status: d.success === false ? "failed" : (d.status ?? "completed"),
          });
          break;
        }
        case "contextCompaction":
          entries.push({ kind: "compaction" });
          break;
        case "plan":
          entries.push({ kind: "assistant", text: item.text ?? "" });
          break;
        case "subAgentActivity": {
          const sub = item as { kind?: string; agentThreadId?: string; agentPath?: string };
          entries.push({
            kind: "agent",
            event: sub.kind ?? "started",
            name: (sub.agentPath ?? "").split("/").filter(Boolean).pop() ?? "agent",
            path: sub.agentPath ?? "",
            agentThreadId: sub.agentThreadId ?? "",
          });
          break;
        }
      }
    }
  }
  return entries;
}

/** The engine binary ships beside the app (extraResources) in production;
 *  in development it comes from the sibling unbiased-app-engine checkout's
 *  `make bundle` output. UNBIASED_ENGINE_DIR overrides both for testing. */
function resolveEngineDir(): string {
  const override = process.env.UNBIASED_ENGINE_DIR;
  if (override) return override;
  if (app.isPackaged) return join(process.resourcesPath, "engine");
  return join(app.getAppPath(), "..", "unbiased-app-engine", "dist", "bundle");
}

/** Small data-URL preview for attachment cards; full-size stays on disk. */
function thumbDataUrl(image: NativeImage, max = 112): string {
  const { width, height } = image.getSize();
  const scale = max / Math.max(width, height, 1);
  const small =
    scale < 1
      ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) })
      : image;
  return small.toDataURL();
}

function pushStatus(status: EngineStatus): void {
  lastStatus = status;
  win?.webContents.send("engine:status", status);
}

// ── Auth / credentials ───────────────────────────────────────────────
// The desktop's sign-in surface. The engine wrapper reads the key from
// UNBIASED_API_KEY (env) else ~/.unbiased/credentials.json; the login flow
// writes the file and pins the key into the engine's launch env.
const PLATFORM_BASE = "https://platform.unbiased.ai";
function credentialsPath(): string {
  return join(app.getPath("home"), ".unbiased", "credentials.json");
}

/** The key the engine would use, and where it came from. Env wins (matches
 *  the wrapper's own ResolveKey order), then the credentials file. */
function readStoredKey(): { key: string; source: "env" | "file" } | null {
  const envKey = process.env.UNBIASED_API_KEY?.trim();
  if (envKey) return { key: envKey, source: "env" };
  try {
    const cred = JSON.parse(readFileSync(credentialsPath(), "utf8")) as { apiKey?: unknown };
    if (typeof cred.apiKey === "string" && cred.apiKey.trim()) return { key: cred.apiKey.trim(), source: "file" };
  } catch {
    // no file
  }
  return null;
}

type WhoamiResult =
  | {
      ok: true;
      organization: { id: string; name: string };
      workload: { id: string; name: string };
      keyName: string;
      accessStatus: string;
      // Present only once the platform's whoami is extended to return it.
      paretoRolloutPercent?: number | null;
    }
  | { ok: false; error: string; code?: string; status?: number };

/** Validate a key against the platform's CLI whoami. Never billable, never
 *  hits the model — a pure identity check safe to run before sign-in. */
async function whoamiValidate(key: string): Promise<WhoamiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/cli/whoami`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (res.status === 401) return { ok: false, error: "That API key isn't valid.", code: "invalid_api_key", status: 401 };
    if (res.status === 503) return { ok: false, error: "The platform is temporarily unavailable — try again shortly.", code: "unavailable", status: 503 };
    if (!res.ok) return { ok: false, error: `Validation failed (HTTP ${res.status}).`, status: res.status };
    const body = (await res.json()) as Record<string, unknown>;
    return {
      ok: true,
      organization: body.organization as { id: string; name: string },
      workload: body.workload as { id: string; name: string },
      keyName: String(body.keyName ?? ""),
      accessStatus: String(body.accessStatus ?? "unknown"),
      paretoRolloutPercent:
        typeof body.paretoRolloutPercent === "number" ? body.paretoRolloutPercent : undefined,
    };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return { ok: false, error: aborted ? "Validation timed out — check your connection." : "Couldn't reach the platform.", code: "network" };
  } finally {
    clearTimeout(timer);
  }
}

type BillingResult =
  | {
      ok: true;
      organization: { name: string };
      balanceCents: number | null;
      monthToDateSpendCents: number | null;
      spendSyncedAt: string | null;
      tokens: { input: number; cached: number; output: number } | null;
    }
  | { ok: false; error: string };

/** Credits and month-to-date spend, from the platform's CLI billing route.
 *  Replaces the engine's account/rateLimits/read, which is ChatGPT-plan
 *  plumbing and always fails under gateway API-key auth. Pareto has no quota
 *  windows to report — it's prepaid credit — so this is what "usage" means. */
async function readBilling(): Promise<BillingResult> {
  const stored = readStoredKey();
  if (!stored) return { ok: false, error: "not signed in" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${PLATFORM_BASE}/api/cli/billing`, {
      headers: { Authorization: `Bearer ${stored.key}` },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const b = (await res.json()) as {
      organization?: { name?: string };
      balance?: { available?: boolean; balanceCents?: number };
      usage?: {
        available?: boolean;
        monthToDateSpendCents?: number | null;
        spendSyncedAt?: string | null;
        monthToDateUsage?: { totalInputTokens?: number; totalCachedTokens?: number; totalOutputTokens?: number };
      };
    };
    // Balance and usage fail independently upstream, so each is reported
    // separately rather than collapsing the whole card on one outage.
    const u = b.usage?.monthToDateUsage;
    return {
      ok: true,
      organization: { name: b.organization?.name ?? "" },
      balanceCents: b.balance?.available ? (b.balance.balanceCents ?? null) : null,
      monthToDateSpendCents: b.usage?.available ? (b.usage.monthToDateSpendCents ?? null) : null,
      spendSyncedAt: b.usage?.spendSyncedAt ?? null,
      tokens: u
        ? {
            input: u.totalInputTokens ?? 0,
            cached: u.totalCachedTokens ?? 0,
            output: u.totalOutputTokens ?? 0,
          }
        : null,
    };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === "AbortError";
    return { ok: false, error: aborted ? "timed out" : "could not reach the platform" };
  } finally {
    clearTimeout(timer);
  }
}

// ── Self-update ──────────────────────────────────────────────────────
// We install updates OURSELVES rather than using electron-updater, because
// Squirrel.Mac refuses to update a bundle that isn't Developer ID signed —
// and ours is ad-hoc signed (see build/adhoc-sign.cjs). Swapping the .app
// ourselves is exactly what scripts/install.sh already does by hand, so the
// same steps work here: download → verify SHA-256 → mount → replace → relaunch.
const UPDATE_REPO = "circuitandchisel/unbiased-app-releases";
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// A desktop app stays open for days, so a timer alone means a release can go
// unnoticed for hours (the check fires at launch, then not again until the
// interval elapses). Re-check when the window regains focus — that's when
// someone is actually looking at the sidebar — throttled so alt-tabbing
// doesn't hammer the API.
const UPDATE_FOCUS_THROTTLE_MS = 10 * 60 * 1000;
let lastUpdateCheck = 0;

// Auto-download lives HERE, not in renderer localStorage with the other
// preferences: the check fires on a timer 8s after boot and every 6h after,
// with no guarantee a renderer has mounted, let alone told us anything.
// Default on — the people this helps are the ones who would never find the
// switch. Off restores the old behaviour exactly.
function updatePrefsFile(): string {
  return join(app.getPath("userData"), "update-prefs.json");
}
let updatePrefsCache: { autoDownload: boolean } | null = null;
function updatePrefs(): { autoDownload: boolean } {
  if (!updatePrefsCache) {
    try {
      const raw = JSON.parse(readFileSync(updatePrefsFile(), "utf8")) as { autoDownload?: unknown };
      updatePrefsCache = { autoDownload: raw.autoDownload !== false };
    } catch {
      updatePrefsCache = { autoDownload: true };
    }
  }
  return updatePrefsCache;
}
function setUpdatePrefs(next: { autoDownload: boolean }): void {
  updatePrefsCache = next;
  try {
    writeFileSync(updatePrefsFile(), JSON.stringify(next));
  } catch {
    /* a preference that fails to persist is not worth failing the app over */
  }
}
// Suppresses per-chunk progress while auto-downloading: the whole point is
// that nothing interrupts until there is something to act on.
let silentInstall = false;

type UpdateInfo = { version: string; dmgUrl: string; sumsUrl: string | null };
let pendingUpdate: UpdateInfo | null = null;
let updateInstalling = false;
// Where a downloaded-and-verified bundle waits until the user relaunches.
// Two-phase on purpose: downloading 190MB and then yanking the app away in
// one click loses whatever the user was doing. Download in the background,
// then let them pick the moment to relaunch.
let stagedUpdate: { path: string; version: string } | null = null;

/** Hidden sibling of the installed app, so a staged bundle doesn't show up
 *  in Finder as a second "Unbiased" while it waits. */
function stagedPathFor(target: string): string {
  const dir = join(target, "..");
  const name = target.split("/").pop() ?? "Unbiased.app";
  return join(dir, `.${name}.incoming`);
}

/** Numeric-segment compare: "1.10.0" > "1.9.9". Returns >0 if a is newer. */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/);
  const pb = b.replace(/^v/, "").split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i] ?? "0", 10);
    const nb = parseInt(pb[i] ?? "0", 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) continue; // pre-release tails
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Ask the public releases repo what the latest version is. */
async function checkForUpdate(): Promise<UpdateInfo | null> {
  lastUpdateCheck = Date.now();
  // Dev preview: UNBIASED_FAKE_UPDATE=1 surfaces the banner without a
  // packaged build, so the update UI can be iterated on with `npm run dev`.
  // Installing is still gated on isPackaged, so this can't swap anything.
  if (process.env.UNBIASED_FAKE_UPDATE) {
    const info: UpdateInfo = { version: "9.9.9", dmgUrl: "", sumsUrl: null };
    pendingUpdate = info;
    send("update:available", info);
    // =2 previews the downloaded/"ready to relaunch" state (happy dog).
    if (process.env.UNBIASED_FAKE_UPDATE === "2") {
      stagedUpdate = { path: "/dev/null/fake", version: info.version };
      send("update:staged", { version: info.version });
    }
    return info;
  }
  // Unpackaged runs have no .app to replace — never offer an update in dev.
  if (!app.isPackaged) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      tag_name?: string;
      assets?: { name: string; browser_download_url: string }[];
    };
    const tag = body.tag_name;
    if (!tag || compareVersions(tag, app.getVersion()) <= 0) return null;
    const assets = body.assets ?? [];
    const dmg = assets.find((a) => a.name.endsWith(".dmg"));
    if (!dmg) return null;
    const info: UpdateInfo = {
      version: tag.replace(/^v/, ""),
      dmgUrl: dmg.browser_download_url,
      sumsUrl: assets.find((a) => a.name === "SHA256SUMS")?.browser_download_url ?? null,
    };
    pendingUpdate = info;
    if (updatePrefs().autoDownload && !stagedUpdate && !updateInstalling) {
      // Stage it quietly. The banner appears once, saying the only thing the
      // user can usefully act on: restart. update:pending withholds the
      // update from the renderer until then, so no Download button flashes up
      // and then changes under them mid-download.
      silentInstall = true;
      void installUpdate(info).then((r) => {
        silentInstall = false;
        // A failed silent attempt falls back to the manual banner rather than
        // retrying forever — the user can see it and decide.
        if (!r.ok) send("update:available", info);
      });
      return info;
    }
    send("update:available", info);
    return info;
  } catch {
    return null; // offline, rate-limited — silent; we retry on the next tick
  }
}

/** The running app's bundle: .../Unbiased.app/Contents/MacOS/Unbiased → the .app. */
function appBundlePath(): string {
  return join(app.getPath("exe"), "..", "..", "..");
}

/** Adopt a bundle staged by a previous run. Without this a completed
 *  180MB+ download is forgotten the moment the app restarts — stagedUpdate is
 *  memory-only — so an interrupted update re-downloads from scratch every
 *  time, which is what made a failed update feel like a loop. */
function recoverStagedUpdate(): void {
  if (!app.isPackaged) return;
  const staged = stagedPathFor(appBundlePath());
  const plist = join(staged, "Contents/Info.plist");
  if (!existsSync(plist)) return;
  try {
    const version = execFileSync("/usr/libexec/PlistBuddy", [
      "-c", "Print :CFBundleShortVersionString", plist,
    ], { encoding: "utf8" }).trim();
    if (version && compareVersions(version, app.getVersion()) > 0) {
      stagedUpdate = { path: staged, version };
      pendingUpdate = { version, dmgUrl: "", sumsUrl: null };
      return;
    }
    // Same version or older: it already landed, or it is stale. Either way it
    // is 180MB of nothing, so reclaim the space.
    rmSync(staged, { recursive: true, force: true });
  } catch {
    /* unreadable plist — leave it alone rather than delete something unknown */
  }
}

async function installUpdate(info: UpdateInfo): Promise<{ ok: boolean; error?: string }> {
  if (!app.isPackaged) return { ok: false, error: "updates only apply to the installed app" };
  if (updateInstalling) return { ok: false, error: "an update is already installing" };
  updateInstalling = true;
  const tmp = mkdtempSync(join(tmpdir(), "unbiased-update-"));
  const dmgPath = join(tmp, "update.dmg");
  let mounted: string | null = null;
  const cleanup = () => {
    if (mounted) {
      try {
        execFileSync("hdiutil", ["detach", mounted, "-quiet"]);
      } catch {
        /* already gone */
      }
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  try {
    // ── download with progress ──
    if (!silentInstall) send("update:progress", { phase: "downloading", percent: 0 });
    const res = await fetch(info.dmgUrl);
    if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get("content-length") ?? 0);
    const chunks: Buffer[] = [];
    let received = 0;
    let lastSent = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      chunks.push(buf);
      received += buf.length;
      const percent = total ? Math.round((received / total) * 100) : 0;
      // Throttle: a 190MB download would otherwise flood the renderer.
      if (percent !== lastSent && percent % 2 === 0) {
        lastSent = percent;
        if (!silentInstall) send("update:progress", { phase: "downloading", percent });
      }
    }
    const data = Buffer.concat(chunks);
    writeFileSync(dmgPath, data);

    // ── verify ──
    // A corrupted 190MB download must never replace a working app.
    if (info.sumsUrl) {
      if (!silentInstall) send("update:progress", { phase: "verifying", percent: 100 });
      const sums = await (await fetch(info.sumsUrl)).text();
      const name = info.dmgUrl.split("/").pop() ?? "";
      const expected = sums
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .find((p) => p[1]?.replace(/^\*/, "") === name)?.[0];
      if (expected) {
        const actual = createHash("sha256").update(data).digest("hex");
        if (actual !== expected) throw new Error("checksum mismatch — update refused");
      }
    }

    // ── swap the bundle ──
    if (!silentInstall) send("update:progress", { phase: "installing", percent: 100 });
    // NOT -quiet: it suppresses the very table we parse the mount point out
    // of, leaving us mounted with no idea where. Columns are tab-separated;
    // the mount point is the last field of the volume's row.
    const out = execFileSync("hdiutil", [
      "attach", dmgPath, "-nobrowse", "-mountrandom", "/tmp",
    ]).toString();
    mounted =
      out
        .split("\n")
        .map((line) => line.split("\t").pop()?.trim() ?? "")
        .filter((p) => p.startsWith("/"))
        .pop() ?? null;
    if (!mounted) throw new Error("could not determine the disk image mount point");
    const srcApp = readdirSync(mounted).find((n) => n.endsWith(".app"));
    if (!srcApp) throw new Error("no .app inside the disk image");
    // Sanity-check the payload BEFORE deleting the installed app: a DMG
    // missing the engine would leave the user with a bundle that can't run.
    if (!existsSync(join(mounted, srcApp, "Contents/Resources/engine/unbiased-app-engine"))) {
      throw new Error("the downloaded app is missing its engine — update refused");
    }

    const target = appBundlePath();
    // Stage beside the target and STOP. The swap happens in applyUpdate(),
    // when the user chooses to relaunch. ditto (not cp -R) preserves the
    // code signature; a broken seal would make macOS refuse to launch it.
    const staged = stagedPathFor(target);
    rmSync(staged, { recursive: true, force: true });
    execFileSync("ditto", [join(mounted, srcApp), staged]);
    cleanup();

    stagedUpdate = { path: staged, version: info.version };
    updateInstalling = false;
    send("update:staged", { version: info.version });
    return { ok: true };
  } catch (err) {
    cleanup();
    updateInstalling = false;
    const message = err instanceof Error ? err.message : String(err);
    send("update:error", { message });
    return { ok: false, error: message };
  }
}

/** Swap the staged bundle in and restart. Only reached once a download has
 *  been verified and staged, so the window where the app is missing is a
 *  single `mv` — not a 190MB copy. */
function applyUpdate(): { ok: boolean; error?: string } {
  if (!stagedUpdate || !existsSync(stagedUpdate.path)) {
    // The staged copy vanished (manual cleanup, disk tools). Fall back to
    // offering the download again rather than pretending we can relaunch.
    stagedUpdate = null;
    const message = "the downloaded update is no longer available — download it again";
    send("update:error", { message });
    return { ok: false, error: message };
  }
  const target = appBundlePath();
  try {
    rmSync(target, { recursive: true, force: true });
    execFileSync("mv", [stagedUpdate.path, target]);
    try {
      execFileSync("xattr", ["-dr", "com.apple.quarantine", target]);
    } catch {
      /* nothing to strip */
    }
    app.relaunch();
    app.quit();
    // relaunch only spawns once this process exits, so a quit that stalls
    // leaves the user with an app that swapped itself on disk and never came
    // back — indistinguishable, from the outside, from a broken update.
    // Nothing here should block, but the cost of being wrong is high and the
    // cost of the guard is one timer.
    setTimeout(() => app.exit(0), 4000).unref();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send("update:error", { message });
    return { ok: false, error: message };
  }
}

// ── Secret redaction at the display boundary ─────────────────────────
// Known local secret VALUES (the Unbiased API key). Every engine event
// forwarded to the renderer passes through send(), so masking here
// guarantees a leaked key never renders in the UI or lands in the
// transcript cache — even when a command's output echoes it. This is
// display-layer only: the engine talks to the gateway directly, so what
// the MODEL sees cannot be filtered from this process.
let knownSecrets: string[] | null = null;
function loadKnownSecrets(): string[] {
  if (knownSecrets) return knownSecrets;
  const vals: string[] = [];
  const stored = readStoredKey();
  // Length floor: never build a replacer from a trivial string that could
  // mangle ordinary text.
  if (stored && stored.key.length >= 12) vals.push(stored.key);
  knownSecrets = vals;
  return vals;
}
/** Invalidate the redaction cache after a key change (login/logout). */
function resetKnownSecrets(): void {
  knownSecrets = null;
}

/** Mask known secret values anywhere in a JSON-serializable payload.
 *  Keys are base64url-ish (no JSON-escaped chars), so a straight replace
 *  on the serialized form is exact and catches every nesting depth. */
function redactSecrets<T>(payload: T): T {
  const secrets = loadKnownSecrets();
  if (!secrets.length) return payload;
  let s = JSON.stringify(payload);
  let hit = false;
  for (const sec of secrets) {
    if (s.includes(sec)) {
      hit = true;
      s = s.split(sec).join("•••unbiased-api-key•••");
    }
  }
  return hit ? (JSON.parse(s) as T) : payload;
}

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, redactSecrets(payload));
}

/** Launcher icon (rasterized from resources/icon.svg). In development it
 *  lives in the repo; packaged builds must ship it via extraResources. */
function resolveIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "resources", "icon.png");
}

/** Remembered window bounds, so the app reopens at the size/place the user
 *  left it. Falls back to a large default sized to the current display. */
function windowStateFile(): string {
  return join(app.getPath("userData"), "window-state.json");
}
function loadWindowBounds(): { width: number; height: number; x?: number; y?: number } {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  // Default: fill most of the screen, capped so it isn't unwieldy on huge
  // monitors and never smaller than a usable floor.
  const fallback = {
    width: Math.max(1100, Math.min(1680, Math.round(sw * 0.85))),
    height: Math.max(720, Math.min(1050, Math.round(sh * 0.88))),
  };
  try {
    const saved = JSON.parse(readFileSync(windowStateFile(), "utf8")) as {
      width?: number;
      height?: number;
      x?: number;
      y?: number;
    };
    // Only trust saved bounds that still fit on some connected display.
    if (
      typeof saved.width === "number" &&
      typeof saved.height === "number" &&
      saved.width >= 800 &&
      saved.height >= 600
    ) {
      const onScreen =
        saved.x === undefined ||
        saved.y === undefined ||
        screen.getAllDisplays().some((d) => {
          const b = d.workArea;
          return saved.x! < b.x + b.width && saved.x! + 100 > b.x && saved.y! < b.y + b.height && saved.y! + 40 > b.y;
        });
      return onScreen ? { ...fallback, ...saved } : { width: saved.width, height: saved.height };
    }
  } catch {
    // no saved state
  }
  return fallback;
}

function createWindow(): void {
  const iconPath = resolveIconPath();
  // macOS ignores BrowserWindow icons — the dock owns the launcher icon.
  if (process.platform === "darwin" && existsSync(iconPath)) {
    app.dock?.setIcon(iconPath);
  }
  const bounds = loadWindowBounds();
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 800,
    minHeight: 600,
    title: "Unbiased",
    ...(process.platform !== "darwin" && existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: { preload: join(__dirname, "../preload/index.js") },
  });
  if (bounds.x === undefined) win.center();

  // Persist size/position (debounced) so the next launch restores them.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBounds = () => {
    if (!win || win.isDestroyed()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        if (win && !win.isDestroyed()) writeFileSync(windowStateFile(), JSON.stringify(win.getBounds()));
      } catch {
        // best-effort
      }
    }, 400);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);

  // Coming back to the app is the moment a new release should surface.
  win.on("focus", () => {
    if (stagedUpdate) return; // already downloaded; nothing to re-check
    if (Date.now() - lastUpdateCheck < UPDATE_FOCUS_THROTTLE_MS) return;
    void checkForUpdate();
  });
  // Links in rendered markdown are real anchors now — route them to the
  // system browser instead of navigating (or spawning) app windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (/^https?:/.test(url) && !url.startsWith("http://localhost")) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// Server-initiated approval requests awaiting a human decision, keyed by a
// string handle the renderer can safely round-trip. The owning thread is
// kept so the card can be retired when that thread's turn dies (interrupt,
// failure) — the engine drops the request server-side and would never
// answer a late decision.
type ApprovalDecision = "accept" | "acceptForSession" | "decline";
type PendingApproval = { threadId: string | null } & (
  | { kind: "engine"; rpcId: number | string }
  // Client-executed tools (the agent browser) need the same card, but the
  // decision resolves a promise here instead of answering an engine RPC.
  | { kind: "local"; settle: (decision: ApprovalDecision) => void }
);
const pendingApprovals = new Map<string, PendingApproval>();
let nextLocalApproval = 1;
// Approval handles are minted here, never derived from the engine's JSON-RPC
// id. Keying the map on `apr_${msg.id}` let a reused id overwrite a live
// entry: the first rpcId was orphaned so that turn waited on a reply that
// could never come, and an Allow click landed on a different request than the
// card described. The rpcId is data we answer with, not identity.
let nextEngineApproval = 1;

/** Raise a Permissions card for work this process is about to do itself, and
 *  wait for the human. Routed exactly like an engine approval: a sub-agent's
 *  request surfaces in its PARENT's pane, and a backgrounded conversation
 *  holds it until reopened. */
function requestLocalApproval(threadId: string | null, command: string, reason: string): Promise<ApprovalDecision> {
  const requestId = `apr_local_${nextLocalApproval++}`;
  return new Promise((resolve) => {
    pendingApprovals.set(requestId, { kind: "local", threadId, settle: resolve });
    const sub = threadId ? subAgents.get(threadId) : undefined;
    const target = sub ? sub.parent : threadId;
    const payload: Record<string, unknown> = {
      requestId,
      kind: "command",
      itemId: requestId,
      command,
      cwd: null,
      reason,
      ...(sub ? { agentName: sub.name } : {}),
    };
    const paneId = target ? paneForThread(target) : null;
    if (paneId) {
      send("chat:approval-request", { paneId, ...payload });
    } else if (target) {
      const held = heldApprovals.get(target) ?? [];
      held.push(payload);
      heldApprovals.set(target, held);
    } else {
      send("chat:approval-request", { paneId: "main", ...payload });
    }
  });
}

/** The conversation a thread belongs to — sub-agent grants follow the root,
 *  so one approval covers the agent and everything it spawns. */
function rootThreadOf(threadId: string | null): string {
  let id = threadId ?? "main";
  for (let hops = 0; hops < 8; hops++) {
    const sub = subAgents.get(id);
    if (!sub) break;
    id = sub.parent;
  }
  return id;
}

// Live PTYs for the integrated terminal, keyed by handle.
const ptys = new Map<string, IPty>();
let nextPtyId = 1;

// The in-page annotation picker, injected with executeJavaScript. Runs
// entirely inside the page: hover-highlight → click to pick an element →
// inline comment bubble → the returned promise resolves with the pick
// (or null on Escape), which is exactly when executeJavaScript resolves.
const ANNOTATE_PICKER = `
(() => {
  if (window.__unbiasedPick) return window.__unbiasedPick;
  window.__unbiasedPick = new Promise((resolve) => {
    const Z = 2147483646;
    const hl = document.createElement('div');
    hl.style.cssText = 'position:fixed;z-index:' + Z + ';pointer-events:none;border:2px solid #FF563F;border-radius:4px;background:rgba(255,86,63,0.08);left:-9999px;top:0';
    const badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;z-index:' + (Z + 1) + ';pointer-events:none;width:22px;height:22px;border-radius:50% 50% 50% 4px;background:#FF563F;left:-9999px;top:0';
    document.documentElement.append(hl, badge);
    let current = null;
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      hl.remove(); badge.remove();
    };
    const done = (val) => { cleanup(); delete window.__unbiasedPick; resolve(val); };
    const onMove = (e) => {
      badge.style.left = (e.clientX + 10) + 'px';
      badge.style.top = (e.clientY - 28) + 'px';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === hl || el === badge) return;
      current = el;
      const r = el.getBoundingClientRect();
      hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px';
      hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    const onClick = (e) => {
      if (!current) return;
      e.preventDefault(); e.stopPropagation();
      const el = current;
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      badge.remove();
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:' + (Z + 1) + ';display:flex;align-items:center;gap:6px;background:#26262b;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,0.5);padding:5px 6px 5px 14px;left:' +
        Math.max(8, Math.min(r.left + r.width / 2 - 140, innerWidth - 300)) + 'px;top:' + Math.max(8, r.top - 48) + 'px';
      const input = document.createElement('input');
      input.placeholder = 'Add an optional comment…';
      input.style.cssText = 'background:transparent;border:none;outline:none;color:#eee;font:13px -apple-system,sans-serif;width:200px';
      const ok = document.createElement('button');
      ok.textContent = '\\u2713';
      ok.style.cssText = 'background:#FF563F;color:#fff;border:none;border-radius:50%;width:26px;height:26px;cursor:pointer;font-size:13px;line-height:1';
      box.append(input, ok);
      document.documentElement.append(box);
      input.focus();
      const finish = () => {
        const text = (el.innerText || el.textContent || '').trim().slice(0, 1500);
        box.remove();
        done({ text, comment: input.value.trim(), url: location.href, title: document.title, tag: el.tagName.toLowerCase() });
      };
      ok.addEventListener('click', finish);
      input.addEventListener('keydown', (ke) => {
        ke.stopPropagation();
        if (ke.key === 'Enter') finish();
        if (ke.key === 'Escape') { box.remove(); done(null); }
      });
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
  });
  return window.__unbiasedPick;
})()
`;

/** Run the picker in the browser page; forward a completed pick to the
 *  renderer as a main-composer annotation carrying page provenance. */
async function startAnnotatePicker(id: number): Promise<void> {
  const wc = browserViews.get(id)?.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    const result = (await wc.executeJavaScript(ANNOTATE_PICKER, true)) as {
      text: string;
      comment: string;
      url: string;
      title: string;
      tag: string;
    } | null;
    if (result?.text) {
      // The page thumbnail rides along, Codex-style, for the sent-message
      // annotation card. Best-effort — a failed capture drops the image.
      let thumb: string | undefined;
      try {
        thumb = thumbDataUrl(await wc.capturePage(), 360);
      } catch {
        thumb = undefined;
      }
      send("browser:annotate", {
        text: `${result.text}\n\n(from ${result.title || "page"} — ${result.url})`,
        comment: result.comment || undefined,
        tag: result.tag,
        thumb,
      });
    }
  } catch {
    // Navigation mid-pick destroys the page context; the pick just ends.
  }
}

// The embedded browser: sandboxed WebContentsViews layered over the side
// panel, one per renderer browser tab, keyed by the tab's id. The renderer
// owns the toolbars and reports each placeholder's bounds; this side owns
// navigation and pushes state back tagged with the id.
const browserViews = new Map<number, WebContentsView>();

function ensureBrowserView(id: number): WebContentsView {
  const existing = browserViews.get(id);
  if (existing) return existing;
  const view = new WebContentsView({ webPreferences: { sandbox: true } });
  browserViews.set(id, view);
  win?.contentView.addChildView(view);
  const wc = view.webContents;
  const pushState = () => {
    if (wc.isDestroyed()) return;
    send("browser:state", {
      id,
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
    });
  };
  wc.on("did-navigate", pushState);
  wc.on("did-navigate-in-page", pushState);
  wc.on("page-title-updated", pushState);
  wc.on("did-start-loading", pushState);
  wc.on("did-stop-loading", pushState);
  // Popups/new-tab links load in the same view — tabs are renderer-owned.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void wc.loadURL(url);
    return { action: "deny" };
  });

  // Right-click menu, Codex-style. "Add … to chat" stages the selection
  // or link as an annotation in the main composer.
  wc.on("context-menu", (_e, params) => {
    const selection = params.selectionText.trim();
    const link = params.linkURL;
    const items: (MenuItemConstructorOptions | null)[] = [
      selection
        ? { label: "Quick annotate", click: () => send("browser:annotate", { text: selection, tag: "selection" }) }
        : link
          ? { label: "Quick annotate", click: () => send("browser:annotate", { text: link, tag: "link" }) }
          : null,
      { label: "Annotate", click: () => void startAnnotatePicker(id) },
      { type: "separator" },
      link ? { label: "Open link", click: () => void wc.loadURL(link) } : null,
      link ? { label: "Open in external browser", click: () => void shell.openExternal(link) } : null,
      { type: "separator" },
      link ? { label: "Copy link address", click: () => clipboard.writeText(link) } : null,
      selection ? { label: "Copy", click: () => wc.copy() } : null,
      link ? { label: "Save Link As…", click: () => wc.downloadURL(link) } : null,
      { type: "separator" },
      { label: "Inspect", click: () => wc.inspectElement(params.x, params.y) },
    ];
    // Drop the nulls, then collapse the separator runs they leave behind.
    const template = items
      .filter((i): i is MenuItemConstructorOptions => i !== null)
      .filter(
        (item, idx, arr) =>
          item.type !== "separator" || (idx > 0 && idx < arr.length - 1 && arr[idx - 1].type !== "separator"),
      );
    Menu.buildFromTemplate(template).popup({ window: win ?? undefined });
  });
  return view;
}

function wireNotifications(): void {
  engine.on("notification", (msg: { method: string; params?: Record<string, unknown> }) => {
    const params = msg.params ?? {};
    // Per-thread bookkeeping runs for EVERY notification; only the
    // pane-targeted sends require a pane to currently own the thread.
    const paneId = paneForThread(params.threadId);
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    switch (msg.method) {
      case "rawResponseItem/completed": {
        const raw = params.item as {
          type?: string;
          name?: string;
          namespace?: string;
          arguments?: string;
          author?: string;
          recipient?: string;
          content?: { type?: string; text?: string }[];
        } | undefined;
        if (!raw || !threadId) break;
        // The parent's spawn call carries the instructions the sub-agent
        // will be given — the only client-visible copy.
        if (
          raw.type === "function_call" &&
          raw.namespace === "collaboration" &&
          raw.name === "spawn_agent" &&
          typeof raw.arguments === "string"
        ) {
          try {
            const args = JSON.parse(raw.arguments) as { task_name?: string; message?: string };
            // task_name can arrive path-formed ("/root/x") — key by the last
            // segment, which is what registration looks up.
            const task = args.task_name?.split("/").filter(Boolean).pop();
            if (task && args.message) {
              pendingSpawnPrompts.set(`${threadId}:${task}`, args.message);
            }
          } catch {
            // unparseable args — no prompt preview
          }
          const callId = (params.item as { call_id?: string }).call_id;
          if (typeof callId === "string") pendingSpawnCalls.set(callId, threadId);
        }
        // Corrections/follow-ups: capture the text for the lifecycle row and
        // deliver it to the target's mailbox NOW — the engine holds queued
        // mail invisible until the sub's turn drains it.
        if (
          raw.type === "function_call" &&
          raw.namespace === "collaboration" &&
          (raw.name === "send_message" || raw.name === "followup_task") &&
          typeof raw.arguments === "string"
        ) {
          try {
            const args = JSON.parse(raw.arguments) as { target?: string; message?: string };
            const task = args.target?.split("/").filter(Boolean).pop();
            if (task && args.message) {
              pendingMessagePrompts.set(`${threadId}:${task}`, args.message);
              // The engine frees a closed agent's path for reuse, so the
              // same name can refer to a dead thread AND a live successor —
              // the LAST matching registration is the live one.
              let target: string | null = null;
              for (const [subId, info] of subAgents) {
                if (info.parent === threadId && (info.name === task || info.path.endsWith(`/${task}`))) {
                  target = subId;
                }
              }
              if (target) {
                const box = subAgentMail.get(target) ?? [];
                box.push({ at: Date.now() / 1000, author: "", text: args.message, preDelivered: true });
                if (box.length > MAIL_CAP) box.shift();
                subAgentMail.set(target, box);
                send("chat:subagent-activity", { threadId: target });
              }
            }
          } catch {
            // unparseable args
          }
        }
        // The spawn OUTPUT carries the engine-assigned nickname
        // ({"task_name": "...", "nickname": "Ramanujan"}). Rename the
        // registry entry and let the renderer retitle its rows.
        if (raw.type === "function_call_output") {
          const out = params.item as { call_id?: string; output?: unknown };
          const parent = typeof out.call_id === "string" ? pendingSpawnCalls.get(out.call_id) : undefined;
          if (parent && typeof out.output === "string") {
            pendingSpawnCalls.delete(out.call_id as string);
            try {
              const parsed = JSON.parse(out.output) as { task_name?: string; nickname?: string };
              const task = parsed.task_name?.split("/").filter(Boolean).pop();
              if (parsed.nickname && task) {
                // Path reuse: prefer the newest registration with this name.
                let match: [string, SubAgentInfo] | null = null;
                for (const entry of subAgents) {
                  if (entry[1].parent === parent && entry[1].name === task) match = entry;
                }
                const renamed = match !== null;
                if (match) {
                  const [subId, info] = match;
                  info.name = parsed.nickname;
                  pushSubAgents(parent);
                  const pane = paneForThread(parent);
                  if (pane) {
                    send("chat:subagent-event", {
                      paneId: pane,
                      event: "renamed",
                      name: parsed.nickname,
                      path: info.path,
                      agentThreadId: subId,
                    });
                  }
                }
                // Raws can precede subAgentActivity — stash for registration.
                if (!renamed) pendingNicknames.set(`${parent}:${task}`, parsed.nickname);
              }
            } catch {
              // not a spawn ack — ignore
            }
          }
        }
        // Mail addressed to a sub-agent thread: the task/message text.
        if (raw.type === "agent_message" && Array.isArray(raw.content)) {
          const text = raw.content
            .filter((c) => c?.type === "input_text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join("\n");
          if (text) {
            const { author, payload } = interAgentPayload(text);
            const box = subAgentMail.get(threadId) ?? [];
            // Corrections are pre-delivered from the sender's raw call while
            // the engine still has them queued: the drain-time copy CONSUMES
            // that flag rather than duplicating — and a repeated identical
            // message (two flags) correctly keeps both entries.
            const pending = box.find((m) => m.preDelivered && m.text === payload);
            if (pending) {
              delete pending.preDelivered;
              if (author ?? raw.author) pending.author = author ?? raw.author ?? pending.author;
            } else {
              box.push({ at: Date.now() / 1000, author: author ?? raw.author ?? "", text: payload });
              if (box.length > MAIL_CAP) box.shift();
              subAgentMail.set(threadId, box);
              send("chat:subagent-activity", { threadId });
            }
          }
        }
        break;
      }
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        if (threadId && turn?.id) {
          runningTurns.set(threadId, turn.id);
          bgStream.delete(threadId);
          send("chat:thread-activity", { threadId, running: true });
          const sub = subAgents.get(threadId);
          if (sub) {
            sub.status = "running";
            pushSubAgents(sub.parent);
            send("chat:subagent-activity", { threadId });
          }
        }
        if (!paneId) break;
        if (turn?.id) panes[paneId].turnId = turn.id;
        send("chat:turn-started", { paneId, turnId: panes[paneId].turnId });
        break;
      }
      case "item/agentMessage/delta": {
        const delta = (params.delta as string) ?? "";
        // Always accumulate — this is what seeds the transcript when a
        // backgrounded conversation is reopened mid-stream.
        if (threadId) bgStream.set(threadId, (bgStream.get(threadId) ?? "") + delta);
        if (paneId) send("chat:delta", { paneId, delta });
        // A sub-agent's reply streams to its viewer pane (if open).
        if (threadId && subAgents.has(threadId)) send("chat:subagent-delta", { threadId, delta });
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item as
          | { type?: string; id?: string; status?: string; changes?: { path?: string }[] }
          | undefined;
        const phase = msg.method === "item/started" ? "started" : "completed";
        // A finished assistant message lands in the engine's history — the
        // partial-stream buffer for it is no longer needed.
        if (item?.type === "agentMessage" && phase === "completed" && threadId) {
          bgStream.delete(threadId);
          // Message boundary: the next delta belongs to a NEW assistant
          // message. Multi-agent turns emit several messages per turn, and
          // without this they concatenate into one run-on paragraph.
          if (paneId) send("chat:message-boundary", { paneId });
        }
        // Sub-agent registry: the parent thread emits a subAgentActivity
        // marker per spawn/interaction. Runs even when the parent is
        // backgrounded — the roster must be current when it reopens.
        if (item?.type === "subAgentActivity" && phase === "completed" && threadId) {
          const p = params.item as { kind?: string; agentThreadId?: string; agentPath?: string };
          if (p.agentThreadId && p.agentPath) {
            const existing = subAgents.get(p.agentThreadId);
            const taskName = p.agentPath.split("/").filter(Boolean).pop() ?? p.agentThreadId;
            const promptKey = `${threadId}:${taskName}`;
            // started rows carry the spawn instructions; interacted rows the
            // send_message/followup text.
            const prompt =
              p.kind === "interacted"
                ? pendingMessagePrompts.get(promptKey)
                : pendingSpawnPrompts.get(promptKey);
            if (p.kind === "interacted") pendingMessagePrompts.delete(promptKey);
            else pendingSpawnPrompts.delete(promptKey);
            // The spawn-output raw (nickname) usually precedes registration.
            const stashedNickname = pendingNicknames.get(promptKey);
            if (stashedNickname !== undefined) pendingNicknames.delete(promptKey);
            const name = existing?.name && existing.name !== taskName ? existing.name : (stashedNickname ?? taskName);
            subAgents.set(p.agentThreadId, {
              parent: threadId,
              path: p.agentPath,
              name,
              status: p.kind === "interrupted" ? "interrupted" : (existing?.status ?? "running"),
              // A fresh task re-arms the closed-row announcement.
              closedAnnounced: p.kind === "interacted" ? false : existing?.closedAnnounced,
            });
            pushSubAgents(threadId);
            // An approval that raced ahead of this registration was held
            // under the sub's own id, which no pane ever opens — re-route it
            // to the parent now or the spawn hangs on it forever.
            const stranded = heldApprovals.get(p.agentThreadId);
            if (stranded) {
              heldApprovals.delete(p.agentThreadId);
              const parentPane = paneForThread(threadId);
              for (const payload of stranded) {
                const tagged = { ...payload, agentName: name };
                if (parentPane) {
                  send("chat:approval-request", { paneId: parentPane, ...tagged });
                } else {
                  const held = heldApprovals.get(threadId) ?? [];
                  held.push(tagged);
                  heldApprovals.set(threadId, held);
                }
              }
            }
            // Lifecycle row in the parent's transcript, Codex-style
            // ("Created an agent" / "Messaged an agent" / …) — with the
            // spawn instructions when the raw call carried them.
            if (paneId) {
              send("chat:subagent-event", {
                paneId,
                event: p.kind ?? "started",
                name,
                path: p.agentPath,
                agentThreadId: p.agentThreadId,
                prompt: prompt ?? null,
              });
            }
          }
        }
        // A sub-agent's own items (replies, commands) refresh its viewer.
        if (threadId && subAgents.has(threadId) && phase === "completed") {
          send("chat:subagent-activity", { threadId });
        }
        if (!paneId) break; // history holds these for a backgrounded thread
        if (item?.type === "commandExecution") {
          send("chat:command", { paneId, phase, item });
        } else if (item?.type === "dynamicToolCall") {
          // Browser-tool calls render as command-style cards.
          const d = item as { id?: string; tool?: string; arguments?: unknown; status?: string; success?: boolean };
          const args = d.arguments && typeof d.arguments === "object" ? d.arguments : {};
          const argsText = Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
          send("chat:command", {
            paneId,
            phase,
            item: {
              id: d.id,
              command: `${d.tool ?? "tool"}${argsText}`.slice(0, 400),
              // A started call is in progress — defaulting to "completed"
              // showed a green "done" for a page still loading.
              status:
                d.success === false
                  ? "failed"
                  : (d.status ?? (phase === "started" ? "inProgress" : "completed")),
            },
          });
        } else if (item?.type === "plan") {
          if (phase === "completed") {
            const planItem = params.item as { text?: string };
            send("chat:plan", { paneId, text: planItem.text ?? "" });
          }
        } else if (item?.type === "contextCompaction") {
          // Mark where the model's verbatim history got summarized.
          if (phase === "completed") send("chat:compaction", { paneId });
        } else if (item?.type === "fileChange") {
          // File changes render as command-style cards so the approval
          // buttons have a card to land on.
          const files = (item.changes ?? [])
            .map((c) => c.path?.split("/").filter(Boolean).pop() ?? "?")
            .join(", ");
          send("chat:command", {
            paneId,
            phase,
            item: {
              id: item.id,
              command: `Apply changes: ${files || "(files)"}`,
              status: item.status,
            },
          });
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        const tu = params.tokenUsage as
          | {
              last?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
              modelContextWindow?: number | null;
            }
          | undefined;
        const last = tu?.last;
        // Context occupancy ≈ the latest request's full prompt + completion.
        // cachedInputTokens is a SUBSET of inputTokens (the cache-hit
        // breakdown), NOT an addition — summing it double-counted cached
        // history and showed an impossible >100% context.
        const used = last?.totalTokens ?? (last?.inputTokens ?? 0) + (last?.outputTokens ?? 0);
        const window = tu?.modelContextWindow ?? null;
        const usage = {
          used,
          window,
          // NOT clamped: a conversation that outgrows the window is exactly
          // what the user needs to see. Clamping to 100 showed a calm "100%"
          // at 154% while every request was already failing.
          percent: window ? Math.round((used / window) * 100) : null,
        };
        // Persist per thread so the gauge survives restarts and resumes.
        try {
          const map = loadCtxUsage();
          map[String(params.threadId)] = usage;
          writeFileSync(ctxUsageFile(), JSON.stringify(map));
        } catch {
          // best-effort
        }
        if (paneId) send("chat:token-usage", { paneId, ...usage });
        break;
      }
      case "turn/completed": {
        const turn = params.turn as
          | { status?: string; usage?: unknown; error?: { message?: string; additionalDetails?: string | null } | null }
          | undefined;
        if (threadId) {
          runningTurns.delete(threadId);
          bgStream.delete(threadId);
          // A turn can't end while the engine still waits on an approval —
          // it dropped the request (interrupt/failure). Retire the card so
          // dead Allow/Deny buttons don't linger in the transcript.
          const droppedApprovals: string[] = [];
          for (const [reqId, info] of pendingApprovals) {
            if (info.threadId !== threadId) continue;
            pendingApprovals.delete(reqId);
            // A local waiter would hang forever otherwise.
            if (info.kind === "local") info.settle("decline");
            droppedApprovals.push(reqId);
            const owner = subAgents.get(threadId)?.parent ?? threadId;
            const ownerPane = paneForThread(owner);
            if (ownerPane) send("chat:approval-canceled", { paneId: ownerPane, requestId: reqId });
          }
          if (droppedApprovals.length) {
            for (const [tid, arr] of heldApprovals) {
              const kept = arr.filter((a) => !droppedApprovals.includes(a.requestId as string));
              if (kept.length !== arr.length) {
                if (kept.length) heldApprovals.set(tid, kept);
                else heldApprovals.delete(tid);
              }
            }
          }
          const sub = subAgents.get(threadId);
          if (sub) {
            sub.status =
              turn?.status === "failed" ? "failed" : turn?.status === "interrupted" ? "interrupted" : "idle";
            pushSubAgents(sub.parent);
            send("chat:subagent-activity", { threadId });
            // Closure/failure rows fire once per task — sub turns also end
            // between queued mails, and an interrupted turn already tells
            // its own story via the interrupt marker.
            const isFailure = turn?.status === "failed";
            if ((isFailure || turn?.status === "completed") && !sub.closedAnnounced) {
              sub.closedAnnounced = true;
              const parentPane = paneForThread(sub.parent);
              if (parentPane) {
                send("chat:subagent-event", {
                  paneId: parentPane,
                  event: isFailure ? "failed" : "completed",
                  name: sub.name,
                  path: sub.path,
                  agentThreadId: threadId,
                });
              }
            }
          }
          if (!paneId && turn?.status === "failed") {
            heldErrors.set(
              threadId,
              [turn.error?.message, turn.error?.additionalDetails].filter(Boolean).join(" — ") ||
                "unknown error",
            );
          }
          send("chat:thread-activity", { threadId, running: false });
        }
        if (!paneId) break;
        panes[paneId].turnId = null;
        send("chat:turn-completed", {
          paneId,
          status: turn?.status ?? "completed",
          usage: turn?.usage ?? null,
          // A failed turn is invisible without this — surface the cause.
          error: turn?.error
            ? [turn.error.message, turn.error.additionalDetails].filter(Boolean).join(" — ")
            : null,
        });
        break;
      }
    }
  });

  engine.on(
    "server-request",
    (msg: { id: number | string; method: string; params?: Record<string, unknown> }) => {
      const params = msg.params ?? {};
      // Route an approval to the owning pane, or hold it if the thread is
      // backgrounded — the engine waits on the request, and it replays when
      // the conversation is reopened. Auto-declining here would silently
      // reject work the user asked for.
      function deliverApproval(payload: Record<string, unknown>): void {
        // A sub-agent's approval must surface in its PARENT's pane — the sub
        // thread never owns a pane, so without this reroute the request
        // would sit in heldApprovals forever and the spawn would hang.
        const sub = typeof params.threadId === "string" ? subAgents.get(params.threadId) : undefined;
        const targetThread = sub ? sub.parent : params.threadId;
        const tagged = sub ? { ...payload, agentName: sub.name } : payload;
        const paneId = paneForThread(targetThread);
        if (paneId) {
          send("chat:approval-request", { paneId, ...tagged });
        } else if (typeof targetThread === "string") {
          const held = heldApprovals.get(targetThread) ?? [];
          held.push(tagged);
          heldApprovals.set(targetThread, held);
        } else {
          send("chat:approval-request", { paneId: "main", ...tagged });
        }
      }
      const approvalThread = typeof params.threadId === "string" ? params.threadId : null;
      if (msg.method === "item/commandExecution/requestApproval") {
        const requestId = `apr_${nextEngineApproval++}`;
        pendingApprovals.set(requestId, { kind: "engine", rpcId: msg.id, threadId: approvalThread });
        deliverApproval({
          requestId,
          kind: "command",
          // itemId ties the request to its commandExecution item so the
          // renderer can put the buttons ON the command card.
          itemId: (params.itemId as string) ?? null,
          command: (params.command as string) ?? "(unknown command)",
          cwd: (params.cwd as string) ?? null,
          reason: (params.reason as string) ?? null,
        });
        return;
      }
      if (msg.method === "item/fileChange/requestApproval") {
        const requestId = `apr_${nextEngineApproval++}`;
        pendingApprovals.set(requestId, { kind: "engine", rpcId: msg.id, threadId: approvalThread });
        deliverApproval({
          requestId,
          kind: "fileChange",
          // Lands on the fileChange item's card (same itemId), which
          // already names the files being changed.
          itemId: (params.itemId as string) ?? null,
          command: "Apply file changes",
          cwd: null,
          reason: (params.reason as string) ?? null,
          // The write root the agent wants access to (e.g. ~/Desktop).
          grantRoot: (params.grantRoot as string) ?? null,
        });
        return;
      }
      // Dynamic tool calls (the agent browser): run the CLI and answer
      // with its output. Errors return success:false so the model can
      // adapt instead of the turn dying.
      if (msg.method === "item/tool/call") {
        const tool = String((params as { tool?: unknown }).tool ?? "");
        void handleAgentBrowserCall(tool, (params as { arguments?: unknown }).arguments, approvalThread)
          .catch((err) => ({
            contentItems: [{ type: "inputText" as const, text: `tool crashed: ${String(err)}` }],
            success: false,
          }))
          .then((response) => engine.respond(msg.id, response));
        return;
      }
      // Anything we don't render yet (user-input tools, permissions):
      // declining beats hanging the turn on a question nobody can see.
      console.warn("[app] declining unhandled server request:", msg.method);
      engine.respond(msg.id, { decision: "decline" });
    },
  );
}

let engineWired = false;
async function startEngine(): Promise<void> {
  const engineDir = resolveEngineDir();
  const bin = join(engineDir, "unbiased-app-engine");
  if (!existsSync(bin)) {
    pushStatus({
      state: "exited",
      code: null,
      detail: `engine bundle not found at ${engineDir} — run \`make bundle\` in unbiased-app-engine`,
    });
    return;
  }
  // The engine refuses to start without a key; gate here so the renderer's
  // login screen shows instead of a cryptic "no API key" exit.
  const stored = readStoredKey();
  if (!stored) {
    pushStatus({ state: "exited", code: null, detail: "not signed in" });
    return;
  }

  // Listeners attach once; a re-login stops the old process and starts fresh.
  if (!engineWired) {
    engine.on("status", pushStatus);
    wireNotifications();
    engineWired = true;
  }
  engine.stop();
  resetSubAgentState();
  engine.start(bin, { UNBIASED_API_KEY: stored.key });

  const result = await engine.handshake(app.getVersion());
  pushStatus({
    state: "connected",
    userAgent: result.userAgent,
    engineVersion: engineVersionFromUserAgent(result.userAgent),
    codexHome: result.codexHome,
  });
}

app.whenReady().then(async () => {
  ipcMain.handle("engine:status", () => lastStatus);

  // ── Auth IPC ────────────────────────────────────────────────────────
  // Presence + source of the stored key (no network). keyName is the
  // credentials-file label if we wrote one; env keys are opaque.
  // ── Update IPC ──────────────────────────────────────────────────────
  ipcMain.handle("update:check", async () => (await checkForUpdate()) ?? { none: true });
  ipcMain.handle("update:pending", () => ({
    // While a silent download is in flight the renderer is told nothing: a
    // Download button that appears and then rewrites itself to Restart is
    // worse than no banner at all.
    update: stagedUpdate || !updatePrefs().autoDownload ? pendingUpdate : null,
    staged: stagedUpdate ? { version: stagedUpdate.version } : null,
  }));

  ipcMain.handle("update:prefs", () => ({
    autoDownload: updatePrefs().autoDownload,
    version: app.getVersion(),
    lastCheckedAt: lastUpdateCheck || null,
  }));
  ipcMain.handle("update:set-prefs", (_e, p: { autoDownload: boolean }) => {
    setUpdatePrefs({ autoDownload: !!p.autoDownload });
    // Turning it on mid-session should act now, not in six hours.
    if (p.autoDownload && pendingUpdate && !stagedUpdate && !updateInstalling) {
      silentInstall = true;
      void installUpdate(pendingUpdate).then(() => {
        silentInstall = false;
      });
    }
    return { ok: true };
  });
  ipcMain.handle("update:download", async () => {
    if (!pendingUpdate) return { ok: false, error: "no update available" };
    return installUpdate(pendingUpdate);
  });
  ipcMain.handle("update:apply", () => applyUpdate());

  ipcMain.handle("auth:status", () => {
    const stored = readStoredKey();
    return { hasKey: !!stored, source: stored?.source ?? null };
  });

  // Validate a key (or the stored one) against the platform. Pure check —
  // no persistence, no engine start.
  ipcMain.handle("auth:validate", async (_e, key?: string) => {
    const k = (key ?? readStoredKey()?.key ?? "").trim();
    if (!k) return { ok: false, error: "No API key to validate." };
    return whoamiValidate(k);
  });

  // Sign in: validate, persist (unless the key comes from the environment),
  // then (re)start the engine with it. Returns the whoami identity.
  ipcMain.handle("auth:login", async (_e, payload: { key?: string }) => {
    const fromEnv = process.env.UNBIASED_API_KEY?.trim();
    const key = (payload?.key ?? fromEnv ?? readStoredKey()?.key ?? "").trim();
    if (!key) return { ok: false, error: "No API key provided." };
    const who = await whoamiValidate(key);
    if (!who.ok) return who;
    // Only persist a user-entered key; an env key is the environment's to own.
    const isEnvKey = key === fromEnv;
    if (!isEnvKey) {
      try {
        mkdirSync(join(app.getPath("home"), ".unbiased"), { recursive: true });
        writeFileSync(credentialsPath(), JSON.stringify({ apiKey: key }, null, 2), { mode: 0o600 });
      } catch (err) {
        return { ok: false, error: `Couldn't save credentials: ${String(err)}` };
      }
    }
    resetKnownSecrets();
    startEngine().catch((err) => pushStatus({ state: "exited", code: null, detail: String(err) }));
    return who;
  });

  // Sign out: stop the engine and remove the stored credentials file. An
  // env-provided key can't be removed by us — report that so the UI can say so.
  ipcMain.handle("auth:logout", (_e, opts?: { removeKey?: boolean }) => {
    engine.stop();
    pushStatus({ state: "exited", code: null, detail: "signed out" });
    const envKey = !!process.env.UNBIASED_API_KEY?.trim();
    // Removing the stored key is now the user's choice (Settings → Account):
    // keeping it makes the next sign-in a one-click "Continue".
    if (opts?.removeKey !== false) {
      try {
        rmSync(credentialsPath(), { force: true });
      } catch {
        // nothing to remove
      }
    }
    resetKnownSecrets();
    return { ok: true, envKeyRemains: envKey };
  });

  ipcMain.handle("chat:send", async (_e, payload: {
    paneId: PaneId;
    text: string;
    attachments?: { name: string; path: string; kind?: "image" }[];
  }) => {
    const { paneId, text, attachments } = payload;
    const pane = ensurePane(paneId);
    let created = false;
    if (!pane.threadId) {
      let started: { thread: { id: string } };
      if (paneId.startsWith("side") && panes.main.threadId) {
        // The Codex semantics, confirmed from its own client: a side chat is
        // an ephemeral FORK of the parent conversation — full context copied
        // into a temporary thread the engine forgets at exit. (Codex also
        // passes excludeTurns to trim the response payload, but that flag is
        // gated behind the experimentalApi capability; we ignore the returned
        // turn array anyway, so we simply don't ask for the trim.)
        started = (await engine.request("thread/fork", {
          threadId: panes.main.threadId,
          ephemeral: true,
          ...threadPolicy(),
        })) as { thread: { id: string } };
      } else if (paneId.startsWith("side")) {
        // No parent conversation yet: a plain scratch thread.
        started = (await engine.request("thread/start", {
          ...threadPolicy(),
          ephemeral: true,
          experimentalRawEvents: true,
          dynamicTools: agentBrowserTools(),
          developerInstructions: APP_DEVELOPER_INSTRUCTIONS,
        })) as { thread: { id: string } };
      } else {
        // Explicit default when no project is chosen — left implicit, the
        // engine falls back to its own process cwd (wherever the app
        // launched from) and the chat wrongly files under that project.
        let cwd = pendingCwd ?? defaultChatDir();
        if (pendingCwd && workMode === "worktree") {
          const wt = await createWorktree(pendingCwd);
          if (wt) cwd = wt;
        } else if (pendingCwd && typeof workMode === "object") {
          // A previously created worktree — validate it still exists and
          // belongs to this project before trusting it.
          const info = loadWorktrees()[workMode.existing];
          if (info && info.project === pendingCwd && existsSync(workMode.existing)) {
            cwd = workMode.existing;
          }
        }
        started = (await engine.request("thread/start", {
          ...threadPolicy(),
          cwd,
          // Model-driven browser automation (agent-browser CLI), when
          // installed — the calls come back as item/tool/call requests.
          dynamicTools: agentBrowserTools(),
          developerInstructions: APP_DEVELOPER_INSTRUCTIONS,
          // Raw response items feed the sub-agent viewer (task text + spawn
          // instructions). Sub-threads inherit this from their parent.
          experimentalRawEvents: true,
        })) as { thread: { id: string }; cwd?: string };
        mainCwd = (started as { cwd?: string }).cwd ?? cwd;
      }
      pane.threadId = started.thread.id;
      threadAccessModes.set(started.thread.id, accessMode);
      created = true;
    }
    // Attachments ride as `mention` input items — the engine resolves the
    // path and pulls the content into context itself (same mechanism as
    // codex's @-mentions), so files AND folders both work. Images go as
    // `localImage` items instead, which the engine feeds to the model as
    // actual image input rather than file text.
    const input: Record<string, unknown>[] = [{ type: "text", text }];
    for (const a of attachments ?? []) {
      if (a.kind === "image") {
        input.push({ type: "localImage", path: a.path });
      } else {
        input.push({ type: "mention", name: a.name, path: a.path });
      }
    }
    if (planMode) input.unshift({ type: "text", text: PLAN_DIRECTIVE });
    const result = (await engine.request("turn/start", {
      threadId: pane.threadId,
      input,
      // Turn-level overrides apply "this turn and subsequent turns", so a
      // mode switched mid-conversation takes effect immediately. Plan mode
      // hard-forces read-only regardless of the access mode.
      approvalPolicy: planMode ? "on-request" : threadPolicy().approvalPolicy,
      // The side pane forks the main thread, so mainCwd is right for both.
      sandboxPolicy: planMode ? { type: "readOnly" } : turnSandbox(mainCwd),
    })) as { turn?: { id?: string } };
    if (result.turn?.id) pane.turnId = result.turn.id;
    return { turnId: pane.turnId, threadId: pane.threadId, created };
  });

  // Client-side transcript cache: the engine's history omits things only
  // the renderer knows (failed-turn errors, annotation cards, thumbnails),
  // so the rendered entries persist per thread and win on resume when
  // richer than what the engine returns.
  const transcriptsDir = () => {
    const dir = join(app.getPath("userData"), "transcripts");
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const transcriptFile = (threadId: string) =>
    join(transcriptsDir(), `${threadId.replace(/[^\w.-]/g, "_")}.json`);

  ipcMain.handle("transcript:save", (_e, p: { threadId: string; entries: unknown }) => {
    try {
      writeFileSync(transcriptFile(p.threadId), JSON.stringify(p.entries));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle("transcript:load", (_e, threadId: string) => {
    try {
      // Caches written before redaction existed may hold raw values.
      return redactSecrets({ entries: JSON.parse(readFileSync(transcriptFile(threadId), "utf8")) });
    } catch {
      return { entries: null };
    }
  });

  ipcMain.handle("usage:context", (_e, threadId: string) => {
    return { usage: loadCtxUsage()[threadId] ?? null };
  });

  ipcMain.handle("usage:billing", () => readBilling());


  // ── Resource + storage stats (Settings → Resources) ─────────────────
  // Live process metrics: Chromium's own processes via getAppMetrics(),
  // plus the children WE spawn (engine, terminal shells), which Chromium
  // doesn't track — measured with one `ps` call.
  ipcMain.handle("stats:resources", async () => {
    const procs = app.getAppMetrics().map((m) => ({
      pid: m.pid,
      kind: m.type, // Browser | Tab | GPU | Utility …
      memMB: (m.memory?.workingSetSize ?? 0) / 1024,
      cpu: m.cpu?.percentCPUUsage ?? 0,
    }));
    const extras: { pid: number; kind: string }[] = [];
    if (engine.pid) extras.push({ pid: engine.pid, kind: "engine" });
    for (const pty of ptys.values()) extras.push({ pid: pty.pid, kind: "terminal" });
    const extraProcs: { pid: number; kind: string; memMB: number; cpu: number }[] = [];
    if (extras.length) {
      try {
        const out = await new Promise<string>((resolve, reject) =>
          execFile(
            "ps",
            ["-o", "pid=,rss=,pcpu=", "-p", extras.map((e) => e.pid).join(",")],
            (err, stdout) => (err ? reject(err) : resolve(stdout)),
          ),
        );
        for (const line of out.trim().split("\n")) {
          const [pid, rss, pcpu] = line.trim().split(/\s+/);
          const kind = extras.find((e) => e.pid === Number(pid))?.kind;
          if (kind) extraProcs.push({ pid: Number(pid), kind, memMB: Number(rss) / 1024, cpu: Number(pcpu) });
        }
      } catch {
        // some pid exited between listing and ps — fine, report what we have
      }
    }
    return { procs: [...procs, ...extraProcs] };
  });

  // What each conversation costs on disk: the engine's append-only rollout
  // (filename embeds the thread id) + our transcript cache. Worktrees and
  // the engine home measured with `du`.
  ipcMain.handle("stats:storage", async () => {
    const engineHome =
      lastStatus.state === "connected"
        ? lastStatus.codexHome
        : join(app.getPath("home"), ".unbiased", "app-engine", "home");
    const threads: Record<
      string,
      {
        rolloutBytes: number;
        transcriptBytes: number;
        mtime: number;
        agent?: { nickname: string | null; task: string; parent: string | null };
      }
    > = {};
    const entry = (id: string) => (threads[id] ??= { rolloutBytes: 0, transcriptBytes: 0, mtime: 0 });
    // A sub-agent's rollout opens with a session_meta line naming its
    // nickname, agent path, and parent thread — enough to label the row
    // like a conversation instead of a bare thread id.
    const agentMeta = (file: string): { nickname: string | null; task: string; parent: string | null } | null => {
      try {
        const fd = openSync(file, "r");
        const buf = Buffer.alloc(65536);
        const n = readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        const firstLine = buf.toString("utf8", 0, n).split("\n")[0];
        const meta = JSON.parse(firstLine) as {
          payload?: { agent_path?: string; agent_nickname?: string; parent_thread_id?: string };
        };
        const path = meta.payload?.agent_path;
        if (!path) return null;
        return {
          nickname: meta.payload?.agent_nickname ?? null,
          task: path.split("/").filter(Boolean).pop() ?? path,
          parent: meta.payload?.parent_thread_id ?? null,
        };
      } catch {
        return null; // meta line longer than the probe, or not a sub-agent
      }
    };
    const walkSessions = (dir: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(dir, n);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) walkSessions(p);
        else {
          const m = n.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
          if (m) {
            const e = entry(m[1]);
            e.rolloutBytes += st.size;
            e.mtime = Math.max(e.mtime, st.mtimeMs);
            if (!e.agent) e.agent = agentMeta(p) ?? undefined;
          }
        }
      }
    };
    walkSessions(join(engineHome, "sessions"));
    try {
      for (const n of readdirSync(transcriptsDir())) {
        if (!n.endsWith(".json")) continue;
        try {
          entry(n.slice(0, -5)).transcriptBytes = statSync(join(transcriptsDir(), n)).size;
        } catch {
          // race with deletion
        }
      }
    } catch {
      // no transcripts yet
    }
    const duKB = (dir: string): Promise<number> =>
      new Promise((resolve) =>
        execFile("du", ["-sk", dir], (err, stdout) => resolve(err ? 0 : Number(stdout.split(/\s+/)[0]) || 0)),
      );
    const wtMap = loadWorktrees();
    const worktrees = await Promise.all(
      Object.entries(wtMap)
        .filter(([dir]) => existsSync(dir))
        .map(async ([dir, info]) => ({ dir, project: info.project, branch: info.branch, kb: await duKB(dir) })),
    );
    const engineHomeKB = await duKB(engineHome);
    return { threads, worktrees, engineHomeKB };
  });

  ipcMain.handle("planmode:set", (_e, on: boolean) => {
    planMode = !!on;
    return { planMode };
  });

  ipcMain.handle("workmode:set", (_e, p: { mode: string; dir?: string }) => {
    if (p.mode === "local" || p.mode === "worktree") workMode = p.mode;
    else if (p.mode === "existing" && p.dir) workMode = { existing: p.dir };
    return { ok: true };
  });

  // Delete a conversation worktree: git removes it from the parent repo's
  // bookkeeping (force — agent work in it is disposable by definition once
  // the user deletes it), falling back to a plain rm if the repo is gone.
  ipcMain.handle("worktrees:remove", async (_e, dir: string) => {
    const map = loadWorktrees();
    const info = map[dir];
    if (info) {
      const removed = await new Promise<boolean>((resolve) => {
        execFile(
          "git",
          ["-C", info.project, "worktree", "remove", "--force", dir],
          { timeout: 30000 },
          (error) => resolve(!error),
        );
      });
      if (!removed) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }
      delete map[dir];
      writeFileSync(worktreesFile(), JSON.stringify(map, null, 2) + "\n");
    } else {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    return { ok: true };
  });

  // Worktrees previously created for a project (and still on disk).
  ipcMain.handle("worktrees:list", (_e, project: string) => {
    const map = loadWorktrees();
    const worktrees = Object.entries(map)
      .filter(([dir, info]) => info.project === project && existsSync(dir))
      .map(([dir, info]) => ({ dir, branch: info.branch }));
    return { worktrees };
  });

  // What the ACTIVE main conversation is actually working in.
  ipcMain.handle("conversation:info", () => {
    const wt = mainCwd ? loadWorktrees()[mainCwd] : undefined;
    return {
      cwd: mainCwd,
      isWorktree: !!wt,
      project: wt?.project ?? null,
      branch: wt?.branch ?? null,
    };
  });

  ipcMain.handle("policy:set-mode", (_e, mode: string) => {
    if (mode === "ask" || mode === "auto" || mode === "full") accessMode = mode;
    return { mode: accessMode };
  });

  ipcMain.handle("chat:interrupt", async (_e, paneId: PaneId) => {
    const pane = ensurePane(paneId);
    // The per-thread record covers a conversation reopened mid-turn,
    // where the pane's own turnId may not have been set by turn/started.
    const turnId = pane.turnId ?? (pane.threadId ? runningTurns.get(pane.threadId) : null);
    if (!pane.threadId || !turnId) return { interrupted: false };
    await engine.request("turn/interrupt", { threadId: pane.threadId, turnId });
    // Stop means stop: sub-agents run in their own sessions, so without a
    // cascade they keep working (and a sub blocked on an approval would
    // wait forever). Queued corrections still reach them — the engine
    // starts a fresh turn for pending mail after an interrupt.
    for (const [subId, info] of subAgents) {
      if (info.parent !== pane.threadId) continue;
      const subTurn = runningTurns.get(subId);
      if (!subTurn) continue;
      try {
        await engine.request("turn/interrupt", { threadId: subId, turnId: subTurn });
      } catch {
        // sub turn may have just ended on its own
      }
    }
    return { interrupted: true };
  });

  // Manually summarize the conversation's history. Useful when a very
  // tool-dense conversation starts returning empty completions: replacing
  // the verbatim tool-call log with a summary cuts the density that trips
  // the gateway's cascade. Emits a contextCompaction item on completion,
  // which the renderer already renders as a divider.
  ipcMain.handle("chat:compact", async (_e, paneId: PaneId) => {
    const pane = ensurePane(paneId);
    if (!pane.threadId) return { ok: false, error: "no conversation" };
    try {
      await engine.request("thread/compact/start", { threadId: pane.threadId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("chat:approve", (_e, payload: {
    requestId: string;
    decision: "accept" | "acceptForSession" | "decline";
  }) => {
    const pending = pendingApprovals.get(payload.requestId);
    if (pending === undefined) return { ok: false };
    pendingApprovals.delete(payload.requestId);
    if (pending.kind === "engine") {
      engine.respond(pending.rpcId, { decision: payload.decision });
    } else {
      pending.settle(payload.decision);
      // No engine item stands behind a local approval card, so nothing would
      // ever flip it off "running" — resolve it here.
      const sub = pending.threadId ? subAgents.get(pending.threadId) : undefined;
      const paneId = paneForThread(sub ? sub.parent : pending.threadId);
      if (paneId) {
        send("chat:command", {
          paneId,
          phase: "completed",
          item: { id: payload.requestId, status: payload.decision === "decline" ? "declined" : "completed" },
        });
      }
    }
    return { ok: true };
  });

  ipcMain.handle("threads:list", async () => {
    const result = (await engine.request("thread/list", { limit: 100 })) as { data?: WireThread[] };
    const home = app.getPath("home");
    // Codex-style sections: threads group under a project only when the
    // user has explicitly opened (and not removed) that folder — the
    // projects.json list is authoritative. Everything else, including
    // chats of removed projects, lists under Recents. Keyed by full path
    // so two folders sharing a basename stay distinct; explicitly opened
    // projects render even with zero conversations.
    const records = loadProjects();
    const projectMap = new Map<string, ThreadSummary[]>();
    const folderToPrimary = new Map<string, string>();
    for (const r of records) {
      projectMap.set(r.primary, []);
      for (const f of r.folders) folderToPrimary.set(f, r.primary);
    }
    const worktrees = loadWorktrees();
    const threadProjectOverrides = loadThreadProjects();
    const recents: ThreadSummary[] = [];
    for (const t of result.data ?? []) {
      const summary: ThreadSummary = { id: t.id, title: threadTitle(t), createdAt: t.createdAt };
      // Explicit assignment wins, then worktree conversations group under
      // their parent project, then the thread's own cwd.
      const effectiveCwd =
        threadProjectOverrides[t.id] ?? (t.cwd && worktrees[t.cwd] ? worktrees[t.cwd].project : t.cwd);
      const primary = effectiveCwd && effectiveCwd !== home ? folderToPrimary.get(effectiveCwd) : undefined;
      const group = primary ? projectMap.get(primary) : undefined;
      if (group) group.push(summary);
      else recents.push(summary);
    }
    return {
      projects: records.map((r) => ({
        path: r.primary,
        name: r.name,
        icon: r.icon,
        color: r.color,
        folders: r.folders,
        threads: projectMap.get(r.primary) ?? [],
      })),
      recents,
      // Threads with a live turn — seeds the sidebar activity indicators.
      running: [...runningTurns.keys()],
    };
  });

  // Archive every chat in a project (engine-side thread/archive — they
  // drop out of thread/list but survive for a future archived view).
  ipcMain.handle("project:archive-chats", async (_e, path: string) => {
    const result = (await engine.request("thread/list", { limit: 100 })) as { data?: WireThread[] };
    const record = loadProjects().find((r) => r.primary === path);
    const folders = record?.folders ?? [path];
    // Match the sidebar's grouping exactly (threads:list): explicit
    // assignment wins, then worktree→project mapping, then the thread's own
    // cwd — so this archives precisely the chats listed under the project.
    const worktrees = loadWorktrees();
    const overrides = loadThreadProjects();
    const targets = (result.data ?? []).filter((t) => {
      const effective = overrides[t.id] ?? (t.cwd && worktrees[t.cwd] ? worktrees[t.cwd].project : t.cwd);
      return !!effective && (effective === path || folders.includes(effective));
    });
    for (const t of targets) {
      await engine.request("thread/archive", { threadId: t.id });
      if (panes.main.threadId === t.id) {
        panes.main.threadId = null;
        panes.main.turnId = null;
        resetSidePanes();
      }
    }
    return { archived: targets.length };
  });

  // Remove = forget the project in the app. Files and chats survive;
  // its chats regroup under Recents (see threads:list).
  ipcMain.handle("project:remove", (_e, path: string) => {
    saveProjects(loadProjects().filter((p) => p.primary !== path));
    return { ok: true };
  });

  // Edit-project save: name, icon, color, folders, primary — matched by the
  // project's previous primary path.
  ipcMain.handle("project:update", (_e, p: { path: string; record: ProjectRecord }) => {
    const projects = loadProjects();
    const idx = projects.findIndex((r) => r.primary === p.path);
    if (idx === -1) return { ok: false, error: "Project not found" };
    const rec = p.record;
    if (!rec.folders.length) return { ok: false, error: "A project needs at least one folder" };
    projects[idx] = {
      name: rec.name.trim() || projects[idx].name,
      folders: rec.folders,
      primary: rec.folders.includes(rec.primary) ? rec.primary : rec.folders[0],
      icon: rec.icon,
      color: rec.color,
    };
    saveProjects(projects);
    return { ok: true, record: projects[idx] };
  });

  ipcMain.handle("project:reveal", (_e, path: string) => {
    void shell.openPath(path);
    return { ok: true };
  });

  // Rename lives in the ENGINE (thread/name/set) so the sidebar title —
  // which comes from thread/list — updates everywhere, including resumes.
  ipcMain.handle("threads:rename", async (_e, p: { threadId: string; name: string }) => {
    try {
      await engine.request("thread/name/set", { threadId: p.threadId, name: p.name });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle("threads:assign-project", (_e, p: { threadId: string; projectPath: string }) => {
    const map = loadThreadProjects();
    map[p.threadId] = p.projectPath;
    writeFileSync(threadProjectsFile(), JSON.stringify(map, null, 2) + "\n");
    rememberProject(p.projectPath);
    return { ok: true };
  });

  // Create takes the same record the edit modal produces. With source
  // folders it just registers them; with none, an empty project is a fresh
  // directory named after the project in the home folder.
  ipcMain.handle(
    "project:create",
    (_e, p: { name: string; folders?: string[]; primary?: string; icon?: string; color?: string | null }) => {
      const name = p.name.trim();
      if (!name) return { path: null, name: null, error: "Project name is required" };
      const folders = (p.folders ?? []).filter(Boolean);
      let primary: string;
      if (folders.length > 0) {
        primary = p.primary && folders.includes(p.primary) ? p.primary : folders[0];
      } else {
        const safe = name.replace(/[/\\]/g, "-");
        primary = join(app.getPath("home"), safe);
        try {
          mkdirSync(primary, { recursive: true });
        } catch (err) {
          return { path: null, name: null, error: `Couldn't create ${primary}: ${String(err)}` };
        }
        folders.push(primary);
      }
      const projects = loadProjects();
      if (projects.some((r) => r.primary === primary)) {
        return { path: null, name: null, error: "A project already uses that primary folder" };
      }
      projects.unshift({ name, folders, primary, icon: p.icon ?? "folder", color: p.color ?? null });
      saveProjects(projects);
      pendingCwd = primary;
      mainCwd = primary;
      panes.main.threadId = null;
      panes.main.turnId = null;
      resetSidePanes();
      return { path: primary, name };
    },
  );

  ipcMain.handle("project:pick-location", async () => {
    if (!win) return { path: null };
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose where the project folder is created",
      buttonLabel: "Use this location",
    });
    return { path: result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0] };
  });

  ipcMain.handle("project:choose", async () => {
    if (!win) return { path: null, name: null };
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Choose a project folder",
      buttonLabel: "Open project",
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null, name: null };
    const path = result.filePaths[0];
    rememberProject(path);
    pendingCwd = path;
    mainCwd = path;
    panes.main.threadId = null;
    panes.main.turnId = null;
    resetSidePanes();
    return { path, name: path.split("/").filter(Boolean).pop() ?? path };
  });

  ipcMain.handle("threads:open", async (_e, id: string) => {
    const running = runningTurns.has(id);
    // A thread with a live turn is already loaded in the engine —
    // thread/read returns its history without disturbing the turn;
    // re-resuming it is what thread/resume is NOT for.
    const result = running
      ? ((await engine.request("thread/read", { threadId: id, includeTurns: true })) as {
          thread: WireThread;
          cwd?: string;
        })
      : ((await engine.request("thread/resume", { threadId: id, ...threadPolicy() })) as {
          thread: WireThread;
          cwd?: string;
        });
    mainCwd = result.cwd ?? result.thread.cwd ?? null;
    // An unanswered browser card on the conversation we are leaving would
    // otherwise block its tool call — and therefore its turn — forever.
    settleLocalApprovals(panes.main.threadId);
    panes.main.threadId = id;
    panes.main.turnId = runningTurns.get(id) ?? null;
    // The side chat (if any) was forked from the previous conversation;
    // it resets alongside every main-context switch.
    resetSidePanes();
    // Everything that happened while this thread was backgrounded: the
    // partial assistant stream, approval requests the agent is blocked
    // on, and a turn failure nobody saw. Held items are consumed here.
    const approvals = heldApprovals.get(id) ?? [];
    heldApprovals.delete(id);
    const failure = heldErrors.get(id) ?? null;
    heldErrors.delete(id);
    // History replays raw engine content — same redaction as live events.
    return redactSecrets({
      id,
      entries: threadToEntries(result.thread),
      running,
      streamText: bgStream.get(id) ?? "",
      approvals,
      failure,
    });
  });

  ipcMain.handle("threads:detach", (_e, cwd?: string) => {
    // Fresh main-chat view: the next send creates a new thread, in `cwd` if given.
    settleLocalApprovals(panes.main.threadId);
    panes.main.threadId = null;
    panes.main.turnId = null;
    resetSidePanes();
    pendingCwd = cwd ?? null;
    mainCwd = cwd ?? null;
    return { ok: true };
  });

  // Sub-agent roster for a (re)opened conversation — the live pushes only
  // reach a pane that already owns the thread.
  ipcMain.handle("subagents:list", (_e, parent: string) => ({ agents: subAgentsForParent(parent) }));

  // A sub-agent's transcript on demand: thread/read leaves its running turn
  // undisturbed, and the bgStream tail covers text still streaming.
  ipcMain.handle("subagents:transcript", async (_e, id: string) => {
    const info = subAgents.get(id);
    try {
      const result = (await engine.request("thread/read", { threadId: id, includeTurns: true })) as {
        thread: WireThread;
      };
      // The task/messages the agent was GIVEN aren't thread items — they
      // ride the inter-agent channel we capture from raw notifications.
      // Merge mail (as user bubbles) with the turns by time so the pane
      // reads as the two-sided conversation it actually is.
      // Rollout is the authoritative mail source (survives resume/restart);
      // live raw captures fill the gap before the rollout flushes.
      const mail = rolloutMail(id, info?.path ?? null);
      // Live captures fill the gap before the rollout flushes. Dedupe by
      // COUNT per text, not mere presence: the same text can legitimately be
      // sent twice, and each rollout copy accounts for one live capture.
      const rolloutCopies = new Map<string, number>();
      for (const r of mail) rolloutCopies.set(r.text, (rolloutCopies.get(r.text) ?? 0) + 1);
      for (const m of subAgentMail.get(id) ?? []) {
        const left = rolloutCopies.get(m.text) ?? 0;
        if (left > 0) rolloutCopies.set(m.text, left - 1);
        else mail.push(m);
      }
      // The sub-agent's thread FORKS the parent's visible history (user
      // prompts and the root's own replies), and thread/read returns those
      // turns as if they were the agent's. The agent-to-agent view starts at
      // the spawn — and the spawn moment IS the first mail's timestamp, so
      // anything earlier is forked parent history and dropped. The user
      // filter stays as a fallback for the no-mail case.
      // Only stamped mail anchors the spawn moment — a timestamp-less
      // rollout line would set spawnAt to 0 and disable the filter.
      const stamped = mail.filter((m) => m.at > 0);
      const spawnAt = stamped.length > 0 ? Math.min(...stamped.map((m) => Math.floor(m.at))) : null;
      const timeline: { t: number; mail: boolean; entries: unknown[] }[] = [];
      for (const turn of result.thread.turns ?? []) {
        const t = turn.startedAt ?? 0;
        // A turn without startedAt can't be classified — keep it rather
        // than silently dropping the agent's replies.
        if (spawnAt !== null && turn.startedAt != null && t < spawnAt) continue; // forked parent history
        const entries = threadToEntries({ ...result.thread, turns: [turn] }).filter(
          (e) => (e as { kind?: string }).kind !== "user",
        );
        if (entries.length === 0) continue;
        timeline.push({ t, mail: false, entries });
      }
      for (const m of mail) {
        // Floor to seconds to match turn.startedAt's resolution — mail is
        // recorded milliseconds INTO the second its turn starts.
        timeline.push({ t: Math.floor(m.at), mail: true, entries: [{ kind: "user", text: m.text }] });
      }
      // Mail always PRECEDES the turn it triggers, so ties break mail-first.
      timeline.sort((a, b) => a.t - b.t || (a.mail === b.mail ? 0 : a.mail ? -1 : 1));
      return redactSecrets({
        entries: timeline.flatMap((x) => x.entries),
        running: runningTurns.has(id),
        streamText: bgStream.get(id) ?? "",
        name: info?.name ?? null,
        path: info?.path ?? null,
      });
    } catch (err) {
      return { entries: [], running: false, streamText: "", name: info?.name ?? null, path: info?.path ?? null, error: String(err) };
    }
  });

  ipcMain.handle("side:reset", (_e, paneId?: string) => {
    // Side chats are disposable: dropping the reference is the whole
    // cleanup — the ephemeral thread evaporates with the engine.
    if (paneId) dropSidePane(paneId);
    else resetSidePanes();
    return { ok: true };
  });

  // Read-only file access for the viewer panel. Paths resolve against the
  // active conversation's cwd; output is capped and binary files refused.
  ipcMain.handle("file:read", (_e, rawPath: string) => {
    const base = mainCwd ?? pendingCwd ?? app.getPath("home");
    const fullPath = isAbsolute(rawPath) ? rawPath : join(base, rawPath);
    try {
      const info = statSync(fullPath);
      if (!info.isFile()) return { error: "Not a file", fullPath };
      if (info.size > 1_000_000) return { error: "File is larger than 1 MB", fullPath };
      const content = readFileSync(fullPath, "utf8");
      if (content.includes("\u0000")) return { error: "Binary file", fullPath };
      const rel = relative(base, fullPath);
      return { fullPath, relPath: rel.startsWith("..") ? fullPath : rel, content };
    } catch {
      return { error: `Could not open ${rawPath}`, fullPath };
    }
  });

  // Existence probe for inline file chips: same resolution as file:read,
  // so a chip only renders as a link when clicking it would actually work.
  ipcMain.handle("file:exists", (_e, rawPath: string) => {
    const base = mainCwd ?? pendingCwd ?? app.getPath("home");
    const fullPath = isAbsolute(rawPath) ? rawPath : join(base, rawPath);
    try {
      return { exists: statSync(fullPath).isFile() };
    } catch {
      return { exists: false };
    }
  });

  ipcMain.handle("attach:choose", async () => {
    if (!win) return { attachments: [] };
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "openDirectory", "multiSelections"],
      title: "Attach files or folders",
      buttonLabel: "Attach",
      defaultPath: mainCwd ?? undefined,
    });
    if (result.canceled) return { attachments: [] };
    return {
      attachments: result.filePaths.map((path) => {
        const name = path.split("/").filter(Boolean).pop() ?? path;
        try {
          if (statSync(path).isDirectory()) return { path, name, kind: "folder" };
        } catch {
          // fall through to the generic file card
        }
        // Picked image files render a thumbnail card and send as localImage
        // (a mention would dump binary into context). Unreadable/exotic
        // formats quietly stay plain files.
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) {
          const img = nativeImage.createFromPath(path);
          if (!img.isEmpty()) return { path, name, kind: "image", thumb: thumbDataUrl(img) };
        }
        return { path, name, kind: "file" };
      }),
    };
  });

  ipcMain.handle("browser:open", (_e, p: { id: number; url?: string }) => {
    const view = ensureBrowserView(p.id);
    if (p.url) void view.webContents.loadURL(p.url);
    return { ok: true };
  });

  ipcMain.handle("browser:bounds", (_e, p: { id: number; x: number; y: number; width: number; height: number }) => {
    // The renderer measures in its own CSS pixels; setBounds wants window
    // DIPs. They differ by the page zoom factor (Cmd+= / Cmd+-), so an
    // unzoomed conversion strands the view at the wrong spot and size.
    const z = win?.webContents.getZoomFactor() ?? 1;
    // Lookup, never create: a late ResizeObserver tick for a tab the user
    // just closed would otherwise mint an orphan view layered over the panel.
    browserViews.get(p.id)?.setBounds({
      x: Math.round(p.x * z),
      y: Math.round(p.y * z),
      width: Math.max(0, Math.round(p.width * z)),
      height: Math.max(0, Math.round(p.height * z)),
    });
  });

  ipcMain.handle("browser:visible", (_e, p: { id: number; visible: boolean }) => {
    browserViews.get(p.id)?.setVisible(p.visible);
  });

  ipcMain.handle("browser:navigate", (_e, p: { id: number; url?: string; action?: "back" | "forward" | "reload" }) => {
    const wc = browserViews.get(p.id)?.webContents;
    if (!wc) return;
    if (p.url) {
      const url = /^[a-z][a-z0-9+.-]*:/i.test(p.url) ? p.url : `https://${p.url}`;
      void wc.loadURL(url);
    } else if (p.action === "back") {
      wc.navigationHistory.goBack();
    } else if (p.action === "forward") {
      wc.navigationHistory.goForward();
    } else if (p.action === "reload") {
      wc.reload();
    }
  });

  ipcMain.handle("browser:annotate-mode", (_e, id: number) => {
    void startAnnotatePicker(id);
    return { ok: true };
  });

  ipcMain.handle("browser:close", (_e, id: number) => {
    const view = browserViews.get(id);
    if (view) {
      browserViews.delete(id);
      win?.contentView.removeChildView(view);
      view.webContents.close();
    }
  });

  // Integrated terminal: a real PTY running the user's shell, rooted at
  // the active conversation's cwd (the Codex/Claude-desktop contract —
  // the terminal sees the same files the agent works on).
  ipcMain.handle("term:create", (_e, opts: { cols?: number; rows?: number }) => {
    const cwd = mainCwd ?? pendingCwd ?? app.getPath("home");
    const shell = process.env.SHELL || "/bin/zsh";
    const id = `pty_${nextPtyId++}`;
    const pty = ptySpawn(shell, [], {
      name: "xterm-256color",
      cwd,
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      env: process.env as Record<string, string>,
    });
    pty.onData((data) => send("term:data", { id, data }));
    pty.onExit(({ exitCode }) => {
      ptys.delete(id);
      send("term:exit", { id, exitCode });
    });
    ptys.set(id, pty);
    return { id, cwd, shell };
  });

  ipcMain.handle("term:write", (_e, p: { id: string; data: string }) => {
    ptys.get(p.id)?.write(p.data);
  });

  ipcMain.handle("term:resize", (_e, p: { id: string; cols: number; rows: number }) => {
    ptys.get(p.id)?.resize(Math.max(2, Math.floor(p.cols)), Math.max(1, Math.floor(p.rows)));
  });

  ipcMain.handle("term:kill", (_e, id: string) => {
    ptys.get(id)?.kill();
    ptys.delete(id);
  });

  // One directory level for the workspace tree — the renderer expands
  // lazily, so huge folders (node_modules…) cost nothing until opened.
  // No path argument = the active conversation's root.
  ipcMain.handle("fs:list", (_e, rawDir?: string) => {
    const base = mainCwd ?? pendingCwd ?? app.getPath("home");
    const dir = rawDir ? (isAbsolute(rawDir) ? rawDir : join(base, rawDir)) : base;
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
        .map((d) => ({ name: d.name, dir: d.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return { dir, entries };
    } catch {
      return { dir, entries: [], error: `Could not read ${dir}` };
    }
  });

  // Current branch of a project, for the composer's context strip.
  ipcMain.handle("git:branch", (_e, path: string) => {
    return new Promise((resolve) => {
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, timeout: 3000 }, (err, stdout) => {
        resolve({ branch: err ? null : stdout.trim() });
      });
    });
  });

  const runGit = (cwd: string, args: string[]) =>
    new Promise<{ out: string; err: string; code: number }>((resolve) => {
      execFile("git", args, { cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ out: stdout ?? "", err: stderr ?? "", code: error ? 1 : 0 });
      });
    });

  // Branch switcher data: local branches, the current one, and the dirty
  // working-tree files with +/- stats (drives the commit/discard modal).
  ipcMain.handle("git:branches", async (_e, path: string) => {
    const br = await runGit(path, ["branch", "--format=%(refname:short)", "--sort=-committerdate"]);
    if (br.code !== 0) return { error: "Not a git repository", branches: [], current: "", dirty: [] };
    const cur = await runGit(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = await runGit(path, ["status", "--porcelain"]);
    const numstat = await runGit(path, ["diff", "HEAD", "--numstat"]);
    const stats = new Map<string, { plus: number; minus: number }>();
    for (const line of numstat.out.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (m) stats.set(m[3], { plus: m[1] === "-" ? 0 : Number(m[1]), minus: m[2] === "-" ? 0 : Number(m[2]) });
    }
    const dirty = status.out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const raw = l.slice(3).trim();
        const file = raw.includes(" -> ") ? raw.split(" -> ")[1] : raw;
        const st = stats.get(file);
        return { file, plus: st?.plus ?? 0, minus: st?.minus ?? 0 };
      });
    return { branches: br.out.split("\n").filter(Boolean), current: cur.out.trim(), dirty };
  });

  ipcMain.handle("git:checkout", async (_e, p: { path: string; branch: string; create?: boolean }) => {
    const r = await runGit(p.path, p.create ? ["checkout", "-b", p.branch] : ["checkout", p.branch]);
    return r.code === 0 ? { ok: true } : { ok: false, error: r.err.trim() || "Checkout failed" };
  });

  ipcMain.handle("git:commit-all", async (_e, p: { path: string; message: string }) => {
    const add = await runGit(p.path, ["add", "-A"]);
    if (add.code !== 0) return { ok: false, error: add.err.trim() };
    const commit = await runGit(p.path, ["commit", "-m", p.message]);
    return commit.code === 0
      ? { ok: true }
      : { ok: false, error: commit.err.trim() || commit.out.trim() || "Commit failed" };
  });

  // ---- Review pane: structured diffs + commit/push/PR actions ----

  type ReviewLine = { t: "a" | "d" | "c"; no: number; text: string };
  type ReviewHunk = { newStart: number; lines: ReviewLine[] };
  type ReviewFile = { path: string; plus: number; minus: number; hunks: ReviewHunk[] };

  function parseUnifiedDiff(text: string): ReviewFile[] {
    const files: ReviewFile[] = [];
    let cur: ReviewFile | null = null;
    let hunk: ReviewHunk | null = null;
    let pendingOld = "";
    let oldNo = 0;
    let newNo = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("diff --git")) {
        cur = null;
        hunk = null;
        continue;
      }
      if (line.startsWith("--- ")) {
        pendingOld = line.slice(4).replace(/^a\//, "");
        continue;
      }
      if (line.startsWith("+++ ")) {
        const p = line.slice(4).replace(/^b\//, "");
        cur = { path: p === "/dev/null" ? pendingOld : p, plus: 0, minus: 0, hunks: [] };
        files.push(cur);
        hunk = null;
        continue;
      }
      if (!cur) continue;
      if (line.startsWith("@@")) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (!m) continue;
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
        hunk = { newStart: newNo, lines: [] };
        cur.hunks.push(hunk);
        continue;
      }
      if (!hunk) continue;
      if (line.startsWith("+")) {
        hunk.lines.push({ t: "a", no: newNo++, text: line.slice(1) });
        cur.plus++;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ t: "d", no: oldNo++, text: line.slice(1) });
        cur.minus++;
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file" — not content
      } else {
        hunk.lines.push({ t: "c", no: newNo, text: line.slice(1) });
        oldNo++;
        newNo++;
      }
    }
    return files;
  }

  // Structured diff: "branch" = merge-base(origin main-ish)→working tree
  // (committed + uncommitted, like Codex's Branch view); "working" = HEAD→
  // working tree. Untracked files are synthesized as all-added.
  ipcMain.handle("review:diff", async (_e, p: { path: string; mode: "branch" | "working" }) => {
    const branch = (await runGit(p.path, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
    let baseLabel = "Working Tree";
    let diffArgs = ["diff", "HEAD"];
    if (p.mode === "branch") {
      let base = "";
      for (const ref of ["origin/main", "origin/master", "main", "master"]) {
        const mb = await runGit(p.path, ["merge-base", "HEAD", ref]);
        if (mb.code === 0 && mb.out.trim()) {
          base = mb.out.trim();
          baseLabel = ref;
          break;
        }
      }
      if (!base) return { error: "No base branch found (origin/main, main, …)", files: [], plus: 0, minus: 0, branch, baseLabel: "" };
      diffArgs = ["diff", base];
    }
    const diff = await runGit(p.path, diffArgs);
    if (diff.code !== 0) return { error: diff.err.trim() || "diff failed", files: [], plus: 0, minus: 0, branch, baseLabel };
    const files = parseUnifiedDiff(diff.out);
    // Untracked files appear in neither diff — synthesize them.
    const status = await runGit(p.path, ["status", "--porcelain"]);
    for (const line of status.out.split("\n")) {
      if (!line.startsWith("?? ")) continue;
      const rel = line.slice(3).trim();
      if (rel.endsWith("/")) continue;
      try {
        const content = readFileSync(join(p.path, rel), "utf8");
        if (content.includes("\u0000") || content.length > 400_000) continue;
        const lines = content.split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        files.push({
          path: rel,
          plus: lines.length,
          minus: 0,
          hunks: [{ newStart: 1, lines: lines.map((text, i) => ({ t: "a" as const, no: i + 1, text })) }],
        });
      } catch {
        // unreadable — skip
      }
    }
    const plus = files.reduce((n, f) => n + f.plus, 0);
    const minus = files.reduce((n, f) => n + f.minus, 0);
    return { files, plus, minus, branch, baseLabel };
  });

  ipcMain.handle("review:commit-push", async (_e, path: string) => {
    const status = await runGit(path, ["status", "--porcelain"]);
    if (status.out.trim()) {
      const add = await runGit(path, ["add", "-A"]);
      if (add.code !== 0) return { ok: false, error: add.err.trim() };
      const commit = await runGit(path, ["commit", "-m", "Changes from Unbiased"]);
      if (commit.code !== 0) return { ok: false, error: commit.err.trim() || commit.out.trim() };
    }
    const push = await runGit(path, ["push", "-u", "origin", "HEAD"]);
    return push.code === 0 ? { ok: true } : { ok: false, error: push.err.trim() || "push failed" };
  });

  ipcMain.handle("review:create-pr", (_e, path: string) => {
    return new Promise((resolve) => {
      execFile("gh", ["pr", "create", "--fill", "--web"], { cwd: path, timeout: 60000 }, (err, _o, stderr) => {
        resolve(err ? { ok: false, error: (stderr ?? "").trim() || "gh pr create failed (is GitHub CLI installed?)" } : { ok: true });
      });
    });
  });

  // Destructive by design — only reachable through the modal that lists
  // exactly which files will be lost.
  ipcMain.handle("git:discard", async (_e, path: string) => {
    const reset = await runGit(path, ["reset", "--hard"]);
    if (reset.code !== 0) return { ok: false, error: reset.err.trim() };
    const clean = await runGit(path, ["clean", "-fd"]);
    return clean.code === 0 ? { ok: true } : { ok: false, error: clean.err.trim() };
  });

  // Line blame for the file viewer (GitLens-style hints). Porcelain output
  // gives hash/author/time/summary; the commit URL derives from the repo's
  // origin remote (ssh remotes normalized to https).
  ipcMain.handle("git:blame-line", async (_e, p: { file: string; line: number }) => {
    const dir = p.file.split("/").slice(0, -1).join("/") || "/";
    const run = (args: string[]) =>
      new Promise<string>((resolve) => {
        execFile("git", args, { cwd: dir, timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout));
      });
    const out = await run(["blame", "-L", `${p.line},${p.line}`, "--porcelain", "--", p.file]);
    if (!out) return { error: "No blame information" };
    const hash = out.split(/\s/)[0] ?? "";
    const field = (key: string) =>
      out
        .split("\n")
        .find((l) => l.startsWith(key + " "))
        ?.slice(key.length + 1) ?? "";
    const uncommitted = /^0+$/.test(hash);
    let url: string | null = null;
    if (!uncommitted) {
      let remote = (await run(["config", "--get", "remote.origin.url"])).trim().replace(/\.git$/, "");
      const ssh = /^git@([^:]+):(.+)$/.exec(remote);
      if (ssh) remote = `https://${ssh[1]}/${ssh[2]}`;
      if (/^https?:/.test(remote)) url = `${remote}/commit/${hash}`;
    }
    return {
      hash,
      author: field("author"),
      time: Number(field("author-time")) * 1000,
      summary: field("summary"),
      uncommitted,
      url,
    };
  });

  // "Open in external browser" from the browser toolbar.
  ipcMain.handle("browser:open-external", (_e, url: string) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { ok: true };
  });

  // Whole-word references search across the active project — the engine
  // behind ⌘-click in the file viewer. Text-based (grep), not semantic:
  // works for every language, no language servers. execFile with an args
  // array means the symbol is never shell-interpreted.
  ipcMain.handle("fs:search-refs", (_e, word: string) => {
    const base = mainCwd ?? pendingCwd;
    if (!base || base === app.getPath("home")) {
      return { results: [], error: "References need a project conversation" };
    }
    if (!/^[\w$]{1,128}$/.test(word)) return { results: [], error: "Not a searchable symbol" };
    return new Promise((resolve) => {
      execFile(
        "grep",
        [
          "-rnIwF", // recursive, line numbers, skip binaries, whole word, literal
          "--exclude-dir=node_modules",
          "--exclude-dir=.git",
          "--exclude-dir=.claude", // worktrees duplicate the whole repo
          "--exclude-dir=dist",
          "--exclude-dir=out",
          "--exclude-dir=build",
          "--exclude-dir=.next",
          "--exclude-dir=target",
          word,
          base,
        ],
        { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 },
        (_err, stdout) => {
          // grep exits 1 on "no matches" — a result, not a failure.
          const lines = stdout ? stdout.split("\n").filter(Boolean) : [];
          const results = [];
          for (const ln of lines.slice(0, 200)) {
            const m = /^(.*?):(\d+):(.*)$/.exec(ln);
            if (!m) continue;
            results.push({
              path: m[1],
              rel: relative(base, m[1]),
              line: Number(m[2]),
              text: m[3].trim().slice(0, 200),
            });
          }
          resolve({ results, truncated: lines.length > 200 });
        },
      );
    });
  });

  // Full-size image as a data URL for the side panel's preview tab (the
  // renderer can't load file:// under its CSP; data: is allowed).
  ipcMain.handle("file:read-image", (_e, path: string) => {
    try {
      if (statSync(path).size > 15_000_000) return { error: "Image is larger than 15 MB" };
      const img = nativeImage.createFromPath(path);
      if (img.isEmpty()) return { error: "Could not read image" };
      return { dataUrl: img.toDataURL() };
    } catch {
      return { error: `Could not open ${path}` };
    }
  });

  // Site icons for source links in assistant markdown. Same shape as
  // file:read-image above and for the same reason: `img-src 'self' data:`
  // means the renderer cannot load a remote icon itself. Misses are cached as
  // null too, so a site without an icon is asked once per run.
  const FAVICON_CACHE_MAX = 256;
  const faviconCache = new Map<string, string | null>();
  ipcMain.handle("link:favicon", async (_e, rawHost: string) => {
    const host = faviconHostOrNull(String(rawHost ?? ""));
    if (!host) return { dataUrl: null };
    if (faviconCache.has(host)) return { dataUrl: faviconCache.get(host) ?? null };
    // /favicon.ico first, then /favicon.png. Sites served out of a bundler
    // increasingly ship only the PNG and point at it with <link rel="icon">,
    // which we deliberately don't fetch pages to read — learn.chatgpt.com is
    // one. The second guess costs a request only when the first one misses.
    const dataUrl = (await fetchIcon(host, "/favicon.ico")) ?? (await fetchIcon(host, "/favicon.png"));
    // Bounded: a long session citing many domains would otherwise hold every
    // icon it ever saw, and the renderer keeps its own copy of the same bytes.
    // Map iterates in insertion order, so the oldest entry goes first.
    if (faviconCache.size >= FAVICON_CACHE_MAX) {
      const oldest = faviconCache.keys().next().value;
      if (oldest !== undefined) faviconCache.delete(oldest);
    }
    faviconCache.set(host, dataUrl);
    return { dataUrl };
  });

  ipcMain.handle("clipboard:has-image", () => !clipboard.readImage().isEmpty());

  // A copied/pasted image lives in the native clipboard; persist it to a
  // temp PNG so it can ride the next turn as a localImage input item.
  ipcMain.handle("attach:clipboard-image", () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return { attachment: null };
    const dir = join(app.getPath("temp"), "unbiased-pastes");
    mkdirSync(dir, { recursive: true });
    const name = `pasted-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
    const path = join(dir, name);
    writeFileSync(path, image.toPNG());
    return { attachment: { name, path, kind: "image", thumb: thumbDataUrl(image) } };
  });

  ipcMain.handle("threads:delete", async (_e, id: string) => {
    // A running turn dies with its thread — stop it first so the engine
    // isn't left executing against a deleted conversation.
    const turnId = runningTurns.get(id);
    if (turnId) {
      try {
        await engine.request("turn/interrupt", { threadId: id, turnId });
      } catch {
        // the delete below is the outcome that matters
      }
    }
    // Sub-agents run in their own sessions: stop and forget them with
    // their parent, or they keep executing (and raising approvals) against
    // a deleted conversation.
    for (const [subId, info] of [...subAgents]) {
      if (info.parent !== id) continue;
      const subTurn = runningTurns.get(subId);
      if (subTurn) {
        try {
          await engine.request("turn/interrupt", { threadId: subId, turnId: subTurn });
        } catch {
          // best-effort — the sub may have just finished
        }
      }
      runningTurns.delete(subId);
      settleLocalApprovals(subId);
      subAgents.delete(subId);
      subAgentMail.delete(subId);
      heldApprovals.delete(subId);
      bgStream.delete(subId);
    }
    runningTurns.delete(id);
    settleLocalApprovals(id);
    browserNetGrants.delete(id);
    browserConnectGrants.delete(id);
    threadAccessModes.delete(id);
    bgStream.delete(id);
    heldApprovals.delete(id);
    heldErrors.delete(id);
    await engine.request("thread/delete", { threadId: id });
    try {
      rmSync(transcriptFile(id), { force: true });
    } catch {
      // cache cleanup is best-effort
    }
    if (panes.main.threadId === id) {
      panes.main.threadId = null;
      panes.main.turnId = null;
      resetSidePanes();
    }
    return { ok: true };
  });

  createWindow();
  // Check for updates shortly after launch (let the window settle first),
  // then on a slow timer — a desktop app can stay open for days.
  // Before the first check, so a bundle staged by a previous run is offered
  // as "restart" instead of being downloaded all over again.
  recoverStagedUpdate();
  if (stagedUpdate) {
    send("update:available", { version: stagedUpdate.version, dmgUrl: "", sumsUrl: null });
    send("update:staged", { version: stagedUpdate.version });
  }
  setTimeout(() => void checkForUpdate(), 8000);
  setInterval(() => void checkForUpdate(), UPDATE_INTERVAL_MS);
  // The engine no longer auto-starts: the renderer's login gate decides
  // whether to sign in (a stored key + remembered session) or prompt first,
  // then calls auth:login, which validates and starts the engine.
});

app.on("window-all-closed", () => {
  for (const pty of ptys.values()) pty.kill();
  ptys.clear();
  engine.stop();
  // The agent browser's daemon outlives us otherwise — close every session.
  const bin = agentBrowserBinCache;
  if (bin && !browserAttachedExternal) execFile(bin, ["close", "--all"], () => {});
  // Our own Chrome goes with us; its profile (and logins) persist on disk.
  managedChrome?.kill();
  app.quit();
});
