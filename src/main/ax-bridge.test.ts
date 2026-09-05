import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { AX_TOOL_NAMES, SCREENSHOT_TOOL_NAMES, routesToAx, parseBatchSteps, describeBatch, summarizeBatch, MAX_BATCH_STEPS, AxClient, AxError, appOfStep, axConsent, axNeedsFocus, screenshotToolsOffered, coordinateToolAllowed, withScreenshotGuidance, SCREENSHOT_FRAME_SENTENCE, axReadOptsFrom, axFilterSwitched, AX_DEFAULT_READ_OPTS, shouldRecoverRaise, describeAxAction, indexElementLines, readAxManifest, resolveAxDir, shouldOpenAccessibilitySettings, axNotTrustedText, RAISE_DESCRIPTION, APP_STATE_SPACE_SENTENCE, LAUNCH_FRONT_SENTENCE, withSpaceGuidance, otherSpaceNote, launchOutcome, renderActionResult, ACTION_NO_CHANGE_SENTENCE, TASK_DISCIPLINE_SENTENCE, SCREENSHOT_SPACE_SENTENCE, type AxCallInfo } from "./ax-bridge";

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
// "boom" errors, "slow" never answers, "die" exits, "hangHelloOnce" makes the
// next hello go unanswered, and AX_FAKE_SLOW_HELLO_MS in the inherited env
// delays the FIRST hello by that many ms (the startup hello is the only one a
// test cannot arm over the wire, because start() is what spawns the process).

