const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const root = join(__dirname, "..");
const electronRoot = join(root, "node_modules", "electron", "dist");
const sourceApp = join(electronRoot, "Electron.app");
const launcherRoot = join(root, "node_modules", ".unbiased-dev");
const launcherApp = join(homedir(), "Applications", "Unbiased Dev.app");
const launcherExecutable = join(launcherApp, "Contents", "MacOS", "Unbiased Dev");
const launcherScript = join(launcherRoot, "launch-electron");
const defaultAppRoot = join(launcherRoot, "default-app");
const defaultAppAsar = join(launcherApp, "Contents", "Resources", "default_app.asar");
const version = require(join(root, "node_modules", "electron", "package.json")).version;
const markerPath = join(launcherRoot, "version");
const launcherRevision = "8";

function run(command, args) {
  const result = require("node:child_process").spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function prepareMacLauncher() {
  const currentVersion = existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim() : "";
  if (currentVersion === `${version}:${launcherRevision}` && existsSync(launcherExecutable) && existsSync(launcherScript)) return;

  rmSync(launcherRoot, { recursive: true, force: true });
  mkdirSync(launcherRoot, { recursive: true });
  mkdirSync(join(homedir(), "Applications"), { recursive: true });
  rmSync(launcherApp, { recursive: true, force: true });
  run("ditto", [sourceApp, launcherApp]);

  const plistPath = join(launcherApp, "Contents", "Info.plist");
  const asarCli = join(root, "node_modules", "@electron", "asar", "bin", "asar.js");
  run(process.execPath, [asarCli, "extract", defaultAppAsar, defaultAppRoot]);
  const defaultAppMain = join(defaultAppRoot, "main.js");
  const defaultAppSource = readFileSync(defaultAppMain, "utf8");
  const welcomeFallback = "    await loadApplicationByFile('index.html');";
  const rendererUrl = `http://localhost:${process.env.UNBIASED_DEV_PORT ?? "5173"}`;
  if (!defaultAppSource.includes(welcomeFallback)) {
    throw new Error("Electron's default app bootstrap changed; update build/dev-launcher.cjs");
  }
  writeFileSync(
    defaultAppMain,
    defaultAppSource.replace(
      welcomeFallback,
      [
        "    await new Promise((resolve) => setTimeout(resolve, 1000));",
        "    let rendererAvailable = false;",
        "    try {",
        `        const response = await fetch(${JSON.stringify(rendererUrl)}, { signal: AbortSignal.timeout(1500) });`,
        "        rendererAvailable = response.ok;",
        "    } catch {}",
        "    if (rendererAvailable) {",
        `        process.env.ELECTRON_RENDERER_URL = ${JSON.stringify(rendererUrl)};`,
        "        process.env.NODE_ENV_ELECTRON_VITE = 'development';",
        "        process.env.UNBIASED_DEV_APP_NAME = 'Unbiased Dev';",
        `        await loadApplicationPackage(${JSON.stringify(root)});`,
        "    } else {",
        "        const { spawn } = await import('node:child_process');",
        `        const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(__filename)}], {`,
        `            cwd: ${JSON.stringify(root)},`,
        "            detached: true,",
        "            stdio: 'ignore',",
        `            env: { ...process.env, UNBIASED_DEV_PORT: ${JSON.stringify(process.env.UNBIASED_DEV_PORT ?? "5173")} },`,
        "        });",
        "        child.unref();",
        "        app.quit();",
        "    }",
      ].join("\n"),
    ),
  );
  run(process.execPath, [asarCli, "pack", defaultAppRoot, defaultAppAsar]);
  renameSync(join(launcherApp, "Contents", "MacOS", "Electron"), launcherExecutable);
  run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIdentifier ai.unbiased.desktop.dev", plistPath]);
  run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleName Unbiased Dev", plistPath]);
  run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleDisplayName Unbiased Dev", plistPath]);
  run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleExecutable Unbiased Dev", plistPath]);
  run("/usr/libexec/PlistBuddy", ["-c", "Delete :ElectronAsarIntegrity", plistPath]);
  run("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--identifier",
    "ai.unbiased.desktop.dev",
    "--requirements",
    '=designated => identifier "ai.unbiased.desktop.dev"',
    "--timestamp=none",
    launcherApp,
  ]);
  run("codesign", ["--verify", "--deep", "--strict", launcherApp]);
  writeFileSync(
    launcherScript,
    [
      "#!/bin/sh",
      'entry="$1"',
      "shift",
      `if [ "$entry" = "." ]; then entry=${JSON.stringify(root)}; fi`,
      `exec /usr/bin/open -W -n ${JSON.stringify(launcherApp)} --env ELECTRON_RENDERER_URL --env NODE_ENV_ELECTRON_VITE --env UNBIASED_DEV_APP_NAME --args "$entry" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(markerPath, `${version}:${launcherRevision}\n`);
}

const env = { ...process.env };
delete env.ELECTRON_EXEC_PATH;
delete env.ELECTRON_RENDERER_URL;
delete env.ELECTRON_MAJOR_VER;
delete env.ELECTRON_CLI_ARGS;

if (process.platform === "darwin") {
  prepareMacLauncher();
  env.ELECTRON_EXEC_PATH = launcherScript;
  env.UNBIASED_DEV_APP_NAME = "Unbiased Dev";
}

const electronVite = join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-vite.cmd" : "electron-vite");
const child = spawn(electronVite, ["dev", ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
