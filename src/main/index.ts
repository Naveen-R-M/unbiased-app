import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { EngineClient, engineVersionFromUserAgent, type EngineStatus } from "./engine";

// Walking skeleton: open a window, spawn the engine, run the initialize
// handshake, surface the result in a status bar. Turns come next.

const engine = new EngineClient();
let win: BrowserWindow | null = null;
let lastStatus: EngineStatus = { state: "starting" };

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

app.whenReady().then(async () => {
  ipcMain.handle("engine:status", () => lastStatus);
  createWindow();

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
  engine.start(bin);
  try {
    const result = await engine.handshake(app.getVersion());
    pushStatus({
      state: "connected",
      userAgent: result.userAgent,
      engineVersion: engineVersionFromUserAgent(result.userAgent),
      codexHome: result.codexHome,
    });
  } catch (err) {
    pushStatus({ state: "exited", code: null, detail: String(err) });
  }
});

app.on("window-all-closed", () => {
  engine.stop();
  app.quit();
});
