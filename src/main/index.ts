import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { EngineClient, engineVersionFromUserAgent, type EngineStatus } from "./engine";

const engine = new EngineClient();
let win: BrowserWindow | null = null;
let lastStatus: EngineStatus = { state: "starting" };

// The active conversation. Threads persist in the engine home; null means
// a fresh chat whose thread is created lazily on first send, so switching
// around the sidebar never litters the history with empty threads.
let threadId: string | null = null;
let activeTurnId: string | null = null;

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
  turns?: { items?: WireItem[] }[];
};

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
    width: 900,
    height: 640,
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
    switch (msg.method) {
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        if (turn?.id) activeTurnId = turn.id;
        send("chat:turn-started", { turnId: activeTurnId });
        break;
      }
      case "item/agentMessage/delta": {
        send("chat:delta", { delta: (params.delta as string) ?? "" });
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item as { type?: string } | undefined;
        if (item?.type === "commandExecution") {
          send("chat:command", { phase: msg.method === "item/started" ? "started" : "completed", item });
        }
        break;
      }
      case "turn/completed": {
        const turn = params.turn as { status?: string; usage?: unknown } | undefined;
        activeTurnId = null;
        send("chat:turn-completed", { status: turn?.status ?? "completed", usage: turn?.usage ?? null });
        break;
      }
    }
  });

  engine.on(
    "server-request",
    (msg: { id: number | string; method: string; params?: Record<string, unknown> }) => {
      const params = msg.params ?? {};
      if (msg.method === "item/commandExecution/requestApproval") {
        const requestId = `apr_${msg.id}`;
        pendingApprovals.set(requestId, msg.id);
        send("chat:approval-request", {
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

  ipcMain.handle("chat:send", async (_e, text: string) => {
    let created = false;
    if (!threadId) {
      const started = (await engine.request("thread/start", { ...THREAD_POLICY })) as {
        thread: { id: string };
      };
      threadId = started.thread.id;
      created = true;
    }
    const result = (await engine.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    })) as { turn?: { id?: string } };
    if (result.turn?.id) activeTurnId = result.turn.id;
    return { turnId: activeTurnId, threadId, created };
  });

  ipcMain.handle("threads:list", async () => {
    const result = (await engine.request("thread/list", { limit: 50 })) as { data?: WireThread[] };
    const threads: ThreadSummary[] = (result.data ?? []).map((t) => ({
      id: t.id,
      title: threadTitle(t),
      createdAt: t.createdAt,
    }));
    return { threads };
  });

  ipcMain.handle("threads:open", async (_e, id: string) => {
    const result = (await engine.request("thread/resume", { threadId: id, ...THREAD_POLICY })) as {
      thread: WireThread;
    };
    threadId = id;
    activeTurnId = null;
    return { id, entries: threadToEntries(result.thread) };
  });

  ipcMain.handle("threads:detach", () => {
    // Fresh-chat view: the next send creates a new thread.
    threadId = null;
    activeTurnId = null;
    return { ok: true };
  });

  ipcMain.handle("chat:interrupt", async () => {
    if (!threadId || !activeTurnId) return { interrupted: false };
    await engine.request("turn/interrupt", { threadId, turnId: activeTurnId });
    return { interrupted: true };
  });

  ipcMain.handle("chat:approve", (_e, payload: { requestId: string; decision: "accept" | "decline" }) => {
    const engineRequestId = pendingApprovals.get(payload.requestId);
    if (engineRequestId === undefined) return { ok: false };
    pendingApprovals.delete(payload.requestId);
    engine.respond(engineRequestId, { decision: payload.decision });
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
