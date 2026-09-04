import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { AX_TOOL_NAMES, SCREENSHOT_TOOL_NAMES, routesToAx, AxClient, AxError, appOfStep, axConsent, axNeedsFocus, offerScreenshotTools, shouldRecoverRaise, describeAxAction, indexElementLines, readAxManifest, resolveAxDir, shouldOpenAccessibilitySettings, axNotTrustedText } from "./ax-bridge";

const scratch = () => mkdtempSync(join(tmpdir(), "ax-"));

// ── The manifest ───────────────────────────────────────────────────────────

function writeBundle(dir: string, manifest: unknown): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "unbiased-ax"), "#!/bin/sh\n");
  chmodSync(join(dir, "unbiased-ax"), 0o755);
  return dir;
}
const good = { name: "unbiased-ax", version: "0.1.0", protocolVersion: 1, runtime: "native", entry: "unbiased-ax", args: [] };

test("a valid native manifest resolves to its executable", () => {
  const dir = writeBundle(join(scratch(), "dist"), good);
  const m = readAxManifest(dir);
  assert.ok(m && !("error" in m), JSON.stringify(m));
  assert.equal(m.entryPath, join(dir, "unbiased-ax"));
  assert.equal(m.version, "0.1.0");
});

test("no manifest means not installed, which is not an error", () => {
  assert.equal(readAxManifest(join(scratch(), "nope")), null);
});

for (const [label, manifest] of [
  ["the node runtime (that is the learning sidecar, not this)", { ...good, runtime: "node" }],
  ["a protocol we do not speak", { ...good, protocolVersion: 2 }],
  ["an entry escaping the bundle", { ...good, entry: "../../bin/sh" }],
  ["an entry that does not exist", { ...good, entry: "missing" }],
] as const) {
  test(`${label} is refused with a reason`, () => {
    const m = readAxManifest(writeBundle(join(scratch(), "dist"), manifest));
    assert.ok(m && "error" in m, `expected refusal for ${label}`);
  });
}

test("the dev fallback finds a sibling checkout from a worktree, not just a plain clone", () => {
  const root = scratch();
  const dist = join(root, "unbiased-ax", "dist");
  mkdirSync(dist, { recursive: true });
  const deep = join(root, "unbiased-app", ".claude", "worktrees", "wt-1");
  mkdirSync(deep, { recursive: true });
  assert.equal(resolveAxDir({ isPackaged: false, resourcesPath: "/unused", appPath: deep }), dist);
});

// ── The client, against a fake bridge ──────────────────────────────────────
// A shell script exec'ing node on a small script: hello answers, "echo" echoes,
// "boom" errors, "slow" never answers, "die" exits.

function fakeBridge(): ReturnType<typeof readAxManifest> {
  const dir = join(scratch(), "dist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fake.js"),
    `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "hello") return console.log(JSON.stringify({ id, result: { name: "unbiased-ax", protocolVersion: 1, trusted: true } }));
  if (method === "boom") return console.log(JSON.stringify({ id, error: { code: "no_such_app", message: "No running app matches" } }));
  if (method === "slow") return;
  if (method === "die") process.exit(3);
  console.log(JSON.stringify({ id, result: { ok: true, method, params } }));
});
`,
  );
  writeFileSync(join(dir, "unbiased-ax"), `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "fake.js")}"\n`);
  chmodSync(join(dir, "unbiased-ax"), 0o755);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(good));
  return readAxManifest(dir);
}

test("start performs the handshake and reports trust", async () => {
  const m = fakeBridge();
  assert.ok(m && !("error" in m));
  const c = new AxClient(m);
  const hello = await c.start();
  assert.equal(hello.trusted, true);
  assert.equal(c.alive, true);
  c.stop();
});

test("a request gets its own answer back, matched by id, and an error becomes an AxError with its code", async () => {
  const m = fakeBridge();
  assert.ok(m && !("error" in m));
  const c = new AxClient(m);
  await c.start();
  const [a, b] = await Promise.all([c.request("echo", { n: 1 }), c.request("echo", { n: 2 })]);
  assert.deepEqual((a.params as { n: number }).n, 1);
  assert.deepEqual((b.params as { n: number }).n, 2);
  await assert.rejects(c.request("boom", {}), (e: unknown) => e instanceof AxError && e.code === "no_such_app");
  c.stop();
});

