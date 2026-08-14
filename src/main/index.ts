import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  WebContentsView,
} from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type { NativeImage } from "electron";
import { isAbsolute, join, relative } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { EngineClient, engineVersionFromUserAgent, type EngineStatus } from "./engine";
import { spawn as ptySpawn, type IPty } from "@lydell/node-pty";

const engine = new EngineClient();
let win: BrowserWindow | null = null;
let lastStatus: EngineStatus = { state: "starting" };

// Two conversation panes share one engine. "main" is the persistent,
// sidebar-listed conversation; "side" is a scratch pane on an ephemeral
// thread (in-memory only — codex discards it when the engine exits).
// Notifications carry threadId, so each pane's traffic routes cleanly.
type PaneId = "main" | "side";
const panes: Record<PaneId, { threadId: string | null; turnId: string | null }> = {
  main: { threadId: null, turnId: null },
  side: { threadId: null, turnId: null },
};

function paneForThread(threadId: unknown): PaneId | null {
  if (panes.main.threadId === threadId) return "main";
  if (panes.side.threadId === threadId) return "side";
  return null;
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
  ask: { approvalPolicy: "untrusted", sandbox: "read-only" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  full: { approvalPolicy: "never", sandbox: "danger-full-access" },
};
const MODE_TURN_SANDBOX: Record<AccessMode, Record<string, unknown>> = {
  ask: { type: "readOnly" },
  auto: { type: "workspaceWrite" },
  full: { type: "dangerFullAccess" },
};

function threadPolicy(): { approvalPolicy: string; sandbox: string } {
  return MODE_THREAD_POLICY[accessMode];
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
};
type WireThread = {
  id: string;
  name?: string | null;
  preview?: string;
  createdAt?: string;
  cwd?: string;
  turns?: { items?: WireItem[] }[];
};

// Projects the user has explicitly opened. Persisted so a project appears
// in the sidebar the moment it's chosen — before (and regardless of) any
// conversation existing in it. Thread cwds merge in at list time.
function projectsFile(): string {
  return join(app.getPath("userData"), "projects.json");
}

function loadProjects(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(projectsFile(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function rememberProject(path: string): void {
  const projects = loadProjects();
  if (!projects.includes(path)) {
    projects.unshift(path);
    writeFileSync(projectsFile(), JSON.stringify(projects, null, 2) + "\n");
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

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

/** Launcher icon (rasterized from resources/icon.svg). In development it
 *  lives in the repo; packaged builds must ship it via extraResources. */
function resolveIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "resources", "icon.png");
}

function createWindow(): void {
  const iconPath = resolveIconPath();
  // macOS ignores BrowserWindow icons — the dock owns the launcher icon.
  if (process.platform === "darwin" && existsSync(iconPath)) {
    app.dock?.setIcon(iconPath);
  }
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    title: "Unbiased",
    ...(process.platform !== "darwin" && existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: { preload: join(__dirname, "../preload/index.js") },
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
// string handle the renderer can safely round-trip.
const pendingApprovals = new Map<string, number | string>();

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
async function startAnnotatePicker(): Promise<void> {
  const wc = browserView?.webContents;
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

// The embedded browser: a sandboxed WebContentsView layered over the side
// panel. The renderer owns the toolbar and reports the placeholder's
// bounds; this side owns navigation and pushes state back.
let browserView: WebContentsView | null = null;

function ensureBrowserView(): WebContentsView {
  if (browserView) return browserView;
  const view = new WebContentsView({ webPreferences: { sandbox: true } });
  browserView = view;
  win?.contentView.addChildView(view);
  const wc = view.webContents;
  const pushState = () => {
    if (wc.isDestroyed()) return;
    send("browser:state", {
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
  // Popups/new-tab links load in the same pane — there is one pane.
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
      { label: "Annotate", click: () => void startAnnotatePicker() },
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
    const paneId = paneForThread(params.threadId);
    if (!paneId) return; // a thread no pane owns (e.g. just deleted)
    switch (msg.method) {
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        if (turn?.id) panes[paneId].turnId = turn.id;
        send("chat:turn-started", { paneId, turnId: panes[paneId].turnId });
        break;
      }
      case "item/agentMessage/delta": {
        send("chat:delta", { paneId, delta: (params.delta as string) ?? "" });
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item as { type?: string } | undefined;
        if (item?.type === "commandExecution") {
          send("chat:command", {
            paneId,
            phase: msg.method === "item/started" ? "started" : "completed",
            item,
          });
        }
        break;
      }
      case "turn/completed": {
        const turn = params.turn as { status?: string; usage?: unknown } | undefined;
        panes[paneId].turnId = null;
        send("chat:turn-completed", {
          paneId,
          status: turn?.status ?? "completed",
          usage: turn?.usage ?? null,
        });
        break;
      }
    }
  });

  engine.on(
    "server-request",
    (msg: { id: number | string; method: string; params?: Record<string, unknown> }) => {
      const params = msg.params ?? {};
      if (msg.method === "item/commandExecution/requestApproval") {
        const paneId = paneForThread(params.threadId) ?? "main";
        const requestId = `apr_${msg.id}`;
        pendingApprovals.set(requestId, msg.id);
        send("chat:approval-request", {
          paneId,
          requestId,
          // itemId ties the request to its commandExecution item so the
          // renderer can put the buttons ON the command card.
          itemId: (params.itemId as string) ?? null,
          command: (params.command as string) ?? "(unknown command)",
          cwd: (params.cwd as string) ?? null,
          reason: (params.reason as string) ?? null,
        });
        return;
      }
      // Anything we don't render yet (file changes, user-input tools):
      // declining beats hanging the turn on a question nobody can see.
      console.warn("[app] declining unhandled server request:", msg.method);
      engine.respond(msg.id, { decision: "decline" });
    },
  );
}

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

  engine.on("status", pushStatus);
  wireNotifications();
  engine.start(bin);

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

  ipcMain.handle("chat:send", async (_e, payload: {
    paneId: PaneId;
    text: string;
    attachments?: { name: string; path: string; kind?: "image" }[];
  }) => {
    const { paneId, text, attachments } = payload;
    const pane = panes[paneId];
    let created = false;
    if (!pane.threadId) {
      let started: { thread: { id: string } };
      if (paneId === "side" && panes.main.threadId) {
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
      } else if (paneId === "side") {
        // No parent conversation yet: a plain scratch thread.
        started = (await engine.request("thread/start", {
          ...threadPolicy(),
          ephemeral: true,
        })) as { thread: { id: string } };
      } else {
        started = (await engine.request("thread/start", {
          ...threadPolicy(),
          // Explicit home when no project is chosen — left implicit, the
          // engine falls back to its own process cwd (wherever the app
          // launched from) and the chat wrongly files under that project.
          cwd: pendingCwd ?? app.getPath("home"),
        })) as { thread: { id: string }; cwd?: string };
        mainCwd = (started as { cwd?: string }).cwd ?? pendingCwd ?? mainCwd;
      }
      pane.threadId = started.thread.id;
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
    const result = (await engine.request("turn/start", {
      threadId: pane.threadId,
      input,
      // Turn-level overrides apply "this turn and subsequent turns", so a
      // mode switched mid-conversation takes effect immediately.
      approvalPolicy: threadPolicy().approvalPolicy,
      sandboxPolicy: MODE_TURN_SANDBOX[accessMode],
    })) as { turn?: { id?: string } };
    if (result.turn?.id) pane.turnId = result.turn.id;
    return { turnId: pane.turnId, threadId: pane.threadId, created };
  });

  ipcMain.handle("policy:set-mode", (_e, mode: string) => {
    if (mode === "ask" || mode === "auto" || mode === "full") accessMode = mode;
    return { mode: accessMode };
  });

  ipcMain.handle("chat:interrupt", async (_e, paneId: PaneId) => {
    const pane = panes[paneId];
    if (!pane.threadId || !pane.turnId) return { interrupted: false };
    await engine.request("turn/interrupt", { threadId: pane.threadId, turnId: pane.turnId });
    return { interrupted: true };
  });

  ipcMain.handle("chat:approve", (_e, payload: { requestId: string; decision: "accept" | "decline" }) => {
    const engineRequestId = pendingApprovals.get(payload.requestId);
    if (engineRequestId === undefined) return { ok: false };
    pendingApprovals.delete(payload.requestId);
    engine.respond(engineRequestId, { decision: payload.decision });
    return { ok: true };
  });

  ipcMain.handle("threads:list", async () => {
    const result = (await engine.request("thread/list", { limit: 100 })) as { data?: WireThread[] };
    const home = app.getPath("home");
    // Codex-style sections: threads that ran inside a project folder group
    // under that folder's name; home-dir (or cwd-less) threads are Recents.
    // Keyed by full path so two folders sharing a basename stay distinct.
    // Explicitly opened projects render even with zero conversations.
    const projectMap = new Map<string, ThreadSummary[]>();
    for (const path of loadProjects()) projectMap.set(path, []);
    const recents: ThreadSummary[] = [];
    for (const t of result.data ?? []) {
      const summary: ThreadSummary = { id: t.id, title: threadTitle(t), createdAt: t.createdAt };
      if (t.cwd && t.cwd !== home) {
        const list = projectMap.get(t.cwd) ?? [];
        list.push(summary);
        projectMap.set(t.cwd, list);
      } else {
        recents.push(summary);
      }
    }
    return {
      projects: [...projectMap].map(([path, threads]) => ({
        path,
        name: path.split("/").filter(Boolean).pop() ?? path,
        threads,
      })),
      recents,
    };
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
    panes.side.threadId = null;
    panes.side.turnId = null;
    return { path, name: path.split("/").filter(Boolean).pop() ?? path };
  });

  ipcMain.handle("threads:open", async (_e, id: string) => {
    const result = (await engine.request("thread/resume", { threadId: id, ...threadPolicy() })) as {
      thread: WireThread;
      cwd?: string;
    };
    mainCwd = result.cwd ?? result.thread.cwd ?? null;
    panes.main.threadId = id;
    panes.main.turnId = null;
    // The side chat (if any) was forked from the previous conversation;
    // it resets alongside every main-context switch.
    panes.side.threadId = null;
    panes.side.turnId = null;
    return { id, entries: threadToEntries(result.thread) };
  });

  ipcMain.handle("threads:detach", (_e, cwd?: string) => {
    // Fresh main-chat view: the next send creates a new thread, in `cwd` if given.
    panes.main.threadId = null;
    panes.main.turnId = null;
    panes.side.threadId = null;
    panes.side.turnId = null;
    pendingCwd = cwd ?? null;
    mainCwd = cwd ?? null;
    return { ok: true };
  });

  ipcMain.handle("side:reset", () => {
    // Side chats are disposable: dropping the reference is the whole
    // cleanup — the ephemeral thread evaporates with the engine.
    panes.side.threadId = null;
    panes.side.turnId = null;
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

  ipcMain.handle("browser:open", (_e, url?: string) => {
    const view = ensureBrowserView();
    if (url) void view.webContents.loadURL(url);
    return { ok: true };
  });

  ipcMain.handle("browser:bounds", (_e, b: { x: number; y: number; width: number; height: number }) => {
    // The renderer measures in its own CSS pixels; setBounds wants window
    // DIPs. They differ by the page zoom factor (Cmd+= / Cmd+-), so an
    // unzoomed conversion strands the view at the wrong spot and size.
    const z = win?.webContents.getZoomFactor() ?? 1;
    ensureBrowserView().setBounds({
      x: Math.round(b.x * z),
      y: Math.round(b.y * z),
      width: Math.max(0, Math.round(b.width * z)),
      height: Math.max(0, Math.round(b.height * z)),
    });
  });

  ipcMain.handle("browser:visible", (_e, visible: boolean) => {
    browserView?.setVisible(visible);
  });

  ipcMain.handle("browser:navigate", (_e, p: { url?: string; action?: "back" | "forward" | "reload" }) => {
    const wc = browserView?.webContents;
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

  ipcMain.handle("browser:annotate-mode", () => {
    void startAnnotatePicker();
    return { ok: true };
  });

  ipcMain.handle("browser:close", () => {
    if (browserView) {
      win?.contentView.removeChildView(browserView);
      browserView.webContents.close();
      browserView = null;
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
    await engine.request("thread/delete", { threadId: id });
    if (panes.main.threadId === id) {
      panes.main.threadId = null;
      panes.main.turnId = null;
      panes.side.threadId = null;
      panes.side.turnId = null;
    }
    return { ok: true };
  });

  createWindow();
  try {
    await startEngine();
  } catch (err) {
    pushStatus({ state: "exited", code: null, detail: String(err) });
  }
});

app.on("window-all-closed", () => {
  for (const pty of ptys.values()) pty.kill();
  ptys.clear();
  engine.stop();
  app.quit();
});
