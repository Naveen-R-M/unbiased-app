import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  WebContentsView,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type { NativeImage } from "electron";
import { dirname, isAbsolute, join, relative } from "node:path";
import { homedir, hostname } from "node:os";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { startSecretProxy, type SecretConnector } from "./oauth-proxy";
import {
  CATALOGUE_CACHE_VERSION,
  fetchCatalogueFromAnyHost,
  parseCatalogue,
  type Catalogue,
  type CatalogueEntry,
} from "./connector-catalogue";
import type { Server as HttpServer } from "node:http";
import { execFile, execFileSync, spawn as spawnProcess } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { get as httpGet } from "node:http";
import { EngineClient, engineVersionFromUserAgent, type EngineStatus } from "./engine";
import { pollDeviceToken, requestDeviceAuthorization } from "./device-auth";
import {
  dueAt,
  isDue,
  loadTasks,
  MAX_NAME_CHARS,
  MAX_PROMPT_CHARS,
  MAX_TASKS,
  parseRunVerdict,
  saveTasks,
  validateSchedule,
  VERDICT_CONTRACT,
  type RunStatus,
  type ScheduledTask,
  type ScheduleSpec,
} from "./scheduler";
import {
  deleteMemoryNote,
  loadMemoryNotes,
  projectMemoryDir,
  renderMemorySection,
  saveMemoryNote,
  validateMemory,
} from "./memory";
import {
  LearningClient,
  buildEvent,
  buildTaskMeta,
  readSidecarManifest,
  resolveSidecarDir,
  sidecarLooksInstalled,
} from "./learning";
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

/**
 * Is the browser already listening on `port` one WE started?
 *
 * This distinction used to be guessed from `launched`: anything already
 * listening was treated as the user's own browser. That is wrong after an
 * unclean exit — our own managed Chrome outlives the app (window-all-closed
 * never runs on SIGTERM), so the next launch adopted its own browser while
 * believing it belonged to the user, which suppressed the mirror pane and
 * made resetting a stale tab unsafe.
 *
 * Ownership is decided by the profile directory on the listening process's
 * command line: only our Chrome runs with `agentChromeProfile()`. Wrong-way
 * failures are safe — an unreadable answer means "not ours", which only ever
 * makes us more conservative.
 */
function ownsChromeOnPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 4000 }, (err, pids) => {
      const pid = String(pids ?? "").trim().split(/\s+/).filter(Boolean)[0];
      if (err || !pid) return resolve(false);
      execFile("ps", ["-p", pid, "-o", "command="], { timeout: 4000, maxBuffer: 1_000_000 }, (err2, cmd) => {
        if (err2) return resolve(false);
        resolve(String(cmd).includes(`--user-data-dir=${agentChromeProfile()}`));
      });
    });
  });
}

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
  // Windowless by default: the Agent browser side tab IS the window, so a
  // second Chrome on the desktop is just clutter. The tab streams frames and
  // forwards clicks/typing, so sign-ins happen there too.
  //
  // Escape hatch: some sites refuse headless clients outright (bot checks,
  // certain Google sign-in flows). UNBIASED_AGENT_CHROME_HEADED=1 restores the
  // real window for those cases without a rebuild.
  const headed = process.env.UNBIASED_AGENT_CHROME_HEADED === "1";
  managedChrome = spawnProcess(
    bin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...(headed
        ? // A covered window gets its rendering throttled, which stalls
          // Page.startScreencast — the mirror must keep working behind the app.
          ["--disable-backgrounding-occluded-windows"]
        : ["--headless=new"]),
      // Headless defaults to 800x600, which makes desktop sites render their
      // narrow layout. Give pages a normal viewport to lay out in.
      "--window-size=1440,900",
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
    if (await cdpAlive(port)) {
      // Our Chrome is up — same signal the per-tool path sends, so the pane
      // appears on a cold start too, before the first tool returns.
      send("agentmirror:activity", { tool: "launch" });
      return { ok: true, launched: true, firstRun };
    }
  }
  return { ok: false, launched: true, firstRun, error: `Chrome started but never opened port ${port}.` };
}

// Set when attached to a browser WE DID NOT LAUNCH: closing it would take
// down tabs that are not ours. A browser this app started is ours to close.
let browserAttachedExternal = false;

// Whether the agent-browser CLI's session is bound to our Chrome yet.
//
// This is the fix for the two-browsers bug. `runAgentBrowser` passes no
// --cdp/--session/--profile, so the CLI uses its own "default" session — and
// an unbound default session launches its OWN Chrome in a throwaway temp
// profile. Only browser_connect ever called ensureAgentChrome, so every other
// tool (open, search, snapshot…) drove that temp browser while the Agent
// browser pane mirrored port 9222 and showed a Chrome nobody was driving.
// Binding once, before the first tool that needs a page, makes the pane and
// the agent the same browser by construction.
let browserSessionBound = false;

/**
 * Make sure the CLI is attached to a browser we can also mirror.
 * Returns null on success, or the message to hand back to the model.
 */
async function ensureBrowserSession(): Promise<string | null> {
  // A browser the user pointed us at is already attached and is not ours to
  // re-target; leave it exactly as it is.
  if (browserSessionBound || browserAttachedExternal) return null;
  const ready = await ensureAgentChrome(AGENT_CHROME_PORT);
  if (!ready.ok) {
    return (
      `Could not start a browser session: ${ready.error ?? "unknown error"}. ` +
      "Use browser_search and public pages instead."
    );
  }
  // Already listening and not ours: the user's own debuggable browser. Adopt
  // it, but mark it external so we never close it or mirror it uninvited.
  if (!ready.launched && !(await ownsChromeOnPort(AGENT_CHROME_PORT))) {
    browserAttachedExternal = true;
  }
  const r = await runAgentBrowser(["connect", String(AGENT_CHROME_PORT)], 30_000);
  // `connect` exits 0 even when discovery fails, so read the output.
  if (!r.ok || /✗|failed|refused/i.test(r.out)) {
    return `Could not attach to a browser on port ${AGENT_CHROME_PORT}: ${r.out || "no detail"}`;
  }
  browserSessionBound = true;
  // A Chrome of OURS that we did not just launch is a leftover from a previous
  // run, still parked on whatever it was last doing. Blank it, so the pane
  // opens on this session's work instead of presenting a stale page as the
  // agent's view. Never done to a browser that is not ours.
  if (!ready.launched && !browserAttachedExternal) {
    await runAgentBrowser(["open", "about:blank"], 20_000);
  }
  return null;
}

/**
 * One browser tab per conversation.
 *
 * The session stays single and shared — that is deliberate, and it is what
 * keeps the user's signed-in state working: an `--session` per chat would mean
 * a separate Chrome with a separate profile, so every conversation would have
 * to log in to X again, and the mirror would have no single port to watch.
 * What was missing is the dimension below it. Two chats browsing at once both
 * drove the one page: an open in one moved the page out from under the other,
 * and a snapshot could return someone else's site.
 *
 * Keyed by the ROOT conversation, so a side chat and its sub-agents share the
 * tab of the conversation they belong to rather than each spawning their own.
 */
const browserTabs = new Map<string, { label: string; targetId: string | null }>();

// Whose tab is currently ACTIVE in the CLI session. Selection is skipped when
// it would be a no-op, and that is not an optimisation: `tab <label>` — even
// re-selecting the tab that is already active — invalidates every ref the
// last snapshot handed out. Measured: snapshot → tab <same> → click @ref
// fails "Unknown ref"; snapshot → click works. Selecting before every call
// therefore broke every snapshot-then-act sequence, which is the normal
// shape of browser work. Only our own selections change the active tab (the
// agent has no tab tools and the mirror binds by target id), so this tracker
// cannot go stale.
let browserActiveRoot: string | null = null;

/** A tab label is passed to the CLI as a ref, so it has to be a bare token.
 *  Hashed rather than truncated: thread ids share long prefixes, and two
 *  conversations colliding on a label would silently share a tab — the exact
 *  bug this exists to fix. */
function browserTabLabel(rootId: string): string {
  return `chat-${createHash("sha256").update(rootId).digest("hex").slice(0, 10)}`;
}

/**
 * Serialize browser work across conversations.
 *
 * Selecting a tab is STATEFUL — the CLI has no per-command tab flag, and each
 * session simply remembers its active tab. So "select, then act" has to be
 * atomic: without this, chat A selects, chat B selects, and A's command lands
 * on B's page. The lock spans a whole tool call rather than a single command,
 * because browser_search is an open/wait/eval/read sequence that must stay on
 * one tab throughout.
 */
let browserOpChain: Promise<unknown> = Promise.resolve();
function withBrowserLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chained on settle, not on success: one failed call must not wedge the
  // queue for every conversation after it.
  const run = browserOpChain.then(fn, fn);
  browserOpChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Learn a labelled tab's CDP target id, so the mirror can follow that exact
 *  tab instead of guessing from URLs. */
async function browserTabTargetId(label: string): Promise<string | null> {
  const r = await runAgentBrowser(["tab", "list", "--json"]);
  try {
    const parsed = JSON.parse(r.out) as { data?: { tabs?: { label?: string | null; targetId?: string }[] } };
    const hit = (parsed.data?.tabs ?? []).find((t) => t.label === label);
    return typeof hit?.targetId === "string" ? hit.targetId : null;
  } catch {
    return null;
  }
}

/** Give this conversation its own tab and make it the active one. Returns null
 *  on success, or the message to hand back to the model. */
async function selectConversationTab(rootId: string): Promise<string | null> {
  const label = browserTabLabel(rootId);
  let entry = browserTabs.get(rootId);
  // Same conversation as the last browser call: the tab is already active,
  // and re-selecting it would throw away the refs its latest snapshot issued.
  // "Active" here includes a popup the page itself opened — the CLI follows
  // those (measured), and the conversation's work moves with it.
  if (entry && browserActiveRoot === rootId) return null;
  if (!entry) {
    const made = await runAgentBrowser(["tab", "new", "--label", label, "about:blank"], 30_000);
    if (!made.ok) return `Could not open a browser tab for this conversation: ${made.out}`;
    entry = { label, targetId: null };
    browserTabs.set(rootId, entry);
  }
  // Selected explicitly, including right after creating it. `tab new` almost
  // certainly activates what it opened, but "almost certainly" is not good
  // enough here: if it ever does not, the command that follows lands on
  // another conversation's page, which is the whole class of bug this exists
  // to prevent.
  // Select by CDP target id when one is known, falling back to the label.
  // The label marks the tab this conversation STARTED in; the target id
  // tracks where its work actually lives now — a click that opened the
  // workspace in a popup moves the work there, and re-selecting the labelled
  // tab would strand the agent back on the page it already left.
  const sel = await runAgentBrowser(["tab", entry.targetId ?? label]);
  if (!sel.ok || /tab_gone|not found/i.test(sel.out)) {
    // Closed underneath us — by the user, or by a crash. Make a fresh one
    // rather than let the CLI fall back to whatever tab is active.
    const made = await runAgentBrowser(["tab", "new", "--label", label, "about:blank"], 30_000);
    if (!made.ok) return `Could not reopen this conversation's browser tab: ${made.out}`;
    entry.targetId = null;
    const again = await runAgentBrowser(["tab", label]);
    if (!again.ok) return `Could not select this conversation's browser tab: ${again.out}`;
  }
  browserActiveRoot = rootId;
  if (!entry.targetId) entry.targetId = await browserTabTargetId(label);
  return null;
}

// ── Agent-browser mirror ─────────────────────────────────────────────
// Shows the agent's Chrome inside the side panel: a minimal CDP client on the
// same 127.0.0.1 port agent-browser drives. Frames come from
// Page.startScreencast and cross IPC as data URLs (the renderer's CSP forbids
// remote images); input goes back through Input.* — the renderer sends only
// normalized {kind,...} shapes and the mapping to CDP methods lives HERE, so
// a compromised renderer cannot name arbitrary protocol methods.
let mirrorWs: WebSocket | null = null;
// Supervisor state. The pane can be opened before Chrome exists, the agent can
// close and reopen tabs, and a target can be destroyed mid-session — a single
// attach attempt loses in all three cases, so "wanting" the mirror is a
// standing intent that a timer keeps trying to satisfy.
let mirrorDesired = false;
let mirrorSize = { width: 800, height: 600, dpr: 1 };
let mirrorTargetId: string | null = null;
// The last page the agent asked for. /json/list is not ordered by what the
// agent is doing — a stray chrome://settings tab sorted ahead of the real work
// and the pane mirrored the wrong tab — so the agent's own navigation is the
// authority on which tab to watch.
let mirrorPreferredUrl: string | null = null;
// The conversation the pane is SHOWING — not the one that happens to be
// acting. Those are different, and conflating them is what put one chat's X
// feed in another chat's pane: every browser tool call was overwriting a
// global "preferred target", so whichever conversation browsed last won the
// pane regardless of which chat the user had open.
//
// Stored as the conversation, resolved to a tab at tick time rather than once
// at start: a chat that has not browsed yet has no tab, and its tab must be
// picked up the moment it is created.
let mirrorViewRoot: string | null = null;
// Dimensions of the last frame Chrome sent, in page CSS pixels. Compared each
// tick against the shape we asked for: if they drift — a dropped resize, or
// another CDP client changing emulation — the mirror re-imposes its viewport
// instead of letterboxing until someone drags the pane.
/** Set when the connector IPC is wired; a no-op before then, because the
 *  engine can start before that scope exists. */
let refreshCatalogueAtStartup: () => void = () => {};

let mirrorLastFrame: { width: number; height: number } | null = null;
/** The viewport WE last imposed. Frames are compared against this rather than
 *  against a freshly computed one, so a correction in flight is not mistaken
 *  for a second problem. */
let mirrorWantVp: { width: number; height: number } | null = null;
let mirrorMismatchSince = 0;
let mirrorCorrectAt = 0;
let mirrorCorrecting = false;
/** How long a wrong-shaped frame may be withheld while a correction lands.
 *  Past this the pane shows it anyway: a briefly odd mirror beats a frozen
 *  one, and if the correction cannot succeed the user should see reality. */
const MIRROR_SHAPE_GRACE_MS = 2_000;

type CdpTarget = { id?: string; type: string; url: string; title?: string; webSocketDebuggerUrl?: string };

function originOf(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/** Which tab to mirror, most specific signal first. Deterministic for a given
 *  list, so the supervisor cannot flap between two candidates. */
function pickMirrorTarget(targets: CdpTarget[]): CdpTarget | null {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const web = pages.filter((t) => t.url.startsWith("http://") || t.url.startsWith("https://"));
  // A conversation owns exactly one tab, so when the pane is showing a
  // conversation there is exactly one right answer — and if that tab does not
  // exist yet, the right answer is NOTHING. The heuristics below used to be
  // correct when every chat shared one page; with a tab each they actively
  // mislead, because "any real web page" is now quite likely to be a
  // different conversation's.
  const viewTab = mirrorViewRoot ? browserTabs.get(mirrorViewRoot)?.targetId : null;
  if (mirrorViewRoot) return (viewTab ? pages.find((t) => t.id === viewTab) : undefined) ?? null;
  const want = mirrorPreferredUrl;
  const wantOrigin = want ? originOf(want) : null;
  return (
    (want ? web.find((t) => t.url === want) : undefined) ??
    (wantOrigin ? web.find((t) => originOf(t.url) === wantOrigin) : undefined) ??
    // Any real web page beats chrome://, devtools://, about: — the agent reads
    // the web, and those are never the work.
    web[0] ??
    pages.find((t) => t.url && t.url !== "about:blank") ??
    pages[0] ??
    null
  );
}
let mirrorTimer: NodeJS.Timeout | null = null;
let mirrorAttaching = false;
let mirrorMsgId = 0;
const mirrorPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function mirrorCall(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const ws = mirrorWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("mirror not connected"));
  const id = ++mirrorMsgId;
  ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  return new Promise((resolve, reject) => {
    mirrorPending.set(id, { resolve, reject });
    setTimeout(() => {
      if (mirrorPending.delete(id)) reject(new Error(`CDP ${method} timed out`));
    }, 10_000).unref?.();
  });
}

/** Make the PAGE's viewport match the pane's shape, so the mirror fills the
 *  tab like a real browser instead of letterboxing a fixed 1440x900 window
 *  into it. Width is floored at a desktop size: the pane can be narrow, and a
 *  700px-wide viewport makes sites serve their mobile layout — which the agent
 *  would then be reading too. Above that floor the page simply renders larger
 *  and scales down, exactly like zooming out. */
function mirrorViewport(paneW: number, paneH: number): { width: number; height: number } {
  const width = Math.max(1024, Math.round(paneW) || 1024);
  const ratio = paneW > 0 && paneH > 0 ? paneH / paneW : 0.75;
  const height = Math.min(4096, Math.max(400, Math.round(width * ratio)));
  return { width, height };
}

/** Capture at the density the pane is actually PAINTED at. The frame is drawn
 *  into paneW*dpr physical pixels, so a deviceScaleFactor of 1 means Chrome
 *  hands us a 1024px-wide image that gets stretched across ~1490 real pixels —
 *  visibly soft text. Scale so the frame carries one image pixel per physical
 *  pixel, and no more: past that it is bytes nobody can see. */
async function mirrorApplyViewport(
  paneW: number,
  paneH: number,
  dpr: number,
): Promise<{ width: number; height: number; scale: number }> {
  const vp = mirrorViewport(paneW, paneH);
  const wanted = Math.max(1, paneW) * (dpr > 0 ? dpr : 1);
  const scale = Math.min(2, Math.max(1, wanted / vp.width));
  await mirrorCall("Emulation.setDeviceMetricsOverride", {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: scale,
    mobile: false,
  });
  mirrorWantVp = { width: vp.width, height: vp.height };
  return { ...vp, scale };
}

/** Is this frame shaped like the viewport we asked for? */
function mirrorShapeWrong(got: { width: number; height: number } | null): boolean {
  if (!got || !mirrorWantVp) return false;
  return Math.abs(got.width - mirrorWantVp.width) > 2 || Math.abs(got.height - mirrorWantVp.height) > 2;
}

/**
 * Re-impose our viewport on the mirrored tab.
 *
 * Something else changes it out from under us: the agent-browser CLI drives
 * the same tab and sets its own metrics for snapshots, and Chrome drops an
 * override on some navigations. The old code only noticed on the 1.5s
 * supervisor tick, which is precisely the "resizes for a moment" the pane
 * showed. Called from the frame handler now, so a stray shape is corrected on
 * the very next frame, with a cooldown so a burst of odd frames cannot turn
 * into a burst of overrides (each of which would itself cause a reflow).
 */
async function mirrorCorrectViewport(): Promise<void> {
  if (mirrorCorrecting || !mirrorWs) return;
  const now = Date.now();
  if (now - mirrorCorrectAt < 600) return;
  mirrorCorrecting = true;
  mirrorCorrectAt = now;
  try {
    const vp = await mirrorApplyViewport(mirrorSize.width, mirrorSize.height, mirrorSize.dpr);
    await mirrorCall("Page.startScreencast", {
      format: "jpeg",
      quality: 85,
      ...mirrorFrameBounds(vp),
      everyNthFrame: 1,
    });
  } catch {
    /* the supervisor tick retries */
  } finally {
    mirrorCorrecting = false;
  }
}

/** Screencast bounds in the SAME pixels the frame is rendered in. */
function mirrorFrameBounds(vp: { width: number; height: number; scale: number }) {
  return {
    maxWidth: Math.min(3200, Math.round(vp.width * vp.scale)),
    maxHeight: Math.min(3200, Math.round(vp.height * vp.scale)),
  };
}

function mirrorTeardown(notify: boolean): void {
  mirrorLastFrame = null;
  mirrorWantVp = null;
  mirrorMismatchSince = 0;
  const ws = mirrorWs;
  // Hand the tab back at its natural size — the agent keeps using it after the
  // pane closes, and leaving our pane's shape imposed on it would be rude.
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ id: ++mirrorMsgId, method: "Emulation.clearDeviceMetricsOverride", params: {} }));
    } catch {
      /* closing anyway */
    }
  }
  mirrorWs = null;
  for (const p of mirrorPending.values()) p.reject(new Error("mirror closed"));
  mirrorPending.clear();
  try {
    ws?.close();
  } catch {
    /* already gone */
  }
  if (notify) send("agentmirror:state", { connected: false });
}

/** Attach to the most recently active page tab and start streaming frames.
 *  maxWidth/maxHeight bound the JPEG Chrome renders — the pane's size, so a
 *  small pane never pays for 4K frames. */