test("a method that never answers times out instead of hanging the turn", async () => {
  const m = fakeBridge();
  assert.ok(m && !("error" in m));
  const c = new AxClient(m);
  await c.start();
  // Per-call: the handshake needs node's startup time, the probe does not.
  await assert.rejects(c.request("slow", {}, 150), (e: unknown) => e instanceof AxError && e.code === "timeout");
  c.stop();
});

test("an exit rejects what was in flight and marks the client dead", async () => {
  const m = fakeBridge();
  assert.ok(m && !("error" in m));
  const c = new AxClient(m);
  await c.start();
  await assert.rejects(c.request("die", {}), (e: unknown) => e instanceof AxError && e.code === "bridge_exited");
  assert.equal(c.alive, false);
  await assert.rejects(c.request("echo", {}), (e: unknown) => e instanceof AxError && e.code === "bridge_exited");
});

// ── Approval text ──────────────────────────────────────────────────────────

const TREE = [
  '1 standard window "YouTube - Brave" {raise}',
  "2   toolbar",
  '643       link "Tame Impala - Loser (Official Video) 4 minutes, 28 seconds" {press,show menu}',
  '~13     text field "Address and search bar" = youtube.com {press}',
].join("\n");

test("an approval for act names the element the model is about to press", () => {
  const lines = indexElementLines(TREE);
  const text = describeAxAction("computer_act", { app: "Brave", id: 643, action: "press" }, lines);
  assert.ok(text.startsWith('press #643 in Brave — link "Tame Impala - Loser (Official Video)'), text);
  assert.ok(text.endsWith("…") && text.length < 100, `clipped for a one-line card: ${text}`);
  assert.equal(lines.get(13), 'text field "Address and search bar" = youtube.com {press}', "a ~ diff line is still a line");
  assert.equal(lines.get(999), undefined);
});

test("the index accumulates: a diff updates one line and keeps the rest", () => {
  // The model read the full tree once, then a diff. An approval for an id the
  // diff did not mention must still name it.
  const lines = indexElementLines(TREE);
  indexElementLines('~13     text field "Address and search bar" = youtube.com/results?q=x {press}', lines);
  assert.ok(lines.get(13)!.includes("results?q=x"), "updated");
  assert.ok(lines.get(643)!.startsWith("link"), "kept");
});

test("set and key read as what they are", () => {
  assert.equal(describeAxAction("computer_set_value", { app: "Brave", id: 13, text: "https://youtube.com" }, indexElementLines(TREE)),
    'Set #13 in Brave — text field "Address and search bar" = youtube.com {press} to "https://youtube.com"');
  assert.equal(describeAxAction("computer_press_key", { app: "Brave", key: "return" }), "Press return in Brave");
  assert.equal(describeAxAction("computer_app_state", { app: "Brave" }), "Read the UI of Brave");
});

test("the old computer_act shape still means what it said, rather than a silent press", () => {
  // value and key used to ride on computer_act. Splitting the verbs must not
  // turn a model's stale habit into the wrong action performed quietly.
  assert.equal(describeAxAction("computer_act", { app: "Brave", id: 13, value: "https://youtube.com" }, indexElementLines(TREE)),
    'Set #13 in Brave — text field "Address and search bar" = youtube.com {press} to "https://youtube.com"');
  assert.equal(describeAxAction("computer_act", { app: "Brave", key: "return" }), "Press return in Brave");
});

// ── Consent policy ─────────────────────────────────────────────────────────
// Measured on the first live run: eight AX calls, eight approval cards, in a
// conversation whose mode was set to full — where MODE_THREAD_POLICY says
// approvalPolicy "never". The card was hard-coded to ask every time, and
// nothing consulted the mode. The browser gate at index.ts:1583 had the right
// shape all along; this is that shape, made testable.

test("full access means what it says: no card", () => {
  for (const tool of ["computer_app_state", "computer_act"]) {
    assert.equal(axConsent({ tool, mode: "full", granted: false }), "allow", tool);
  }
});

test("ask and auto still ask, because the action reaches outside the sandbox", () => {
  assert.equal(axConsent({ tool: "computer_act", mode: "ask", granted: false }), "ask");
  assert.equal(axConsent({ tool: "computer_act", mode: "auto", granted: false }), "ask");
});

test("a session grant for this app skips later cards, in ask and auto alike", () => {
  assert.equal(axConsent({ tool: "computer_act", mode: "ask", granted: true }), "allow");
  assert.equal(axConsent({ tool: "computer_app_state", mode: "auto", granted: true }), "allow");
});

