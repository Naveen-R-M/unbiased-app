import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

function pushStatus(status: EngineStatus): void {
  lastStatus = status;
  win?.webContents.send("engine:status", status);
}

function send(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    title: "Unbiased",
    webPreferences: { preload: join(__dirname, "../preload/index.js") },
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

  ipcMain.handle("chat:send", async (_e, payload: { paneId: PaneId; text: string }) => {
    const { paneId, text } = payload;
    const pane = panes[paneId];
    let created = false;
    if (!pane.threadId) {
      const startParams =
        paneId === "side"
          ? { ...THREAD_POLICY, ephemeral: true }
          : { ...THREAD_POLICY, ...(pendingCwd ? { cwd: pendingCwd } : {}) };
      const started = (await engine.request("thread/start", startParams)) as {
        thread: { id: string };
      };
      pane.threadId = started.thread.id;
      created = true;
    }
    const result = (await engine.request("turn/start", {
      threadId: pane.threadId,
      input: [{ type: "text", text }],
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
    panes.main.threadId = null;
    panes.main.turnId = null;
    return { path, name: path.split("/").filter(Boolean).pop() ?? path };
  });

  ipcMain.handle("threads:open", async (_e, id: string) => {
    const result = (await engine.request("thread/resume", { threadId: id, ...THREAD_POLICY })) as {
      thread: WireThread;
    };
    panes.main.threadId = id;
    panes.main.turnId = null;
    return { id, entries: threadToEntries(result.thread) };
  });

  ipcMain.handle("threads:detach", (_e, cwd?: string) => {
    // Fresh main-chat view: the next send creates a new thread, in `cwd` if given.
    panes.main.threadId = null;
    panes.main.turnId = null;
    pendingCwd = cwd ?? null;
    return { ok: true };
  });

  ipcMain.handle("side:reset", () => {
    // Side chats are disposable: dropping the reference is the whole
    // cleanup — the ephemeral thread evaporates with the engine.
    panes.side.threadId = null;
    panes.side.turnId = null;
    return { ok: true };
  });

  ipcMain.handle("threads:delete", async (_e, id: string) => {
    await engine.request("thread/delete", { threadId: id });
    if (panes.main.threadId === id) {
      panes.main.threadId = null;
      panes.main.turnId = null;
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