async function mirrorStart(maxWidth: number, maxHeight: number): Promise<{ ok: boolean; error?: string }> {
  mirrorTeardown(false);
  try {
    const res = await fetch(`http://127.0.0.1:${AGENT_CHROME_PORT}/json/list`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { ok: false, error: `CDP list failed (${res.status})` };
    const targets = (await res.json()) as CdpTarget[];
    const page = pickMirrorTarget(targets);
    if (!page) {
      // Two different situations, and telling the user "the browser is not
      // open" for the second one is simply false — the browser is open, this
      // conversation just has no tab in it yet.
      const hasPages = targets.some((t) => t.type === "page");
      send("agentmirror:state", { connected: false, reason: hasPages ? "no-tab" : "no-browser" });
      return { ok: false, error: hasPages ? "this conversation has no browser tab yet" : "no page tab to mirror" };
    }
    mirrorTargetId = page.id ?? null;

    const ws = new WebSocket(page.webSocketDebuggerUrl!);
    mirrorWs = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("CDP socket failed to open"));
    });
    ws.onclose = () => {
      if (mirrorWs === ws) mirrorTeardown(true);
    };
    ws.onmessage = (ev) => {
      let msg: { id?: number; method?: string; result?: unknown; error?: { message?: string }; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const p = mirrorPending.get(msg.id);
        if (p) {
          mirrorPending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
          else p.resolve(msg.result);
        }
        return;
      }
      if (msg.method === "Page.screencastFrame" && msg.params) {
        const { data, metadata, sessionId } = msg.params as {
          data: string;
          metadata: { deviceWidth: number; deviceHeight: number };
          sessionId: number;
        };
        // Ack immediately or Chrome stops sending after a handful of frames.
        void mirrorCall("Page.screencastFrameAck", { sessionId }).catch(() => {});
        mirrorLastFrame = { width: metadata.deviceWidth, height: metadata.deviceHeight };
        if (mirrorShapeWrong(mirrorLastFrame)) {
          if (!mirrorMismatchSince) mirrorMismatchSince = Date.now();
          void mirrorCorrectViewport();
          // Withhold the transitional frame: the renderer sizes the image from
          // these dimensions, so forwarding one is what makes the pane visibly
          // jump. The previous good frame stays on screen instead.
          if (Date.now() - mirrorMismatchSince < MIRROR_SHAPE_GRACE_MS) return;
        } else {
          mirrorMismatchSince = 0;
        }
        send("agentmirror:frame", {
          src: `data:image/jpeg;base64,${data}`,
          width: metadata.deviceWidth,
          height: metadata.deviceHeight,
        });
      } else if (msg.method === "Page.frameNavigated" && msg.params) {
        const frame = (msg.params as { frame?: { parentId?: string; url?: string } }).frame;
        if (frame && !frame.parentId) send("agentmirror:state", { connected: true, url: frame.url ?? "" });
      }
    };

    await mirrorCall("Page.enable");
    // A background tab is not painted, so the screencast emits NOTHING — the
    // pane sat on "Waiting for the first frame…" forever while the agent
    // worked in a tab Chrome had parked. Measured: 0 frames hidden, 7 in 2.5s
    // after this call. Both are best-effort: neither is worth failing on.
    await mirrorCall("Page.bringToFront").catch(() => {});
    await mirrorCall("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
    const vp = await mirrorApplyViewport(maxWidth, maxHeight, mirrorSize.dpr);
    await mirrorCall("Page.startScreencast", {
      format: "jpeg",
      // 60 was visibly lossy on text; 85 is near-transparent for UI
      // screenshots and still a fraction of PNG.
      quality: 85,
      ...mirrorFrameBounds(vp),
      everyNthFrame: 1,
    });
    send("agentmirror:state", { connected: true, url: page.url, title: page.title });
    return { ok: true };
  } catch (err) {
    mirrorTeardown(false);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Modifier bitmask (alt 1, ctrl 2, meta 4, shift 8) is computed renderer-side
// from the DOM event and passed through verbatim.
type MirrorInput =
  | { kind: "mouse"; type: "mousePressed" | "mouseReleased" | "mouseMoved"; x: number; y: number; button: "left" | "middle" | "right" | "none"; clickCount: number; modifiers: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { kind: "text"; text: string }
  | { kind: "key"; type: "rawKeyDown" | "keyUp"; key: string; code: string; keyCode: number; modifiers: number; text?: string };

async function mirrorInput(ev: MirrorInput): Promise<void> {
  if (ev.kind === "mouse") {
    await mirrorCall("Input.dispatchMouseEvent", {
      type: ev.type,
      x: ev.x,
      y: ev.y,
      button: ev.button,
      clickCount: ev.clickCount,
      modifiers: ev.modifiers,
    });
  } else if (ev.kind === "wheel") {
    await mirrorCall("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: ev.x,
      y: ev.y,
      deltaX: ev.deltaX,
      deltaY: ev.deltaY,
      modifiers: ev.modifiers,
    });
  } else if (ev.kind === "text") {
    // insertText types verbatim into the focused element and needs no key
    // mapping — the reliable path for printable characters.
    await mirrorCall("Input.insertText", { text: ev.text.slice(0, 1024) });
  } else {
    await mirrorCall("Input.dispatchKeyEvent", {
      type: ev.type,
      key: ev.key,
      code: ev.code,
      windowsVirtualKeyCode: ev.keyCode,
      nativeVirtualKeyCode: ev.keyCode,
      modifiers: ev.modifiers,
      ...(ev.text !== undefined ? { text: ev.text, unmodifiedText: ev.text } : {}),
    });
  }
}

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
  if (!agentBrowserBinCache) {
    // Said once, loudly. Until now this returned null and agentBrowserTools()
    // quietly declared nothing, so a machine without the CLI was
    // indistinguishable from a model that ignored its browser — the whole
    // capability vanished with no log line anywhere to say why.
    console.warn(
      "[browser] agent-browser not found — the browser_* tools will NOT be offered to the model.\n" +
        `[browser] looked in: ${candidates.slice(0, 6).join(", ")}\n` +
        "[browser] install it (e.g. `brew install agent-browser`) and restart the app.",
    );
  }
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
  // Engine errors leak the engine. codex's not-logged-in error for an MCP
  // server ends `Run \`codex mcp login <name>\``, and with nothing said here
  // the model relayed it verbatim — a CLI this product does not ship, pointed
  // at a CODEX_HOME it does not use. Observed live on a HoneyComb server the
  // user had added. The instruction has to name the real affordance, because
  // "do not say that" with no replacement just leaves the user stuck.
  "This app runs on a modified engine, and some of its errors name tools that are not part of this",
  "product. Never pass those on. In particular, if an MCP server reports that it is not logged in,",
  "do NOT repeat any `codex ...` command: signing in lives in the app, under Settings then MCP",
  "servers, where that server now shows a Sign in button. Say that instead. The same applies to any",
  "other command an engine error suggests — describe what the user should do in Unbiased, and if",
  "there is no way to do it in the app, say so plainly rather than inventing one.",
  // The browser. Same reasoning as delegation below, and the same fix: the
  // browser_* tools were declared on every turn but never mentioned here, so
  // asked to do something on the web the model would answer "I have no browser
  // automation capability" and reach for the shell instead — running the
  // agent-browser CLI itself, in its own session and its own signed-out temp
  // profile, outside every gate and invisible to the Agent browser pane.
  // Naming the capability is what stops that.
  "You have a real browser: the browser_* tools drive a Chrome this app manages, and the user watches it",
  "in the app's Agent browser tab. Reach for it on your own initiative whenever a task involves the web —",
  "browser_search for anything public, and browser_connect FIRST for anything behind the user's own login",
  "(their Slack, email, dashboards, admin panels). Never shell out to `agent-browser`, curl, or any other",
  "command to browse: those run outside the app's permission and mirroring, so the user cannot see or",
  "approve them. If a browser tool is genuinely absent from your tools, say the Agent browser is",
  "unavailable rather than substituting a shell command for it.",
  // Delegation. The collaboration tools are available on every turn, but models
  // rarely reach for them unprompted — Claude Code and codex get "automatic"
  // sub-agents purely by saying when to delegate, so this does the same. The
  // retry rule below is not hypothetical: re-briefing a failed agent in-thread
  // stacks instruction blocks into a growing context until it cannot succeed
  // (the Euler failure, 2026-08-21). Keep spawning model-initiated — never
  // tell the user they must ask for agents.
  "Use sub-agents (spawn_agent) on your own initiative when work splits into independent,",
  "parallelizable pieces: exploring several modules or directories at once, producing one artifact",
  "per item in a list, broad research where only conclusions matter, or long self-contained jobs",
  "that would otherwise fill this conversation with intermediate output. Give each agent a",
  "self-contained brief — exact paths, the deliverable, acceptance criteria — because it starts",
  "with none of this conversation's context. Do NOT delegate small edits, sequential steps where",
  "each depends on the last, or anything needing the full discussion so far; do those yourself.",
  "Keep it to the few agents the work genuinely needs. If an agent fails on a provider or stream",
  "error, spawn a FRESH agent with the same brief instead of re-sending instructions to the failed",
  "one — a retried thread accumulates every prior attempt and only gets more likely to fail.",
  // Retry ceiling. A spawn_agent call whose ARGUMENTS come back rejected is a
  // transport failure, not a payload the model can fix by reshaping: observed
  // live, the arguments arrive empty (the model reports "task_name and message
  // were both omitted" for calls it populated). Without a stated ceiling the
  // model reads the parse error as its own mistake and reshapes forever — one
  // review turn burned ~15 attempts and produced no delegation at all. Two
  // strikes, then do the work directly, which is a perfectly good outcome.
  // WORKAROUND (2026-08-26) — remove once the gateway is fixed.
  //
  // A spawn_agent brief containing ANY non-ASCII character arrives at the
  // engine as an EMPTY arguments string. Isolated over six probes on one
  // session:
  //   28 chars, plain words                -> spawned
  //   2,399 chars, plain words             -> spawned   (length is fine)
  //   newline in the message               -> spawned   (escaping is fine)
  //   double quotes in the message         -> spawned   (escaping is fine)
  //   em dash (U+2014) in the message      -> FAILED
  // Engine error: `failed to parse function arguments: EOF while parsing a
  // value at line 1 column 0` — serde's message for zero bytes, so the payload
  // is discarded rather than mangled.
  //
  // This bites hard because the model writes em dashes, curly quotes and
  // ellipses naturally in prose, so almost any conversationally-worded brief
  // fails while a terse one succeeds. That is exactly the pattern seen live:
  // short exploration briefs delegated, PR-review briefs never did.
  //
  // Only the collab tools are affected. The app's own browser_* tools ride the
  // wire as plain function tools and are unharmed, which points at the
  // namespace flatten/split path rather than at tool calls generally.
  "Keep every spawn_agent brief to plain ASCII. Line breaks, straight quotes and backticks are all",
  "fine — the one thing that breaks is any character outside ASCII. Write a hyphen instead of an em",
  "or en dash, straight quotes instead of curly ones, three dots instead of an ellipsis character,",
  "the word \"to\" instead of an arrow, and no emoji or accented letters. This is a transport",
  "limitation rather than a style preference: one non-ASCII character makes the whole brief arrive",
  "as an empty payload and the spawn fails. Length is not a problem, so spell the task out in full.",
  "If spawn_agent still rejects your ARGUMENTS — a parse error, or a complaint that required fields",
  "are missing from a call you populated — retry ONCE with a plainer one-line brief, and if that",
  "also fails, STOP delegating and do the work yourself in this conversation. Say in one line that",
  "delegation was unavailable and get on with the task. Never spend a turn retrying it.",
  // Slot hygiene. The engine is explicit that "completed agents remain open and
  // count toward the concurrency limit until closed", and the cap is 5 per
  // session (max_concurrent_threads_per_session). close_agent exists ONLY as a
  // model tool — there is no client RPC for it, so the app cannot reclaim a
  // slot on the model's behalf; asking here is the only lever there is.
  // Without this, three sub-agents in one conversation permanently consume
  // three of five slots, and a second round of delegation later in the same
  // conversation fails with "agent thread limit reached".
  "The order after delegating is fixed: collect every agent's report, WRITE YOUR FINAL ANSWER, and",
  "only then call close_agent on each one. Closing is cleanup, never the last thing you do — a turn",
  "that ends with progress narration and no answer has failed, however tidy the agents are. Never",
  "close an agent whose report you have not read. A finished agent keeps occupying one of this",
  "conversation's five slots until it is closed, so leaving them open means later delegation in the",
  "same conversation stops working.",
  // Align the model with the schema it was actually given. The engine's own
  // spawn_agent text invites setting `model` ("set `model` only when an
  // explicit override is needed"), but this app configures
  // expose_spawn_agent_model_overrides = false, which removes that field from
  // the schema — so following that advice sends a key the tool does not
  // declare. Sub-agents inherit Pareto either way.
  "Never set a `model` field on spawn_agent. This app does not offer model overrides, and",
  "sub-agents already inherit the current model.",
].join(" ");

/** The instructions a thread actually gets: the static block above plus the
 *  project's memory index, when it has one. Computed per thread START — the
 *  index a running conversation sees is a snapshot, same as Claude Code's
 *  per-session index, refreshed on the next thread/start or resume. */
function developerInstructionsFor(cwd: string | null): string {
  const dir = memoryDirForCwd(cwd);
  const section = renderMemorySection(loadMemoryNotes(dir), dir);
  return section ? `${APP_DEVELOPER_INSTRUCTIONS}\n\n${section}` : APP_DEVELOPER_INSTRUCTIONS;
}

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

// Scheduling, offered to the model as a dynamic tool — the same extension
// point the browser uses, so no new machinery is involved.
//
// The schedule is taken as flat fields rather than the engine's tagged union.
// A oneOf over four variants is exactly the shape models get wrong, and the
// cost of guessing is a task that fires at the wrong time and is not noticed
// for a week. Flat fields with one enum are far harder to misread, and
// validateSchedule rebuilds the real union on this side.
const SCHEDULE_TOOLS = [
  {
    type: "function",
    name: "schedule_create",
    description:
      "Create a recurring scheduled task that runs on its own later. Use when the user asks for something repeating — a morning brief, a Friday summary, a watch on something that changes. The user is shown a card with the full details and must approve it before anything is armed, so propose it directly rather than asking in chat first. Each run starts a FRESH conversation with no memory of this one and runs read-only, so write the prompt as complete standing instructions: name the project, the paths and what to report. Do not use this for one-off work you can simply do now.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short label, e.g. 'Daily brief'." },
        prompt: {
          type: "string",
          description: "The full instruction for each run. Self-contained — the run cannot see this conversation.",
        },
        repeat: {
          type: "string",
          enum: ["daily", "weekdays", "weekly", "hourly"],
          description: "weekdays = Mon–Fri.",
        },
        time: { type: "string", description: "Local time as HH:MM, 24-hour. Required for daily, weekdays and weekly." },
        days: {
          type: "array",
          items: { type: "string", enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] },
          description: "Required for weekly. Ignored otherwise.",
        },
        intervalHours: { type: "integer", description: "Required for hourly. 1–24." },
        projectPath: {
          type: "string",
          description:
            "Absolute path to the project the run should work in. Omit to use this conversation's project, which is almost always right — pass it only when the user names a different one.",
        },
      },
      required: ["name", "prompt", "repeat"],
    },
  },
];

// Memory, offered as a dynamic tool the same way scheduling is. The saved
// note only ever becomes prompt text in later threads, so unlike
// schedule_create there is no approval card — visibility comes from the
// "Saved memory" transcript row instead, and memory_forget bounds a mistake.
const MEMORY_TOOLS = [
  {
    type: "function",
    name: "memory_save",
    description:
      "Save a durable note to this project's persistent memory so FUTURE conversations start knowing it. " +
      "Save: corrections and preferences the user states, project facts not written down anywhere, and " +
      "hard-won lessons — each with its Why. Do NOT save things the repo or git history already records, " +
      "or details that only matter to this conversation. Saving an existing name updates that note — " +
      "that is how you edit one.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short kebab-case slug, e.g. 'release-needs-em-dash'. Reusing a name overwrites that note.",
        },
        description: {
          type: "string",
          description:
            "ONE sentence: what this says and when to reach for it. This line is all a future " +
            "conversation sees before deciding to read the note — a vague one makes the memory " +
            "invisible forever.",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "user = who the user is/preferences; feedback = guidance they gave; project = facts about this project; reference = pointers to external resources.",
        },
        content: {
          type: "string",
          description: "The note body, markdown. The fact, then **Why:** (the evidence behind it), then **How to apply:**.",
        },
      },
      required: ["name", "description", "type", "content"],
    },
  },
  {
    type: "function",
    name: "memory_forget",
    description:
      "Delete one note from this project's persistent memory, by its exact name from the memory index. " +
      "Use when a memory turns out wrong or obsolete — a wrong note re-read by every future conversation " +
      "is worse than none.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The note's exact name from the index." } },
      required: ["name"],
    },
  },
];

/** How far before its own task mail a sub-agent's first turn may be stamped
 *  and still count as the agent's. See the filter in subagents:transcript. */
const SPAWN_GRACE_SECONDS = 2;

/** What KIND of thing a step card describes. Sent with every command entry so
 *  the transcript never has to infer it from the text — a shell command, an
 *  MCP call and a scheduling proposal all arrive as `command` entries, and
 *  only this says which is which. Without it the renderer classified by
 *  string prefix and dressed a scheduling card as a shell command, complete
 *  with a fabricated `$` prompt. */
type StepSource = "shell" | "browser" | "memory" | "tool";

function dynamicToolSource(tool: string | undefined): StepSource {
  const t = tool ?? "";
  if (t.startsWith("browser_")) return "browser";
  if (t.startsWith("memory_")) return "memory";
  return "tool";
}

/** The step card's label for a dynamic tool call — used by both the live
 *  notification path and history replay, so a call renders identically on
 *  resume. Most tools show their raw arguments (short and informative:
 *  `browser_search {"query":…}`), but the memory tools carry a whole note
 *  body as arguments, and a JSON dump of it reads as debug output. Name the
 *  action and the note instead — the content is one click away on the
 *  "Saved Memory" row. */
function dynamicToolCommandText(tool: string | undefined, rawArgs: unknown): string {
  const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
  const t = tool ?? "tool";
  if (t === "memory_save" || t === "memory_forget") {
    const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "memory";
    return `${t === "memory_save" ? "save memory" : "forget memory"} · ${name}`;
  }
  const argsText = Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
  return `${t}${argsText}`.slice(0, 400);
}

/**
 * Every dynamic tool a conversation gets.
 *
 * Composed rather than returned from one source: agentBrowserTools() yields
 * undefined when the CLI is absent, and while it was the only contributor that
 * meant "no browser" and "no dynamic tools at all" were the same value. Adding
 * a second family to that would have made scheduling silently disappear on any
 * machine without agent-browser installed.
 */
function threadDynamicTools(): Record<string, unknown>[] | undefined {
  const tools = [...SCHEDULE_TOOLS, ...MEMORY_TOOLS, ...(agentBrowserTools() ?? [])];
  return tools.length ? (tools as Record<string, unknown>[]) : undefined;
}

function runAgentBrowser(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  const bin = agentBrowserBin();
  if (!bin)
    return Promise.resolve({
      ok: false,
      // Actionable, because this text is what the model relays to the user. A
      // bare "not installed" got paraphrased as "I have no browser", which is
      // the wrong conclusion — the browser is missing, not absent by design.
      out:
        "The Agent browser is unavailable: the agent-browser CLI is not installed on this machine. " +
        "Tell the user to install it (`brew install agent-browser`) and restart Unbiased. Do not try to " +
        "browse with shell commands instead.",
    });
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

/** Double-quoted phrases in a search query — the parts Bing is being asked to
 *  match verbatim. Only runs of 3+ characters count, so a stray quote pair
 *  cannot manufacture a phrase. */
function quotedPhrases(query: string): string[] {
  const out: string[] = [];
  const re = /"([^"]{3,})"/g;
  for (let m = re.exec(query); m; m = re.exec(query)) {
    const phrase = m[1].trim();
    if (phrase) out.push(phrase);
  }
  return out;
}

/** Comparable form for phrase matching. Punctuation has to go: Bing renders
 *  its own dashes and drops colons from titles, so "Thomson: Continual" on the
 *  page may well be "Thomson Continual" in the DOM. Letters, digits and single
 *  spaces are the only parts that survive that reliably. */
function searchNorm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Quoted phrases that appear in NO result. Bing silently relaxes an
 *  exact-phrase query when nothing matches it — it drops the quotes, returns
 *  broad keyword hits, and sets none of the markers it normally uses to say so
 *  (#sp_requery, #sp_recourse, .b_no, "No results found for" all stay absent,
 *  measured). So the only way to know is to check the results ourselves. */
function unmatchedPhrases(query: string, rows: { title?: string; url?: string; snippet?: string }[]): string[] {
  const phrases = quotedPhrases(query);
  if (phrases.length === 0) return [];
  const haystacks = rows.map((r) => searchNorm(`${r.title ?? ""} ${r.snippet ?? ""} ${r.url ?? ""}`));
  return phrases.filter((phrase) => {
    const needle = searchNorm(phrase);
    return needle !== "" && !haystacks.some((h) => h.includes(needle));
  });
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
  // Any approved browser tool means the agent is about to browse — that, not
  // Chrome's launch, is the moment to show the user what it is doing. Launch
  // was the wrong trigger: Chrome usually already exists by the second task,
  // so the pane never opened again for the rest of the session. Denied calls
  // fall out above, so this only fires for browsing that actually happens.
  // Still withheld for a browser the user already had open — auto-mirroring
  // someone's personal Chrome and its tabs stays opt-in.
  // Every tool that needs a live page attaches first. browser_connect does its
  // own (richer) attach, and browser_close must not resurrect a browser it is
  // about to shut down.
  if (tool !== "browser_connect" && tool !== "browser_close") {
    // Inside the lock: browserSessionBound is read, then set after two awaits,
    // so two conversations arriving together could both pass the guard and
    // attach twice — launching or adopting a browser the other is already
    // using. Harmless with one conversation, which is why it was fine before
    // per-conversation tabs made concurrency the normal case.
    const failure = await withBrowserLock(() => ensureBrowserSession());
    if (failure) return text(failure, false);
  }
  // Carries the conversation, so the pane only springs open for the chat the
  // user is actually looking at. Without it a background chat's browsing
  // popped the Agent browser onto whichever conversation was on screen.
  if (!browserAttachedExternal) send("agentmirror:activity", { tool, threadId: rootThreadOf(threadId) });
  // Remember where the agent is going, so the mirror follows it rather than
  // whatever tab happens to sort first.
  if (tool === "browser_open") {
    const target = webUrlOrNull(str("url"));
    if (target) mirrorPreferredUrl = target;
  }
  // Everything below runs against ONE tab, chosen for this conversation and
  // held for the whole call. browser_connect and browser_close are excluded:
  // they act on the session rather than a page, and close must not create a
  // tab on its way to shutting the browser down.
  const root = rootThreadOf(threadId);
  const tabScoped = root !== null && tool !== "browser_connect" && tool !== "browser_close";
  return withBrowserLock(async (): Promise<DynamicToolResponse> => {
    if (tabScoped) {
      const failure = await selectConversationTab(root);
      if (failure) return text(failure, false);
      // Deliberately does NOT steer the mirror. The pane follows the
      // conversation the user is looking at; a call from a background chat
      // must not drag the view onto its page.
    }
    const result = await runBrowserTool();
    // A click can open the real destination in a NEW tab — Slack's workspace
    // "Launch" does — and the CLI follows it. Adopt that tab as the
    // conversation's, or the registry (and with it the mirror, and any later
    // re-select) stays pointed at the page the agent already left: the pane
    // showed the workspace picker while the agent worked elsewhere.
    if (tabScoped && (tool === "browser_click" || tool === "browser_press")) {
      const entry = browserTabs.get(root);
      if (entry) {
        const r = await runAgentBrowser(["tab", "list", "--json"], 15_000);
        try {
          const parsed = JSON.parse(r.out) as { data?: { tabs?: { active?: boolean; targetId?: string }[] } };
          const active = (parsed.data?.tabs ?? []).find((t) => t.active);
          if (typeof active?.targetId === "string" && active.targetId !== entry.targetId) {
            entry.targetId = active.targetId;
          }
        } catch {
          /* adoption is best-effort; the click's own result already returned */
        }
      }
    }
    return result;
  });

  async function runBrowserTool(): Promise<DynamicToolResponse> {
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
      // A relaxed exact-phrase query is worse than an empty one: the results
      // look confident and well-formed while answering a different question,
      // and the `rows.length === 0` guard above never fires because Bing
      // returns a full page of them. The dangerous case is an exact-title
      // search used to check whether something exists — relaxation turns "no
      // such thing" into ten plausible citations. Results are still returned
      // (they are real pages, and a long phrase can be missing from a
      // truncated snippet even on a genuine match), but the framing is
      // corrected before the model reads them.
      const unmatched = unmatchedPhrases(query, rows);
      const warning =
        unmatched.length === 0
          ? ""
          : `[warning] No result contains the exact phrase ${unmatched.map((p) => JSON.stringify(p)).join(" or ")}. ` +
            "Bing drops quotes when a phrase has no matches and gives no signal that it did, so read this as " +
            "\"no source found for that exact wording\" — do NOT cite these results as confirming the phrase " +
            "exists. Open a result to check, or search again with distinctive keywords instead of a quoted phrase.\n\n";
      return text(
        `${warning}Results for ${JSON.stringify(query)}:\n\n${list}\n\n[next] browser_open one of these URLs to read it, ` +
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
      // Only a browser of OURS is ours to close later. Not the same as "we
      // launched it this time": our managed Chrome survives an unclean exit,
      // and treating that leftover as the user's browser is what suppressed
      // the mirror pane for the rest of the session.
      browserAttachedExternal =
        "url" in target ? true : launched ? false : !(await ownsChromeOnPort(target.port));
      browserSessionBound = true;
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
      // The CLI session is no longer bound to anything; the next browser tool
      // has to attach again rather than assuming a live page.
      browserSessionBound = false;
      // Every conversation's tab went with the browser. Keeping the registry
      // would hand the next call a label that no longer exists, and the
      // recovery path would then quietly create a tab in a browser we just
      // told the user we had closed.
      browserTabs.clear();
      browserActiveRoot = null;
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

// Per-turn message phases, cleared when a turn ends. A turn whose only
// assistant output was commentary produced no answer — the app used to treat
// every assistant message alike, so that was indistinguishable from a finished
// reply and the conversation simply appeared to stop.
const turnSawFinalAnswer = new Set<string>();
const turnSawCommentary = new Set<string>();

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
  browserSessionBound = false;
  browserTabs.clear();
  browserActiveRoot = null;
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
/** Sub-agent nicknames recovered from a thread's own rollout.
 *
 *  The engine assigns a nickname ("Singer", "Ramanujan") and reports it in the
 *  spawn tool's OUTPUT. Live, that arrives as a raw response item — but raws
 *  only flow for threads STARTED with experimentalRawEvents, and the engine
 *  ignores the flag on resume. Measured against 0.147.0 across three separate
 *  processes: start-with-flag emitted 6 raws for one turn, resume-with-flag 0,
 *  resume-without 0. So a reopened conversation never learns the nicknames and
 *  every sub-agent row keeps its raw task name ("app_bridge_routing").
 *
 *  The rollout has it, though: the same function_call_output is persisted as
 *  `{"task_name":"/root/some_task","nickname":"Singer"}`. Same trick
 *  rolloutMail already uses for inter-agent mail, for the same reason.
 *
 *  Returns task name (last path segment, matching the live path) → nickname. */
const rolloutNicknameCache = new Map<string, { mtimeMs: number; size: number; names: Map<string, string> }>();
function rolloutNicknames(threadId: string): Map<string, string> {
  const file = findRolloutFile(threadId);
  if (!file) return new Map();
  let st;
  try {
    st = statSync(file);
  } catch {
    return new Map();
  }
  if (st.size > 8_000_000) return new Map(); // a parent rollout this big is not worth a full parse
  const cached = rolloutNicknameCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return new Map(cached.names);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return new Map();
  }
  const names = new Map<string, string>();
  for (const line of raw.split("\n")) {
    // Cheap reject before JSON.parse: these files run to thousands of lines.
    // Matched WITHOUT quotes on purpose — `output` is a JSON string, so the key
    // is escaped in the raw line (\"nickname\") and a quoted probe matches
    // nothing. The first cut of this rejected every line and silently found no
    // nicknames at all; caught by running it against a real rollout.
    if (!line.includes("nickname")) continue;
    try {
      const parsed = JSON.parse(line) as { payload?: { type?: string; output?: unknown } };
      if (parsed.payload?.type !== "function_call_output") continue;
      if (typeof parsed.payload.output !== "string") continue;
      const out = JSON.parse(parsed.payload.output) as { task_name?: string; nickname?: string };
      const task = out.task_name?.split("/").filter(Boolean).pop();
      // Later spawns of the same task name win, matching the live path's
      // "prefer the newest registration" rule.
      if (task && out.nickname) names.set(task, out.nickname);
    } catch {
      // unparseable line — skip
    }
  }
  rolloutNicknameCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, names: new Map(names) });
  return names;
}

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

/**
 * Recover sub-agent nicknames from a thread's rollout and publish them.
 *
 * Extracted because reopening a conversation was the only thing that ran it,
 * and that is not the only time it is needed. Nicknames normally arrive as raw
 * response items, and the engine emits raws only for threads STARTED with
 * experimentalRawEvents — a RESUMED conversation gets none. So an agent
 * spawned after a resume kept its raw task name ("security_reviewer") even
 * though the engine had already assigned it one ("Dalton"), because nothing
 * re-read the rollout between the spawn and the end of the turn.
 *
 * Idempotent: it renames only entries still carrying the task name, so an
 * agent already named by the live path is untouched. rolloutNicknames is
 * cached on mtime+size, so calling this per turn is close to free.
 */