test("listing apps is never gated: it names apps and touches nothing", () => {
  assert.equal(axConsent({ tool: "computer_apps", mode: "ask", granted: false }), "allow");
});

// ── Reading must not steal the screen ──────────────────────────────────────
// The model raised Brave three times in one task, taking the user's screen
// each time, because it assumed a read needed focus. It does not: the
// Accessibility API reads background apps across Spaces, which is the whole
// advantage over screenshots.



// ── Raise is gone ──────────────────────────────────────────────────────────
// Measured across three live runs: the model raised Brave on its own every
// time — four times in one task — taking the user off whatever they were
// doing. Codex's trace over the same task never raises: set_value, press_key
// and click all work on a background app, and ours do too (a bare key posted
// to a backgrounded Brave was verified not to change the frontmost app).
// A capability the model cannot be talked out of using is one to remove.

test("reading and acting never need the app in front", () => {
  for (const args of [{ app: "Brave", key: "space" }, { app: "Brave", key: "space", id: 774 }, { app: "Brave", id: 1, action: "press" }]) {
    assert.equal(axNeedsFocus("computer_act", args), false, JSON.stringify(args));
  }
  assert.equal(axNeedsFocus("computer_app_state", { app: "Brave" }), false);
});

test("raise is the one thing that takes the screen, and it exists again", () => {
  // Removing it was an over-correction. With every window of an app on another
  // Space, the tree is the menu bar and nothing else — raising is the only way
  // in, and without it the model spent six minutes failing to find one.
  assert.equal(axNeedsFocus("computer_raise", { app: "Brave" }), true);
  assert.equal(describeAxAction("computer_raise", { app: "Brave" }), "Bring Brave to the front");
  assert.equal(appOfStep("computer_raise", { app: "Brave" }), "Brave", "a raise step wears the app's icon too");
});

// ── The app a step touched ─────────────────────────────────────────────────

test("appOfStep names the app a computer step acted on, for its icon", () => {
  assert.equal(appOfStep("computer_act", { app: "Brave Browser", id: 1 }), "Brave Browser");
  assert.equal(appOfStep("computer_app_state", { app: "Finder" }), "Finder");
  assert.equal(appOfStep("computer_apps", {}), null, "listing apps touches no one app");
  assert.equal(appOfStep("memory_save", { app: "Brave" }), null, "not a computer tool");
});

// ── One consent gate for every desktop tool ────────────────────────────────
// Measured, 58 calls over 5 minutes: the model reached for the older
// screenshot tools (computer_key, computer_screenshot, computer_type) and each
// one raised a card, in a conversation set to Full access, because only the AX
// tools consulted the mode. Worse, the cards CAUSED the loop: each card lives
// in the Unbiased window on the user's Space, so approving it switched the
// Space back and undid the raise that preceded it — 16 raises in one task.

test("the screenshot tools obey the access mode exactly like the AX ones", () => {
  for (const tool of ["computer_screenshot", "computer_key", "computer_type", "computer_click", "computer_move", "computer_scroll"]) {
    assert.equal(axConsent({ tool, mode: "full", granted: false }), "allow", `${tool} in full`);
    assert.equal(axConsent({ tool, mode: "ask", granted: false }), "ask", `${tool} in ask`);
    assert.equal(axConsent({ tool, mode: "ask", granted: true }), "allow", `${tool} with a session grant`);
  }
});

// ── The screenshot tools step aside when the bridge can do better ──────────

test("with the bridge alive, the screenshot tools are not offered", () => {
  // The model tried Spotlight and command+k only because they were on the
  // menu; the tree had Slack's DM list the whole time.
  assert.equal(offerScreenshotTools({ axAlive: true }), false);
  assert.equal(offerScreenshotTools({ axAlive: false }), true, "without a bridge they are the only way");
});

// ── Recovering a Space we already asked for ────────────────────────────────
// Measured on a working run: 10 calls, 3 of them raises. The second raise was
// pure waste — Chrome had drifted back off-Space between one action and the
// next read, so the read returned nothing and the model had to ask for the
// raise again. If this conversation already raised that app, the read should
// recover by itself.

