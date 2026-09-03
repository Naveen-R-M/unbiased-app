import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTER_PERMISSION_SETTINGS,
  ComputerPermissionError,
  SerialExecutor,
  createComputerUseService,
  desktopPoint,
  parseComputerAction,
  openComputerPermissionSettings,
  requestComputerPermission,
  validateKey,
  validateModifiers,
  validatePoint,
} from "./computer-use";

const display = {
  id: 1,
  bounds: { x: -1440, y: 24, width: 1440, height: 900 },
  size: { width: 1440, height: 900 },
  scaleFactor: 2,
};

test("primary-display coordinates are validated in the screenshot frame", () => {
  assert.deepEqual(validatePoint({ x: 0, y: 899 }, display), { x: 0, y: 899 });
  assert.throws(() => validatePoint({ x: 1440, y: 1 }, display), /outside the primary display/);
  assert.throws(() => validatePoint({ x: 2.5, y: 1 }, display), /x must be an integer/);
});

test("local screenshot coordinates translate into the virtual desktop", () => {
  assert.deepEqual(desktopPoint({ x: 400, y: 200 }, display), { x: -1040, y: 224 });
});

test("computer_click requires explicit coordinates", () => {
  assert.throws(() => parseComputerAction("computer_click", {}, display), /x must be an integer/);
  assert.deepEqual(parseComputerAction("computer_click", { x: 5, y: 6 }, display), {
    type: "click",
    point: { x: 5, y: 6 },
    button: "left",
  });
});

test("keys and modifiers use a restricted whitelist", () => {
  assert.equal(validateKey("ArrowDown"), "Down");
  assert.equal(validateKey("k"), "K");
  assert.deepEqual(validateModifiers(["command", "shift", "command"]), ["command", "shift"]);
  assert.throws(() => validateKey("LaunchMail"), /Unsupported key/);
  assert.throws(() => validateModifiers(["fn"]), /modifiers may contain/);
});

test("scroll requires a bounded non-zero delta", () => {
  assert.throws(
    () => parseComputerAction("computer_scroll", { x: 1, y: 1, deltaX: 0, deltaY: 0 }, display),
    /must be non-zero/,
  );
  assert.throws(
    () => parseComputerAction("computer_scroll", { x: 1, y: 1, deltaY: 101 }, display),
    /between -100 and 100/,
  );
});

test("the executor serializes work globally and continues after failure", async () => {
  const executor = new SerialExecutor();
  const events: string[] = [];
  const first = executor.run(async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 15));
    events.push("first:end");
    throw new Error("expected");
  });
  const second = executor.run(async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await assert.rejects(first, /expected/);
  await second;
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("the service checks Accessibility before loading native input", async () => {
  let loaded = false;
  const service = createComputerUseService({
    platform: "darwin",
    getPrimaryDisplay: () => display,
    capturePrimaryDisplay: async () => ({ dataUrl: "data:image/png;base64,AA==", width: 1440, height: 900 }),
    accessibilityTrusted: () => false,
    loadNut: async () => {
      loaded = true;
      throw new Error("should not load");
    },
  });
  const result = await service.run({ type: "move", point: { x: 1, y: 1 } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.permission, "accessibility");
  assert.equal(loaded, false);
});

test("screen-capture denial is reported as a recoverable permission failure", async () => {
  const service = createComputerUseService({
    platform: "darwin",
    getPrimaryDisplay: () => display,
    capturePrimaryDisplay: async () => {
      throw new ComputerPermissionError("screen-capture", "denied");
    },
    accessibilityTrusted: () => true,
    loadNut: async () => {
      throw new Error("not needed");
    },
  });
  const result = await service.run({ type: "screenshot" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.permission, "screen-capture");
});

test("any desktop capture failure offers screen-capture recovery", async () => {
  const service = createComputerUseService({
    platform: "darwin",
    getPrimaryDisplay: () => display,
    capturePrimaryDisplay: async () => {
      throw new Error("Electron returned an empty desktop image.");
    },
    accessibilityTrusted: () => true,
    loadNut: async () => {
      throw new Error("not needed");
    },
  });
  const result = await service.run({ type: "screenshot" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.permission, "screen-capture");
});

test("permission recovery targets the exact macOS privacy panes", () => {
  assert.match(COMPUTER_PERMISSION_SETTINGS.accessibility.uri, /Privacy_Accessibility$/);
  assert.match(COMPUTER_PERMISSION_SETTINGS["screen-capture"].uri, /Privacy_ScreenCapture$/);
});

test("approved permission recovery invokes the system opener", async () => {
  const opened: string[] = [];
  await openComputerPermissionSettings("screen-capture", async (uri) => {
    opened.push(uri);
  });
  assert.deepEqual(opened, [COMPUTER_PERMISSION_SETTINGS["screen-capture"].uri]);
});

test("screen-capture recovery invokes the native permission request", async () => {
  let requested = false;
  const status = await requestComputerPermission("screen-capture", async () => ({
    askForAccessibilityAccess: () => undefined,
    askForScreenCaptureAccess: () => { requested = true; },
    getAuthStatus: (permission) => permission === "screen" ? "authorized" : "denied",
  }));
  assert.equal(requested, true);
  assert.equal(status, "authorized");
});

test("screenshot responses state the exact coordinate frame", async () => {
  const service = createComputerUseService({
    platform: "darwin",
    getPrimaryDisplay: () => display,
    capturePrimaryDisplay: async () => ({ dataUrl: "data:image/png;base64,AA==", width: 1440, height: 900 }),
    accessibilityTrusted: () => true,
    loadNut: async () => {
      throw new Error("not needed");
    },
  });
  const result = await service.run({ type: "screenshot" });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.message, /x=0\.\.1439, y=0\.\.899/);
});