function fakeBridge(): ReturnType<typeof readAxManifest> {
  const dir = join(scratch(), "dist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fake.js"),
    `
let hellos = 0;
let hang = false;
let slow = Number(process.env.AX_FAKE_SLOW_HELLO_MS || 0);
// Counted when the reply is SENT, so a delayed hello is counted when it lands.
const helloReply = (id) => { hellos += 1; console.log(JSON.stringify({ id, result: { name: "unbiased-ax", protocolVersion: 1, trusted: true, crossSpace: hellos >= 2 } })); };
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  // The real bridge decides crossSpace lazily: undecided (false) at start,
  // true once it has proved the private path. Model that: the first hello
  // says false, every later one true. "hellos" is test-only, like "echo".
  if (method === "hello") {
    if (hang) { hang = false; return; }
    if (slow) { const d = slow; slow = 0; return setTimeout(() => helloReply(id), d); }
    return helloReply(id);
  }
  if (method === "hellos") return console.log(JSON.stringify({ id, result: { hellos } }));
  if (method === "hangHelloOnce") { hang = true; return console.log(JSON.stringify({ id, result: {} })); }
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

test("start performs the handshake and reports trust and cross-Space", async (t) => {
  const m = fakeBridge();
  assert.ok(m && !("error" in m));
  const c = new AxClient(m);
  t.after(() => c.stop());
  const hello = await c.start();
  assert.equal(hello.trusted, true);
  assert.equal(hello.crossSpace, false, "the fake's first hello is undecided — the client must not assume true");
  assert.equal(c.crossSpace, false);
  assert.equal(c.alive, true);
});

test("a later hello can turn cross-Space on, and the client follows it", async (t) => {
  // The bridge decides its verdict lazily: spawned before the Accessibility
  // grant it says false, and says true once it has proved the private path.
  // The app must pick that up without a restart.
  const m = fakeBridge();
  assert.ok(m && !("error" in m));
  const c = new AxClient(m);
  t.after(() => c.stop());
  await c.start();
  assert.equal(c.crossSpace, false);
  assert.equal(await c.refreshCrossSpace(), true, "reports the flip");
  assert.equal(c.crossSpace, true, "the second hello said true");
  const n = await c.request("hellos", {});
  assert.equal(n.hellos, 2, "exactly two hellos: start, then one refresh");
  assert.equal(await c.refreshCrossSpace(), false, "no flip the second time");
  assert.equal((await c.request("hellos", {})).hellos, 2, "once true, refresh is a no-op and sends nothing");
});

test("a hello that goes unanswered is not a flip, and the flag stays where it was", async (t) => {
  // The bridge can be busy (a tree of a browser with fifty tabs) when the
  // prelude asks. Silence must read as "still undecided", never as a verdict,
  // and the next ask must still be able to flip it.
  const m = fakeBridge();
  assert.ok(m && !("error" in m));
  const c = new AxClient(m);
  t.after(() => c.stop());
  await c.start();
  await c.request("hangHelloOnce", {});
  c.helloTimeoutMs = 200;
  assert.equal(await c.refreshCrossSpace(), false, "a hello that times out is not a flip");
  assert.equal(c.crossSpace, false, "and the flag stays where it was");
  assert.equal(await c.refreshCrossSpace(), true, "the next hello is answered and flips it");
  assert.equal(c.crossSpace, true);
  assert.equal((await c.request("hellos", {})).hellos, 2, "the dropped hello was never answered, so it is not counted");
});

test("the startup hello waits for the bridge's self-check, not just the ordinary request budget", async (t) => {
  // The bridge is normally spawned already trusted, so the STARTUP hello is the
  // one that runs its self-check, and a slow app can stretch that past the
  // ordinary request budget. A timeout there makes startAxBridge kill the
  // bridge, and every new thread then gets no AX tools at all.
  const m = fakeBridge();
  assert.ok(m && !("error" in m));
  process.env.AX_FAKE_SLOW_HELLO_MS = "800";
  t.after(() => { delete process.env.AX_FAKE_SLOW_HELLO_MS; });
  const c = new AxClient(m, 300);
  c.helloTimeoutMs = 2_000;
  t.after(() => c.stop());
  const hello = await c.start();
  assert.equal(hello.trusted, true, "an 800 ms hello outlives a 300 ms request budget because hello has its own");
  // And it is the hello budget that saved it: the same slow hello under a
  // short one times out, exactly as start() did before.
  const d = new AxClient(m, 300);
  d.helloTimeoutMs = 300;
  t.after(() => d.stop());
  await assert.rejects(d.start(), (e: unknown) => e instanceof AxError && e.code === "timeout");
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

// ── The coordinate verbs step aside; the eyes stay ─────────────────────────

test("with the bridge alive the model can still SEE, but not click by coordinate", () => {
  // The model tried Spotlight and command+k only because they were on the
  // menu; the tree had Slack's DM list the whole time. Those are the typing
  // and coordinate verbs. computer_screenshot is the opposite case: it is the
  // only way to look at something the tree cannot express, and a model told to
  // look while holding no looking tool raised the app instead — measured once,
  // in a run that otherwise never raised.
  assert.equal(screenshotToolsOffered({ axAlive: true }), "screenshot-only");
  assert.equal(screenshotToolsOffered({ axAlive: false }), "all");
  // "screenshot-only" is spelled in index.ts as coordinateToolAllowed over the
  // declarations, so the tool has to still BE there under that name. A rename
  // would take the eyes away again, silently, while computer_app_state's
  // description still tells the model to reach for them.
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const at = src.indexOf("const COMPUTER_USE_TOOLS = [");
  const block = src.slice(at, src.indexOf("\n];", at));
  assert.ok(block.includes('name: "computer_screenshot"'),
    "COMPUTER_USE_TOOLS no longer declares computer_screenshot — the filter that keeps it would yield nothing");
});

// ── Recovering a Space we already asked for ────────────────────────────────
// Measured on a working run: 10 calls, 3 of them raises. The second raise was
// pure waste — Chrome had drifted back off-Space between one action and the
// next read, so the read returned nothing and the model had to ask for the
// raise again. If this conversation already raised that app, the read should
// recover by itself.

test("a read that comes back empty retries once, but only for an app we raised before, and never across Spaces", () => {
  assert.equal(shouldRecoverRaise({ windowsHere: 0, offscreen: 12, raisedBefore: true, crossSpace: false }), true);
  assert.equal(shouldRecoverRaise({ windowsHere: 0, offscreen: 12, raisedBefore: false, crossSpace: false }), false,
    "never raise an app the model has not already chosen to bring forward");
  assert.equal(shouldRecoverRaise({ windowsHere: 2, offscreen: 12, raisedBefore: true, crossSpace: false }), false,
    "windows are here; nothing to recover");
  assert.equal(shouldRecoverRaise({ windowsHere: 0, offscreen: 0, raisedBefore: true, crossSpace: false }), false,
    "the app has no windows at all — raising will not conjure one");
  assert.equal(shouldRecoverRaise({ windowsHere: 0, offscreen: 12, raisedBefore: true, crossSpace: true }), false,
    "with cross-Space on the window is readable where it is; measured 9 automatic raises in 4 minutes before this");
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
    "a picture of the pane the user is already looking at does not flip the switch this message exists to ask for");

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

// ── An action must see what the read saw ──────────────────────────────────
// The bridge diffs an action's after-snapshot against the last snapshot it
// took. Reads sent interactive:true; every action sent no options at all, so
// the two snapshots were different views of the same tree and the difference
// between the views was reported as change. Measured on a Maps place card: one
// press came back "+73 added", and the very next read came back with the same
// 73 ids "removed". The model was told the card it had just opened was gone,
// said so, and pressed again — nine calls to undo one lie.

test("an action snapshots the way the app last read, or the diff is a lie", () => {
  assert.deepEqual(axReadOptsFrom({}), { interactive: true, web: false }, "same defaults as computer_app_state");
  assert.deepEqual(axReadOptsFrom({ interactive: false }), { interactive: false, web: false });
  assert.deepEqual(axReadOptsFrom({ web: true }), { interactive: true, web: true });
  assert.deepEqual(axReadOptsFrom({ interactive: false, web: true }), { interactive: false, web: true });
  // depth filters the same tree the same way, and the read's own reply invites
  // the model to change it ("truncated — use query or depth").
  assert.deepEqual(axReadOptsFrom({ depth: 5 }), { interactive: true, web: false, depth: 5 });
  assert.deepEqual(axReadOptsFrom({ depth: "5" }), { interactive: true, web: false },
    "a depth that is not a number is not a filter — leave the bridge its own default");
  // Measured: a read with interactive:true followed by an action with no
  // options reported +73 elements added and then the same 73 removed.
  assert.deepEqual(AX_DEFAULT_READ_OPTS, { interactive: true, web: false });
  assert.ok(Object.isFrozen(AX_DEFAULT_READ_OPTS),
    "it is handed out by reference to every action on an unread app; one mutation would rewrite the default for all of them");
});

test("a read that CHANGES the filter has no honest diff, so it asks for the whole tree", () => {
  // The lie the rest of this commit kills, reached with two reads instead of
  // an action: read interactive:true (46 nodes), read interactive:false (119
  // nodes, brand-new ids), read true again — "- removed:" the 73 that were
  // never gone. Fix C's description actively invites that middle read.
  const on = { interactive: true, web: false };
  assert.equal(axFilterSwitched(on, { interactive: false, web: false }), true);
  assert.equal(axFilterSwitched(on, { interactive: true, web: true }), true);
  assert.equal(axFilterSwitched({ interactive: true, web: false, depth: 5 }, on), true, "depth is a filter too");
  assert.equal(axFilterSwitched(on, { interactive: true, web: false, depth: 5 }), true);
  assert.equal(axFilterSwitched(on, on), false, "the same view twice is exactly when a diff is honest");
  assert.equal(axFilterSwitched({ interactive: true, web: false, depth: 5 }, { interactive: true, web: false, depth: 5 }), false);
  // An app nothing has read yet is not "no baseline": a launch or a raise may
  // have written one, and it wrote it in the defaults.
  assert.equal(axFilterSwitched(undefined, { interactive: false, web: false }), true,
    "the first read after a launch, asking for static text, is a changed filter — the launch tree was interactive-only");
  assert.equal(axFilterSwitched(undefined, { interactive: true, web: false }), false);
});

/** The text of one call: from `ax.request(` forward to its matching `)`, with
 *  depth balanced and quoted strings skipped. A fixed character window was the
 *  first attempt and it was wrong twice over — reformatting a call across
 *  lines failed it, and a longer call (a legitimate `keepFront: true`) failed
 *  it too, with eight characters of margin. A call is a call however it is
 *  spelled. */
function bridgeCallAt(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

test("every bridge call that rewrites the diff baseline carries the read's options", () => {
  // index.ts cannot be imported here (it pulls in electron), so read it as
  // source, the same way the routing test above does.
  //
  // Every method below stores its snapshot as the bridge's `last[app]` — the
  // baseline the NEXT diff is measured against (Dispatcher.swift: afterAction
  // for the acting verbs and raise, directly for tree, find and launch). One
  // that snapshots in a different view than the reads manufactures change:
  // measured on Maps, +73 added and then the same 73 removed.
  //
  // The WHOLE file, not one function: reassertRaise raises from above the
  // dispatcher, and a new call site added below handleComputerUseCall would
  // have slipped past a range-limited scan entirely.
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  // find and tree are the read's own calls; they carry the freshly built opts
  // object, which IS the recorded view. Everything else must ask for it.
  const carriedByOpts = new Set(["tree", "find"]);
  for (const method of ["act", "setValue", "key", "scroll", "raise", "launch", "tree", "find"]) {
    // Any receiver, not just `ax.` — `ax!.request(...)` slipped through a
    // marker that spelled the variable out, which is how a call site added
    // later would most plausibly be written. And any whitespace after the
    // paren: a call Prettier wraps onto its own lines is the same call, but a
    // literal marker sees nothing there at all, so the site simply vanishes
    // from the scan while the count of the OTHER sites keeps the test green.
    // The engine's own request() names are all slash-namespaced
    // ("turn/start"), so none of these can collide.
    const marker = new RegExp(`\\.request\\(\\s*"${method}"`, "g");
    const hits = [...src.matchAll(marker)];
    assert.ok(hits.length > 0, `expected at least one .request("${method}") in index.ts`);
    for (const hit of hits) {
      // Anchored on this hit, so each site resolves independently.
      const call = bridgeCallAt(src, (hit.index ?? 0) + hit[0].indexOf("("));
      const carrier = carriedByOpts.has(method) ? /axActionOpts|\bopts\b/ : /axActionOpts/;
      assert.match(call.replace(/\s+/g, " "), carrier,
        `this ${method} call snapshots in a different view than the read did, so the next diff will be a lie` +
        (carriedByOpts.has(method) ? " (carry ...axActionOpts(appName), or the read's own opts)" : " (carry ...axActionOpts(appName))"));
    }
  }
});

test("a read records its filter before anything snapshots, and takes a whole tree when it changed", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const start = src.indexOf('case "computer_app_state": {');
  assert.ok(start > 0, "expected the computer_app_state case in index.ts");
  const block = src.slice(start, src.indexOf('case "computer_launch"', start));
  const recorded = block.indexOf("axReadOpts.set(");
  const firstCall = block.indexOf("ax.request(");
  assert.ok(recorded > 0 && firstCall > 0, "expected the read to record its filter and to call the bridge");
  assert.ok(recorded < firstCall,
    "record the filter BEFORE the auto-recovery raise: that raise snapshots and rewrites the baseline, and would write it in the previous read's view");
  assert.match(block, /full:\s*a\.full === true \|\| switched/,
    "a read that changed the filter has no honest diff — it has to ask for the whole tree");
});

test("a withheld verb is refused when it is called anyway, not merely left off the menu", () => {
  // Withholding is declaration-only: index.ts routes every computer_* name
  // that is not an AX tool to the coordinate handler, and in Full access the
  // consent gate answers "allow". A remembered or hallucinated computer_type
  // would otherwise reach the desktop with no card at all.
  for (const t of ["computer_type", "computer_click", "computer_key", "computer_move", "computer_scroll"]) {
    assert.equal(coordinateToolAllowed(t, "screenshot-only"), false, `${t} must not run while the bridge is alive`);
    assert.equal(coordinateToolAllowed(t, "all"), true, `${t} is all there is without a bridge`);
  }
  assert.equal(coordinateToolAllowed("computer_screenshot", "screenshot-only"), true, "looking is the one that survives");
  assert.equal(coordinateToolAllowed("computer_screenshot", "all"), true);

  // And the door is actually wired to it, before the consent gate.
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const body = src.slice(src.indexOf("async function handleComputerUseCall"));
  const gate = body.indexOf("coordinateToolAllowed");
  const consent = body.indexOf("axConsent");
  assert.ok(gate > 0, "handleComputerUseCall does not consult coordinateToolAllowed — the tools are off the menu but still executable");
  assert.ok(gate < consent, "the refusal has to come before the consent gate, which says allow in Full access");
});

test("with the bridge alive, the screenshot description stops promising coordinates", () => {
  const shot = { name: "computer_screenshot", description: "Capture it. " + SCREENSHOT_FRAME_SENTENCE + " Approval required." };
  const other = { name: "computer_click", description: "Click " + SCREENSHOT_FRAME_SENTENCE };
  assert.deepEqual(withScreenshotGuidance(shot, "all"), shot, "without a bridge the frame is exactly what it is for");
  assert.deepEqual(withScreenshotGuidance(other, "screenshot-only"), other, "the swap is for the one tool that survives");
  const swapped = withScreenshotGuidance(shot, "screenshot-only").description;
  assert.ok(!swapped.includes("coordinate frame to use for later computer actions"),
    "it must not point the model at verbs that are now refused");
  assert.ok(swapped.includes("SEE what the tree cannot express") && swapped.includes("element ids"));
  assert.ok(swapped.startsWith("Capture it. ") && swapped.endsWith(" Approval required."),
    "one sentence swapped by value, the rest of the description untouched");
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

// ── Batching ──────────────────────────────────────────────────────────────
// A bridge call costs 3-70ms over a local pipe; a model round trip costs
// seconds. Batching exists to spend one of the expensive kind instead of five.

test("a batch parses the verbs it supports", () => {
  const r = parseBatchSteps([
    { do: "set_value", id: 4, text: "Planet Fitness" },
    { do: "key", key: "return", wait_ms: 800 },
    { do: "read" },
  ]);
  assert.ok("steps" in r, `expected steps, got ${JSON.stringify(r)}`);
  if (!("steps" in r)) return;
  assert.equal(r.steps.length, 3);
  assert.deepEqual(r.steps[0], { do: "set_value", id: 4, text: "Planet Fitness", waitMs: 0 });
  assert.deepEqual(r.steps[1], { do: "key", key: "return", waitMs: 800 });
});

test("opening or raising an app cannot ride inside a batch", () => {
  // Both take over the user's screen. Each deserves its own approval rather
  // than being item 4 of a list the user skimmed.
  for (const verb of ["launch", "raise"]) {
    const r = parseBatchSteps([{ do: verb, app: "Maps" }]);
    assert.ok("error" in r, `${verb} should be rejected`);
    if ("error" in r) assert.match(r.error, /not batchable/);
  }
});

test("a batch refuses steps that cannot run, naming which one", () => {
  const cases: [unknown, RegExp][] = [
    [[], /empty/],
    ["press", /must be an array/],
    [[{ do: "press" }], /step 1: id is required/],
    [[{ do: "read" }, { do: "set_value", id: 2 }], /step 2: text is required/],
    [[{ do: "scroll", id: 2, direction: "sideways" }], /step 1: direction must be/],
    [[{ do: "act", id: 2 }], /step 1: action is required/],
    [[{ do: "key" }], /step 1: key is required/],
    [[{ do: "read" }, "nope"], /step 2 is not an object/],
  ];
  for (const [input, pattern] of cases) {
    const r = parseBatchSteps(input);
    assert.ok("error" in r, `${JSON.stringify(input)} should have failed`);
    if ("error" in r) assert.match(r.error, pattern);
  }
});

test("a batch is capped, and says how to continue instead of just refusing", () => {
  const tooMany = Array.from({ length: MAX_BATCH_STEPS + 1 }, () => ({ do: "read" }));
  const r = parseBatchSteps(tooMany);
  assert.ok("error" in r);
  if ("error" in r) {
    assert.match(r.error, new RegExp(`max ${MAX_BATCH_STEPS}`));
    assert.match(r.error, /then continue/, "a bare refusal leaves the model stuck");
  }
  const atLimit = parseBatchSteps(Array.from({ length: MAX_BATCH_STEPS }, () => ({ do: "read" })));
  assert.ok("steps" in atLimit, "the limit itself must be allowed");
});

test("a per-step wait is clamped, never negative and never long", () => {
  const r = parseBatchSteps([{ do: "read", wait_ms: 999_999 }, { do: "read", wait_ms: -5 }]);
  assert.ok("steps" in r);
  if (!("steps" in r)) return;
  assert.ok(r.steps[0].waitMs <= 4_000, `clamped, got ${r.steps[0].waitMs}`);
  assert.equal(r.steps[1].waitMs, 0);
});

test("the approval card shows every step, not just a count", () => {
  // One card approves the whole sequence, so a batch must never be a way to
  // slip an irreversible press in behind four harmless reads.
  const lines = new Map([[4, 'search text field "Apple Maps"'], [9, 'button "Send"']]);
  const parsed = parseBatchSteps([
    { do: "set_value", id: 4, text: "hello" },
    { do: "key", key: "return" },
    { do: "press", id: 9 },
  ]);
  assert.ok("steps" in parsed);
  if (!("steps" in parsed)) return;
  const card = describeBatch("Slack", parsed.steps, lines);
  assert.match(card, /3 step\(s\) in Slack/);
  assert.match(card, /1\. set #4 — search text field/);
  assert.match(card, /2\. press return/);
  assert.match(card, /3\. press #9 — button "Send"/, "the destructive step must be visible on the card");
  assert.equal(card.split("\n").length, 4, "one line per step plus the header");
});

test("a batch that stops halfway says so unmistakably", () => {
  const out = summarizeBatch({
    ran: ["step 1 (set_value)"],
    failed: { step: "step 2 (press)", message: "No element 9 in the last snapshot of this app." },
    remaining: 2,
    diff: "~4 text field = hello",
  });
  assert.match(out, /Stopped at step 2 \(press\)/);
  assert.match(out, /Ran first: step 1 \(set_value\)/);
  assert.match(out, /remaining 2 step\(s\) did NOT run/, "the model must not assume the rest happened");
  assert.match(out, /ids may have moved/);
  assert.match(out, /~4 text field = hello/, "what did change still has to be reported");
});

test("a batch that fails on its first step says nothing ran", () => {
  const out = summarizeBatch({
    ran: [],
    failed: { step: "step 1 (press)", message: "No element 99." },
    remaining: 2,
    diff: "",
  });
  assert.match(out, /Nothing ran before it/);
  assert.match(out, /nothing in the tree changed/);
});

test("a batch that changed nothing visible says that, rather than looking successful", () => {
  const out = summarizeBatch({ ran: ["step 1 (press)"], failed: null, remaining: 0, diff: "" });
  assert.match(out, /^Done: step 1 \(press\)\./);
  assert.match(out, /nothing in the tree changed/);
});

// ── Space guidance in the tool descriptions ────────────────────────────────
// With cross-Space on, telling the model to raise before reading is telling it
// to take the user's screen for nothing.

test("with cross-Space on, no description sends the model to raise", () => {
  const raise = { name: "computer_raise", description: RAISE_DESCRIPTION };
  const state = { name: "computer_app_state", description: "Read stuff. " + APP_STATE_SPACE_SENTENCE + "More." };
  const launch = { name: "computer_launch", description: "Open it. " + LAUNCH_FRONT_SENTENCE };
  const other = { name: "computer_apps", description: "List running apps." };

  for (const t of [raise, state, launch, other]) assert.deepEqual(withSpaceGuidance(t, false), t, "off: byte-identical to today");

  assert.ok(!withSpaceGuidance(raise, true).description.includes("exactly one case"));
  assert.ok(withSpaceGuidance(raise, true).description.includes("only when the user asked to SEE"));
  assert.ok(!withSpaceGuidance(state, true).description.includes("call computer_raise"));
  assert.ok(withSpaceGuidance(state, true).description.includes("never raise"));
  assert.ok(!withSpaceGuidance(launch, true).description.includes("brings the app to the front"));
  assert.deepEqual(withSpaceGuidance(other, true), other, "tools with nothing to say about Spaces are untouched");
});

test("the read itself says off-Space windows are readable, and only when that is true", () => {
  // Descriptions are fixed per thread start; the result is composed per call.
  // A thread that began while the bridge was undecided still reads the "off"
  // raise text, so the read has to carry the correction itself.
  const elsewhere = '1 "X" @0,0 1x1 [other Space]';
  assert.equal(otherSpaceNote(true, elsewhere), "Windows marked [other Space] are in the tree and readable; do not raise.");
  assert.equal(otherSpaceNote(false, elsewhere), "", "without cross-Space the marker is not in play and the hint covers that path");
  assert.equal(otherSpaceNote(true, '1 "X" @0,0 1x1 [focused]'), "", "nothing to say when every window is here");
});

// ── What a launch result means ─────────────────────────────────────────────
// The bridge says ok at its deadline as long as the app is running. Only a
// window line proves the tree can be worked with; the text must not claim more.

test("a launch is readable only when a window line is in the tree, not when the app merely runs", () => {
  assert.equal(launchOutcome('2 application "Calculator"\n1   standard window "Calculator" {raise}\n3     scroll area "Edit field"'), "readable");
  assert.equal(launchOutcome('1 application "Maps"\n2   menu bar\n3     menu bar item "Apple"'), "running",
    "the application and its menu bar alone prove only that it is running");
  assert.equal(launchOutcome('1 application "Maps"\n4   dialog "Open" {raise}'), "readable", "a dialog is a window too");
});

// An action that reports "(no changes)" is not a read that found nothing.
// In the Maps run the model heard it as "nothing there" and pressed again.

test("an action with no visible change says to read before repeating, instead of a bare (no changes)", () => {
  const out = renderActionResult("(no changes)");
  assert.ok(out.startsWith("Done."), out);
  assert.ok(out.includes(ACTION_NO_CHANGE_SENTENCE), out);
  assert.ok(!out.includes("(no changes)"), out);
  assert.equal(renderActionResult(""), out);
  const explained = renderActionResult("(no changes)", "Maps is behind a fullscreen Space.");
  assert.ok(explained.startsWith("Done. Maps is behind a fullscreen Space. ") && explained.includes(ACTION_NO_CHANGE_SENTENCE), explained);
  assert.equal(renderActionResult("+ 12 button \"Directions\" {press}"), "Done.\n+ 12 button \"Directions\" {press}");
});

test("a batch that ends with no visible change gets the same guidance", () => {
  const out = summarizeBatch({ ran: ["press #3"], failed: null, remaining: 0, diff: "(no changes)" });
  assert.ok(out.includes(ACTION_NO_CHANGE_SENTENCE), out);
});

test("the tools the model reads first carry the task-discipline sentence", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  for (const name of ["computer_app_state", "computer_do"]) {
    const start = src.indexOf(`name: "${name}"`);
    assert.ok(start > 0, name);
    const desc = src.slice(start, src.indexOf("inputSchema", start));
    assert.ok(desc.includes("TASK_DISCIPLINE_SENTENCE"), `${name} should spell out scope`);
  }
  assert.ok(!src.includes("axText(`Done.\\n${diff}`"), "the press/act site must render through renderActionResult");
  assert.ok(src.includes("renderActionResult(diff"), "the press/act site renders through renderActionResult");
});

test("every finished request reports its timing and size, errors included", async () => {
  const m = fakeBridge();
  assert.ok(m && !("error" in m));
  const c = new AxClient(m);
  const calls: AxCallInfo[] = [];
  c.onCall = (x) => calls.push(x);
  await c.start();
  await c.request("echo", { app: "Maps", interactive: true, query: "Directions" });
  await assert.rejects(c.request("boom", { app: "Maps" }));
  c.stop();
  const echo = calls.find((x) => x.method === "echo");
  assert.ok(echo, JSON.stringify(calls));
  assert.equal(echo.app, "Maps");
  assert.equal(echo.flags, "interactive,query");
  assert.equal(echo.marks, "", "a plain echo has nothing to mark");
  assert.ok(echo.ms >= 0 && echo.bytes > 0 && echo.error === null);
  const boom = calls.find((x) => x.method === "boom");
  assert.ok(boom && boom.error && boom.error.includes("No running app"), JSON.stringify(boom));
});

// Run 3 of the Maps task: the model wanted to look, screenshotted a Space Maps
// was not on, and raised Maps to see it — twice. The window picture is a tool
// of its own now, and the display screenshot says so while Spaces are crossed.

test("the window screenshot is an AX tool: routed, described, and read-gated like app_state", () => {
  assert.ok(routesToAx("computer_app_screenshot"));
  assert.equal(describeAxAction("computer_app_screenshot", { app: "Maps" }), "Photograph Maps's window");
  assert.equal(axNeedsFocus("computer_app_screenshot", {}), false, "it never takes the screen");
  assert.equal(axConsent({ tool: "computer_app_screenshot", mode: "ask", granted: false }), "ask", "window contents reach the model, so it is gated like a read");
});

test("while Spaces are crossed, computer_screenshot says it cannot see the other Space and names the tool that can", () => {
  const shot = { name: "computer_screenshot", description: "Capture it. " + SCREENSHOT_FRAME_SENTENCE + " Approval required." };
  assert.deepEqual(withScreenshotGuidance(shot, "all", false), shot);
  const crossed = withScreenshotGuidance(shot, "all", true).description;
  assert.ok(crossed.endsWith(SCREENSHOT_SPACE_SENTENCE), crossed);
  assert.ok(crossed.includes("computer_app_screenshot"));
  const both = withScreenshotGuidance(shot, "screenshot-only", true).description;
  assert.ok(!both.includes(SCREENSHOT_FRAME_SENTENCE) && both.endsWith(SCREENSHOT_SPACE_SENTENCE), "both rewrites compose");
  const other = { name: "computer_click", description: "Click " + SCREENSHOT_FRAME_SENTENCE };
  assert.deepEqual(withScreenshotGuidance(other, "all", true), other, "only the screenshot tool speaks about Spaces");
});

test("while Spaces are crossed, raise says looking is not a reason either", () => {
  const raise = { name: "computer_raise", description: RAISE_DESCRIPTION };
  const crossed = withSpaceGuidance(raise, true).description;
  assert.ok(crossed.includes("computer_app_screenshot") && crossed.includes("Not to look"), crossed);
});

test("a launch that showed the app and a blank picture are marked in the call line", async () => {
  const { describeAxCall } = await import("./ax-bridge");
  const base = { method: "launch", app: "Maps", ms: 3000, waitedMs: null, bytes: 900, lines: 20, flags: "", marks: "shown", error: null };
  assert.ok(describeAxCall(base).includes("[shown]"));
  assert.ok(describeAxCall({ ...base, method: "screenshot", marks: "blank" }).includes("[blank]"));
  assert.ok(!describeAxCall({ ...base, marks: "" }).includes("["));
});
