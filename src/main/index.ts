import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "electron";
import type { NativeImage } from "electron";
import { isAbsolute, join, relative } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { EngineClient, engineVersionFromUserAgent, type EngineStatus } from "./engine";

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

// Every thread we start or resume gets the same policy: built-in trusted
// commands run freely, everything else asks the human. Sandbox stays
// read-only until the file-change approval UI exists.
const THREAD_POLICY = { approvalPolicy: "untrusted", sandbox: "read-only" } as const;

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
function thumbDataUrl(image: NativeImage): string {
  const { width, height } = image.getSize();
  const scale = 112 / Math.max(width, height, 1);
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
          ...THREAD_POLICY,
        })) as { thread: { id: string } };
      } else if (paneId === "side") {
        // No parent conversation yet: a plain scratch thread.
        started = (await engine.request("thread/start", {
          ...THREAD_POLICY,
          ephemeral: true,
        })) as { thread: { id: string } };
      } else {
        started = (await engine.request("thread/start", {
          ...THREAD_POLICY,
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
    })) as { turn?: { id?: string } };
    if (result.turn?.id) pane.turnId = result.turn.id;
    return { turnId: pane.turnId, threadId: pane.threadId, created };
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
    const result = (await engine.request("thread/resume", { threadId: id, ...THREAD_POLICY })) as {
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
  engine.stop();
  app.quit();
});
