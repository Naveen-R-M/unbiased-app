const { execFileSync, spawn } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const { get } = require("node:http");
const { get: getHttps } = require("node:https");

const config = JSON.parse(process.argv[2] ?? "{}");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + 15_000;
  while (processExists(pid) && Date.now() < deadline) await delay(100);
  if (processExists(pid)) throw new Error(`Unbiased Dev did not exit (pid ${pid}).`);
}

function rendererAvailable(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    const request = (url.startsWith("https:") ? getHttps : get)(url, { timeout: 1_500 }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 500) < 500);
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function launchExistingRenderer() {
  const child = spawn(
    "/usr/bin/open",
    [
      "-n",
      config.bundlePath,
      "--env",
      `ELECTRON_RENDERER_URL=${config.rendererUrl}`,
      "--env",
      "NODE_ENV_ELECTRON_VITE=development",
      "--env",
      "UNBIASED_DEV_APP_NAME=Unbiased Dev",
      "--args",
      config.appPath,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

function launchDevServer() {
  const child = spawn(process.execPath, [config.launcherPath], {
    cwd: config.appPath,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, UNBIASED_DEV_PORT: String(config.port) },
  });
  child.unref();
}

async function main() {
  await waitForExit(config.pid);
  await delay(750);
  execFileSync("/usr/bin/tccutil", ["reset", "Accessibility", config.bundleIdentifier]);
  mkdirSync(dirname(config.markerPath), { recursive: true });
  writeFileSync(config.markerPath, JSON.stringify({ createdAt: new Date().toISOString() }) + "\n");
  await delay(350);
  if (await rendererAvailable(config.rendererUrl)) launchExistingRenderer();
  else launchDevServer();
}

main().catch((error) => {
  try {
    mkdirSync(dirname(config.markerPath), { recursive: true });
    writeFileSync(
      config.markerPath,
      JSON.stringify({ createdAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }) + "\n",
    );
  } catch {
    // The parent app has already exited; there is nowhere else to report this.
  }
  process.exitCode = 1;
});