function applyRolloutNicknames(id: string): void {
  const nicknames = rolloutNicknames(id);
  if (nicknames.size === 0) return;
  for (const [task, nickname] of nicknames) {
    let renamedOne = false;
    for (const [subId, info] of subAgents) {
      if (info.parent !== id || info.name !== task) continue;
      info.name = nickname;
      renamedOne = true;
      const pane = paneForThread(id);
      if (pane) {
        send("chat:subagent-event", {
          paneId: pane,
          event: "renamed",
          name: nickname,
          path: info.path,
          agentThreadId: subId,
        });
      }
    }
    // Nothing registered under that task yet — stash it for whenever the
    // registration arrives, exactly as the live raw path does.
    if (!renamedOne) pendingNicknames.set(`${id}:${task}`, nickname);
  }
  pushSubAgents(id);
  // The registry is empty after an app restart, so the loop above renames
  // nothing and the rows restored from the transcript keep their task names.
  // The renderer still holds those rows, so hand it the whole map and let it
  // retitle by name — that is the only path that works cold.
  const pane = paneForThread(id);
  if (pane) {
    send("chat:subagent-renames", { paneId: pane, names: Object.fromEntries(nicknames) });
  }
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

// threadId → the cwd it was started with. mainCwd only tracks the active
// main pane, but memory writes arrive from scheduled runs and side threads
// too, and a note saved by a background run must land in ITS project's
// store, not whichever conversation happens to be frontmost.
const threadCwds = new Map<string, string>();

const memoryRoot = () => join(homedir(), ".unbiased", "memory");

/** The memory directory a thread reads and writes. Worktree conversations
 *  resolve to their PROJECT's store — keying by cwd would give every
 *  worktree an amnesiac private notebook (matches observed Claude Code
 *  behavior: a worktree session uses the main project's memory). */
function memoryDirForCwd(cwd: string | null): string {
  const at = cwd || defaultChatDir();
  const project = loadWorktrees()[at]?.project ?? at;
  return projectMemoryDir(memoryRoot(), project);
}

// ── The learning sidecar (observe-only) ─────────────────────────────────
// Absent unless its bundle is installed, and silent when it is not: this is
// an optional companion process, not a dependency. It observes; nothing it
// learns rides a prompt from here.
let learning: LearningClient | null = null;

/** Fire-and-forget: every call site should be one line that cannot fail. */
function observeLearning(
  kind: Parameters<typeof buildEvent>[0]["kind"],
  threadId: string | null | undefined,
  summary: string,
  data?: Record<string, unknown>,
): void {
  if (!learning?.isReady || !threadId) return;
  try {
    learning.observe(buildEvent({ kind, threadId, turnId: runningTurns.get(threadId) ?? null, summary, data }));
  } catch {
    /* learning must never be able to break a turn */
  }
}

async function startLearning(): Promise<void> {
  const dir = resolveSidecarDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  if (!sidecarLooksInstalled(dir)) return; // not installed: nothing to say
  const manifest = readSidecarManifest(dir);
  if (!manifest) return;
  if ("error" in manifest) {
    console.warn(`[learning] not starting: ${manifest.error}`);
    return;
  }
  const client = new LearningClient(manifest, join(app.getPath("userData"), "learning.db"));
  try {
    await client.start();
    learning = client;
    console.log(`[learning] sidecar ${manifest.version} observing`);
  } catch (err) {
    console.warn(`[learning] handshake failed, learning is off: ${String(err)}`);
    void client.stop();
  }
}

function memoryDirForThread(threadId: string | null): string {
  const root = threadId ? rootThreadOf(threadId) : null;
  return memoryDirForCwd((root && threadCwds.get(root)) || mainCwd);
}

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

/**
 * A readable worktree name, from the first thing asked of it.
 *
 * The old scheme was `<project>-<timestamp>`, which is unique and tells you
 * nothing: a folder full of `unbiased-app-2026-08-19-0226` is unreadable at a
 * glance. Four words of the opening message plus a short hash reads like
 * `repository-exploration-11baed` — recognisable, and still collision-proof
 * when two conversations open the same way.
 */
function worktreeName(seed: string): string {
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");
  const hash = createHash("sha256").update(`${seed}${Date.now()}`).digest("hex").slice(0, 6);
  return slug ? `${slug}-${hash}` : `session-${hash}`;
}

/**
 * Keep a nested worktree out of `git status`, without touching a tracked file.
 *
 * `.gitignore` belongs to the repository and to everyone who clones it; adding
 * an entry there would show up as a change the user did not make and would
 * travel to their colleagues. `.git/info/exclude` is local to this checkout,
 * which is exactly the scope of a directory this app created on this machine.
 * `--git-common-dir` rather than `--git-dir` because the project may itself be
 * a worktree, where the latter points at a per-worktree stub.
 */
function excludeFromGit(project: string, entry: string): void {
  try {
    const common = execFileSync("git", ["-C", project, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    const gitDir = isAbsolute(common) ? common : join(project, common);
    const file = join(gitDir, "info", "exclude");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === entry)) return;
    mkdirSync(join(gitDir, "info"), { recursive: true });
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    writeFileSync(file, `${current}${sep}${entry}\n`);
  } catch {
    // Best effort. An un-excluded worktree is untidy, not broken.
  }
}

/** Create a fresh worktree for a conversation; null = fall back to local. */
async function createWorktree(project: string, seed?: string): Promise<string | null> {
  const name = worktreeName(seed ?? "");
  // Inside the project, alongside how codex and Claude Code do it
  // (.codex/worktrees, .claude/worktrees). Keeping them in the app's data
  // folder meant a checkout of your repo living somewhere you would never
  // look, with nothing but a JSON map tying it back.
  const dir = join(project, ".unbiased", "worktrees", name);
  const branch = `pareto/${name}`;
  // The parent only — `git worktree add` refuses a target that already exists.
  mkdirSync(join(project, ".unbiased", "worktrees"), { recursive: true });
  excludeFromGit(project, ".unbiased/");
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
  /** Free-form classification the client set at thread/start, handed back
   *  unchanged. Used to keep scheduled runs out of the sidebar. */
  threadSource?: string | null;
  turns?: { items?: WireItem[]; startedAt?: number; durationMs?: number }[];
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
function threadToEntries(
  thread: WireThread,
  opts?: { runningLastTurn?: boolean },
): { entries: unknown[]; runningTurnStart: number | null; runningTurnStartedAt: number | null } {
  const entries: unknown[] = [];
  const turns = thread.turns ?? [];
  // Where the in-flight turn's foldable output begins, and when the turn
  // started. Without these, opening a conversation mid-turn stranded the
  // replayed half of that turn outside the fold forever: the live fold at
  // completion only reaches back to the moment the pane opened, so narration
  // replayed from history sat bare above a "Worked" group covering just the
  // tail — the exact split seen on a scheduled run opened via "Open run".
  let runningTurnStart: number | null = null;
  let runningTurnStartedAt: number | null = null;
  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t];
    // Per-turn bucket, folded when the turn (or a mid-turn user message)
    // flushes it. The live path folds a completed turn's intermediate output
    // under a "Worked" header at turn/completed — but a REOPENED conversation
    // is rebuilt here, and this function used to replay everything flat, so
    // the folds evaporated on reopen: every line of narration stood bare in
    // the transcript with only the consecutive-command groups surviving
    // (those fold at render time). Mirrors the live semantics exactly: the
    // fold starts after the user message and the trailing assistant message
    // stays outside. Duration is not in the wire history, so the header reads
    // "Worked" rather than "Worked for Ns".
    const bucket: unknown[] = [];
    const durationS = typeof turn.durationMs === "number" ? turn.durationMs / 1000 : null;
    const flush = (keepFinalOut: boolean): void => {
      if (bucket.length === 0) return;
      const last = bucket[bucket.length - 1] as { kind?: string; phase?: string | null } | undefined;
      // The trailing assistant message always stays outside, even when its
      // phase is commentary — live folding does the same, and a turn that
      // narrated and stopped should still show SOMETHING rather than fold
      // itself away entirely.
      const finalMsg = keepFinalOut && last?.kind === "assistant" ? bucket.pop() : null;
      // Fold when the bucket holds interim output: tool work where history
      // kept any, or commentary-phase narration where it did not. A turn of
      // plain messages with no phase info (older engines) stays flat — better
      // a loose transcript than answers hidden behind a fold.
      const didWork = bucket.some((e) => {
        const x = e as { kind?: string; phase?: string | null };
        return x.kind === "command" || x.kind === "agent" || (x.kind === "assistant" && x.phase === "commentary");
      });
      // The duration is the whole TURN's, so only the turn-closing flush may
      // claim it — a steered turn flushes once per user interjection, and
      // stamping each fragment with the full figure would show one turn's
      // time twice.
      if (didWork) entries.push({ kind: "work", duration: keepFinalOut ? durationS : null, entries: [...bucket] });
      else entries.push(...bucket);
      if (finalMsg) entries.push(finalMsg);
      bucket.length = 0;
    };
    // A turn still running when the conversation reopens stays raw: its
    // entries are still growing, and the live fold takes over at completion.
    const foldThisTurn = !(opts?.runningLastTurn && t === turns.length - 1);
    if (!foldThisTurn) {
      runningTurnStart = entries.length;
      const at = turn.startedAt;
      // Epoch guard: below ~2001-09 in milliseconds means it is not an epoch-
      // ms value — rather a seconds epoch or something else. A wrong unit here
      // shows a 50-year duration on the fold, so unknown beats guessed.
      runningTurnStartedAt = typeof at === "number" && at > 1e12 ? at : null;
    }
    for (const item of turn.items ?? []) {
      switch (item.type) {
        case "userMessage":
          // A user message (initial, or a mid-turn steer) never hides inside
          // a fold — flush what came before it, folded, then show it.
          flush(false);
          entries.push({ kind: "user", text: item.text ?? contentToText(item.content) });
          // The running turn's fold starts after its user message, matching
          // where the live path plants its start index on send.
          if (!foldThisTurn) runningTurnStart = entries.length;
          break;
        case "agentMessage": {
          // `phase` is the engine's own record of which messages were interim
          // narration ("commentary") and which was the answer
          // ("final_answer"). It is the ONLY signal that survives into
          // history: thread/read returns no tool items at all — measured, a
          // turn with 40+ tool calls replays as 1 user + 15 agent messages —
          // so any fold keyed on "did work happen" sees nothing to fold and
          // replays narration flat. That is exactly the reopened-transcript
          // bug this fixes.
          const m = item as { text?: string; phase?: string | null };
          bucket.push({ kind: "assistant", text: m.text ?? "", phase: m.phase ?? null });
          break;
        }
        case "commandExecution":
          bucket.push({
            kind: "command",
            itemId: item.id ?? "unknown",
            command: item.command ?? "(command)",
            status: item.status ?? "completed",
            exitCode: item.exitCode,
            output: item.aggregatedOutput,
            source: "shell",
          });
          break;
        case "dynamicToolCall": {
          const d = item as { id?: string; tool?: string; arguments?: unknown; status?: string; success?: boolean };
          bucket.push({
            kind: "command",
            itemId: d.id ?? "unknown",
            command: dynamicToolCommandText(d.tool, d.arguments),
            status: d.success === false ? "failed" : (d.status ?? "completed"),
            source: dynamicToolSource(d.tool),
          });
          break;
        }
        case "mcpToolCall": {
          const t = item as unknown as {
            id?: string;
            server?: string;
            tool?: string;
            arguments?: unknown;
            status?: string;
            error?: { message?: string } | null;
          };
          const margs = t.arguments && typeof t.arguments === "object" ? t.arguments : {};
          const margsText = Object.keys(margs).length ? ` ${JSON.stringify(margs)}` : "";
          bucket.push({
            kind: "command",
            itemId: t.id ?? "unknown",
            command: `${t.server ?? "mcp"}.${t.tool ?? "tool"}${margsText}`.slice(0, 400),
            status: t.status ?? "completed",
            output: t.error?.message ?? undefined,
            source: "tool",
          });
          break;
        }
        case "contextCompaction":
          bucket.push({ kind: "compaction" });
          break;
        case "plan":
          bucket.push({ kind: "assistant", text: item.text ?? "" });
          break;
        case "subAgentActivity": {
          const sub = item as { kind?: string; agentThreadId?: string; agentPath?: string };
          bucket.push({
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
    if (foldThisTurn) flush(true);
    else {
      entries.push(...bucket);
      bucket.length = 0;
    }
  }
  return { entries, runningTurnStart, runningTurnStartedAt };
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
// ---- Skills ---------------------------------------------------------------
// Three tiers, and the difference between them is a protocol fact rather than a
// preference (measured against engine 0.147.0):
//
//   bundled  resources/skills            read-only, ships with the app
//   global   ~/.unbiased/skills          the user's own, every conversation
//   project  <cwd>/.codex/skills         codex scans this itself, per cwd
//
// Only the third is project-scoped. codex has exactly two inputs: a cwd-relative
// scan hardcoded to `.codex/skills`, and skills/extraRoots/set — a FLAT GLOBAL
// list with no cwd binding. Registering a per-project directory as an extra root
// leaks it: a skill under project A shows up inside a project B conversation,
// tagged scope "user". Verified. Hence the codex-named directory for project
// skills; it is the only project-scoped mechanism that exists.
function bundledSkillsDir(): string {
  const override = process.env.UNBIASED_SKILLS_DIR?.trim();
  if (override) return override;
  return app.isPackaged
    ? join(process.resourcesPath, "skills")
    : join(app.getAppPath(), "resources", "skills");
}
function globalSkillsDir(): string {
  return join(app.getPath("home"), ".unbiased", "skills");
}
/** The roots we hand the engine. Bundled stays read-only — an app update has to
 *  be able to replace it, and a user edit must not be silently clobbered, so
 *  "edit" in the UI means copy-into-global. */
function skillRoots(): string[] {
  const roots: string[] = [];
  const bundled = bundledSkillsDir();
  if (existsSync(bundled)) roots.push(bundled);
  // Created eagerly so the folder exists to reveal in Finder before the user
  // has added anything.
  const g = globalSkillsDir();
  try {
    mkdirSync(g, { recursive: true });
    roots.push(g);
  } catch (err) {
    console.error("[skills] could not create", g, err);
  }
  return roots;
}

// UNBIASED_API_KEY (env) else ~/.unbiased/credentials.json; the login flow
// writes the file and pins the key into the engine's launch env.
// UNBIASED_PLATFORM_URL points a dev build at a local platform. Only the
// platform calls here (whoami, billing, browser sign-in) follow it; the
// engine's gateway URL is pinned by the supervisor and is not affected.
const PLATFORM_BASE = (process.env.UNBIASED_PLATFORM_URL?.trim() || "https://platform.unbiased.ai").replace(/\/+$/, "");
// The app's OAuth public client id, registered on the platform (unbiased-
// platform docs/admin-api.md → Partners). Public by design — it ships in the
// binary; the person's approval in their browser is what carries the trust.
// Registered 2026-08-28 as partner "Unbiased" → client "Unbiased Desktop".
// Empty disables browser sign-in and the login screen offers only paste-a-key.
const OAUTH_CLIENT_ID = process.env.UNBIASED_OAUTH_CLIENT_ID?.trim() || "dhTH_VbRdB88tgW-m1HWiw";
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

// Release notes come from the releases repo so shipping a changelog entry no
// longer means shipping a build. Cached to disk because the Updates tab must
// say something on a plane, and because GitHub's unauthenticated limit is 60
// requests an hour per IP — several people behind one office NAT would burn
// that on update checks alone.
type ReleaseNote = { version: string; date: string | null; body: string };
function releaseNotesFile(): string {
  return join(app.getPath("userData"), "release-notes.json");
}
let releaseNotesCache: ReleaseNote[] | null = null;
function loadReleaseNotes(): ReleaseNote[] {
  if (!releaseNotesCache) {
    try {
      releaseNotesCache = JSON.parse(readFileSync(releaseNotesFile(), "utf8")) as ReleaseNote[];
    } catch {
      releaseNotesCache = [];
    }
  }
  return releaseNotesCache;
}

/** Everything above the first `---`. Release bodies carry install instructions
 *  below that rule, which are for someone looking at GitHub, not for someone
 *  already running the app. */
function notesAboveRule(body: string): string {
  // Only the rule that DIRECTLY introduces the install block. A bare `---` is
  // also markdown's horizontal rule and its setext-h2 underline, so cutting at
  // the first one anywhere would swallow hand-written notes that use either.
  const m = /^[ \t]*---[ \t]*\r?\n\s*(?:Apple Silicon Mac|Install:)/m.exec(body);
  return (m ? body.slice(0, m.index) : body).trim();
}

async function refreshReleaseNotes(): Promise<void> {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return; // rate-limited or offline — the cache still stands
    const body = (await res.json()) as { tag_name?: string; published_at?: string; body?: string }[];
    const notes = body
      .filter((r) => r.tag_name)
      .map((r) => ({
        version: String(r.tag_name).replace(/^v/, ""),
        date: r.published_at ?? null,
        body: notesAboveRule(r.body ?? ""),
      }))
      .filter((r) => r.body.length > 0);
    if (notes.length === 0) return; // never replace a good cache with nothing
    releaseNotesCache = notes;
    try {
      writeFileSync(releaseNotesFile(), JSON.stringify(notes));
    } catch {
      /* cache is an optimisation, not a requirement */
    }
  } catch {
    /* offline — the cache still stands */
  }
}

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
  // Alongside the version check, so an app left open for days has the notes
  // for whatever it is about to offer. Boot-only would mean the Updates tab
  // describing the version you are already on while the banner offers another.
  void refreshReleaseNotes();
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
        // Announce on BOTH outcomes. Failure falls back to the manual banner.
        // Success must announce too: the banner renders only when the
        // renderer's `update` state is set, and update:staged alone never sets
        // it — so a silently staged update was invisible until the next app
        // restart. Verified live: 1.3.1 sat fully staged on disk for an hour
        // with no banner. staged fired first, so the label says "Relaunch".
        send("update:available", info);
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
      return;
    }
    // Anything that is not this app and not an outward link is refused.
    // Previously only http(s) was considered, which left file:// through — and
    // a file:// navigation is exactly what a dropped file produces when no
    // handler claims it. The renderer swallows those first (see main.tsx), so
    // this is the second line rather than the first, but the failure it guards
    // against is the app replacing itself with the contents of a dropped file
    // and no way back short of reopening the window.
    const own = process.env.ELECTRON_RENDERER_URL ?? `file://${join(__dirname, "../renderer/index.html")}`;
    if (!/^https?:/.test(url) && url !== own) {
      console.warn("[window] blocked navigation to", url.slice(0, 120));
      e.preventDefault();
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
  // An MCP tool call. codex gates every one behind
  // mcpServer/elicitation/request and expects {action}, NOT the {decision}
  // every other approval answers with. Answering with {decision} does not
  // merely get refused — it fails to deserialize server-side, and the call
  // comes back to the user as "user rejected MCP tool call", blaming them
  // for a choice they were never shown. Verified against engine 0.147.0.
  | { kind: "elicitation"; rpcId: number | string }
  // Client-executed tools (the agent browser) need the same card, but the
  // decision resolves a promise here instead of answering an engine RPC.
  | { kind: "local"; settle: (decision: ApprovalDecision) => void }
);
const pendingApprovals = new Map<string, PendingApproval>();
let nextLocalApproval = 1;
// Approval handles are persisted in the transcript, so a card outlives the
// process that created it. Counters restart at 1 every boot, which means a
// card restored from a previous run could carry the SAME id as a live request
// in this one — and answering the stale card would silently answer the new
// request instead. The boot nonce makes that collision impossible: an id from
// a previous run can never match one from this run.
const APPROVAL_BOOT = Math.random().toString(36).slice(2, 8);
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
  const requestId = `apr_${APPROVAL_BOOT}_local_${nextLocalApproval++}`;
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
// Staged downloads and unpacked archives, removed on quit so a skill the user
// rejected leaves nothing behind. Module scope because window-all-closed —
// which does the cleaning — lives outside the whenReady closure.
const skillStages = new Set<string>();
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
          // The judge governor treats "unknown" as busy; say so honestly, so
          // background judging can never compete with this turn for the
          // gateway's per-org concurrency.
          learning?.setIdle(false);
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
        // Phase tracking, to catch a turn that narrates and then stops.
        // `phase` distinguishes interim commentary from the terminal answer.
        // The engine's own note says providers emit it inconsistently and None
        // means UNKNOWN — so this only ever records what it positively sees,
        // and the check at turn end stays silent unless it saw commentary and
        // never saw a final answer.
        if (msg.method === "item/completed" && threadId) {
          const it = params.item as { type?: string; phase?: string | null } | undefined;
          if (it?.type === "agentMessage") {
            if (it.phase === "final_answer") turnSawFinalAnswer.add(threadId);
            else if (it.phase === "commentary") turnSawCommentary.add(threadId);
          }
        }
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
          send("chat:command", { paneId, phase, item: { ...(item as object), source: "shell" } });
          // Both halves: the command attempted, and how it ended. The
          // sidecar's reward model reads the exit code, and its
          // repeated-failed-command signal needs the call text to normalise.
          const ce = item as { command?: string; status?: string; exitCode?: number; aggregatedOutput?: string };
          if (phase === "started") {
            observeLearning("tool_call", threadId, ce.command ?? "(command)", { argsSummary: ce.command ?? "" });
          } else if (phase === "completed") {
            observeLearning("tool_output", threadId, ce.command ?? "(command)", {
              exitCode: typeof ce.exitCode === "number" ? ce.exitCode : 0,
              commandSummary: ce.command ?? "",
            });
          }
        } else if (item?.type === "dynamicToolCall") {
          // Dynamic tool calls render as command-style cards.
          const d = item as { id?: string; tool?: string; arguments?: unknown; status?: string; success?: boolean };
          send("chat:command", {
            paneId,
            phase,
            item: {
              id: d.id,
              command: dynamicToolCommandText(d.tool, d.arguments),
              source: dynamicToolSource(d.tool),
              // A started call is in progress — defaulting to "completed"
              // showed a green "done" for a page still loading.
              status:
                d.success === false
                  ? "failed"
                  : (d.status ?? (phase === "started" ? "inProgress" : "completed")),
            },
          });
        } else if (item?.type === "mcpToolCall") {
          // MCP tool calls render as command-style cards, like the browser
          // tools above. Status comes straight from the engine, which reports
          // inProgress / completed / failed.
          const t = item as unknown as {
            id?: string;
            server?: string;
            tool?: string;
            arguments?: unknown;
            status?: string;
            error?: { message?: string } | null;
          };
          const margs = t.arguments && typeof t.arguments === "object" ? t.arguments : {};
          const margsText = Object.keys(margs).length ? ` ${JSON.stringify(margs)}` : "";
          send("chat:command", {
            paneId,
            phase,
            item: {
              id: t.id,
              command: `${t.server ?? "mcp"}.${t.tool ?? "tool"}${margsText}`.slice(0, 400),
              source: "tool",
              status: t.status ?? (phase === "started" ? "inProgress" : "completed"),
              // Without this a failed call is a red card with an empty body.
              // The engine puts the cause here ("user rejected MCP tool call",
              // upstream errors), and the step card already renders output.
              output: t.error?.message ?? undefined,
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
          // The event the sidecar's whole reflex hangs on: turn_completed is
          // what triggers scoring and distillation on its side. Observed
          // BEFORE runningTurns is cleared so the event still carries its
          // turn id, then flushed — a turn boundary is exactly the moment the
          // app is between pieces of work.
          observeLearning("turn_completed", threadId, `turn ${turn?.status ?? "completed"}`, {
            status: turn?.status ?? "completed",
          });
          learning?.flush();
          // Idle again: nothing of the user's is competing for the gateway.
          if (runningTurns.size <= 1) learning?.setIdle(true);
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
          // Nicknames, for the case where raws never arrive. The engine emits
          // raw items only for threads STARTED with experimentalRawEvents, so
          // a resumed conversation learns nothing from the live path — and a
          // spawn made during that conversation kept its task name. By turn
          // end the spawn's output is in the rollout, so read it from there.
          // Runs for the ROOT: a sub-agent's own turn ending is also the
          // moment its nickname becomes readable.
          const nickRoot = rootThreadOf(threadId);
          for (const info of subAgents.values()) {
            if (info.parent !== nickRoot) continue;
            applyRolloutNicknames(nickRoot);
            break;
          }
        }
        // A turn that only ever narrated: positively saw commentary, never a
        // final answer. Reported as a status rather than an error, because the
        // work usually DID happen — the agent just yielded without writing it
        // up, and the user is otherwise left looking at a stopped screen with
        // no idea anything is missing. Silent when phase was never stamped.
        const narrated =
          threadId !== null &&
          turn?.status === "completed" &&
          turnSawCommentary.has(threadId) &&
          !turnSawFinalAnswer.has(threadId);
        if (threadId) {
          turnSawCommentary.delete(threadId);
          turnSawFinalAnswer.delete(threadId);
        }
        if (!paneId) break;
        panes[paneId].turnId = null;
        send("chat:turn-completed", {
          paneId,
          narrated,
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

  // MCP server lifecycle. Purely informational — the panel reflects it, and a
  // server that fails to start is otherwise invisible: its tools simply never
  // appear, with nothing saying why.
  engine.on("notification", (msg: { method: string; params?: Record<string, unknown> }) => {
    if (msg.method === "mcpServer/oauthLogin/completed") {
      const p = msg.params ?? {};
      send("mcp:login-done", {
        name: typeof p.name === "string" ? p.name : "",
        success: p.success === true,
        error: typeof p.error === "string" ? p.error : null,
      });
      return;
    }
    if (msg.method !== "mcpServer/startupStatus/updated") return;
    const p = msg.params ?? {};
    send("mcp:status", {
      name: typeof p.name === "string" ? p.name : "(unknown)",
      status: typeof p.status === "string" ? p.status : "unknown",
      error: typeof p.error === "string" ? p.error : null,
      failureReason: typeof p.failureReason === "string" ? p.failureReason : null,
    });
  });

  // Scheduled runs. Their threads own no pane, so the main event switch above
  // routes none of their traffic anywhere — this listener is the whole of it.
  // Kept separate rather than folded into that switch: a scheduled thread has
  // no pane, no transcript and no approval cards, and every branch in there
  // begins by resolving one.
  engine.on("notification", (msg: { method: string; params?: Record<string, unknown> }) => {
    const params = msg.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) return;
    const run = scheduledRuns.get(threadId);
    if (!run) return;
    if (msg.method === "item/agentMessage/delta") {
      run.text += (params.delta as string) ?? "";
      return;
    }
    // Take the finished message from the item itself. Deltas alone were not
    // enough: a run whose STATUS line was plainly in the transcript settled
    // with empty text, so the status went unparsed and the row read
    // "finished" — the engine does not always stream a message it delivers
    // whole. The LAST final_answer wins; commentary is narration, and a
    // multi-message turn ends on the answer.
    if (msg.method === "item/completed") {
      const it = params.item as { type?: string; text?: string; phase?: string | null } | undefined;
      if (it?.type === "agentMessage" && typeof it.text === "string" && it.text.trim()) {
        if (it.phase === "final_answer" || !run.finalText) run.finalText = it.text;
      }
      return;
    }
    if (msg.method === "turn/completed") {
      const turn = params.turn as
        | { status?: string; error?: { message?: string; additionalDetails?: string | null } | null }
        | undefined;
      const status: RunStatus =
        turn?.status === "failed" ? "failed" : turn?.status === "interrupted" ? "interrupted" : "completed";
      const error = turn?.error
        ? [turn.error.message, turn.error.additionalDetails].filter(Boolean).join(" — ") || "unknown error"
        : null;
      // Prefer the delivered final message; fall back to the streamed buffer.
      run.settle({ status, error, text: run.finalText || run.text });
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
        // An app-only signal. Rollouts carry no record that the user was ever
        // asked, so the sidecar's approval_decline weight is unreachable from
        // replayed history — these two events are the app's unique
        // contribution to the corpus.
        observeLearning(
          "approval_requested",
          typeof params.threadId === "string" ? params.threadId : null,
          String(payload.command ?? "approval"),
          { kind: String(payload.kind ?? "command") },
        );
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
        const requestId = `apr_${APPROVAL_BOOT}_${nextEngineApproval++}`;
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
        const requestId = `apr_${APPROVAL_BOOT}_${nextEngineApproval++}`;
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
        const args = (params as { arguments?: unknown }).arguments;
        // Three families now, dispatched by prefix rather than by assuming
        // the browser owns every dynamic tool.
        const call = tool.startsWith("schedule_")
          ? handleScheduleToolCall(tool, args, approvalThread)
          : tool.startsWith("memory_")
            ? handleMemoryToolCall(tool, args, approvalThread)
            : handleAgentBrowserCall(tool, args, approvalThread);
        void call
          .catch((err) => ({
            contentItems: [{ type: "inputText" as const, text: `tool crashed: ${String(err)}` }],
            success: false,
          }))
          .then((response) => engine.respond(msg.id, response));
        return;
      }
      // MCP tool calls. codex gates each one behind an elicitation request,
      // and until this branch existed the generic decline below answered it
      // with the wrong shape — so every MCP tool call failed as "user
      // rejected MCP tool call".
      if (msg.method === "mcpServer/elicitation/request") {
        const meta = (params._meta ?? {}) as Record<string, unknown>;
        const server = typeof params.serverName === "string" ? params.serverName : "an MCP server";
        // Two flavours arrive on this method. An approval ("may I run this
        // tool?") is tagged by codex with _meta.codex_approval_kind and is
        // answerable with accept/decline. A genuine form elicitation (a
        // server asking the USER for data, per requestedSchema) needs a form
        // this app does not have — decline it, but decline it in the shape
        // codex can actually read.
        if (meta.codex_approval_kind === undefined) {
          console.warn("[app] declining MCP form elicitation from", server, "— no form UI");
          engine.respond(msg.id, { action: "decline" });
          return;
        }
        const requestId = `apr_${APPROVAL_BOOT}_${nextEngineApproval++}`;
        pendingApprovals.set(requestId, { kind: "elicitation", rpcId: msg.id, threadId: approvalThread });
        deliverApproval({
          requestId,
          kind: "mcpTool",
          // Deliberately NOT attached to the in-flight mcpToolCall card: the
          // request carries no item id, and inferring "the most recent one"
          // is precisely how an approval lands on the wrong card (fixed in
          // 1.2.3, twice). A standalone card costs one row and cannot
          // mis-answer.
          itemId: null,
          command: `${server} tool call`,
          cwd: null,
          reason: typeof meta.tool_description === "string" ? meta.tool_description : null,
          // codex writes the question itself — "Allow the X MCP server to run
          // tool \"y\"?" — and it is the only place the tool's name appears.
          // Re-deriving it here would just drift from the engine.
          message: typeof params.message === "string" ? params.message : null,
        });
        return;
      }
      // Anything we don't render yet (user-input tools, permissions):
      // declining beats hanging the turn on a question nobody can see.
      console.warn("[app] declining unhandled server request:", msg.method);
      engine.respond(msg.id, { decision: "decline" });
    },
  );
}

// ── Where file dialogs open ─────────────────────────────────────────────
// A picker that always starts from the same place makes the user re-walk the
// same tree every time. macOS remembers per-app, not per-purpose, so
// "Attach a file" and "Open a project" fought over one position; keying the
// memory by purpose lets each reopen where that particular job left off.
//
// Deliberately NOT falling back to mainCwd for the project pickers: the whole
// point of opening a project is that you are leaving the current one.

type DialogKey = "project" | "projectLocation" | "attach" | "skills";

function dialogDirsFile(): string {
  return join(app.getPath("userData"), "dialog-dirs.json");
}

function loadDialogDirs(): Partial<Record<DialogKey, string>> {
  try {
    const parsed = JSON.parse(readFileSync(dialogDirsFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The remembered directory, or undefined — a folder that has since been
 *  moved or deleted must not be handed to the dialog, which would either
 *  error or silently ignore it. */
function lastDialogDir(key: DialogKey): string | undefined {
  const dir = loadDialogDirs()[key];
  if (!dir) return undefined;
  try {
    return statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remember where a pick happened.
 *
 * `asParent` is the difference between "choose a thing" and "choose a place".
 * Picking the project /Work/unbiased-app should reopen at /Work, listing its
 * siblings — reopening *inside* the project you just chose is never what you
 * want next. Picking a location to create in is already the place, so it is
 * stored as-is.
 */
function rememberDialogDir(key: DialogKey, chosen: string, asParent = true): void {
  try {
    const dir = asParent ? dirname(chosen) : chosen;
    if (!statSync(dir).isDirectory()) return;
    writeFileSync(dialogDirsFile(), JSON.stringify({ ...loadDialogDirs(), [key]: dir }, null, 2) + "\n");
  } catch {
    // Best effort — a picker that forgets is a small annoyance, not a failure.
  }
}

// ── Scheduled tasks ─────────────────────────────────────────────────────
// The clock. `scheduler.ts` owns the records and the calendar arithmetic;
// this half owns the engine.
//
// A scheduled run is an ordinary thread and an ordinary turn — the same path
// a typed message takes — with two deliberate differences:
//
//   approvalPolicy: "never" + sandbox: "read-only"
//
// Nobody is watching at 8am. Under the interactive "ask" policy
// (`on-request`) an escalation would raise an approval card into an empty
// room and the turn would block on it until the app quit. `never` means the
// engine stops asking: reads run, anything needing escalation fails and the
// model adapts or reports. It is the one place in this app that deliberately
// runs a turn no human is going to answer for.

/** Marks a thread as a scheduled run. Scheduled runs are output you review
 *  from the Scheduled page, not conversations you are holding, so they stay
 *  out of the sidebar — the same treatment sub-agent threads get. */
const SCHEDULED_THREAD_SOURCE = "unbiased_scheduled_task";

function tasksDir(): string {
  return app.getPath("userData");
}

/** "Weekdays at 8:00 AM" — the same sentence the list shows, so the approval
 *  card and the row the user lands on describe the schedule identically. */
function describeSchedule(s: ScheduleSpec): string {
  const clock = (time: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!m) return time;
    const h = Number(m[1]);
    return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
  };
  const names: Record<string, string> = {
    MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun",
  };
  switch (s.type) {
    case "hourly":
      return s.intervalHours === 1 ? "Every hour" : `Every ${s.intervalHours} hours`;
    case "daily":
      return `Daily at ${clock(s.time)}`;
    case "weekdays":
      return `Weekdays at ${clock(s.time)}`;
    case "weekly":
      return `${s.days.map((d) => names[d] ?? d).join(", ")} at ${clock(s.time)}`;
  }
}

/**
 * The `schedule_create` dynamic tool.
 *
 * Nothing is written before the human says yes. The card carries the whole
 * proposal — name, cadence, working directory and the verbatim prompt — because
 * the prompt is the part that actually matters and the part the user never
 * wrote: approving a task means approving text the model composed, which will
 * run unattended on a schedule. Summarising it would defeat the point.
 */
async function handleScheduleToolCall(
  tool: string,
  rawArgs: unknown,
  threadId: string | null,
): Promise<DynamicToolResponse> {
  const text = (t: string, ok: boolean): DynamicToolResponse => ({
    contentItems: [{ type: "inputText", text: t }],
    success: ok,
  });
  if (tool !== "schedule_create") return text(`Unknown scheduling tool ${tool}.`, false);

  const a = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const name = typeof a.name === "string" ? a.name.trim() : "";
  const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
  if (!name) return text("A name is required.", false);
  if (name.length > MAX_NAME_CHARS) return text(`Keep the name under ${MAX_NAME_CHARS} characters.`, false);
  if (!prompt) return text("A prompt is required — say what each run should do.", false);
  if (prompt.length > MAX_PROMPT_CHARS) {
    return text(`Keep the instructions under ${MAX_PROMPT_CHARS} characters.`, false);
  }

  const repeat = typeof a.repeat === "string" ? a.repeat : "";
  const raw =
    repeat === "hourly"
      ? { type: "hourly", intervalHours: a.intervalHours }
      : repeat === "weekly"
        ? { type: "weekly", days: a.days, time: a.time }
        : { type: repeat, time: a.time };
  const checked = validateSchedule(raw);
  if ("error" in checked) return text(`${checked.error} (repeat was ${JSON.stringify(repeat)})`, false);

  const existing = readTasks();
  if (existing.length >= MAX_TASKS) return text(`The user is at the limit of ${MAX_TASKS} scheduled tasks.`, false);

  // An explicit path wins over the conversation's own, so "every morning,
  // summarise what I did in ~/work/api" targets that repo rather than whatever
  // project the chat happens to sit in. Checked here rather than at run time:
  // a typo caught now is a sentence the model can fix, while the same typo
  // found at 9am is a silent fallback to the wrong directory.
  const asked = typeof a.projectPath === "string" ? a.projectPath.trim() : "";
  if (asked) {
    if (!isAbsolute(asked)) return text(`projectPath must be an absolute path (got ${JSON.stringify(asked)}).`, false);
    if (!existsSync(asked)) return text(`No such directory: ${asked}`, false);
    if (!statSync(asked).isDirectory()) return text(`${asked} is a file, not a directory.`, false);
  }
  // The run inherits the conversation's directory unless one was named, so
  // the card names whichever it will actually use.
  const cwd = asked || mainCwd || defaultChatDir();
  const cadence = describeSchedule(checked.schedule);
  const decision = await requestLocalApproval(
    threadId,
    `Schedule "${name}" — ${cadence}`,
    [
      `Runs: ${cadence}`,
      `In: ${cwd}`,
      "Access: read-only files, and it never stops to ask while running.",
      "It can use the signed-in Agent browser as you — so it can read and act on",
      "sites you are logged into.",
      "",
      "It will run this each time:",
      prompt,
    ].join("\n"),
  );
  if (decision === "decline") {
    return text("The user declined the scheduled task. Do not create it, and do not offer again unless asked.", false);
  }

  const now = new Date().toISOString();
  const task: ScheduledTask = {
    key: `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    prompt,
    schedule: checked.schedule,
    enabled: true,
    // The scratch directory is not a project. Recording it as one is what
    // made the form announce "Runs in /Users/naveen/Unbiased" for a task that
    // never touches the filesystem — a real-looking path for a detail that
    // does not apply.
    projectPath: asked || (mainCwd && mainCwd !== defaultChatDir() ? mainCwd : null),
    createdAt: now,
    cursorAt: now,
    lastRunAt: null,
    lastStatus: null,
    lastVerdict: null,
    lastVerdictNote: null,
    lastError: null,
    lastThreadId: null,
    missedAt: null,
  };
  const next = [...existing, task];
  writeTasks(next);
  send("scheduled:updated", { tasks: decorate(next) });

  // A row in the transcript with a link through to the task itself — the user
  // approved a proposal, so the result should be somewhere they can go and see,
  // not just a sentence the model reports back.
  const paneId = paneForThread(rootThreadOf(threadId)) ?? "main";
  send("chat:scheduled-created", { paneId, key: task.key, name, cadence });

  const due = dueAt(task);
  return text(
    `Created and armed "${name}" — ${cadence}. First run ${due.toLocaleString()}. ` +
      "It is listed under Scheduled in the sidebar, where the user can pause, edit or run it now.",
    true,
  );
}

// ── Memory tools (model-initiated) ──────────────────────────────────────
async function handleMemoryToolCall(
  tool: string,
  rawArgs: unknown,
  threadId: string | null,
): Promise<DynamicToolResponse> {
  const text = (t: string, ok: boolean): DynamicToolResponse => ({
    contentItems: [{ type: "inputText", text: t }],
    success: ok,
  });
  const dir = memoryDirForThread(threadId);
  // Plan mode promises a read-only turn and enforces it with a hard sandbox
  // override — but these tools run app-side, outside that sandbox, so the
  // promise is only as good as this check. Refusing in prose (rather than
  // withholding the tools) because tools are declared per THREAD while plan
  // mode toggles per TURN: there is nothing to withdraw mid-conversation.
  if (planMode) {
    return text(
      "Plan mode is read-only, so memory cannot be changed right now. Say what you would save and " +
        "the user can turn plan mode off if they want it kept.",
      false,
    );
  }

  if (tool === "memory_forget") {
    const rawName = (rawArgs as Record<string, unknown>)?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    // The one destructive operation in the feature: no trash, no undo, and
    // the note may be one another conversation relies on. It is also the
    // half a "Saved memory" row cannot cover after the fact — so it asks
    // first, the way schedule_create does.
    const decision = await requestLocalApproval(
      threadId,
      `Forget memory "${name}"`,
      [
        `Deletes ${join(dir, `${name}.md`)}`,
        "",
        "Future conversations in this project will no longer see it. This cannot be undone.",
      ].join("\n"),
    );
    if (decision === "decline") {
      return text("The user declined. Keep the memory and do not offer to remove it again unless asked.", false);
    }
    const r = deleteMemoryNote(dir, name);
    if (!("error" in r)) {
      // The negative label the sidecar has none of: a human said this belief
      // was wrong. Refuting by name is best-effort — the lesson id is the
      // sidecar's, and only lessons proposed AS memories will match — so a
      // miss is an unknown_lesson result, not a failure.
      learning?.refuteLesson(`memory:${name}`, "user asked to forget the memory this became");
      observeLearning("assistant_message", threadId, `forgot memory ${name}`, { memoryForgotten: name });
    }
    return "error" in r ? text(r.error, false) : text(`Forgot "${name}". It will not appear in future conversations.`, true);
  }
  if (tool !== "memory_save") return text(`Unknown memory tool ${tool}.`, false);

  const checked = validateMemory(rawArgs);
  if ("error" in checked) return text(checked.error, false);
  // Redact before persisting, not just at display: a leaked secret in a note
  // would otherwise round-trip into every future thread's instructions. The
  // display boundary (send/redactSecrets) cannot catch it later because the
  // engine reads the file straight from disk.
  const note = redactSecrets({
    ...checked.note,
    originThreadId: threadId ? rootThreadOf(threadId) : null,
    modified: new Date().toISOString(),
  });
  const saved = saveMemoryNote(dir, note);
  if ("error" in saved) return text(saved.error, false);

  // A visible row in the transcript: no approval gate on saves, so the write
  // must at least be seen where it happened. Delivered ONLY to the pane that
  // owns this thread — the `?? "main"` fallback the schedule handler uses is
  // wrong here, because a thread with no pane (a backgrounded conversation)
  // would drop its row into whatever chat happens to be on screen, and the
  // main pane persists its transcript, so the foreign row would be saved
  // into that unrelated conversation for good.
  // A human-validated label, and free: the user let this stand. The corpus
  // has almost no strong signal of its own, so a save is worth recording.
  observeLearning("assistant_message", threadId, `saved memory ${note.name}: ${note.description}`, {
    memorySaved: note.name,
  });
  const paneId = paneForThread(rootThreadOf(threadId));
  if (paneId) {
    // Flag saves that came from a SUB-AGENT. They are routed to the parent's
    // pane but belong to no turn of that conversation, and a sub-agent
    // outlives the turn that spawned it — so the renderer must not splice
    // the receipt onto whatever answer happens to be last, which would
    // attribute the write to a finished turn that never made it.
    const fromSubAgent = !!(threadId && subAgents.has(threadId));
    send("chat:memory-saved", {
      paneId,
      name: note.name,
      description: note.description,
      path: saved.path,
      fromSubAgent,
    });
  }

  return text(
    `Saved "${note.name}" to this project's memory (${saved.path}). Future conversations in this ` +
      "project will see its description in their index.",
    true,
  );
}

const SCHEDULE_TICK_MS = 30_000;
/** A scheduled turn that has not finished in this long is abandoned. The
 *  engine client has no per-request timeout, so without a cap here a wedged
 *  run would hold its slot until the app quit. */
const RUN_TIMEOUT_MS = 10 * 60_000;

let scheduleTimer: NodeJS.Timeout | null = null;
/** Runs in flight, by engine threadId, so the notification listener below can
 *  accumulate their output without touching the main event switch. */
/** finalText: the last delivered agentMessage (the answer). text: the streamed
 *  accumulation, kept as a fallback for engines/turns that only stream. */
const scheduledRuns = new Map<
  string,
  {
    key: string;
    text: string;
    finalText: string;
    settle: (r: { status: RunStatus; error: string | null; text: string }) => void;
  }
>();
/** Guards against a slow run overlapping its own next tick — and now also
 *  carries WHAT is running, so the UI can open the live conversation and stop
 *  it. Before this, a run in flight was a boolean: you could see that
 *  something was happening and do nothing about it. */
const runningTaskKeys = new Map<string, { threadId: string | null; turnId: string | null }>();

function readTasks(): ScheduledTask[] {
  // Older tasks stored the scratch directory as their project, because a plain
  // chat's cwd IS the scratch directory. Normalise on read rather than
  // migrating the file: the answer is derived, so it stays correct if the
  // scratch location ever moves.
  const scratch = defaultChatDir();
  return loadTasks(tasksDir()).map((t) => (t.projectPath === scratch ? { ...t, projectPath: null } : t));
}

function writeTasks(tasks: ScheduledTask[]): void {
  saveTasks(tasksDir(), tasks);
}

/** Patch one task in place on disk and tell the renderer. */
function updateTask(key: string, patch: Partial<ScheduledTask>): ScheduledTask[] {
  const tasks = readTasks().map((t) => (t.key === key ? { ...t, ...patch } : t));
  writeTasks(tasks);
  send("scheduled:updated", { tasks: decorate(tasks) });
  return tasks;
}

/** Add the derived fields the renderer shows but should not compute: the next
 *  firing, and whether a run is in flight right now. */
function decorate(tasks: ScheduledTask[]): unknown[] {
  return tasks.map((t) => ({
    ...t,
    nextDueAt: t.enabled ? dueAt(t).toISOString() : null,
    running: runningTaskKeys.has(t.key),
    // The conversation this run is happening in, while it is happening.
    runningThreadId: runningTaskKeys.get(t.key)?.threadId ?? null,
  }));
}

/**
 * Run one task now. Resolves with the assistant's reply, or with the failure —
 * a scheduled run never throws at its caller, because both callers (the tick
 * and the Run now button) only want to record what happened.
 */
async function runScheduledTask(
  task: ScheduledTask,
  trigger: "schedule" | "manual",
): Promise<{ status: RunStatus; error: string | null; text: string }> {
  if (runningTaskKeys.has(task.key)) {
    return { status: "failed", error: "already running", text: "" };
  }
  runningTaskKeys.set(task.key, { threadId: null, turnId: null });
  send("scheduled:run-state", { key: task.key, running: true });
  let threadId: string | null = null;
  try {
    const cwd = task.projectPath && existsSync(task.projectPath) ? task.projectPath : defaultChatDir();
    // Browser tools, but NOT schedule_create. Withholding every dynamic tool
    // did make self-scheduling structurally impossible, and it also banned the
    // browser — which is the whole point of most scheduled work (watch a page,
    // update a status). Excluding just the scheduling tool keeps the property
    // that matters and returns the capability that was never meant to go.
    const started = (await engine.request("thread/start", {
      approvalPolicy: "never",
      sandbox: "read-only",
      cwd,
      // The run READS memory (its index rides these instructions) but cannot
      // WRITE it. Giving an unattended run memory tools looked right — runs
      // share no conversation, so a note is their only way to tell the next
      // run — but it hands a context that never asks for approval, that
      // browses attacker-controlled pages with pre-granted access (see the
      // grants below), and that nobody is watching, a channel that persists
      // into the developer instructions of EVERY future conversation in this
      // project. That is durable prompt injection, and no amount of
      // after-the-fact visibility fixes it: there is no one there to see it.
      developerInstructions: developerInstructionsFor(cwd),
      dynamicTools: agentBrowserTools(),
      // Tag it so the sidebar can leave it out. threadSource is a free-form
      // client string the engine hands straight back in thread/list, which
      // beats keeping our own ledger of run ids: the answer travels with the
      // thread, so it stays right for runs from previous app versions and
      // needs no pruning.
      threadSource: SCHEDULED_THREAD_SOURCE,
    })) as { thread: { id: string } };
    threadId = started.thread.id;
    threadCwds.set(threadId, cwd); // memory_save from this run targets ITS project
    runningTaskKeys.set(task.key, { threadId, turnId: null });
    // Push the live thread out immediately, so "Open run" works from the
    // moment the run starts rather than only once it has finished.
    send("scheduled:updated", { tasks: decorate(readTasks()) });

    // Pre-authorise the browser for this run. ensureBrowserAllowed would
    // otherwise raise a permission card into a conversation with no pane, and
    // an unattended run has nobody to answer it — the request would sit in
    // heldApprovals until the 10-minute cap killed the turn. The consent is
    // real, it just happened earlier: creating the task showed the user a card
    // carrying the verbatim prompt, and these tasks say "log into my Slack" in
    // so many words.
    browserConnectGrants.add(threadId);
    browserNetGrants.add(threadId);

    const settled = new Promise<{ status: RunStatus; error: string | null; text: string }>((resolve) => {
      scheduledRuns.set(threadId!, { key: task.key, text: "", finalText: "", settle: resolve });
    });
    // `timedOut` rather than matching the message text: the interrupt below
    // keys off this, and a reworded error would silently stop it firing.
    const timeout = new Promise<{ status: RunStatus; error: string | null; text: string; timedOut?: boolean }>((resolve) =>
      setTimeout(
        () =>
          resolve({
            status: "failed",
            error: `timed out after ${RUN_TIMEOUT_MS / 60_000} minutes`,
            text: "",
            timedOut: true,
          }),
        RUN_TIMEOUT_MS,
      ),
    );

    const startedTurn = (await engine.request("turn/start", {
      threadId,
      // The contract rides along at run time and is never stored, so the
      // prompt the user wrote (and tunes) stays exactly theirs.
      input: [{ type: "text", text: task.prompt + VERDICT_CONTRACT }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    })) as { turn?: { id?: string } };
    // turn/interrupt requires BOTH ids, so a stop button is impossible
    // without keeping this.
    runningTaskKeys.set(task.key, { threadId, turnId: startedTurn.turn?.id ?? null });

    const outcome = await Promise.race([settled, timeout]);
    // A timeout that only settles OUR promise is not a limit — it stops the
    // app watching while the agent keeps going. Observed: a run recorded as
    // failed at the ten-minute cap carried on driving the user's signed-in
    // Slack for minutes afterwards, invisible, because the bookkeeping and
    // the engine had come apart. The turn has to actually be interrupted.
    if ((outcome as { timedOut?: boolean }).timedOut) {
      const live = runningTaskKeys.get(task.key);
      if (live?.threadId && live.turnId) {
        try {
          await engine.request("turn/interrupt", { threadId: live.threadId, turnId: live.turnId });
          console.log(`[scheduled] interrupted "${task.name}" at the ${RUN_TIMEOUT_MS / 60_000}-minute cap`);
        } catch (err) {
          // Worth saying loudly: the cap has failed to bite and something is
          // still running with the user's sessions.
          console.error(`[scheduled] could not interrupt "${task.name}" after timeout:`, err);
        }
      }
    }
    const now = new Date().toISOString();
    // Only a completed turn can carry a meaningful verdict; a failure or an
    // interrupt is already the outcome.
    const verdict = outcome.status === "completed" ? parseRunVerdict(outcome.text) : { verdict: null, note: null };
    updateTask(task.key, {
      cursorAt: now,
      lastRunAt: now,
      lastStatus: outcome.status,
      lastVerdict: verdict.verdict,
      lastVerdictNote: verdict.note,
      lastError: outcome.error,
      lastThreadId: threadId,
      missedAt: null,
    });
    console.log(
      `[scheduled] ${trigger} run of "${task.name}" ${outcome.status}` +
        (verdict.verdict ? ` (agent reported: ${verdict.verdict}${verdict.note ? ` - ${verdict.note}` : ""})` : ""),
    );
    if (trigger === "schedule") notifyScheduledRun(task, outcome, threadId);
    return outcome;
  } catch (err) {
    const now = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    updateTask(task.key, {
      cursorAt: now,
      lastRunAt: now,
      lastStatus: "failed",
      lastVerdict: null,
      lastVerdictNote: null,
      lastError: message,
      lastThreadId: threadId,
      missedAt: null,
    });
    return { status: "failed", error: message, text: "" };
  } finally {
    if (threadId) {
      scheduledRuns.delete(threadId);
      // Scoped to the run, not the session: a task's grant must not outlive it.
      browserConnectGrants.delete(threadId);
      browserNetGrants.delete(threadId);
    }
    runningTaskKeys.delete(task.key);
    send("scheduled:run-state", { key: task.key, running: false });
  }
}

/** Tell the user a scheduled run finished. Without this the result only
 *  exists inside the app: a run that fires while they are in another window
 *  leaves no trace they would notice, which for the "have it ready before I
 *  sit down" tasks these exist for is the difference between the feature
 *  landing and not. Manual Run now is deliberately silent — they are already
 *  looking at it. Clicking through opens the run itself. */
function notifyScheduledRun(task: ScheduledTask, outcome: { status: RunStatus; error: string | null; text: string }, threadId: string | null): void {
  if (!Notification.isSupported()) return;
  const summary = outcome.text.replace(/\s+/g, " ").trim();
  const reported = outcome.status === "completed" ? parseRunVerdict(outcome.text) : { verdict: null, note: null };
  const body =
    outcome.status === "completed"
      ? (reported.verdict === "failed" ? `Didn't finish the job: ${reported.note ?? "see the run"}. ` : "") +
          (summary.slice(0, 180) || "Finished with nothing to report.")
      : `${outcome.status === "interrupted" ? "Stopped" : "Failed"}${outcome.error ? `: ${outcome.error}` : ""}`;
  const n = new Notification({ title: task.name, body, silent: false });
  n.on("click", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (threadId) send("scheduled:open-run", { threadId });
  });
  n.show();
}

/**
 * Anything that came due while the app was closed runs now, one at a time.
 *
 * This used to only MARK them missed, on the reasoning that three days
 * offline should not cost three turns the moment the window opens. That
 * reasoning was wrong about what these tasks are: a morning brief exists so
 * the answer is waiting, and a row saying "Missed — Run now" just moves the
 * work to the moment the user sits down, which is exactly what they wanted to
 * avoid. Note that a backlog is bounded by TASKS, not by slots — a daily task
 * missed for a week runs once, against today's state, because the prompt is
 * standing instructions and the answer it wants is about now.
 *
 * Sequential on purpose: firing every missed task at once would put N engine
 * threads in flight against a gateway that bills per call, at the least
 * convenient moment (launch). missedAt stays set until the run settles, so
 * the row reads "Missed" while it is catching up rather than looking idle.
 */
async function catchUpMissed(): Promise<void> {
  const now = new Date();
  const due = readTasks().filter((t) => isDue(t, now));
  if (due.length === 0) return;
  const marked = readTasks().map((t) =>
    due.some((d) => d.key === t.key) ? { ...t, cursorAt: now.toISOString(), missedAt: dueAt(t).toISOString() } : t,
  );
  writeTasks(marked);
  send("scheduled:updated", { tasks: decorate(marked) });
  for (const task of due) {
    if (runningTaskKeys.has(task.key)) continue;
    console.log(`[scheduled] "${task.name}" was due while closed — running it now`);
    await runScheduledTask(task, "schedule");
  }
}

function scheduleTick(): void {
  const now = new Date();
  for (const task of readTasks()) {
    if (!isDue(task, now) || runningTaskKeys.has(task.key)) continue;
    void runScheduledTask(task, "schedule");
  }
}

/** Called once the engine is connected — there is nothing to run a task with
 *  before that, and the engine only starts after sign-in. */
function startScheduler(): void {
  if (scheduleTimer) return;
  void catchUpMissed();
  scheduleTimer = setInterval(scheduleTick, SCHEDULE_TICK_MS);
  // Anything due in the seconds between launch and the first tick.
  scheduleTick();
}

function stopScheduler(): void {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = null;
}

let engineWired = false;
/** One running proxy per secret-bearing connector, keyed by name. */
const secretProxies = new Map<string, { server: HttpServer; fingerprint: string }>();

/**
 * Reconcile the secret proxies with the config. Runs before every engine
 * start because the plugin files codex is about to read point at these ports
 * — a proxy that comes up after codex dials is a connection refused, and one
 * left running for a removed connector keeps a dead secret in memory.
 */
async function syncSecretProxies(): Promise<void> {
  let servers: { name?: string; url?: string; oauthClientId?: string; oauthClientSecret?: string; enabled?: boolean }[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath("home"), ".unbiased", "mcp-servers.json"), "utf8")) as {
      servers?: typeof servers;
    };
    servers = raw.servers ?? [];
  } catch {
    servers = [];
  }
  const wanted = new Map<string, SecretConnector>();
  for (const sv of servers) {
    if (!sv.name || !sv.url || !sv.oauthClientId || !sv.oauthClientSecret) continue;
    if (sv.enabled === false) continue;
    wanted.set(sv.name, { name: sv.name, upstreamUrl: sv.url, clientId: sv.oauthClientId, clientSecret: sv.oauthClientSecret });
  }
  for (const [name, live] of secretProxies) {
    const want = wanted.get(name);
    const fingerprint = want ? `${want.upstreamUrl}|${want.clientId}|${want.clientSecret}` : "";
    if (!want || live.fingerprint !== fingerprint) {
      live.server.close();
      secretProxies.delete(name);
    }
  }
  for (const [name, want] of wanted) {
    if (secretProxies.has(name)) continue;
    try {
      const server = await startSecretProxy(want, {
        // Status and grant type only — never the form body, which carries the
        // authorization code, the refresh token and the secret itself.
        log: (msg) => console.log(`[oauth-proxy:${name}] ${msg}`),
      });
      secretProxies.set(name, { server, fingerprint: `${want.upstreamUrl}|${want.clientId}|${want.clientSecret}` });
    } catch (err) {
      console.error(`[oauth-proxy] could not start for ${name}:`, err);
    }
  }
}

async function startEngine(): Promise<void> {
  await syncSecretProxies();
  // Fire-and-forget: the page refreshes on open anyway, and nothing about
  // starting the engine should wait on GitHub.
  void refreshCatalogueAtStartup();
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
  // extraRoots is session state, so it has to be re-sent after every engine
  // start. It cannot live in the Go supervisor: that process execs itself away
  // before any JSON-RPC happens.
  try {
    await engine.request("skills/extraRoots/set", { extraRoots: skillRoots() });
  } catch (err) {
    // Not fatal — project skills still work, and the panel reports the gap.
    console.error("[skills] extraRoots/set failed:", err);
  }
  pushStatus({
    state: "connected",
    userAgent: result.userAgent,
    engineVersion: engineVersionFromUserAgent(result.userAgent),
    codexHome: result.codexHome,
  });
  // Only now is there something to run a task WITH. Idempotent, so a
  // re-login after a sign-out simply resumes the existing timer.
  startScheduler();
  // After the engine, and never blocking it: an absent or broken sidecar
  // leaves the app exactly as it was.
  void startLearning();
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

  ipcMain.handle("changelog:releases", () => ({ releases: loadReleaseNotes() }));

  ipcMain.handle("update:prefs", () => ({
    autoDownload: updatePrefs().autoDownload,
    version: app.getVersion(),
    lastCheckedAt: lastUpdateCheck || null,
  }));
  ipcMain.handle("update:set-prefs", (_e, p: { autoDownload: boolean }) => {
    setUpdatePrefs({ autoDownload: !!p.autoDownload });
    // Turning it on mid-session should act now, not in six hours.
    if (p.autoDownload && pendingUpdate && !stagedUpdate && !updateInstalling) {
      // Capture: pendingUpdate is module state and a 6h check could swap it
      // mid-download; the announcement must name what was actually staged.
      const toStage = pendingUpdate;
      silentInstall = true;
      void installUpdate(toStage).then(() => {
        silentInstall = false;
        send("update:available", toStage); // same invisibility fix as above
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
    return { hasKey: !!stored, source: stored?.source ?? null, browserSignIn: !!OAUTH_CLIENT_ID };
  });

  // Validate a key (or the stored one) against the platform. Pure check —
  // no persistence, no engine start.
  ipcMain.handle("auth:validate", async (_e, key?: string) => {
    const k = (key ?? readStoredKey()?.key ?? "").trim();
    if (!k) return { ok: false, error: "No API key to validate." };
    return whoamiValidate(k);
  });

  // Validate, persist (unless the key comes from the environment), then
  // (re)start the engine with it. Returns the whoami identity. The one path
  // to a signed-in engine, whether the key was pasted or issued by the browser flow.
  async function completeSignIn(key: string): Promise<WhoamiResult> {
    const who = await whoamiValidate(key);
    if (!who.ok) return who;
    // Only persist a user-entered key; an env key is the environment's to own.
    if (key !== process.env.UNBIASED_API_KEY?.trim()) {
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
  }

  ipcMain.handle("auth:login", async (_e, payload: { key?: string }) => {
    const key = (payload?.key ?? process.env.UNBIASED_API_KEY?.trim() ?? readStoredKey()?.key ?? "").trim();
    if (!key) return { ok: false, error: "No API key provided." };
    return completeSignIn(key);
  });

  // ── Browser sign-in ─────────────────────────────────────────────────
  // The platform's device authorization flow (src/main/device-auth.ts): ask
  // for a code, open the person's own browser on the platform to confirm it,
  // poll until the platform hands back a freshly minted key, then sign in
  // with that key exactly as if it had been pasted. One flow at a time —
  // starting another cancels the previous poll, so two loops never race to
  // write credentials.
  let deviceFlow: { controller: AbortController; result: Promise<WhoamiResult> } | null = null;

  ipcMain.handle("auth:device-start", async () => {
    if (!OAUTH_CLIENT_ID) return { ok: false, error: "Browser sign-in isn't available in this build." };
    deviceFlow?.controller.abort();
    const controller = new AbortController();
    const started = await requestDeviceAuthorization({
      baseUrl: PLATFORM_BASE,
      clientId: OAUTH_CLIENT_ID,
      // Display-only on the platform; it seeds the workload name when the
      // person picks "new workload" there.
      deviceName: hostname().replace(/\.local$/, ""),
      signal: controller.signal,
    });
    if (!started.ok) return started;
    const { grant } = started;
    void shell.openExternal(grant.verificationUriComplete);
    const result = pollDeviceToken({
      baseUrl: PLATFORM_BASE,
      clientId: OAUTH_CLIENT_ID,
      grant,
      signal: controller.signal,
    }).then((token) => (token.ok ? completeSignIn(token.accessToken) : token));
    deviceFlow = { controller, result };
    return {
      ok: true,
      userCode: grant.userCode,
      verificationUri: grant.verificationUri,
      verificationUriComplete: grant.verificationUriComplete,
      expiresIn: grant.expiresIn,
    };
  });

  // Settles when the flow ends: signed in, declined, expired, or canceled.
  ipcMain.handle("auth:device-wait", async () => {
    const flow = deviceFlow;
    if (!flow) return { ok: false, error: "No browser sign-in is in progress." };
    const who = await flow.result;
    if (deviceFlow === flow) deviceFlow = null;
    return who;
  });

  ipcMain.handle("auth:device-cancel", () => {
    deviceFlow?.controller.abort();
    return { ok: true };
  });

  // Sign out: stop the engine and remove the stored credentials file. An
  // env-provided key can't be removed by us — report that so the UI can say so.
  ipcMain.handle("auth:logout", (_e, opts?: { removeKey?: boolean }) => {
    engine.stop();
    // Without this the timer keeps firing against a dead engine, turning
    // every scheduled task into a "engine not running" failure row.
    stopScheduler();
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
          // A fork copies CONVERSATION, not per-thread config: without these
          // three a side chat had no browser tools, no app instructions and no
          // raw item stream, so "use the agent browser" in a side chat was
          // answered with "I don't have that tool" — correctly, because it
          // didn't. Every sibling thread/start below passes the same three.
          // `dynamicTools` and `experimentalRawEvents` are experimentalApi
          // fields absent from ThreadForkParams in the schema; the engine
          // ignores params it does not know (verified against 0.147.0), so
          // this is safe either way — but see the note in HOW-IT-WORKS: a
          // version bump could start dropping them without any error.
          dynamicTools: threadDynamicTools(),
          developerInstructions: developerInstructionsFor(mainCwd),
          experimentalRawEvents: true,
        })) as { thread: { id: string } };
      } else if (paneId.startsWith("side")) {
        // No parent conversation yet: a plain scratch thread.
        started = (await engine.request("thread/start", {
          ...threadPolicy(),
          ephemeral: true,
          experimentalRawEvents: true,
          dynamicTools: threadDynamicTools(),
          developerInstructions: developerInstructionsFor(mainCwd),
        })) as { thread: { id: string } };
      } else {
        // Explicit default when no project is chosen — left implicit, the
        // engine falls back to its own process cwd (wherever the app
        // launched from) and the chat wrongly files under that project.
        let cwd = pendingCwd ?? defaultChatDir();
        if (pendingCwd && workMode === "worktree") {
          const wt = await createWorktree(pendingCwd, text);
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
          dynamicTools: threadDynamicTools(),
          developerInstructions: developerInstructionsFor(cwd),
          // Raw response items feed the sub-agent viewer (task text + spawn
          // instructions). Sub-threads inherit this from their parent.
          experimentalRawEvents: true,
        })) as { thread: { id: string }; cwd?: string };
        mainCwd = (started as { cwd?: string }).cwd ?? cwd;
      }
      pane.threadId = started.thread.id;
      // Side/fork threads inherit the main conversation's cwd; the main
      // branch just set mainCwd above. Recorded so a memory_save from any of
      // them resolves to the right project's store.
      threadCwds.set(started.thread.id, mainCwd ?? defaultChatDir());
      // The scope-bearing event, using the SAME resolution memory uses: a
      // worktree belongs to its parent project. The sidecar cannot derive
      // this — cwd cannot tell /a/api from /b/api, and it has no worktree
      // knowledge at all — so the app declares it.
      if (learning?.isReady) {
        const at = mainCwd ?? defaultChatDir();
        learning.observe(
          buildTaskMeta({
            threadId: started.thread.id,
            cwd: at,
            projectKey: loadWorktrees()[at]?.project ?? at,
          }),
        );
      }
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

  // ── Scheduled tasks IPC ─────────────────────────────────────────────

  ipcMain.handle("scheduled:list", () => ({
    tasks: decorate(readTasks()),
    // The panel says so plainly rather than letting tasks look armed while
    // nothing can actually run them.
    engineReady: lastStatus.state === "connected",
  }));

  ipcMain.handle(
    "scheduled:save",
    (
      _e,
      p: { key?: string | null; name: string; prompt: string; schedule: unknown; projectPath?: string | null },
    ) => {
      const name = (p.name ?? "").trim();
      const prompt = (p.prompt ?? "").trim();
      if (!name) return { ok: false, error: "Give the task a name." };
      if (name.length > MAX_NAME_CHARS) return { ok: false, error: `Keep the name under ${MAX_NAME_CHARS} characters.` };
      if (!prompt) return { ok: false, error: "Say what the task should do." };
      if (prompt.length > MAX_PROMPT_CHARS) {
        return { ok: false, error: `Keep the instructions under ${MAX_PROMPT_CHARS} characters.` };
      }
      const checked = validateSchedule(p.schedule);
      if ("error" in checked) return { ok: false, error: checked.error };

      const tasks = readTasks();
      const existing = p.key ? tasks.find((t) => t.key === p.key) : undefined;
      if (!existing && tasks.length >= MAX_TASKS) {
        return { ok: false, error: `That's the limit of ${MAX_TASKS} scheduled tasks.` };
      }
      const projectPath = typeof p.projectPath === "string" && p.projectPath ? p.projectPath : null;
      let next: ScheduledTask[];
      if (existing) {
        // Editing the schedule re-bases the cursor: leaving it where it was
        // means a task moved from 8am to 9am can look overdue the moment it
        // is saved, and fire immediately.
        const rescheduled = JSON.stringify(existing.schedule) !== JSON.stringify(checked.schedule);
        next = tasks.map((t) =>
          t.key === existing.key
            ? {
                ...t,
                name,
                prompt,
                schedule: checked.schedule,
                projectPath,
                ...(rescheduled ? { cursorAt: new Date().toISOString(), missedAt: null } : {}),
              }
            : t,
        );
      } else {
        const now = new Date().toISOString();
        next = [
          ...tasks,
          {
            key: `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            prompt,
            schedule: checked.schedule,
            enabled: true,
            projectPath,
            createdAt: now,
            cursorAt: now,
            lastRunAt: null,
            lastStatus: null,
            lastVerdict: null,
            lastVerdictNote: null,
            lastError: null,
            lastThreadId: null,
            missedAt: null,
          },
        ];
      }
      writeTasks(next);
      const decorated = decorate(next);
      send("scheduled:updated", { tasks: decorated });
      return { ok: true, tasks: decorated };
    },
  );

  ipcMain.handle("scheduled:set-enabled", (_e, p: { key: string; enabled: boolean }) => {
    // Re-arming re-bases the cursor too — a task disabled for a week should
    // not fire the instant it is switched back on.
    const patch: Partial<ScheduledTask> = p.enabled
      ? { enabled: true, cursorAt: new Date().toISOString(), missedAt: null }
      : { enabled: false };
    const tasks = updateTask(p.key, patch);
    return { ok: true, tasks: decorate(tasks) };
  });

  ipcMain.handle("scheduled:delete", (_e, key: string) => {
    const next = readTasks().filter((t) => t.key !== key);
    writeTasks(next);
    const decorated = decorate(next);
    send("scheduled:updated", { tasks: decorated });
    return { ok: true, tasks: decorated };
  });

  /**
   * Rewrite a task's prompt with the model, grounded in screenshots.
   *
   * Exists because of a measured failure, not as a nicety: the Slack task
   * flailed for ten minutes — seventy-plus blind keypresses — because its
   * prompt said "set your status" without knowing what that UI looks like.
   * Screenshots turned into exact labels and stop rules are the repair.
   *
   * Design rules, each load-bearing:
   *  - AUGMENT, never replace. Wholesale rewrites drop the constraints the
   *    user tuned by hand (required phrases, tone). The instructions demand
   *    the user's intent and exact required wording survive verbatim.
   *  - Proposed, never applied. This returns text; the form shows old vs new
   *    and the user accepts or discards. A prompt that runs unattended for
   *    months must never change to something nobody read.
   *  - Ephemeral thread. Tuning is authoring-time tooling — it must not
   *    leave a conversation in the sidebar or survive a restart.
   *  - Interrupt on timeout, learned the hard way: a cap that only stops the
   *    app watching leaves the engine running invisibly.
   */
  ipcMain.handle(
    "scheduled:tune",
    async (_e, payload: { prompt?: string; note?: string; images?: string[] }) => {
      const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
      const note = typeof payload?.note === "string" ? payload.note.trim() : "";
      const images = Array.isArray(payload?.images) ? payload.images.filter((x): x is string => typeof x === "string") : [];
      if (!prompt) return { ok: false, error: "There is no prompt to improve yet — write a draft first." };
      if (images.length === 0 && !note) {
        return { ok: false, error: "Add a screenshot or a note — something for Pareto to work from." };
      }
      if (images.length > 4) return { ok: false, error: "Four screenshots at most — pick the ones that show the exact screens involved." };
      for (const img of images) {
        if (!isAbsolute(img) || !existsSync(img) || !statSync(img).isFile()) {
          return { ok: false, error: `Not a readable image file: ${img}` };
        }
        if (!/\.(png|jpe?g|gif|webp)$/i.test(img)) {
          return { ok: false, error: `${img} is not an image (png, jpg, gif or webp).` };
        }
      }

      const instructions = [
        "You are refining the standing instructions for a scheduled, unattended agent run. The",
        "current instructions are below, along with screenshots of the exact interface the run",
        "works in" + (note ? " and a note from the user" : "") + ".",
        "",
        "Rewrite the instructions so a fresh agent with NO memory of this conversation can follow",
        "them mechanically. Rules, all of them binding:",
        "- AUGMENT rather than replace: keep the user's intent, tone and every required phrase or",
        "  constraint from the current instructions verbatim. You are adding precision, not voice.",
        "- Ground every UI step in what the screenshots actually show: name the exact visible",
        "  labels, buttons and menus. Never invent an element that is not in a screenshot.",
        "- Make it self-contained: each run remembers nothing from previous runs.",
        "- State what success looks like, concretely, so the run knows when it is done.",
        "- State when to give up: if a step has not worked after three attempts, stop and report",
        "  what was on screen instead of trying variations. This rule must appear in the rewrite.",
        "- Plain text only. No markdown headings.",
        `- HARD LENGTH BUDGET: the rewritten instructions must be under ${MAX_PROMPT_CHARS} characters`,
        "  in total. Precision beats coverage: fold repeated caveats into one rule, and spend the",
        "  budget on the exact labels and stop conditions rather than restating the same warning",
        "  per step.",
        "",
        "Reply with ONLY the rewritten instructions between the markers, nothing else:",
        "<<<PROMPT",
        "(rewritten instructions here)",
        "PROMPT>>>",
        "",
        "Current instructions:",
        "---",
        prompt,
        "---",
        note ? `User's note: ${note}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      let threadId: string | null = null;
      try {
        const started = (await engine.request("thread/start", {
          // Ephemeral: authoring-time tooling, not a conversation — it must
          // not appear in the sidebar or persist a rollout.
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          cwd: defaultChatDir(),
          threadSource: "unbiased_prompt_tuner",
        })) as { thread: { id: string } };
        threadId = started.thread.id;

        const TUNE_TIMEOUT_MS = 3 * 60_000;
        const runTurn = async (input: unknown[]): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
          const settled = new Promise<{ status: RunStatus; error: string | null; text: string }>((resolve) => {
            scheduledRuns.set(threadId!, { key: `tune:${threadId}`, text: "", finalText: "", settle: resolve });
          });
          const timeout = new Promise<{ status: RunStatus; error: string | null; text: string; timedOut?: boolean }>(
            (resolve) => setTimeout(() => resolve({ status: "failed", error: "timed out", text: "", timedOut: true }), TUNE_TIMEOUT_MS),
          );
          const startedTurn = (await engine.request("turn/start", {
            threadId,
            input,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          })) as { turn?: { id?: string } };
          const outcome = await Promise.race([settled, timeout]);
          if ((outcome as { timedOut?: boolean }).timedOut && startedTurn.turn?.id) {
            await engine.request("turn/interrupt", { threadId: threadId!, turnId: startedTurn.turn.id }).catch(() => undefined);
            return { ok: false, error: "Pareto took too long — try again with fewer screenshots." };
          }
          if (outcome.status !== "completed") return { ok: false, error: outcome.error ?? "The rewrite did not finish." };
          return { ok: true, text: outcome.text };
        };
        const extract = (raw: string): string => {
          // The markers make extraction unambiguous; a reply without them is
          // treated as the whole answer rather than discarded, since a model
          // that ignored the framing may still have written a usable prompt.
          const m = raw.match(/<<<PROMPT\s*([\s\S]*?)\s*PROMPT>>>/);
          return (m ? m[1] : raw).trim();
        };

        const first = await runTurn([
          { type: "text", text: instructions },
          ...images.map((path) => ({ type: "localImage", path })),
        ]);
        if (!first.ok) return first;
        let proposal = extract(first.text);
        if (!proposal) return { ok: false, error: "Pareto returned nothing usable." };
        if (proposal.length > MAX_PROMPT_CHARS) {
          // One automatic compression pass on the same thread rather than an
          // error. The old behaviour told the user "try asking for something
          // tighter" — through a UI with no way to ask. The model wrote the
          // oversized draft; the model can shorten it, and the thread still
          // holds the screenshots and rules it wrote it from.
          const second = await runTurn([
            {
              type: "text",
              text:
                `Your rewrite is ${proposal.length} characters; the hard limit is ${MAX_PROMPT_CHARS}. ` +
                "Compress it to fit: merge repeated caveats into single rules, keep every exact UI label, " +
                "the required phrases, the success definition and the stop-after-three-attempts rule. " +
                "Reply with ONLY the compressed instructions between the same <<<PROMPT and PROMPT>>> markers.",
            },
          ]);
          if (second.ok) {
            const compressed = extract(second.text);
            if (compressed) proposal = compressed;
          }
        }
        if (proposal.length > MAX_PROMPT_CHARS) {
          return {
            ok: false,
            error: `Even compressed, the rewrite is ${proposal.length} characters against a limit of ${MAX_PROMPT_CHARS}. Trim the current instructions first, or tune one section at a time.`,
          };
        }
        return { ok: true, proposal };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (threadId) scheduledRuns.delete(threadId);
      }
    },
  );

  ipcMain.handle("scheduled:stop", async (_e, key: string) => {
    const live = runningTaskKeys.get(key);
    if (!live?.threadId || !live.turnId) {
      // Between thread/start and turn/start there is a window with no turn to
      // interrupt. Say so rather than reporting a stop that did not happen.
      return { ok: false, error: live ? "The run has not started its turn yet — try again in a moment." : "That task is not running." };
    }
    try {
      await engine.request("turn/interrupt", { threadId: live.threadId, turnId: live.turnId });
      // The engine answers with turn/completed status "interrupted", which the
      // scheduled-run listener settles — so the run records itself as
      // interrupted through the normal path. Nothing to unwind here.
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("scheduled:run-now", async (_e, key: string) => {
    const task = readTasks().find((t) => t.key === key);
    if (!task) return { ok: false, error: "That task no longer exists." };
    if (lastStatus.state !== "connected") return { ok: false, error: "Sign in first — the engine isn't running." };
    const outcome = await runScheduledTask(task, "manual");
    return { ok: outcome.status === "completed", ...outcome };
  });

  // The run's transcript is a real thread; opening it is the existing
  // threads:open path, so the panel only needs the id.
  ipcMain.handle("scheduled:last-run", (_e, key: string) => {
    const task = readTasks().find((t) => t.key === key);
    if (!task) return { threadId: null };
    return { threadId: task.lastThreadId, status: task.lastStatus, error: task.lastError, at: task.lastRunAt };
  });


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

  // Which approvals are actually still answerable. A card restored from the
  // transcript looks identical to a live one, so the renderer has to ask —
  // otherwise a request whose turn died with the app still shows Allow/Deny.
  // ---- MCP servers -------------------------------------------------------
  // Two different truths, deliberately reported separately: `connected` is
  // what the running engine actually has (authoritative, but empty while the
  // engine is down or before a restart), and `configured` is what the user
  // has asked for. A server present in the second and absent from the first
  // is exactly the "restart to apply" case the panel needs to show.
  function mcpConfigPath(): string {
    return join(app.getPath("home"), ".unbiased", "mcp-servers.json");
  }
  type UserMcpServer = {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    bearerTokenEnvVar?: string;
    /** Absent means on. Off keeps the entry — and its OAuth registration —
     *  while leaving it out of the engine's config. */
    enabled?: boolean;
    /** An OAuth client WE registered with the provider, so its consent screen
     *  shows Unbiased rather than codex's dynamically-registered "Codex". */
    oauthClientId?: string;
    /** Providers whose token exchange needs a secret (Google). Its presence
     *  routes the server through the engine's managed-plugin path. */
    oauthClientSecret?: string;
    scopes?: string[];
    startupTimeoutSec?: number;
    toolTimeoutSec?: number;
    enabledTools?: string[];
  };
  // Absent and unreadable are NOT the same answer. Returning [] for both let a
  // save overwrite a file we had failed to parse — a malformed file read as
  // "no servers", and the next Save wrote only the newly added one, silently
  // destroying the rest. The engine fails loudly on this file for exactly this
  // reason; so must we.
  function readMcpConfig(): { servers: UserMcpServer[]; error: string | null } {
    let text: string;
    try {
      text = readFileSync(mcpConfigPath(), "utf8");
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
      return { servers: [], error: missing ? null : `Could not read ${mcpConfigPath()}: ${String(err)}` };
    }
    try {
      const raw = JSON.parse(text) as { servers?: unknown };
      if (raw.servers !== undefined && !Array.isArray(raw.servers)) {
        return { servers: [], error: `${mcpConfigPath()} has a "servers" value that is not a list.` };
      }
      return { servers: (raw.servers as UserMcpServer[]) ?? [], error: null };
    } catch {
      return { servers: [], error: `${mcpConfigPath()} is not valid JSON. Fix or delete it — saving now would discard whatever it holds.` };
    }
  }
  // Mirrors internal/engine/mcp.go. Kept in sync by hand and deliberately
  // NOT authoritative: the engine revalidates before writing config.toml.
  // This copy exists only so the form can refuse a bad server immediately
  // instead of after an engine restart.
  /** Persist the server list. Shared by the save handler and the OAuth
   *  registration path, which must not lose the file it just read. */
  function writeMcpConfig(servers: UserMcpServer[]): boolean {
    try {
      const tmp = `${mcpConfigPath()}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ servers }, null, 2), { mode: 0o600 });
      renameSync(tmp, mcpConfigPath());
      return true;
    } catch {
      return false;
    }
  }

  const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;
  const MCP_NAME_MAX = 24;
  function validateMcpServer(srv: UserMcpServer): string | null {
    if (!srv.name || !MCP_NAME_RE.test(srv.name)) {
      return "Name can use only letters, digits, underscores and hyphens.";
    }
    if (srv.name.length > MCP_NAME_MAX) {
      return `Name must be ${MCP_NAME_MAX} characters or fewer, so its tool names stay within the gateway's limit.`;
    }
    const hasCmd = !!srv.command, hasUrl = !!srv.url;
    if (hasCmd && hasUrl) return "Give a command or a URL, not both.";
    if (!hasCmd && !hasUrl) return "Give a command (local) or an https URL (remote).";
    if (hasUrl) {
      // Mirrors isLoopbackHost in internal/engine/mcp.go. Plaintext is refused
      // for a network hop, but a loopback server never leaves the machine —
      // and locally-run servers are the common case (Figma's Dev Mode server
      // is http://127.0.0.1:3845/mcp). Loopback only: 192.168/10./169.254 are
      // real hops and stay refused.
      let u: URL;
      try {
        u = new URL(srv.url!);
      } catch {
        return "That is not a valid URL.";
      }
      // new URL() keeps IPv6 literals bracketed; strip them before parsing.
      // Lowercased to match the engine, whose url.Parse preserves host case —
      // "LocalHost" passed here and was then refused there, so the app could
      // save a config that stopped the engine from booting.
      const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      const loopback = host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
      if (u.protocol === "http:" && !loopback) {
        return "http is allowed only for a server on this machine (localhost). Use https for anything else.";
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return "The URL must start with https://, or http:// for a server on this machine.";
      }
    }
    for (const [k, v] of Object.entries(srv.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return `"${k}" is not a valid environment variable name.`;
      if (k === "UNBIASED_API_KEY" || k === "CODEX_HOME") return `${k} is reserved and cannot be set.`;
      if (/["\\]|[\u0000-\u001f]/.test(v)) return `The value for ${k} contains a character that is not allowed.`;
    }
    for (const v of [srv.command ?? "", srv.url ?? "", ...(srv.args ?? [])]) {
      if (/["\\]|[\u0000-\u001f]/.test(v)) return "Commands and arguments cannot contain quotes or backslashes.";
    }
    // The engine refuses these too. Without them here, a value that arrived
    // from a hand-edited file round-tripped through this save and then stopped
    // the engine from starting.
    for (const [field, n] of [["Startup timeout", srv.startupTimeoutSec], ["Tool timeout", srv.toolTimeoutSec]] as const) {
      if (n === undefined || n === null) continue;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return `${field} must be a positive number of seconds.`;
    }
    for (const t of srv.enabledTools ?? []) {
      if (typeof t !== "string" || !MCP_NAME_RE.test(t)) {
        return `Tool name "${String(t)}" can use only letters, digits, underscores and hyphens.`;
      }
    }
    return null;
  }
  /**
   * Trim an MCP icon's transparent padding.
   *
   * Servers ship icons on generous canvases: Figma's is 128x160 with a 52x76
   * mark centred in it, so only 41% of the width is ink. Rendered at any size
   * the glyph looks shrunken and mis-centred, because the box being centred is
   * mostly nothing. Every attempt to fix that by growing the container just
   * grows the padding with it.
   *
   * Cropping to the alpha bounding box makes the icon fill the space it is
   * given, and makes servers with different padding conventions render at the
   * same visual weight. Cached by source, since the list is re-fetched every
   * time the panel opens and the bitmap never changes.
   */
  const iconTrimCache = new Map<string, string>();
  function trimIcon(src: string): string {
    const cached = iconTrimCache.get(src);
    if (cached) return cached;
    let out = src;
    try {
      const img = nativeImage.createFromDataURL(src);
      const { width, height } = img.getSize();
      if (width > 0 && height > 0) {
        const bmp = img.toBitmap(); // BGRA, row-major
        let minX = width, minY = height, maxX = -1, maxY = -1;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (bmp[(y * width + x) * 4 + 3] <= 8) continue; // transparent
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        // Only worth doing when there is real padding to remove; a 1-2px
        // margin is not worth re-encoding, and an empty image must not crop
        // to nothing.
        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        if (maxX >= 0 && (w < width * 0.9 || h < height * 0.9)) {
          out = img.crop({ x: minX, y: minY, width: w, height: h }).toDataURL();
        }
      }
    } catch {
      // An icon we cannot decode is passed through untouched; the renderer
      // filters what it will actually display anyway.
    }
    iconTrimCache.set(src, out);
    return out;
  }

  ipcMain.handle("mcp:list", async () => {
    const cfg = readMcpConfig();
    let connected: unknown[] = [];
    let error: string | null = null;
    try {
      const res = (await engine.request("mcpServerStatus/list", {})) as { data?: unknown[] };
      connected = (Array.isArray(res?.data) ? res.data : []).map((srv) => {
        const s = srv as { serverInfo?: { icons?: { src?: unknown }[] | null } | null };
        const icons = s?.serverInfo?.icons;
        if (!Array.isArray(icons) || icons.length === 0) return srv;
        return {
          ...s,
          serverInfo: {
            ...s.serverInfo,
            icons: icons.map((ic) =>
              typeof ic?.src === "string" && ic.src.startsWith("data:image/")
                ? { ...ic, src: trimIcon(ic.src) }
                : ic,
            ),
          },
        };
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // configError is reported separately from `error`: one means "the engine
    // did not answer", the other "your file is broken" — and only the second
    // must block saving.
    return { connected, configured: cfg.servers, error, configError: cfg.error };
  });
  /** Must match mcp_oauth_callback_port in the engine's config template. */
  const MCP_CALLBACK_PORT = 45999;

  /**
   * The redirect URI codex will use for a given MCP server.
   *
   * Measured rather than assumed: the path is base64url of the first nine
   * bytes of sha256(serverUrl), which reproduced codex's own value exactly for
   * two unrelated URLs, and the same URL under two different server NAMES gave
   * a byte-identical path — so it keys off the URL alone. The port half comes
   * from mcp_oauth_callback_port, which the engine pins for this reason.
   *
   * This has to be exact. A registration declaring any other redirect URI is
   * rejected at the authorize step, and the failure surfaces as an opaque
   * provider error rather than anything naming the mismatch.
   */
  function mcpRedirectUri(serverUrl: string): string {
    // Hashed AFTER URL normalization, because that is what codex hashes: its
    // Rust Url type always renders an empty path as "/", so a pathless server
    // like https://mcp.stripe.com becomes https://mcp.stripe.com/ before the
    // digest. Hashing the raw string registered a callback the provider then
    // rejected at authorize time as "not registered" — measured on Stripe,
    // where the failing redirect matched the normalized form exactly. URLs
    // with a real path (Slack's /mcp) are unchanged by this, which is why
    // they worked and hid the bug.
    const normalized = new URL(serverUrl).toString();
    const digest = createHash("sha256").update(normalized).digest().subarray(0, 9);
    const path = digest.toString("base64url");
    return `http://127.0.0.1:${MCP_CALLBACK_PORT}/callback/${path}`;
  }

  /** One hop of OAuth metadata discovery. Returns null rather than throwing:
   *  a provider that does not serve a document is a normal outcome here, not
   *  an error worth surfacing. */
  async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Find a provider's dynamic-registration endpoint, following RFC 9728 then
   * RFC 8414. The MCP server advertises its authorization server; that server
   * advertises where clients register.
   */
  async function discoverRegistrationEndpoint(
    serverUrl: string,
  ): Promise<{ endpoint: string; scopes: string[] } | null> {
    const u = new URL(serverUrl);
    // RFC 9728 puts the resource's path AFTER the well-known segment; the
    // bare form is the fallback, and providers differ on which they serve.
    const prm =
      (await fetchJson(`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`)) ??
      (await fetchJson(`${u.origin}/.well-known/oauth-protected-resource`));
    const scopes = Array.isArray(prm?.scopes_supported)
      ? (prm!.scopes_supported as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const servers = Array.isArray(prm?.authorization_servers) ? (prm!.authorization_servers as unknown[]) : [];
    const issuer = typeof servers[0] === "string" ? (servers[0] as string) : u.origin;
    const iss = new URL(issuer);
    const meta =
      (await fetchJson(`${iss.origin}/.well-known/oauth-authorization-server${iss.pathname === "/" ? "" : iss.pathname}`)) ??
      (await fetchJson(`${iss.origin}/.well-known/oauth-authorization-server`)) ??
      (await fetchJson(`${iss.origin}/.well-known/openid-configuration`));
    const endpoint = meta?.registration_endpoint;
    if (typeof endpoint !== "string" || !endpoint) return null;
    // Credentials are about to be created here, so the hop must be protected.
    // Loopback is allowed because a server on this machine never leaves it.
    const e = new URL(endpoint);
    const loopback = e.hostname === "localhost" || e.hostname === "127.0.0.1" || e.hostname === "::1";
    if (e.protocol !== "https:" && !loopback) return null;
    return { endpoint, scopes };
  }

  /**
   * Register US with the provider, as us.
   *
   * This is the whole point: codex's own dynamic registration sends
   * client_name "Codex" and no logo at all, and neither is configurable. By
   * registering first we choose both, and hand codex only the resulting
   * client_id — at which point it skips its own registration entirely and runs
   * the authorization against our client. Nothing is intercepted or spoofed;
   * this is the provider's documented endpoint, and we are the client.
   */
  async function registerOAuthClient(serverUrl: string): Promise<{ clientId: string } | { error: string }> {
    const discovered = await discoverRegistrationEndpoint(serverUrl);
    if (!discovered) return { error: "This server does not offer dynamic client registration." };
    const { endpoint } = discovered;
    const redirectUri = mcpRedirectUri(serverUrl);
    const attempt = async (scope: string | null) => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          client_name: "Unbiased",
          client_uri: "https://unbiased.ai",
          // The site's 1024x1024 app icon, verified to resolve. A guessed
          // /icon.png 404'd, and a logo_uri the provider cannot fetch renders
          // as a broken-image placeholder on the consent screen — worse than
          // sending none, because it looks like the app is malfunctioning at
          // the exact moment it is asking to be trusted. The og image is a
          // 1200x630 banner and the wrong shape for this.
          logo_uri: "https://unbiased.ai/assets/unbiased-icon.png",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          // Native app, no secret to keep — the flow is PKCE-protected, and
          // this matches what codex asks for so the client it receives is the
          // shape it expects.
          token_endpoint_auth_method: "none",
          application_type: "native",
          ...(scope ? { scope } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return { res, body };
    };
    // Scope negotiation, widest first. Providers disagree fatally in BOTH
    // directions: Hydra-style registrars (Higgsfield) refuse an AUTHORIZE for
    // any scope the client was not registered with, so registering without
    // scopes bricks the sign-in — while Stripe's registrar refuses the
    // REGISTRATION itself for scopes it does not support ("Not supported:
    // openid, profile, email, offline_access"). So: try the provider's
    // advertised set plus the OIDC quartet; on a scope complaint fall back to
    // the advertised set alone; then to no scope field at all, which is the
    // pre-negotiation behaviour that Stripe accepted.
    const wide = [...new Set([...discovered.scopes, "openid", "profile", "email", "offline_access"])].join(" ");
    const advertised = discovered.scopes.join(" ");
    const ladder = [...new Set([wide || null, advertised || null, null])];
    try {
      let lastDetail = "";
      for (const scope of ladder) {
        const { res, body } = await attempt(scope);
        if (res.ok) {
          const clientId = typeof body?.client_id === "string" ? body.client_id : "";
          if (!clientId) return { error: "The provider returned no client_id." };
          return { clientId };
        }
        lastDetail = typeof body?.error_description === "string" ? body.error_description : `HTTP ${res.status}`;
        const scopeComplaint = /scope|not supported/i.test(
          `${body?.error ?? ""} ${body?.error_description ?? ""}`,
        );
        if (!scopeComplaint) break; // a different failure — narrowing scopes will not help
      }
      return { error: `The provider refused the registration (${lastDetail}).` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Sign in to an MCP server that wants OAuth.
   *
   * The engine has done this all along — codex implements the full OAuth 2.1
   * flow with dynamic client registration, keyring storage and refresh — and
   * the app simply never called it. What the user got instead was the
   * engine's own not-logged-in error, which ends "Run `codex mcp login
   * <name>`": a CLI this product does not ship, against a CODEX_HOME this
   * product does not use. The model relayed that faithfully because it was
   * the only instruction anyone had given it.
   *
   * The authorization URL opens in the user's normal browser, not the Agent
   * browser: they are signing in as themselves, and the callback comes back
   * to a loopback port the engine is already listening on.
   */
  /**
   * The bundled connector catalogue.
   *
   * Read from the engine's own plugin directory rather than hardcoded here:
   * the names, descriptions, categories and logos are already shipped with the
   * pinned binary, and a hand-kept copy would drift the first time it moved.
   *
   * Filtered to remote servers with NO oauth block of their own. That is the
   * exact set that supports on-the-spot registration, which is what lets us
   * register as Unbiased instead of letting codex register as "Codex". The
   * ones carrying a baked-in client_id (Slack) or an unsubstituted placeholder
   * (the Google set, Airtable, Shopify, Zoom) are deliberately left out — they
   * would either show someone else's name on the consent screen or fail
   * outright, and a catalogue entry that cannot work is worse than no entry.
   */
  /**
   * Connectors kept out of the catalogue because they cannot complete a
   * sign-in here.
   *
   * The rule this enforces: an entry that cannot work is worse than no entry.
   * A card that fails only after the user clicks Connect spends their trust to
   * teach them the feature is unreliable.
   *
   * Measured, not assumed — every server in the catalogue was probed for an
   * RFC 8414 registration_endpoint on 2026-08-27, and github is the sole
   * member. Re-run that probe before adding or removing anything here; the
   * providers can change their minds.
   */
  const CONNECTORS_WITHOUT_REGISTRATION: Record<string, string> = {
    // api.githubcopilot.com publishes authorization-server metadata but no
    // registration_endpoint, and codex's own fallback fails the same way
    // ("Dynamic client registration not supported"). It needs an OAuth
    // application registered by hand, so it belongs here until someone does
    // that and supplies its client id.
    github: "GitHub does not offer automatic sign-up",
    // Removed at the user's request after its provider rejected codex's scope
    // request. Possibly fixable now that registration negotiates scopes —
    // delete this line to let it back into the catalogue and find out.
    higgsfield: "Higgsfield's OAuth rejects the engine's scope request",
    // Gmail's MCP endpoint is gated behind Google's Workspace Developer
    // Preview Program: after a fully successful OAuth sign-in (proxied
    // authorize + secret-injected token exchange, both confirmed working), the
    // first tool call still answers "requires that your Google Cloud project
    // is enrolled". Enrollment is per-project, accepts Workspace accounts
    // only, and preview terms are pre-GA. Everything the connector needs on
    // OUR side works; the gate is entirely Google's, so the card would only
    // spend the user's trust. Delete this line once the API reaches GA.
    gmail: "Gmail's API is limited to Google's Workspace Developer Preview",
    // Removed with Gmail. Same provider, same preview-gated MCP endpoints, and
    // the same per-project enrollment that accepts Workspace accounts only —
    // so the setup cost lands on every user for a connector that may refuse
    // them at the first tool call. The engine's managed-plugin path and the
    // app's secret-injecting proxy stay in place and tested: re-listing these
    // is deleting two lines, once Google's APIs are generally available.
    "google-calendar": "Google Calendar's MCP API is preview-gated",
    "google-drive": "Google Drive's MCP API is preview-gated",
  };

  /**
   * Connectors that work only with an OAuth application the user registers
   * themselves — the provider offers no on-the-spot sign-up, and the client
   * id the bundle ships belongs to someone else. Slack's is OpenAI's: use it
   * and the consent screen says "ChatGPT (Local)" is requesting access to
   * your workspace (measured). These appear in the catalogue as
   * setup-required rather than being hidden, because "register an app and
   * paste its id" is a real path the detail page already supports — hiding
   * the entry just made the path undiscoverable.
   */
  const CONNECTORS_BRING_YOUR_OWN: Record<string, { secret?: boolean }> = {
    slack: {},
    // `secret: true` routes a connector through the engine's managed-plugin
    // path and the app's secret-injecting proxy — built and tested for the
    // Google trio, which is currently not offered (see the map above). The
    // machinery is provider-agnostic and stays ready for the next provider
    // whose token exchange demands a client secret.
  };

  function connectorCatalogueDir(): string {
    return join(app.getPath("home"), ".unbiased", "app-engine", "home", ".tmp", "plugins", "plugins");
  }

  /** Load a logo the manifest names outright, e.g. "./assets/logo.png".
   *  Kept inside the plugin directory: a path escaping it is a malformed
   *  manifest, not a file to go and read. */
  function connectorIconAt(dir: string, rel: string): string | null {
    const full = join(dir, rel.replace(/^\.\//, ""));
    if (!full.startsWith(dir)) return null;
    try {
      if (!statSync(full).isFile()) return null;
      const b64 = readFileSync(full).toString("base64");
      const mime = full.endsWith(".svg") ? "image/svg+xml" : "image/png";
      const src = `data:${mime};base64,${b64}`;
      return mime === "image/png" ? trimIcon(src) : src;
    } catch {
      return null;
    }
  }

  /** A connector's logo, inlined so the renderer needs no file access. Prefers
   *  a full-colour raster over the small monochrome marks, which are drawn for
   *  a composer chip rather than a card. */
  function connectorIcon(dir: string, name: string): string | null {
    const assets = join(dir, "assets");
    const prefer = [`${name}.png`, "logo.png", "app-icon.png", `${name}.svg`, "logo.svg"];
    for (const file of prefer) {
      const full = join(assets, file);
      try {
        if (!statSync(full).isFile()) continue;
        const b64 = readFileSync(full).toString("base64");
        const mime = file.endsWith(".svg") ? "image/svg+xml" : "image/png";
        const src = `data:${mime};base64,${b64}`;
        return mime === "image/png" ? trimIcon(src) : src;
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  }

  type Connector = {
    name: string;
    url: string;
    displayName: string;
    description: string;
    longDescription: string;
    developer: string | null;
    version: string | null;
    category: string;
    capabilities: string[];
    prompts: string[];
    brandColor: string | null;
    websiteUrl: string | null;
    privacyUrl: string | null;
    termsUrl: string | null;
    supportUrl: string | null;
    icon: string | null;
    enabled: boolean;
    /** What a hand-registered OAuth app must declare as its callback. Shown
     *  rather than explained: it is unguessable, and one wrong character fails
     *  at the authorize step with an error naming nothing useful. */
    redirectUri: string;
    /** The provider offers no automatic sign-up and the shipped client id is
     *  someone else's — connecting requires the user's own registered app. */
    requiresClientId: boolean;
    /** The provider's token exchange demands a client secret too (Google). */
    requiresSecret: boolean;
    /** Listed, but not connectable yet — the provider-side app is not ready. */
    comingSoon: boolean;
    /** Provider-specific setup guidance, from the catalogue. */
    setupNote: string | null;
    scopes: string[];
    /** A client id already configured for this connector, so the field shows
     *  what is in effect rather than an empty box next to a working setup. */
    clientId: string | null;
  };

  /**
   * These entries are written for codex, and six of the sixteen say so in
   * their own copy — "Manage issues, projects, and team workflows in Linear
   * from Codex." Shipping that verbatim would reintroduce, in our own UI, the
   * exact identity leak the OAuth work was about. The catalogue is read at
   * runtime so it cannot be corrected at the source.
   */
  function deCodex(text: string): string {
    return text.replace(/\bCodex\b/g, "Pareto");
  }

  function str(o: Record<string, unknown>, key: string): string | null {
    const v = o[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  }

  /** Where the last verified catalogue is kept, so the Connectors page works
   *  offline and on first launch after an update. */
  function cataloguePath(): string {
    return join(app.getPath("home"), ".unbiased", "connector-catalogue.json");
  }

  let catalogueCache: Catalogue | null = null;
  // Exposed to startEngine, which lives outside this scope.
  refreshCatalogueAtStartup = () => void refreshCatalogue();
  let catalogueLoaded = false;
  let catalogueRefreshing: Promise<void> | null = null;

  function loadCachedCatalogue(): Catalogue | null {
    if (catalogueLoaded) return catalogueCache;
    catalogueLoaded = true;
    try {
      const raw = JSON.parse(readFileSync(cataloguePath(), "utf8")) as {
        payload?: string;
        etag?: string | null;
        cacheVersion?: number;
      };
      // Discard a cache written by a build that parsed fewer fields than this
      // one. Otherwise its next revalidation is a 304, the stale copy stands,
      // and the new field stays invisible until the publisher happens to
      // change something.
      if (raw?.cacheVersion !== CATALOGUE_CACHE_VERSION) return (catalogueCache = null);
      // The cache stores the VERIFIED payload text and re-parses it, rather
      // than storing parsed objects: one parser, one set of rules, and a build
      // that learns a new field recovers it from the original bytes.
      if (typeof raw?.payload === "string") {
        catalogueCache = parseCatalogue(raw.payload, typeof raw.etag === "string" ? raw.etag : null, new Date().toISOString());
      }
    } catch {
      catalogueCache = null;
    }
    return catalogueCache;
  }

  /**
   * Refresh from the catalogue repo. Never throws and never blocks the caller
   * on a slow network: a failure leaves the previous copy in place, which is
   * the whole point — a bad publish or an offline morning degrades to
   * yesterday's list, not to an empty page.
   */
  async function refreshCatalogue(): Promise<void> {
    if (catalogueRefreshing) return catalogueRefreshing;
    catalogueRefreshing = (async () => {
      const current = loadCachedCatalogue();
      // `current` arms the rollback check: a genuinely-signed but OLDER payload
      // is refused rather than accepted, so whoever can write the bucket
      // cannot quietly reinstate a withdrawn connector.
      const res = await fetchCatalogueFromAnyHost(current?.etag ?? null, { current });
      if (!res.ok) {
        if (res.reason === "rollback")
          console.warn(
            `[connectors] REFUSED an older catalogue than the one cached (${current?.publishedAt}) — keeping the cached copy`,
          );
        else if (res.reason !== "unchanged") console.log(`[connectors] catalogue refresh skipped: ${res.reason}`);
        return;
      }
      const changed = current?.publishedAt !== res.catalogue.publishedAt;
      catalogueCache = res.catalogue;
      catalogueLoaded = true;
      // Only when it actually differs: a push on every refresh would reload
      // the page's list for nothing several times a session.
      if (changed) send("connectors:changed", { publishedAt: res.catalogue.publishedAt });
      try {
        writeFileSync(
          cataloguePath(),
          // The payload verbatim — re-serialising the parsed form is what made
          // a new field unrecoverable from an existing cache.
          JSON.stringify({
            cacheVersion: CATALOGUE_CACHE_VERSION,
            payload: res.catalogue.raw,
            etag: res.catalogue.etag,
          }),
          { mode: 0o600 },
        );
      } catch (err) {
        console.log(`[connectors] could not cache the catalogue: ${String(err)}`);
      }
      console.log(
        `[connectors] catalogue updated: ${res.catalogue.connectors.length} entries, published ${res.catalogue.publishedAt}`,
      );
    })().finally(() => {
      catalogueRefreshing = null;
    });
    return catalogueRefreshing;
  }

  /** A published entry, in the shape the rest of the app already speaks. */
  function connectorFromCatalogue(e: CatalogueEntry): Connector {
    return {
      name: e.name,
      url: e.url,
      displayName: e.displayName,
      description: e.description,
      longDescription: e.longDescription,
      developer: e.developer,
      version: null,
      category: e.category,
      capabilities: e.capabilities,
      prompts: e.prompts,
      brandColor: e.brandColor,
      websiteUrl: e.websiteUrl,
      privacyUrl: e.privacyUrl,
      termsUrl: e.termsUrl,
      supportUrl: e.supportUrl,
      icon: e.icon,
      redirectUri: mcpRedirectUri(e.url),
      clientId: null,
      enabled: true,
      requiresClientId: e.requiresClientId,
      requiresSecret: e.requiresSecret,
      comingSoon: e.comingSoon,
      setupNote: e.setupNote,
      scopes: e.scopes,
    };
  }

  /**
   * The connector list. Published catalogue first, the engine's bundled
   * manifests as the fallback — so a fresh install with no network still has a
   * usable page, and adding a connector no longer needs an app release.
   */
  function readConnectorCatalogue(): Connector[] {
    const remote = loadCachedCatalogue();
    if (remote) {
      // `unavailable` entries stay documented in the catalogue but are not
      // offered: a card that cannot work spends the user's trust.
      return remote.connectors.filter((e) => !e.unavailable).map(connectorFromCatalogue);
    }
    return readBundledCatalogue();
  }

  function readBundledCatalogue(): Connector[] {
    const root = connectorCatalogueDir();
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return [];
    }
    const out: Connector[] = [];
    for (const entry of entries.sort()) {
      const dir = join(root, entry);
      let mcp: { mcpServers?: Record<string, Record<string, unknown>> };
      try {
        mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      } catch {
        continue;
      }
      for (const [name, srv] of Object.entries(mcp.mcpServers ?? {})) {
        if (srv?.type !== "http" || typeof srv?.url !== "string") continue;
        // A shipped oauth block is either a third party's client id or an
        // unsubstituted placeholder — never ours to claim. Deliberately
        // DROPPED even for the bring-your-own entries below: the user's own
        // registration is the only identity these may use.
        if (srv.oauth && !CONNECTORS_BRING_YOUR_OWN[name]) continue;
        if (CONNECTORS_WITHOUT_REGISTRATION[name]) continue;
        if (!MCP_NAME_RE.test(name) || name.length > MCP_NAME_MAX) continue;
        let iface: Record<string, unknown> = {};
        let manifestVersion: string | null = null;
        try {
          const manifest = JSON.parse(readFileSync(join(dir, ".codex-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
          iface = (manifest.interface ?? {}) as Record<string, unknown>;
          manifestVersion = typeof manifest.version === "string" ? manifest.version : null;
        } catch {
          /* metadata is a nicety; the server is the substance */
        }
        // The manifest spells these with a capital URL — websiteURL, not
        // websiteUrl. Reading the lowercase form returned null for all
        // sixteen, silently, which is exactly how a link section ends up
        // empty and nobody notices.
        const prompts = Array.isArray(iface.defaultPrompt)
          ? (iface.defaultPrompt as unknown[]).filter((x): x is string => typeof x === "string").map(deCodex)
          : [];
        const logo = str(iface, "logo");
        out.push({
          name,
          url: srv.url,
          displayName: str(iface, "displayName") ?? entry,
          description: deCodex(str(iface, "shortDescription") ?? ""),
          longDescription: deCodex(str(iface, "longDescription") ?? ""),
          developer: str(iface, "developerName"),
          version: manifestVersion,
          category: str(iface, "category") ?? "Other",
          capabilities: Array.isArray(iface.capabilities)
            ? (iface.capabilities as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
          prompts,
          brandColor: str(iface, "brandColor"),
          websiteUrl: str(iface, "websiteURL"),
          privacyUrl: str(iface, "privacyPolicyURL"),
          termsUrl: str(iface, "termsOfServiceURL"),
          supportUrl: str(iface, "supportURL"),
          // The manifest's own logo path wins; the filename guesses are only
          // for the entries that declare none.
          icon: (logo ? connectorIconAt(dir, logo) : null) ?? connectorIcon(dir, entry),
          redirectUri: mcpRedirectUri(srv.url),
          clientId: null,
          enabled: true,
          requiresClientId: !!CONNECTORS_BRING_YOUR_OWN[name],
          requiresSecret: !!CONNECTORS_BRING_YOUR_OWN[name]?.secret,
          // Only the published catalogue carries this; the bundled fallback
          // is a last resort and offers everything it knows.
          comingSoon: false,
          setupNote: null,
          // The bundled manifest's scope list travels with the connector so a
          // saved registration asks Google for exactly what the server needs.
          scopes: Array.isArray(srv.scopes)
            ? (srv.scopes as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
        });
      }
    }
    return out;
  }

  ipcMain.handle("connectors:list", async () => {
    // Opening the page is the natural moment to pick up a newly published
    // connector — but NOT at the cost of making the page wait on the network.
    // Awaiting this put a "Loading…" in front of the user on every visit, for
    // as long as the fetch took. The cached catalogue is what renders; the
    // refresh runs behind it and announces itself if anything changed.
    void refreshCatalogue();
    await wakeManagedPlugins();
    const catalogue = readConnectorCatalogue();
    const configured = readMcpConfig().servers;
    let status: Record<string, string> = {};
    try {
      // Bounded: this is the last thing between the user and the page, and an
      // engine busy probing a dead server should cost a missing "Connected"
      // badge for a moment, not a page that will not paint.
      const res = (await Promise.race([
        engine.request("mcpServerStatus/list", {}),
        new Promise((resolve) => setTimeout(() => resolve({ data: [] }), 2_500)),
      ])) as { data?: { name?: string; authStatus?: string }[] };
      for (const srv of res?.data ?? []) {
        if (typeof srv?.name === "string") status[srv.name] = typeof srv.authStatus === "string" ? srv.authStatus : "unknown";
      }
    } catch {
      status = {};
    }
    return {
      connectors: catalogue.map((c) => ({
        ...c,
        added: configured.some((sv) => sv.name === c.name),
        authStatus: status[c.name] ?? null,
        clientId: configured.find((sv) => sv.name === c.name)?.oauthClientId ?? null,
        enabled: configured.find((sv) => sv.name === c.name)?.enabled !== false,
      })),
    };
  });

  /**
   * Add a connector and sign in, in one motion.
   *
   * Registering our OAuth client BEFORE the restart is what makes this one
   * restart rather than two: config.toml is rendered from mcp-servers.json at
   * engine start, so the server entry and its client_id have to be on disk
   * together before we bounce it.
   */
  ipcMain.handle("connectors:connect", async (_e, name: string) => {
    const connector = readConnectorCatalogue().find((c) => c.name === name);
    if (!connector) return { ok: false, error: "That connector is not in the catalogue." };
    if (connector.requiresClientId) {
      // No silent fallback here: with no registration endpoint, proceeding
      // means codex registers nothing and the flow either fails or runs on a
      // third party's identity. The detail page carries the setup.
      return {
        ok: false,
        error: `${connector.displayName} needs an OAuth app of your own — open its page, register one with the callback shown there, and paste its client ID.`,
      };
    }
    if (runningTurns.size > 0) return { ok: false, error: "Finish the running turn first — connecting restarts the engine." };
    const cfg = readMcpConfig();
    if (cfg.error) return { ok: false, error: cfg.error };
    if (cfg.servers.some((sv) => sv.name === name)) return { ok: false, error: `${connector.displayName} is already added.` };

    if (connector.comingSoon)
      return { ok: false, error: `${connector.displayName} isn't available yet.` };
    const reg = await registerOAuthClient(connector.url);
    if (!("clientId" in reg)) {
      // No silent Codex-branded fallback. It was originally "a working
      // sign-in beats blocking on branding" — in practice the user met a
      // consent screen naming another product, with no hint why, twice. A
      // named failure they can retry beats a surprise they cannot explain.
      return { ok: false, error: `Could not register Unbiased with ${connector.displayName}: ${reg.error}` };
    }
    const entry: UserMcpServer = {
      name: connector.name,
      url: connector.url,
      oauthClientId: reg.clientId,
    };
    if (!writeMcpConfig([...cfg.servers, entry])) return { ok: false, error: "Could not save the server list." };
    try {
      await startEngine();
    } catch (err) {
      return { ok: false, error: `Added, but the engine did not restart: ${String(err)}` };
    }
    try {
      const res = (await engine.request("mcpServer/oauth/login", { name })) as { authorizationUrl?: string };
      const url = typeof res?.authorizationUrl === "string" ? res.authorizationUrl : "";
      if (!url) return { ok: true, branded: "clientId" in reg, signIn: false };
      await shell.openExternal(url);
      return { ok: true, branded: "clientId" in reg, signIn: true };
    } catch (err) {
      // Added and connected, just not signed in — the MCP panel's Sign in
      // button can finish the job, so this is not a failure of the add.
      return {
        ok: true,
        branded: "clientId" in reg,
        signIn: false,
        error: friendlyMcpError(err instanceof Error ? err.message : String(err), connector.displayName),
      };
    }
  });

  /**
   * Point a connector at an OAuth application the user registered themselves.
   *
   * The escape hatch for providers that do not offer automatic sign-up —
   * GitHub is the one in the current catalogue. Adds the server if it is not
   * there yet, so this works as a first action rather than requiring a failed
   * Connect first.
   */
  ipcMain.handle("connectors:set-client-id", async (_e, payload: { name: string; clientId: string; clientSecret?: string }) => {
    const name = typeof payload?.name === "string" ? payload.name : "";
    // Sanitize hard, because the Google console's credential table puts the
    // ID next to other cells: a drag-select copies "…apps.googleusercontent.com
    // Creation date" and the pasted client is silently invalid. No OAuth client
    // id or secret contains whitespace or zero-width characters, so cutting at
    // the first one is unambiguous and repairs the paste instead of failing an
    // hour later inside a token exchange.
    const clean = (v: unknown): string =>
      typeof v === "string" ? v.replace(/[\u200b-\u200d\ufeff]/g, "").trim().split(/\s/)[0] ?? "" : "";
    const clientId = clean(payload?.clientId);
    const clientSecret = clean(payload?.clientSecret);
    const connector = readConnectorCatalogue().find((c) => c.name === name);
    if (!connector) return { ok: false, error: "That connector is not in the catalogue." };
    // Written verbatim into config.toml, so it is held to the same rule as
    // every other value there.
    if (/["\\]|[\u0000-\u001f]/.test(clientId) || /["\\]|[\u0000-\u001f]/.test(clientSecret)) {
      return { ok: false, error: "A client ID or secret cannot contain quotes or backslashes." };
    }
    // No hard secret requirement any more. The pinned engine LOSES the secret
    // between authorize and token exchange (Google answered "client_secret is
    // missing" to a request our plugin config supplied one for — its stored
    // OAuth state has no secret field), so the Desktop-client route is dead
    // until the engine is fixed. An iOS-type Google client needs no secret at
    // all and rides the ordinary client-id path instead; leaving the field
    // empty selects that route.
    if (runningTurns.size > 0) return { ok: false, error: "Finish the running turn first — this restarts the engine." };
    const cfg = readMcpConfig();
    if (cfg.error) return { ok: false, error: cfg.error };
    const exists = cfg.servers.some((sv) => sv.name === name);
    // An empty value clears it, which is the way back to automatic sign-up.
    const fields = clientId
      ? {
          oauthClientId: clientId,
          ...(clientSecret ? { oauthClientSecret: clientSecret } : { oauthClientSecret: undefined }),
          ...(connector.scopes.length ? { scopes: connector.scopes } : {}),
        }
      : { oauthClientId: undefined, oauthClientSecret: undefined };
    const next = exists
      ? cfg.servers.map((sv) => (sv.name === name ? { ...sv, ...fields } : sv))
      : [...cfg.servers, { name, url: connector.url, ...fields }];
    if (!writeMcpConfig(next)) return { ok: false, error: "Could not save the server list." };
    try {
      await startEngine();
    } catch (err) {
      return { ok: false, error: `Saved, but the engine did not restart: ${String(err)}` };
    }
    return { ok: true };
  });

  /**
   * Switch a connector off without forgetting it.
   *
   * Off is NOT remove: removing discards the OAuth client the user approved in
   * a browser, and reconnecting mints a new one at the provider. Off just
   * leaves the server out of the engine's config.
   *
   * This is app-wide, not per-conversation. codex's thread/start does take a
   * free-form `config` object, but it accepted a deliberately nonsensical key
   * without complaint, so acceptance says nothing about whether an override is
   * applied — and shipping a per-chat switch that silently does nothing would
   * be worse than not having one.
   */
  ipcMain.handle("connectors:set-enabled", async (_e, payload: { name: string; enabled: boolean }) => {
    const name = typeof payload?.name === "string" ? payload.name : "";
    const enabled = payload?.enabled !== false;
    if (runningTurns.size > 0) return { ok: false, error: "Finish the running turn first — this restarts the engine." };
    const cfg = readMcpConfig();
    if (cfg.error) return { ok: false, error: cfg.error };
    if (!cfg.servers.some((sv) => sv.name === name)) return { ok: false, error: "That connector is not configured." };
    const next = cfg.servers.map((sv) => (sv.name === name ? { ...sv, enabled } : sv));
    if (!writeMcpConfig(next)) return { ok: false, error: "Could not save the server list." };
    try {
      await startEngine();
    } catch (err) {
      return { ok: false, error: `Saved, but the engine did not restart: ${String(err)}` };
    }
    return { ok: true };
  });

  ipcMain.handle("connectors:remove", async (_e, name: string) => {
    if (runningTurns.size > 0) return { ok: false, error: "Finish the running turn first — this restarts the engine." };
    const cfg = readMcpConfig();
    if (cfg.error) return { ok: false, error: cfg.error };
    if (!writeMcpConfig(cfg.servers.filter((sv) => sv.name !== name))) {
      return { ok: false, error: "Could not save the server list." };
    }
    try {
      await startEngine();
    } catch (err) {
      return { ok: false, error: `Removed, but the engine did not restart: ${String(err)}` };
    }
    return { ok: true };
  });

  /**
   * Turn an engine error into something a person can act on.
   *
   * The raw form reaches the UI as `rpc error: {"code":-32603,"message":...}`,
   * which is developer output wearing a user's clothes — and in the one case
   * that actually happens, it is also misleading. "Registration failed" reads
   * as a transient fault worth retrying; the truth is that the provider does
   * not offer sign-up at all, so retrying is exactly the wrong response.
   */
  function friendlyMcpError(raw: string, displayName: string): string {
    let message = raw;
    const json = raw.match(/\{.*\}/s);
    if (json) {
      try {
        const parsed = JSON.parse(json[0]) as { message?: unknown };
        if (typeof parsed.message === "string") message = parsed.message;
      } catch {
        /* keep the raw text */
      }
    }
    if (/dynamic client registration not supported/i.test(message)) {
      return `${displayName} does not support signing in automatically — it needs an OAuth application registered with them by hand. Until then it cannot be connected here.`;
    }
    if (/no access token was provided/i.test(message)) {
      return `${displayName} needs you to sign in before it will answer.`;
    }
    return message;
  }

  /**
   * Wake the plugin subsystem so managed-plugin servers exist.
   *
   * codex materializes marketplace plugins LAZILY: until something touches
   * the plugin registry, a connector riding the managed-plugin path (the
   * Google trio) has no MCP server at all, and signing in fails with "No MCP
   * server named 'gmail' found" — measured live, and plugin/list alone made
   * the server appear with its full tool set. Cheap and idempotent, so it is
   * safe to call before any operation that needs those servers.
   */
  async function wakeManagedPlugins(): Promise<void> {
    const hasManaged = readMcpConfig().servers.some((sv) => sv.oauthClientSecret);
    if (!hasManaged) return;
    await engine.request("plugin/list", {}).catch(() => undefined);
  }

  ipcMain.handle("mcp:login", async (_e, name: string) => {
    if (typeof name !== "string" || !name) return { ok: false, error: "No server named." };
    // Claim our own OAuth client before codex can register its own.
    //
    // Order matters and is not negotiable: codex only skips registration when
    // a client_id is already in config.toml, and config.toml is regenerated
    // from mcp-servers.json at engine START. So the id has to be stored and
    // the engine restarted BEFORE the login call, or codex registers itself as
    // "Codex" first and that is what the user sees.
    const cfg = readMcpConfig();
    const server = cfg.servers.find((sv) => sv.name === name);
    let registered: string | null = null;
    if (server?.url && !server.oauthClientId) {
      const reg = await registerOAuthClient(server.url);
      if ("clientId" in reg) {
        const next = cfg.servers.map((sv) => (sv.name === name ? { ...sv, oauthClientId: reg.clientId } : sv));
        const saved = writeMcpConfig(next);
        if (saved) {
          registered = reg.clientId;
          if (runningTurns.size > 0) {
            return { ok: false, error: "Finish the running turn first — signing in restarts the engine." };
          }
          try {
            await startEngine();
          } catch (err) {
            return { ok: false, error: `Registered, but the engine did not restart: ${String(err)}` };
          }
        }
      }
      // A provider without dynamic registration, or one that refused, is not
      // a dead end: codex falls back to registering itself. The sign-in still
      // works; the consent screen just says Codex. Better to proceed and let
      // the user decide than to block on branding.
    }
    await wakeManagedPlugins();
    const attemptLogin = () =>
      engine.request("mcpServer/oauth/login", { name }) as Promise<{ authorizationUrl?: string }>;
    try {
      let res: { authorizationUrl?: string };
      try {
        res = await attemptLogin();
      } catch (err) {
        // The wake is asynchronous on the engine side too — one bounded
        // retry covers the window where the marketplace is still loading.
        if (!/no mcp server named/i.test(String(err))) throw err;
        await new Promise((r) => setTimeout(r, 1_500));
        await wakeManagedPlugins();
        res = await attemptLogin();
      }
      const url = typeof res?.authorizationUrl === "string" ? res.authorizationUrl : "";
      if (!url) return { ok: false, error: "The engine did not return a sign-in link." };
      await shell.openExternal(url);
      return { ok: true, registered: registered !== null };
    } catch (err) {
      const label = readConnectorCatalogue().find((c) => c.name === name)?.displayName ?? name;
      return { ok: false, error: friendlyMcpError(err instanceof Error ? err.message : String(err), label) };
    }
  });

  ipcMain.handle("mcp:save", (_e, payload: { servers: UserMcpServer[] }) => {
    const servers = Array.isArray(payload?.servers) ? payload.servers : [];
    // Writing over a file we could not read would discard servers the user
    // still has. Refuse, and say what to do about it.
    const existing = readMcpConfig();
    if (existing.error) return { ok: false, error: existing.error };
    const seen = new Set<string>();
    for (const srv of servers) {
      const problem = validateMcpServer(srv);
      if (problem) return { ok: false, error: problem };
      const key = srv.name.toLowerCase();
      if (seen.has(key)) return { ok: false, error: `More than one server is named "${srv.name}".` };
      seen.add(key);
    }
    try {
      const dir = join(app.getPath("home"), ".unbiased");
      mkdirSync(dir, { recursive: true });
      // Write-then-rename, the same discipline MaterializeHome uses on
      // config.toml: the engine reads this file at launch, and Save sits right
      // beside Restart engine, so a plain write's truncate-then-fill window is
      // long enough for the supervisor to read an empty file and refuse to
      // start. 0600 because the file can name variables holding credentials.
      const tmp = `${mcpConfigPath()}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ servers }, null, 2), { mode: 0o600 });
      renameSync(tmp, mcpConfigPath());
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true };
  });
  // Config is read by the supervisor at launch, so a change lands on the next
  // start. Restarting here rather than asking the user to quit the app.
  ipcMain.handle("mcp:apply", async () => {
    if (runningTurns.size > 0) return { ok: false, busy: true };
    // startEngine() already stops the current process and resets sub-agent
    // state; doing either here as well just kills the child twice.
    try {
      await startEngine();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true };
  });

  // ---- Skills ------------------------------------------------------------
  // ── Memory ──────────────────────────────────────────────────────────
  // The Environment popover's "Agent memory" section: every note in the
  // thread's project store, with a flag for the ones this conversation
  // saved (matched on the originThreadId provenance stamp).
  ipcMain.handle("memory:list", (_e, threadId?: string | null) => {
    const tid = typeof threadId === "string" ? threadId : null;
    const dir = memoryDirForThread(tid);
    const root = tid ? rootThreadOf(tid) : null;
    return redactSecrets({
      dir,
      memories: loadMemoryNotes(dir).map((n) => ({
        name: n.name,
        description: n.description,
        type: n.type,
        path: join(dir, `${n.name}.md`),
        thisThread: !!root && n.originThreadId === root,
      })),
    });
  });

  ipcMain.handle("skills:list", async (_e, payload?: { cwd?: string | null }) => {
    // cwds drives the PROJECT tier. codex does not walk up parent directories,
    // so the path passed here must be the exact folder holding .codex/skills —
    // normally the conversation's cwd. Verified: a thread opened in
    // mono/packages/web sees nothing from mono/.codex/skills.
    const cwd = payload?.cwd?.trim() || mainCwd || null;
    try {
      const res = (await engine.request("skills/list", {
        cwds: cwd ? [cwd] : [],
        forceReload: true,
      })) as { data?: { cwd?: string; skills?: unknown[] }[] };
      const groups = Array.isArray(res?.data) ? res.data : [];
      // One cwd in, so one group out; flatten rather than make the renderer
      // handle a shape it never sees.
      const skills = groups.flatMap((g) => (Array.isArray(g.skills) ? g.skills : []));
      return {
        skills,
        cwd,
        roots: { bundled: bundledSkillsDir(), global: globalSkillsDir(), project: cwd ? join(cwd, ".codex", "skills") : null },
        error: null,
      };
    } catch (err) {
      return {
        skills: [],
        cwd,
        roots: { bundled: bundledSkillsDir(), global: globalSkillsDir(), project: cwd ? join(cwd, ".codex", "skills") : null },
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
  // Selector is by path, not name: two roots can hold the same name, and the
  // path is what the list already gave the renderer.
  ipcMain.handle("skills:set-enabled", async (_e, payload: { path: string; enabled: boolean }) => {
    if (!payload?.path || !isAbsolute(payload.path)) return { ok: false, error: "A skill path is required." };
    try {
      await engine.request("skills/config/write", { path: payload.path, enabled: !!payload.enabled });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // Opens the folder holding a skill, or creates and opens a root.
  ipcMain.handle("skills:reveal", (_e, payload: { path: string; isDir?: boolean }) => {
    const target = payload?.path;
    if (!target || !isAbsolute(target)) return { ok: false };
    try {
      if (payload.isDir) mkdirSync(target, { recursive: true });
      shell.showItemInFolder(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ---- Limits --------------------------------------------------------------
  // A skill is prose plus, at most, a few helper scripts. These caps are
  // generous for that and hostile to everything else: a dropped node_modules,
  // a repo with its history, a zip bomb.
  //
  // The uncompressed cap is checked against the archive's OWN declared sizes
  // before a single byte is extracted. Checking after extraction is not a
  // check, it is a cleanup.
  const SKILL_MAX_BYTES = 10 * 1024 * 1024; // 10 MB on disk, unpacked
  const SKILL_MAX_FILES = 1000;
  const SKILL_MAX_DOWNLOAD = 20 * 1024 * 1024; // 20 MB over the wire
  // GB matters: a rejected zip bomb reporting "1024.0 MB" reads like a bug.
  const humanBytes = (n: number) =>
    n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB`
    : `${Math.ceil(n / 1024)} KB`;

  /** One staging directory at a time. Every zip validation and every fetch
   *  allocates one, and keeping only the newest stops rejected downloads
   *  accumulating for the life of the session. */
  function stageSkillDir(): string {
    for (const old of skillStages) {
      try {
        rmSync(old, { recursive: true, force: true });
      } catch {
        // under the OS temp dir either way
      }
      skillStages.delete(old);
    }
    const dir = mkdtempSync(join(tmpdir(), "unbiased-skill-"));
    skillStages.add(dir);
    return dir;
  }

  /** Walk a tree, refusing early rather than measuring something enormous in
   *  full. Symlinks are counted but not followed — a link out of the tree must
   *  not smuggle the whole disk past the cap. */
  function measureTree(root: string): { bytes: number; files: number; over: string | null } {
    let bytes = 0, files = 0;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isSymbolicLink()) { files++; continue; }
        if (e.isDirectory()) { stack.push(full); continue; }
        files++;
        try {
          bytes += statSync(full).size;
        } catch {
          // unreadable entry; it still counts toward the file cap
        }
        if (files > SKILL_MAX_FILES) return { bytes, files, over: `More than ${SKILL_MAX_FILES} files. A skill should be a handful of documents, not a source tree.` };
        if (bytes > SKILL_MAX_BYTES) return { bytes, files, over: `Larger than ${humanBytes(SKILL_MAX_BYTES)} unpacked.` };
      }
    }
    return { bytes, files, over: null };
  }

  /** Read a zip's central directory: total unpacked size, entry count, and the
   *  entry names, so both the bomb check and the traversal check happen before
   *  extraction. */
  function inspectZip(zip: string): { bytes: number; files: number; error: string | null } {
    let listing: string, names: string;
    try {
      listing = execFileSync("/usr/bin/unzip", ["-Zl", zip], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
      names = execFileSync("/usr/bin/unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    } catch {
      return { bytes: 0, files: 0, error: "That does not look like a readable zip file." };
    }
    // "N files, M bytes uncompressed, ..." — the archive's own claim, and it is
    // the LAST line. Taking the first match let a crafted entry impersonate the
    // summary: a file named "2 files, 100 bytes uncompressed.txt" is printed
    // above the real total, so exec() read 100 bytes for a 209 MB archive and
    // both caps passed. Proven with a working zip; hence matchAll and the tail.
    const totals = [...listing.matchAll(/(\d+)\s+files?,\s+(\d+)\s+bytes uncompressed/g)];
    const tail = totals.length ? totals[totals.length - 1] : null;
    if (!tail) return { bytes: 0, files: 0, error: "Could not read the zip's contents listing." };
    const files = Number(tail[1]);
    const bytes = Number(tail[2]);
    if (files > SKILL_MAX_FILES) return { bytes, files, error: `That zip holds ${files} files; the limit is ${SKILL_MAX_FILES}.` };
    if (bytes > SKILL_MAX_BYTES) {
      return { bytes, files, error: `That zip unpacks to ${humanBytes(bytes)}; the limit is ${humanBytes(SKILL_MAX_BYTES)}.` };
    }
    for (const raw of names.split("\n")) {
      const entry = raw.trim();
      if (!entry) continue;
      if (entry.startsWith("/") || entry.includes("..")) {
        return { bytes, files, error: `That zip contains an unsafe path (${entry}).` };
      }
    }
    return { bytes, files, error: null };
  }

  /** Find the skill inside an unpacked archive.
   *
   *  A bounded breadth-first search rather than a walk down single-child
   *  wrappers: real repos nest. vercel-labs/skills unpacks to
   *  `skills-main/skills/find-skills/SKILL.md` — depth two below the repo root,
   *  with siblings at every level, which a single-child descent gives up on
   *  immediately. Anything holding one skill resolves; anything holding several
   *  gets named so the user can link one directly instead of us guessing. */
  function findSkillRoot(dir: string, wantName?: string): { root: string | null; choices: string[] } {
    const SEARCH_DEPTH = 5;
    const SKIP = new Set([".git", "node_modules", ".github", "__pycache__", "dist", "build"]);
    const hits: string[] = [];
    let queue: { dir: string; depth: number }[] = [{ dir, depth: 0 }];
    while (queue.length && hits.length < 25) {
      const next: typeof queue = [];
      for (const { dir: cur, depth } of queue) {
        if (existsSync(join(cur, "SKILL.md"))) { hits.push(cur); continue; } // a skill is a leaf
        if (depth >= SEARCH_DEPTH) continue;
        let entries: import("node:fs").Dirent[];
        try {
          entries = readdirSync(cur, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isDirectory() || SKIP.has(e.name)) continue;
          // Dot-directories are skipped EXCEPT the ones skill collections
          // actually use — openai/skills keeps its curated set in `.curated`.
          if (e.name.startsWith(".") && !/^\.(curated|experimental|codex)$/.test(e.name)) continue;
          next.push({ dir: join(cur, e.name), depth: depth + 1 });
        }
      }
      queue = next;
    }
    // A link that named a skill picks it out of a repo holding many — which is
    // the whole point of a registry link, and of a /tree/ link to one folder.
    if (wantName) {
      const named = hits.find((h) => h.split("/").filter(Boolean).pop() === wantName);
      if (named) return { root: named, choices: [] };
    }
    if (hits.length === 1) return { root: hits[0], choices: [] };
    if (hits.length > 1) return { root: null, choices: hits.map((h) => relative(dir, h)) };
    return { root: null, choices: [] };
  }

  // A skill directory is `<name>/SKILL.md` plus whatever else it needs. Only
  // the manifest is required, and its frontmatter is the contract.
  const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  const SKILL_NAME_MAX = 64;
  type SkillSource = { kind: "folder" | "manifest"; manifest: string; name: string; description: string | null };

  /** Minimal frontmatter reader. A YAML dependency would be the only one in
   *  this app, for two scalar fields on the first lines of a file. */
  function readSkillFrontmatter(manifest: string): { name: string | null; description: string | null } {
    let text: string;
    try {
      text = readFileSync(manifest, "utf8").slice(0, 8192);
    } catch {
      return { name: null, description: null };
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) return { name: null, description: null };
    const field = (key: string): string | null => {
      const hit = new RegExp(`^${key}:[ \t]*(.+?)[ \t]*$`, "m").exec(m[1]);
      if (!hit) return null;
      return hit[1].replace(/^["']|["']$/g, "").trim() || null;
    };
    return { name: field("name"), description: field("description") };
  }

  ipcMain.handle("skills:choose", async () => {
    if (!win) return { path: null };
    const res = await dialog.showOpenDialog(win, {
      // Either shape is legitimate: a whole skill folder, or a lone SKILL.md.
      properties: ["openFile", "openDirectory"],
      title: "Choose a skill folder or SKILL.md",
      buttonLabel: "Choose",
      defaultPath: lastDialogDir("skills") ?? mainCwd ?? undefined,
    });
    if (res.canceled || res.filePaths.length === 0) return { path: null };
    rememberDialogDir("skills", res.filePaths[0]);
    return { path: res.filePaths[0] };
  });

  /** Say yes or no BEFORE anything is copied, and say why in the no case. */
  /** The shared tail of every add path: a directory (or a lone manifest) that
   *  should be a skill. Also where the size cap lands for folders and drops. */
  function validateSkillDir(src: string, opts?: { fromArchive?: boolean }): Record<string, unknown> {
    const isDir = statSync(src).isDirectory();
    const manifest = isDir ? join(src, "SKILL.md") : src;
    if (!existsSync(manifest)) return { ok: false, error: "No SKILL.md found." };
    let measured: { bytes: number; files: number; over: string | null };
    if (isDir) {
      measured = measureTree(src);
      if (measured.over) return { ok: false, error: measured.over };
    } else {
      measured = { bytes: statSync(src).size, files: 1, over: null };
    }
    const { name, description } = readSkillFrontmatter(manifest);
    const folderName = (isDir ? src : join(src, "..")).split("/").filter(Boolean).pop() ?? "";
    const suggested = name ?? folderName;
    if (!suggested) return { ok: false, error: "Could not work out a name for this skill." };
    // Anything the agent might execute is worth naming before it is installed:
    // a skill is instructions, but it can ship scripts alongside them.
    const scripts: string[] = [];
    if (isDir) {
      const stack = [src];
      while (stack.length && scripts.length < 20) {
        const dir = stack.pop()!;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) { stack.push(full); continue; }
          if (/\.(sh|bash|zsh|py|rb|pl|js|mjs|cjs|ts)$/i.test(e.name)) scripts.push(relative(src, full));
        }
      }
    }
    return {
      ok: true,
      path: src,
      kind: isDir ? "folder" : "manifest",
      fromArchive: !!opts?.fromArchive,
      name: suggested,
      description,
      bytes: measured.bytes,
      files: measured.files,
      sizeLabel: humanBytes(measured.bytes),
      scripts,
      warning: description ? null : "This skill has no description, so Pareto has little to go on when deciding to use it.",
    };
  }

  ipcMain.handle("skills:validate", (_e, payload: { path?: string }) => {
    const src = payload?.path;
    if (!src || !isAbsolute(src)) return { ok: false, error: "Choose a folder or a SKILL.md file." };
    let isDir: boolean;
    try {
      isDir = statSync(src).isDirectory();
    } catch {
      return { ok: false, error: "That path could not be read." };
    }
    // A zip is staged and unpacked first, then validated like any folder — but
    // only after its own declared sizes clear the caps.
    if (!isDir && /\.zip$/i.test(src)) {
      const zip = inspectZip(src);
      if (zip.error) return { ok: false, error: zip.error };
      const stage = stageSkillDir();
      try {
        execFileSync("/usr/bin/unzip", ["-q", "-o", "-d", stage, src], { maxBuffer: 8 * 1024 * 1024 });
      } catch {
        return { ok: false, error: "That zip could not be unpacked." };
      }
      // The pre-check reads the archive's own claim about itself. Measure what
      // actually landed before going further, so a declaration that lies costs
      // one rejected extraction rather than the disk.
      const landed = measureTree(stage);
      if (landed.over) {
        rmSync(stage, { recursive: true, force: true });
        skillStages.delete(stage);
        return { ok: false, error: `That zip unpacked to more than it declared. ${landed.over}` };
      }
      const found = findSkillRoot(stage);
      if (!found.root) {
        return {
          ok: false,
          error: found.choices.length
            ? `That zip holds several skills (${found.choices.slice(0, 4).join(", ")}${found.choices.length > 4 ? ", …" : ""}). Unzip it and choose one folder.`
            : "No SKILL.md inside that zip.",
        };
      }
      return validateSkillDir(found.root, { fromArchive: true });
    }
    const manifest = isDir ? join(src, "SKILL.md") : src;
    if (!isDir && !/(^|\/)SKILL\.md$/.test(src)) {
      return { ok: false, error: "Choose a skill folder, a SKILL.md file, or a .zip." };
    }
    if (!existsSync(manifest)) {
      return { ok: false, error: "That folder has no SKILL.md at its top level, so nothing would read it." };
    }
    return validateSkillDir(src);
  });

  /** Work out what a pasted link actually points at. Deliberately narrow: the
   *  shapes people paste, and nothing clever. */
  function resolveSkillUrl(
    input: string,
  ): { downloads: string[]; kind: "zip" | "manifest"; subpath?: string; wantName?: string } | { error: string } {
    let u: URL;
    try {
      u = new URL(input.trim());
    } catch {
      return { error: "That is not a valid link." };
    }
    if (u.protocol !== "https:") return { error: "Only https links are supported." };
    const parts = u.pathname.split("/").filter(Boolean);

    // A registry page is HTML about a skill, not the skill. skills.sh encodes
    // everything needed in its path — /{owner}/{repo}/{skill} — so translate it
    // to the repo and remember which skill was asked for.
    if (/^(www\.)?skills\.sh$/.test(u.hostname)) {
      if (parts.length < 2) return { error: "Link a specific skill on skills.sh, not the index." };
      const [owner, repo, skill] = parts;
      return {
        downloads: [
          `https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`,
          `https://github.com/${owner}/${repo}/archive/refs/heads/master.zip`,
        ],
        kind: "zip",
        wantName: skill,
      };
    }

    const gh = /^(www\.)?github\.com$/.test(u.hostname);
    if (gh && parts.length >= 2) {
      const [owner, repo, kind, ref, ...rest] = parts;
      const clean = repo.replace(/\.git$/, "");
      if (kind === "blob" && rest.length) {
        // A file link. Only a manifest is meaningful on its own.
        const raw = `https://raw.githubusercontent.com/${owner}/${clean}/${ref}/${rest.join("/")}`;
        if (!/SKILL\.md$/i.test(raw)) return { error: "Link a skill's folder, or its SKILL.md file." };
        return { downloads: [raw], kind: "manifest" };
      }
      if (kind === "tree") {
        return {
          downloads: [`https://github.com/${owner}/${clean}/archive/refs/heads/${ref}.zip`],
          kind: "zip",
          subpath: rest.join("/"),
          wantName: rest.length ? rest[rest.length - 1] : undefined,
        };
      }
      // Bare repo link: the default branch is not in the URL, so try the two
      // that cover nearly everything rather than spending an API call on it.
      return {
        downloads: [
          `https://github.com/${owner}/${clean}/archive/refs/heads/main.zip`,
          `https://github.com/${owner}/${clean}/archive/refs/heads/master.zip`,
        ],
        kind: "zip",
      };
    }
    if (/\.zip$/i.test(u.pathname)) return { downloads: [u.toString()], kind: "zip" };
    if (/SKILL\.md$/i.test(u.pathname)) return { downloads: [u.toString()], kind: "manifest" };
    // Naming the shape that was pasted beats restating the allowlist: the common
    // mistake is a page about a skill rather than the skill's files.
    return {
      error: `That looks like a web page rather than a skill's files. Link its GitHub repo or folder, a .zip, or a SKILL.md — ${u.hostname} is not a source this can download from.`,
    };
  }

  /** Stream to disk, refusing at the cap rather than after it. */
  async function downloadCapped(url: string, dest: string): Promise<string | null> {
    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (!res.ok) return `The server answered ${res.status}.`;
    if (!res.url.startsWith("https://")) return "That link redirected to an insecure address.";
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > SKILL_MAX_DOWNLOAD) return `That download is ${humanBytes(declared)}; the limit is ${humanBytes(SKILL_MAX_DOWNLOAD)}.`;
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) return "Nothing came back from that link.";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SKILL_MAX_DOWNLOAD) {
        void reader.cancel();
        return `That download passed ${humanBytes(SKILL_MAX_DOWNLOAD)} and was stopped.`;
      }
      chunks.push(Buffer.from(value));
    }
    writeFileSync(dest, Buffer.concat(chunks));
    return null;
  }

  ipcMain.handle("skills:fetch", async (_e, payload: { url?: string }) => {
    const resolved = resolveSkillUrl(payload?.url ?? "");
    if ("error" in resolved) return { ok: false, error: resolved.error };
    const stage = stageSkillDir();
    const target = join(stage, resolved.kind === "zip" ? "download.zip" : "SKILL.md");
    let lastError: string | null = null;
    for (const url of resolved.downloads) {
      lastError = await downloadCapped(url, target);
      if (!lastError) break;
    }
    if (lastError) return { ok: false, error: lastError };

    if (resolved.kind === "manifest") {
      // A lone manifest: park it in its own folder so the shape matches.
      const dir = join(stage, "skill");
      mkdirSync(dir, { recursive: true });
      cpSync(target, join(dir, "SKILL.md"));
      return validateSkillDir(dir, { fromArchive: true });
    }

    const zip = inspectZip(target);
    if (zip.error) return { ok: false, error: zip.error };
    const out = join(stage, "unpacked");
    try {
      execFileSync("/usr/bin/unzip", ["-q", "-o", "-d", out, target], { maxBuffer: 8 * 1024 * 1024 });
    } catch {
      return { ok: false, error: "That archive could not be unpacked." };
    }
    const landed = measureTree(out);
    if (landed.over) return { ok: false, error: `That archive unpacked to more than it declared. ${landed.over}` };
    // A /tree/ link names a folder inside the repo; honour it before searching.
    let base = out;
    if (resolved.subpath) {
      const wrappers = readdirSync(out, { withFileTypes: true }).filter((e) => e.isDirectory());
      const inner = wrappers.length === 1 ? join(out, wrappers[0].name) : out;
      const candidate = join(inner, resolved.subpath);
      if (existsSync(candidate)) base = candidate;
    }
    const found = findSkillRoot(base, resolved.wantName);
    if (!found.root) {
      return {
        ok: false,
        error: found.choices.length
          ? `That link holds several skills (${found.choices.slice(0, 4).join(", ")}${found.choices.length > 4 ? ", …" : ""}). Link one of them directly.`
          : resolved.wantName
            ? `No skill named "${resolved.wantName}" in that repository.`
            : "No SKILL.md found at that link.",
      };
    }
    return validateSkillDir(found.root, { fromArchive: true });
  });

  ipcMain.handle("skills:limits", () => ({
    maxBytes: SKILL_MAX_BYTES,
    maxFiles: SKILL_MAX_FILES,
    maxDownload: SKILL_MAX_DOWNLOAD,
    label: humanBytes(SKILL_MAX_BYTES),
  }));

  ipcMain.handle(
    "skills:install",
    (_e, payload: { path?: string; name?: string; scope?: "global" | "project"; cwd?: string | null }) => {
      const src = payload?.path;
      const name = (payload?.name ?? "").trim();
      if (!src || !isAbsolute(src)) return { ok: false, error: "Choose a folder or a SKILL.md file." };
      if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX) {
        return { ok: false, error: "Use letters, digits, hyphens and underscores only, starting with a letter or digit." };
      }
      let root: string;
      if (payload.scope === "project") {
        const cwd = payload.cwd;
        if (!cwd || !isAbsolute(cwd)) return { ok: false, error: "Open a project first to add a skill to it." };
        // codex scans exactly <cwd>/.codex/skills and does not walk up, so this
        // path is the engine's, not a naming choice of ours.
        root = join(cwd, ".codex", "skills");
      } else {
        root = globalSkillsDir();
      }
      const dest = join(root, name);
      if (existsSync(dest)) {
        return { ok: false, error: `A skill named "${name}" is already there. Rename it or remove the existing one.` };
      }
      try {
        mkdirSync(root, { recursive: true });
        if (statSync(src).isDirectory()) {
          cpSync(src, dest, { recursive: true });
        } else {
          mkdirSync(dest, { recursive: true });
          cpSync(src, join(dest, "SKILL.md"));
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true, path: join(dest, "SKILL.md"), root };
    },
  );

  ipcMain.handle("skills:remove", (_e, payload: { path?: string; cwd?: string | null }) => {
    const manifest = payload?.path;
    if (!manifest || !isAbsolute(manifest)) return { ok: false, error: "No skill given." };
    // Only ever inside a root WE manage. A skill from ~/.agents/skills or the
    // engine's own .system belongs to something else; deleting it from here
    // would be reaching into another tool's files.
    //
    // The cwd comes from the caller, matching skills:list and skills:install.
    // Reading mainCwd instead was wrong: a conversation running in a worktree
    // has a different mainCwd from the project the panel listed, so deleting a
    // project skill was refused as "outside the folders Unbiased manages".
    const projectCwd = payload?.cwd && isAbsolute(payload.cwd) ? payload.cwd : mainCwd;
    const owned = [globalSkillsDir(), ...(projectCwd ? [join(projectCwd, ".codex", "skills")] : [])];
    const dir = join(manifest, "..");
    if (!owned.some((root) => dir.startsWith(root + "/"))) {
      return { ok: false, error: "That skill lives outside the folders Unbiased manages." };
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true };
  });

  ipcMain.handle("chat:live-approvals", () => ({ requestIds: [...pendingApprovals.keys()] }));

  ipcMain.handle("chat:approve", (_e, payload: {
    requestId: string;
    decision: "accept" | "acceptForSession" | "decline";
  }) => {
    const pending = pendingApprovals.get(payload.requestId);
    // Nothing is waiting on this: the turn died, most often because the app
    // was quit while the card was up. Say so rather than returning a bare
    // false the caller can mistake for "sent".
    if (pending === undefined) return { ok: false, expired: true };
    observeLearning(
      "approval_decision",
      "threadId" in pending ? (pending.threadId as string | null) : null,
      `user ${payload.decision}`,
      { decision: payload.decision === "acceptForSession" ? "acceptForSession" : payload.decision },
    );
    pendingApprovals.delete(payload.requestId);
    // No engine item stands behind a synthesized card, so nothing would ever
    // flip it off "running" — resolve it here. Shared by local approvals and
    // MCP elicitations, both of which raise a card of their own.
    function settleSynthesizedCard(threadId: string | null, requestId: string, decision: ApprovalDecision): void {
      const sub = threadId ? subAgents.get(threadId) : undefined;
      const paneId = paneForThread(sub ? sub.parent : threadId);
      if (paneId) {
        send("chat:command", {
          paneId,
          phase: "completed",
          item: { id: requestId, status: decision === "decline" ? "declined" : "completed" },
        });
      }
    }
    if (pending.kind === "engine") {
      engine.respond(pending.rpcId, { decision: payload.decision });
    } else if (pending.kind === "elicitation") {
      // "acceptForSession" collapses to a plain accept: codex advertises
      // persistence options in the request (_meta.persist), but the shape for
      // choosing one is undocumented, and guessing at it risks a reply that
      // fails to deserialize — the exact failure this branch exists to fix.
      // The card still offers the choice; it just asks again next time.
      engine.respond(pending.rpcId, {
        action: payload.decision === "decline" ? "decline" : "accept",
        content: {},
      });
      settleSynthesizedCard(pending.threadId, payload.requestId, payload.decision);
    } else {
      pending.settle(payload.decision);
      settleSynthesizedCard(pending.threadId, payload.requestId, payload.decision);
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
    // Runs from before threadSource was set carry no tag, so their threads
    // would still surface. The task records name the most recent one per task,
    // which is exactly the set currently visible in Recents. Older untagged
    // runs may still linger — deleting those rows once is the only cleanup.
    const scheduledThreadIds = new Set(
      readTasks()
        .map((t) => t.lastThreadId)
        .filter((x): x is string => typeof x === "string"),
    );
    const worktrees = loadWorktrees();
    const threadProjectOverrides = loadThreadProjects();
    const recents: ThreadSummary[] = [];
    for (const t of result.data ?? []) {
      // Scheduled runs are reachable from the Scheduled page (Open run / Open
      // last run) and nowhere else. Two daily tasks would otherwise add ~60
      // rows a month to Recents and bury the conversations the user started.
      if (t.threadSource === SCHEDULED_THREAD_SOURCE || scheduledThreadIds.has(t.id)) continue;
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
        // A project with no folder of its own belongs in the app's own
        // workspace, not loose in the home directory. Dropping it at ~/<Name>
        // scattered app-created folders among Documents, Downloads and the
        // rest, where nothing marks them as ours and nothing groups them
        // together. defaultChatDir() is the same ~/Unbiased the no-project
        // chats already use, and it falls back to home if it cannot be made,
        // so the old behaviour survives as the failure case rather than the
        // default one.
        primary = join(defaultChatDir(), safe);
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
      // First run opens in the app's workspace, matching where a project with
      // no chosen location is created. After that the last pick wins.
      defaultPath: lastDialogDir("projectLocation") ?? defaultChatDir(),
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    rememberDialogDir("projectLocation", result.filePaths[0], false);
    return { path: result.filePaths[0] };
  });

  ipcMain.handle("project:choose", async () => {
    if (!win) return { path: null, name: null };
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Choose a project folder",
      buttonLabel: "Open project",
      defaultPath: lastDialogDir("project"),
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null, name: null };
    const path = result.filePaths[0];
    rememberDialogDir("project", path);
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
      : ((await engine.request("thread/resume", {
          threadId: id,
          ...threadPolicy(),
          // Re-declare everything a thread/start would. Tools are declared per
          // session, not stored with the thread, so a resumed conversation had
          // NO dynamic tools at all — reopening a chat silently cost it the
          // agent browser and the scheduling tool, and the model discovered
          // that mid-task ("there are no browser_connect tools available").
          //
          // Same omission as the side-chat fork, in the path I did not check
          // when fixing that one. ThreadResumeParams accepts
          // developerInstructions; dynamicTools and experimentalRawEvents are
          // experimentalApi fields absent from the schema, and the engine
          // ignores unknown params, so this cannot break a resume. Whether it
          // HONOURS them on resume is unverified — experimentalRawEvents is
          // known to be ignored here (measured for the sub-agent nicknames),
          // so dynamicTools may be too. If it is, a reopened conversation
          // needs a fresh thread to regain tools, not this.
          dynamicTools: threadDynamicTools(),
          // The thread's cwd is only known once the resume RETURNS, so the
          // memory index rides along when this app session has seen the
          // thread before, and is omitted on a cold reopen — no section
          // beats injecting some other project's memory (mainCwd still
          // points at the conversation being left).
          developerInstructions: threadCwds.has(id)
            ? developerInstructionsFor(threadCwds.get(id) ?? null)
            : APP_DEVELOPER_INSTRUCTIONS,
          experimentalRawEvents: true,
        })) as {
          thread: WireThread;
          cwd?: string;
        });
    mainCwd = result.cwd ?? result.thread.cwd ?? null;
    if (mainCwd) threadCwds.set(id, mainCwd); // memory_save now targets the right project
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
    // Nicknames from the rollout. Two jobs: seed pendingNicknames so a spawn
    // made AFTER this open is named correctly, and retitle sub-agents already
    // registered under their raw task name so existing rows stop reading
    // "app_bridge_routing". Both are needed — the first alone leaves the
    // transcript wrong, the second alone leaves the next spawn wrong.
    applyRolloutNicknames(id);
    const approvals = heldApprovals.get(id) ?? [];
    heldApprovals.delete(id);
    const failure = heldErrors.get(id) ?? null;
    heldErrors.delete(id);
    // History replays raw engine content — same redaction as live events.
    return redactSecrets({
      id,
      ...(() => {
        const replay = threadToEntries(result.thread, { runningLastTurn: running });
        return {
          entries: replay.entries,
          runningTurnStart: replay.runningTurnStart,
          runningTurnStartedAt: replay.runningTurnStartedAt,
        };
      })(),
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
        //
        // The window matters. Mail is recorded milliseconds INTO the second
        // its turn starts and both sides are floored to seconds, so an
        // agent's own first turn can be stamped a tick BEFORE the task that
        // triggered it — a strict `t < spawnAt` then deletes the agent's
        // entire reply (observed: a two-agent spawn whose answers sat in the
        // rollout unseen). Forked parent history is older by minutes or
        // hours, so a couple of seconds of grace separates the two cleanly.
        //
        // Do NOT widen this to "keep everything when the filter finds
        // nothing": an agent that has not answered yet ALSO yields nothing,
        // and the pane would then show the parent's whole conversation in
        // the agent's voice.
        if (spawnAt !== null && turn.startedAt != null && t < spawnAt - SPAWN_GRACE_SECONDS) continue;
        const entries = threadToEntries({ ...result.thread, turns: [turn] }).entries.filter(
          (e) => (e as { kind?: string }).kind !== "user",
        );
        if (entries.length === 0) continue;
        // Nothing the agent did precedes its own spawn, so clamping only
        // lifts the tick-early turns — and the mail-first tie-break below
        // then keeps the prompt above the reply it triggered.
        timeline.push({ t: spawnAt !== null ? Math.max(t, spawnAt) : t, mail: false, entries });
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

  /** One attachment record from a path — folder, image (thumbnailed, sent as
   *  localImage so the model sees pixels rather than binary in context), or a
   *  plain file. Shared by the picker and by drag-and-drop. */
  function describeAttachment(path: string): Record<string, unknown> {
    const name = path.split("/").filter(Boolean).pop() ?? path;
    try {
      if (statSync(path).isDirectory()) return { path, name, kind: "folder" };
    } catch {
      // fall through to the generic file card
    }
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)) {
      const img = nativeImage.createFromPath(path);
      if (!img.isEmpty()) return { path, name, kind: "image", thumb: thumbDataUrl(img) };
    }
    return { path, name, kind: "file" };
  }

  ipcMain.handle("attach:choose", async () => {
    if (!win) return { attachments: [] };
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "openDirectory", "multiSelections"],
      title: "Attach files or folders",
      buttonLabel: "Attach",
      defaultPath: lastDialogDir("attach") ?? mainCwd ?? undefined,
    });
    if (result.canceled) return { attachments: [] };
    if (result.filePaths[0]) rememberDialogDir("attach", result.filePaths[0]);
    return { attachments: result.filePaths.map(describeAttachment) };
  });

  // Drag-and-drop lands here. The renderer can resolve a dropped File to a
  // real path (webUtils) but cannot stat it or read an image off disk, so the
  // classification has to happen on this side — and it is the SAME
  // classification the picker uses, deliberately: a folder dragged in and a
  // folder chosen from the dialog should arrive as the same kind of thing.
  ipcMain.handle("attach:paths", (_e, p: { paths?: unknown }) => {
    const paths = Array.isArray(p?.paths) ? p.paths.filter((x): x is string => typeof x === "string") : [];
    // Only paths that exist. A drop can carry an item with no file behind it
    // (a dragged selection, a web image), and webUtils hands back "" for those.
    const real = paths.filter((path) => {
      if (!path || !isAbsolute(path)) return false;
      try {
        statSync(path);
        return true;
      } catch {
        return false;
      }
    });
    if (real[0]) rememberDialogDir("attach", real[0]);
    return { attachments: real.map(describeAttachment) };
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

  // ── Agent-browser mirror IPC ──
  /** One supervision step: attach if we are not attached, and notice when the
   *  tab we were mirroring is gone so the next step re-attaches. */
  async function mirrorTick(): Promise<{ ok: boolean; error?: string }> {
    if (!mirrorDesired || mirrorAttaching) return { ok: !!mirrorWs };
    if (mirrorWs) {
      // Still attached — make sure the target still exists. A closed tab does
      // not always deliver a socket close promptly.
      try {
        const res = await fetch(`http://127.0.0.1:${AGENT_CHROME_PORT}/json/list`, {
          signal: AbortSignal.timeout(2_000),
        });
        const targets = (await res.json()) as CdpTarget[];
        const best = pickMirrorTarget(targets);
        // Re-attach when our tab is gone OR when the agent has moved to a
        // better one — opening a new tab used to leave the pane on the old.
        if (mirrorTargetId && (!targets.some((t) => t.id === mirrorTargetId) || (best?.id && best.id !== mirrorTargetId))) {
          mirrorTeardown(true);
        } else if (mirrorWs) {
          // Chrome can park our tab again whenever another one comes forward,
          // and a parked tab silently stops painting. Cheap to reassert.
          await mirrorCall("Page.bringToFront").catch(() => {});
          // Backstop only: the frame handler corrects a wrong shape within one
          // frame. This catches the case where frames have stopped arriving
          // altogether, so nothing is left to trigger that path.
          if (mirrorShapeWrong(mirrorLastFrame)) await mirrorCorrectViewport();
        }
      } catch {
        mirrorTeardown(true); // Chrome went away
      }
      return { ok: !!mirrorWs };
    }
    mirrorAttaching = true;
    try {
      return await mirrorStart(mirrorSize.width, mirrorSize.height);
    } finally {
      mirrorAttaching = false;
    }
  }
  function mirrorSupervise(): void {
    if (mirrorTimer) return;
    mirrorTimer = setInterval(() => void mirrorTick(), 1_500);
    mirrorTimer.unref?.();
  }

  ipcMain.handle(
    "agentmirror:start",
    async (_e, p: { width: number; height: number; dpr: number; threadId?: string | null }) => {
    mirrorDesired = true;
    mirrorSize = {
      width: Number(p?.width) || 800,
      height: Number(p?.height) || 600,
      dpr: Math.min(3, Math.max(1, Number(p?.dpr) || 1)),
    };
    // Which conversation's tab this pane is watching. Without it the mirror
    // picks a tab by URL and, now that each chat has its own, can show the
    // wrong chat browsing — the same crossed wires one layer up.
    mirrorViewRoot = rootThreadOf(typeof p?.threadId === "string" ? p.threadId : null);
    mirrorSupervise();
    return mirrorTick();
    },
  );
  ipcMain.handle("agentmirror:stop", () => {
    mirrorDesired = false;
    if (mirrorTimer) {
      clearInterval(mirrorTimer);
      mirrorTimer = null;
    }
    mirrorTeardown(false);
    return { ok: true };
  });
  // Resize = restart the screencast at the new bounds; Chrome allows calling
  // startScreencast again on a live session.
  ipcMain.handle("agentmirror:resize", async (_e, p: { width: number; height: number; dpr: number }) => {
    // Remember it even while detached, so a later re-attach uses the real size.
    mirrorSize = {
      width: Number(p?.width) || 800,
      height: Number(p?.height) || 600,
      dpr: Math.min(3, Math.max(1, Number(p?.dpr) || mirrorSize.dpr)),
    };
    if (!mirrorWs) return { ok: false };
    try {
      const vp = await mirrorApplyViewport(mirrorSize.width, mirrorSize.height, mirrorSize.dpr);
      await mirrorCall("Page.startScreencast", {
        format: "jpeg",
        quality: 85,
        ...mirrorFrameBounds(vp),
        everyNthFrame: 1,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
  ipcMain.handle("agentmirror:input", async (_e, ev: MirrorInput) => {
    try {
      await mirrorInput(ev);
      return { ok: true };
    } catch {
      return { ok: false }; // a dropped click is not worth a dialog
    }
  });

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

  /** Close a deleted conversation's browser tab. Best-effort: the browser may
   *  not be running, and a failure here must never block the delete. */
  async function releaseConversationTab(rootId: string): Promise<void> {
    const entry = browserTabs.get(rootId);
    if (!entry) return;
    browserTabs.delete(rootId);
    if (browserActiveRoot === rootId) browserActiveRoot = null;
    if (browserSessionBound && !browserAttachedExternal) {
      await withBrowserLock(() => runAgentBrowser(["tab", "close", entry.label], 15_000)).catch(() => undefined);
    }
  }

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
    void releaseConversationTab(id);
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
  void refreshReleaseNotes();
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
  void learning?.stop();
  learning = null;
  // Downloads and unpacked archives that were never installed.
  for (const dir of skillStages) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort; it is under the OS temp dir either way
    }
  }
  skillStages.clear();
  stopScheduler();
  engine.stop();
  // The agent browser's daemon outlives us otherwise — close every session.
  const bin = agentBrowserBinCache;
  if (bin && !browserAttachedExternal) execFile(bin, ["close", "--all"], () => {});
  // Our own Chrome goes with us; its profile (and logins) persist on disk.
  managedChrome?.kill();
  app.quit();
});
