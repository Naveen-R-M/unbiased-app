import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { EngineClient, engineVersionFromUserAgent, type EngineStatus } from "./engine";

const engine = new EngineClient();
let win: BrowserWindow | null = null;
let lastStatus: EngineStatus = { state: "starting" };

// One conversation per app run for now (ephemeral: nothing persisted).
// The threads-sidebar milestone replaces this with thread/list + resume.
let threadId: string | null = null;
let activeTurnId: string | null = null;

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
      case "turn/completed": {
        const turn = params.turn as { status?: string; usage?: unknown } | undefined;
        activeTurnId = null;
        send("chat:turn-completed", { status: turn?.status ?? "completed", usage: turn?.usage ?? null });
        break;
      }
    }
  });

  // Chat milestone runs approvalPolicy "never" + read-only sandbox, so the
  // engine should not ask us anything. If it does, declining beats hanging
  // the turn forever on a request nobody can see. The approvals milestone
  // replaces this with a real dialog.
  engine.on("server-request", (msg: { id: number | string; method: string }) => {
    console.warn("[app] declining unexpected server request:", msg.method);
    engine.respond(msg.id, { decision: "decline" });
  });
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
  const thread = (await engine.request("thread/start", {
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  })) as { thread: { id: string } };
  threadId = thread.thread.id;

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
    if (!threadId) throw new Error("no thread — engine not connected");
    const result = (await engine.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    })) as { turn?: { id?: string } };
    if (result.turn?.id) activeTurnId = result.turn.id;
    return { turnId: activeTurnId };
  });

  ipcMain.handle("chat:interrupt", async () => {
    if (!threadId || !activeTurnId) return { interrupted: false };
    await engine.request("turn/interrupt", { threadId, turnId: activeTurnId });
    return { interrupted: true };
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
