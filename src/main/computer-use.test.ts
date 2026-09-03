import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTER_CAPTURE_MAX_EDGE,
  COMPUTER_PERMISSION_SETTINGS,
  captureFrameFor,
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
  assert.throws(() => validatePoint({ x: 1440, y: 1 }, display), /outside the screenshot/);
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

// ── The capture frame ──────────────────────────────────────────────────────
// Measured 2026-09-03 on a 3840x2160 display: every computer_screenshot added
// 4.15MB of base64 PNG to the conversation, four of them took one rollout to
// 10.2MB, and the following turn came back "413 Payload Too Large". Vision
// models downsample past roughly 1568px on the long edge, so those megabytes
// bought nothing the model could see.
//
// Capping the capture introduces exactly one risk, and it is arithmetic: if
// the frame the model is TOLD about and the display a click lands on ever
// disagree, clicks go somewhere else on a real desktop. Hence the round-trip
// assertions below.

const display4k = {
  id: 2,
  bounds: { x: 0, y: 0, width: 3840, height: 2160 },
  size: { width: 3840, height: 2160 },
  scaleFactor: 1,
};

test("a display within the cap is delivered whole, and mapping stays identity", () => {
  // 1440x900 is under the cap, so nothing about the existing behaviour moves.
  assert.deepEqual(captureFrameFor(display), { width: 1440, height: 900 });
  assert.deepEqual(desktopPoint({ x: 400, y: 200 }, display), { x: -1040, y: 224 });
});

test("a 4K display is capped on its long edge with the aspect ratio intact", () => {
  const frame = captureFrameFor(display4k);
  assert.equal(Math.max(frame.width, frame.height), COMPUTER_CAPTURE_MAX_EDGE);
  assert.equal(frame.width, 1568);
  assert.equal(frame.height, 882); // 2160 * 1568/3840, exactly
  // The payload scales with area, which is the whole point of doing this.
  const shrink = (frame.width * frame.height) / (3840 * 2160);
  assert.ok(shrink < 0.2, `expected a >5x area cut, got ${(1 / shrink).toFixed(1)}x`);
});

test("every corner of the frame maps inside the display, never past its edge", () => {
  const frame = captureFrameFor(display4k);
  for (const [x, y] of [
    [0, 0],
    [frame.width - 1, 0],
    [0, frame.height - 1],
    [frame.width - 1, frame.height - 1],
  ] as const) {
    const p = desktopPoint({ x, y }, display4k);
    assert.ok(p.x >= 0 && p.x < 3840, `x ${p.x} out of the display for frame x ${x}`);
    assert.ok(p.y >= 0 && p.y < 2160, `y ${p.y} out of the display for frame y ${y}`);
  }
});

test("the middle of the frame lands in the middle of the display", () => {
  const frame = captureFrameFor(display4k);
  const p = desktopPoint({ x: Math.floor(frame.width / 2), y: Math.floor(frame.height / 2) }, display4k);
  assert.ok(Math.abs(p.x - 1920) <= 4, `x ${p.x} not near 1920`);
  assert.ok(Math.abs(p.y - 1080) <= 4, `y ${p.y} not near 1080`);
});

test("coordinates are validated against the FRAME, not the display", () => {
  // The model only ever sees the frame, so a coordinate the display could
  // hold but the frame cannot is a model mistake and has to be refused --
  // silently scaling it would click a place the model never looked at.
  const frame = captureFrameFor(display4k);
  assert.deepEqual(validatePoint({ x: frame.width - 1, y: frame.height - 1 }, display4k), {
    x: frame.width - 1,
    y: frame.height - 1,
  });
  assert.throws(() => validatePoint({ x: 2344, y: 2089 }, display4k), /outside/);
  assert.throws(() => validatePoint({ x: frame.width, y: 0 }, display4k), /outside/);
});

test("mapping is monotonic across the frame", () => {
  const frame = captureFrameFor(display4k);
  let previous = -1;
  for (let x = 0; x < frame.width; x += 37) {
    const { x: mapped } = desktopPoint({ x, y: 0 }, display4k);
    assert.ok(mapped > previous, `frame x ${x} mapped to ${mapped}, not past ${previous}`);
    previous = mapped;
  }
});

// ── Permission messages name the app the user has to find ─────────────────
// The dev build registers with macOS as "Unbiased Dev". Measured on a real
// tool result: the first sentence said "allow Unbiased" and the recovery
// sentence appended after it said "enable Unbiased Dev" -- one message, two
// different rows to look for, and only one of them exists in the pane.

test("permission failures name the app that is actually in the macOS list", async () => {
  const service = createComputerUseService({
    platform: "darwin",
    appName: () => "Unbiased Dev",
    getPrimaryDisplay: () => display,
    capturePrimaryDisplay: async () => {
      throw new Error("Failed to get sources.");
    },
    accessibilityTrusted: () => false,
    loadNut: async () => {
      throw new Error("not needed");
    },
  });
  const shot = await service.run({ type: "screenshot" });
  assert.equal(shot.ok, false);
  assert.match(shot.message, /allow Unbiased Dev,/);
  assert.doesNotMatch(shot.message, /allow Unbiased,/);
  const click = await service.run({ type: "click", point: { x: 1, y: 1 }, button: "left" });
  assert.equal(click.ok, false);
  assert.match(click.message, /Accessibility access to Unbiased Dev\b/);
});

test("with no name configured the messages fall back to the shipped app's", async () => {
  const service = createComputerUseService({
    platform: "darwin",
    getPrimaryDisplay: () => display,
    capturePrimaryDisplay: async () => {
      throw new Error("x");
    },
    accessibilityTrusted: () => true,
    loadNut: async () => {
      throw new Error("not needed");
    },
  });
  const shot = await service.run({ type: "screenshot" });
  assert.match(shot.message, /allow Unbiased,/);
});