test("a read that comes back empty retries once, but only for an app we raised before", () => {
  assert.equal(shouldRecoverRaise({ windowsHere: 0, offscreen: 12, raisedBefore: true }), true);
  assert.equal(shouldRecoverRaise({ windowsHere: 0, offscreen: 12, raisedBefore: false }), false,
    "never raise an app the model has not already chosen to bring forward");
  assert.equal(shouldRecoverRaise({ windowsHere: 2, offscreen: 12, raisedBefore: true }), false,
    "windows are here; nothing to recover");
  assert.equal(shouldRecoverRaise({ windowsHere: 0, offscreen: 0, raisedBefore: true }), false,
    "the app has no windows at all — raising will not conjure one");
});

// ── The missing Accessibility grant ────────────────────────────────────────
// The one failure the user cannot fix from the transcript. Nothing the app
// does can grant it, so the app opens the pane and gets out of the way.

test("the Accessibility pane opens for a missing grant, and only once", () => {
  assert.equal(shouldOpenAccessibilitySettings({ code: "not_trusted", openedBefore: false }), true);
  assert.equal(shouldOpenAccessibilitySettings({ code: "not_trusted", openedBefore: true }), false,
    "the pane is already open; opening it again steals focus from the switch they are reaching for");
  assert.equal(shouldOpenAccessibilitySettings({ code: "no_such_app", openedBefore: false }), false,
    "a mistyped app name is not a permission problem");
  assert.equal(shouldOpenAccessibilitySettings({ code: null, openedBefore: false }), false,
    "a crash or a timeout is not a permission problem either");
});

test("the not-trusted message names the row that is actually in the pane", () => {
  const shipped = axNotTrustedText("Unbiased", true);
  assert.match(shipped, /Unbiased/);
  assert.match(shipped, /now open/, "it should say the pane is already open, not give directions to it");
  assert.doesNotMatch(shipped, /computer_screenshot/,
    "the screenshot tools are not offered while the bridge is alive — do not send the model after a tool it does not have");

  // A dev build is "Electron" in System Settings, not "Unbiased". Naming the
  // wrong row sends the user hunting for an entry that is not there.
  assert.match(axNotTrustedText("Electron", true), /Electron/);

  const notOpened = axNotTrustedText("Unbiased", false);
  assert.match(notOpened, /System Settings > Privacy & Security > Accessibility/,
    "if the pane could not be opened, the message has to say where to go");
});

// ── Opening an app, and the split verbs ────────────────────────────────────
// A model with no way to open an app reaches for a shell, and once there it
// does not come back. These are the tools that close that door, plus the
// transcript details that make them legible.

test("every desktop tool that names an app is attributed to it, so its row shows that app's icon", () => {
  for (const tool of ["computer_launch", "computer_press", "computer_set_value", "computer_press_key", "computer_scroll_view", "computer_act", "computer_app_state", "computer_raise"]) {
    assert.equal(appOfStep(tool, { app: "Maps" }), "Maps", `${tool} should be attributed to Maps`);
  }
  assert.equal(appOfStep("computer_apps", { app: "Maps" }), null, "listing apps is not an action in one app");
  assert.equal(appOfStep("shell", { app: "Maps" }), null, "unknown tools are not desktop steps");
});

test("an approval card names the verb and the control, never the raw tool name", () => {
  const lines = new Map([[10, 'search field "Apple Maps"']]);
  assert.equal(describeAxAction("computer_launch", { app: "Maps" }), "Open Maps");
  assert.match(describeAxAction("computer_press", { app: "Maps", id: 10 }, lines), /^Press #10 in Maps — search field/);
  assert.match(describeAxAction("computer_set_value", { app: "Maps", id: 10, text: "Planet Fitness" }, lines), /Set #10 in Maps .* to "Planet Fitness"/);
  assert.equal(describeAxAction("computer_press_key", { app: "Maps", key: "return" }), "Press return in Maps");
  assert.equal(describeAxAction("computer_scroll_view", { app: "Maps", id: 10, direction: "down" }), "Scroll down in Maps");
  assert.equal(describeAxAction("computer_act", { app: "Maps", id: 10, action: "show menu" }, lines).startsWith("show menu #10"), true);
  for (const tool of ["computer_launch", "computer_press", "computer_set_value", "computer_press_key", "computer_scroll_view"]) {
    assert.notEqual(describeAxAction(tool, { app: "Maps", id: 10 }), tool, `${tool} fell through to its own name`);
  }
});

test("computer_type describes the field it is filling even with no remembered line", () => {
  // The card can be shown before any read of that app in this conversation,
  // so it has to be readable without one.
  assert.equal(describeAxAction("computer_set_value", { app: "Slack", id: 4, text: "Hi" }), 'Set #4 in Slack to "Hi"');
});

test("opening an app is gated like every other desktop tool", () => {
  for (const tool of ["computer_launch", "computer_scroll_view", "computer_press", "computer_set_value", "computer_press_key"]) {
    assert.equal(axConsent({ tool, mode: "ask", granted: false }), "ask", `${tool} must ask the first time`);
    assert.equal(axConsent({ tool, mode: "full", granted: false }), "allow", `${tool} must not ask in Full access`);
    assert.equal(axConsent({ tool, mode: "ask", granted: true }), "allow", `${tool} rides the session grant`);
  }
});

// ── Routing: the bug that cost twelve minutes ─────────────────────────────
// Two families of desktop tools, dispatched by NAME. A name in both goes to
// whichever the router checks first — and they take different arguments
// entirely, an element id versus screen coordinates. When five AX tools were
// declared without being added to the routing list, every one of them reached
// the coordinate handler and reported "click at undefined, undefined". The
// model could not open an app, and spent twelve minutes trying Finder menus.

test("no desktop tool name belongs to both families", () => {
  const shared = AX_TOOL_NAMES.filter((n) => (SCREENSHOT_TOOL_NAMES as readonly string[]).includes(n));
  assert.deepEqual(shared, [],
    `these names would dispatch to whichever handler is checked first: ${shared.join(", ")}`);
});

test("every tool the app declares to the model is routed", () => {
  // The real invariant, and the one that broke: AX_TOOLS in index.ts is the
  // list handed to the model, AX_TOOL_NAMES is the list the router consults,
  // and nothing tied them together. index.ts cannot be imported here (it pulls
  // in electron), so read the declarations out of the source and compare.
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const block = src.slice(src.indexOf("const AX_TOOLS = ["), src.indexOf("\n];", src.indexOf("const AX_TOOLS = [")));
  const declared = [...block.matchAll(/name:\s*"(computer_[a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length >= 9, `expected the AX tool declarations, found ${declared.length}`);
  const unrouted = declared.filter((n) => !routesToAx(n));
  assert.deepEqual(unrouted, [],
    `declared to the model but dispatched to the screenshot handler instead: ${unrouted.join(", ")}`);
});

test("the screenshot tools do not route to the accessibility handler", () => {
  for (const name of SCREENSHOT_TOOL_NAMES) {
    assert.equal(routesToAx(name), false, `${name} is coordinate-based and must not reach the AX handler`);
  }
  assert.equal(routesToAx("browser_navigate"), false, "unrelated tools are not desktop tools");
});

test("the tools a model needs to operate an app are all present", () => {
  // Losing any one of these is what sends a model to the shell, or to
  // improvising through Finder. Named individually so a deletion is loud.
  for (const needed of ["computer_launch", "computer_app_state", "computer_press", "computer_set_value", "computer_press_key", "computer_scroll_view"]) {
    assert.ok((AX_TOOL_NAMES as readonly string[]).includes(needed), `${needed} is missing`);
  }
});

test("the directive never names a tool that does not exist", () => {
  // Renaming the verbs left the directive telling the model to call
  // computer_click, which by then was the coordinate-based tool it is not
  // offered. Prose that names tools has to be checked like code.
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const start = src.indexOf("const COMPUTER_DIRECTIVE");
  const directive = src.slice(start, src.indexOf("approval.\";", start));
  const known = new Set<string>([...AX_TOOL_NAMES, ...SCREENSHOT_TOOL_NAMES]);
  const mentioned = [...new Set(directive.match(/computer_[a-z_]+/g) ?? [])];
  assert.ok(mentioned.length > 0, "expected the directive to name some tools");
  const unknown = mentioned.filter((n) => !known.has(n));
  assert.deepEqual(unknown, [], `the directive names tools that do not exist: ${unknown.join(", ")}`);
  // It must also steer to the ACCESSIBILITY family, never the fallback one.
  const wrongFamily = mentioned.filter((n) => (SCREENSHOT_TOOL_NAMES as readonly string[]).includes(n));
  assert.deepEqual(wrongFamily, [],
    `the directive points at coordinate-based tools that are not offered while the bridge runs: ${wrongFamily.join(", ")}`);
});
