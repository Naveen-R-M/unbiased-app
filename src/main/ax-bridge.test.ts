import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { roleOfLine, pointerRoute, AX_TOOL_NAMES, SCREENSHOT_TOOL_NAMES, routesToAx, parseBatchSteps, describeBatch, summarizeBatch, MAX_BATCH_STEPS, AxClient, AxError, appOfStep, axConsent, axNeedsFocus, screenshotToolsOffered, coordinateToolAllowed, withScreenshotGuidance, SCREENSHOT_FRAME_SENTENCE, axReadOptsFrom, AX_DEFAULT_READ_OPTS, shouldRecoverRaise, describeAxAction, indexElementLines, readAxManifest, resolveAxDir, shouldOpenAccessibilitySettings, axNotTrustedText, RAISE_DESCRIPTION, APP_STATE_SPACE_SENTENCE, LAUNCH_FRONT_SENTENCE, withSpaceGuidance, otherSpaceNote, launchOutcome, renderActionResult, ACTION_NO_CHANGE_SENTENCE, TASK_DISCIPLINE_SENTENCE, SCREENSHOT_SPACE_SENTENCE, parseCandidates, describeCandidates, parkedNextCall, parkedReadNote, batchNudge, isSingleEdit, stepsForNudge, traceStep, MAX_TYPE_LENGTH, type BatchStep, BATCH_NUDGE_AFTER, type RecentEdit, pointerHeadline, drawGate, DRAW_GATE_POINTS, surfaceCommands, skillBody, skillPreamble, shouldSendSkill, prependSkill, appendSkill, MAX_SKILL_PREAMBLE, candidateWorked, summarizeCandidates, MAX_CANDIDATES, MAX_CANDIDATE_STEPS, type AxCallInfo, touchedFieldIds, renderFieldValues, MAX_FIELDS_READ_BACK, type FieldValue, renderInspector, MAX_INSPECTOR_FIELDS, BATCH_VERBS, type InspectorField } from "./ax-bridge";

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

// Measured 2026-09-08 on the Figma logo run: 28 web/interactive flips between
// consecutive reads, and every one became a forced full tree (~9KB) because the
// bridge held one baseline per app. It now holds one per filter, so a flip is a
// diff against that filter's own last read and only a never-used filter is a
// full tree. The app has nothing left to decide here.
test("a read that changes the filter is a diff, not a forced full tree (the bridge keeps one baseline per filter)", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  assert.ok(!src.includes("axFilterSwitched"), "the app no longer decides this; the bridge diffs against the filter's own baseline");
  assert.ok(src.includes("full: a.full === true,"), "full is the model's explicit ask and nothing else");
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
  //
  // `opts` is allowed as the carrier anywhere, because every definition of it
  // is checked below to BE the recorded view — spelled out here, a batch step
  // that folds `settle: false` into an axActionOpts spread reads as a call
  // with no options at all, and the guard fails on a call that is correct.
  for (const [, def] of src.matchAll(/const opts(?::[^=]+)? = \{([\s\S]*?)\n *\};?/g)) {
    assert.match(def, /axActionOpts|\.\.\.want/,
      `this opts object is neither the read's own view (...want) nor the recorded one (axActionOpts), so the calls carrying it snapshot in a view of their own: ${def.trim().slice(0, 80)}`);
  }
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
      assert.match(call.replace(/\s+/g, " "), /axActionOpts|\bopts\b/,
        `this ${method} call snapshots in a different view than the read did, so the next diff will be a lie (carry ...axActionOpts(appName), or an opts object built from it)`);
    }
  }
});

test("a read records its filter before anything snapshots", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const start = src.indexOf('case "computer_app_state": {');
  assert.ok(start > 0, "expected the computer_app_state case in index.ts");
  const block = src.slice(start, src.indexOf('case "computer_launch"', start));
  const recorded = block.indexOf("axReadOpts.set(");
  const firstCall = block.indexOf("ax.request(");
  assert.ok(recorded > 0 && firstCall > 0, "expected the read to record its filter and to call the bridge");
  assert.ok(recorded < firstCall,
    "record the filter BEFORE the auto-recovery raise: that raise snapshots and rewrites the baseline, and would write it in the previous read's view");
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

// Measured 2026-09-10, one conversation: with the toggle on, "Hello" got the
// app list read before the greeting; with it off, "what is today?" opened a
// calendar app for 27 seconds because an earlier turn's directive said every
// number must come from a tool result. The toggle is where app work goes,
// not a claim that every message is app work.
test("the directive leaves messages that need no app alone, and scopes the source rule to app-read facts", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const start = src.indexOf("const COMPUTER_DIRECTIVE");
  const directive = src.slice(start, src.indexOf("approval.\";", start));
  assert.match(directive, /needs no app/);
  assert.match(directive, /direct answer and no desktop call/);
  assert.match(directive, /present as coming from an app/);
  assert.match(directive, /What you know without an app, you may simply say/);
  assert.doesNotMatch(directive, /Every number, name, distance, time or price in your answer must/);
  assert.doesNotMatch(directive, /so use them: start with/);
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

// Rollout 01a081a0 (2026-09-08): with no human in the loop, three model turns
// opened "You're right — let me stop…" in direct reply to this sentence and to
// the batch caveat, and each began a re-plan. A tool result is evidence, not a
// reviewer: it says what happened and what else is available.
test("tool text states facts and options, never scolds or cites past runs", () => {
  const batch = summarizeBatch({ ran: ["a", "b"], failed: null, remaining: 0, diff: "~ 1", unwatched: true });
  for (const s of [ACTION_NO_CHANGE_SENTENCE, batch]) {
    assert.ok(!/\bdo not\b|don't|\bnever\b|in the last run|cost \w+ turns|retries/i.test(s), s);
  }
});

// The checkpoint's wiring lives in index.ts, which has no unit harness; this
// pins the six places it must touch, the way the routing and skill tests do.
test("the checkpoint is wired: declared, routed, gated before actions, written at the threshold, replayed after compaction, fed facts", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  assert.ok(src.includes("...CHECKPOINT_TOOLS,"), "declared to every thread");
  assert.ok(src.includes('tool.startsWith("checkpoint_")') && src.includes("handleCheckpointToolCall("), "routed by prefix");
  assert.ok(src.includes("isGatedTool(tool) && checkpointDue("), "the first action past the threshold is held once");
  assert.ok(src.includes("ctxPercent.set("), "the app tracks context occupancy per root thread");
  assert.ok(src.includes("checkpointReplayDue.add(") && src.includes("checkpointPreamble("), "the file comes back on the first tool result after a compaction");
  assert.ok(src.includes("recordFact("), "measured facts are recorded by the app");
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
  // The code travels beside the prose. Anything sorting failures into kinds —
  // stale element ids apart from timeouts apart from a dead bridge — keys off
  // this, because the messages are written to be read and get rewritten.
  assert.equal(boom.code, "no_such_app");
  assert.equal(echo.code, null, "a call that worked carries no code");
});

test("a call reports inside the async context of whoever asked for it", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const m = fakeBridge();
  assert.ok(m && !("error" in m));
  const c = new AxClient(m);
  const seen: (string | undefined)[] = [];
  const store = new AsyncLocalStorage<string>();
  c.onCall = () => seen.push(store.getStore());
  await c.start();
  // A reply arrives on the bridge's stdout 'line' event, and that listener is
  // registered once in start(). Without binding, report() runs in startup's
  // context and every caller's async-local state is invisible — measured on a
  // real run as 222 driver records with a null thread while the tool records
  // wrapping them were all correct.
  await store.run("the caller", () => c.request("echo", { app: "Maps" }));
  c.stop();
  assert.deepEqual(
    seen.filter((x) => x !== undefined),
    ["the caller"],
    `the echo reported outside its caller's context: ${JSON.stringify(seen)}`,
  );
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

test("select_text parses, traces, and defaults to the whole value", () => {
  const all = parseBatchSteps([{ do: "select_text", id: 7 }]);
  assert.ok("steps" in all, JSON.stringify(all));
  assert.deepEqual(all.steps[0], { do: "select_text", id: 7, waitMs: 0 });
  assert.equal(traceStep(all.steps[0]), "select_text #7 (all)");

  const some = parseBatchSteps([{ do: "select_text", id: 7, text: "121212" }]);
  assert.ok("steps" in some);
  assert.equal(traceStep(some.steps[0]), 'select_text #7 "121212"');

  // id is what scopes it to a field rather than to the document; without one
  // this would be command+a by another name.
  assert.ok("error" in parseBatchSteps([{ do: "select_text" }]));
  assert.ok("error" in parseBatchSteps([{ do: "select_text", id: 7, text: 12 }]));
});

test("a role is read off an element line by where it stops", () => {
  assert.equal(roleOfLine('text field "Last name" = Kumar {press,show menu}'), "text field");
  assert.equal(roleOfLine('pop up button "Country" = India {press}'), "pop up button");
  assert.equal(roleOfLine('incrementor "Seats"'), "incrementor");
  assert.equal(roleOfLine("button [disabled] {press}"), "button");
  assert.equal(roleOfLine('text area = a long note'), "text area");
  assert.equal(roleOfLine(undefined), null);
  assert.equal(roleOfLine(""), null);
});

test("the preamble says where the reference files are, when it knows", () => {
  const md = "---\nname: x\n---\n# Body\ntext";
  const withDir = skillPreamble(md, "/Apps/Unbiased.app/Contents/Resources/skills/computer-use");
  assert.ok(withDir!.includes("/references/"), withDir!);
  assert.ok(withDir!.includes("shell command"), "it must say how to open one: " + withDir);
  // A file the reader cannot locate reads as detail withheld, so without a
  // directory the pointer is simply absent rather than dangling.
  assert.ok(!skillPreamble(md)!.includes("/references/"));
  assert.ok(skillPreamble(md)!.includes("# Body"));
});

test("computer_find is routed, and its description sells the refusal", () => {
  assert.ok(AX_TOOL_NAMES.includes("computer_find"), "declared but not routed sends it to the screenshot handler");
  assert.ok(routesToAx("computer_find"));
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const at = src.indexOf('name: "computer_find"');
  assert.ok(at > 0, "computer_find must be declared to the model");
  const decl = src.slice(at, src.indexOf("inputSchema", at));
  // The value is that it refuses. A description that only promises to find
  // something invites the model to treat a list of two as an answer.
  assert.ok(/never picks for you/i.test(decl), "the description must say it does not choose");
  assert.ok(/exact/i.test(decl), "and that matching is exact by default");
});

test("the pointer route is recorded, and the two that used to look alike no longer do", () => {
  // The bug: "quiet" and "took the user's cursor and raised the app" both
  // recorded as null, so the metrics could not answer which had happened. On a
  // drawing run all thirteen pointer calls read null while the user watched
  // their own cursor turn into a pen.
  assert.equal(pointerRoute("pointer", "backgrounded,pointerUntouched"), "window");
  assert.equal(pointerRoute("pointer", "pointerUntouched"), "quiet");
  assert.equal(pointerRoute("pointer", "raised"), "cursor+raised");
  assert.equal(pointerRoute("pointer", "pointerReturned"), "cursor");
  assert.equal(pointerRoute("pointer", ""), "cursor-left");
  assert.notEqual(pointerRoute("pointer", "pointerUntouched"), pointerRoute("pointer", "raised"));
  // Only pointer calls have a route; everything else would be inventing one.
  assert.equal(pointerRoute("act", "backgrounded"), null);
  assert.equal(pointerRoute("tree", ""), null);
});

test("computer_verify is routed, and its description refuses to let unknown pass as yes", () => {
  assert.ok(AX_TOOL_NAMES.includes("computer_verify"), "declared but not routed sends it to the screenshot handler");
  assert.ok(routesToAx("computer_verify"));
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const at = src.indexOf('name: "computer_verify"');
  assert.ok(at > 0, "computer_verify must be declared to the model");
  const decl = src.slice(at, src.indexOf("inputSchema", at));
  // The whole point is the third answer. A description that offers only yes
  // and no teaches the model that anything else is a yes.
  assert.ok(/unknown is NOT success/i.test(decl), "the description must say unknown is not success");
  // And the reason it exists at all: the retry that undoes the thing.
  assert.ok(/UNDO/i.test(decl), "it must warn that pressing a toggle again may undo the first press");
  assert.ok(/looking again|read.*again/i.test(decl), "and that a stale tree is answered by reading, not by acting again");
});

test("a verify verdict is reported as an answer, never as a failed call", () => {
  // "unsatisfied" means the check ran and said no. Marking that as a failed
  // tool call is how a caller learns to retry what it just proved did not
  // happen — which on a toggle undoes the press that did.
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const at = src.indexOf('case "computer_verify"');
  assert.ok(at > 0, "computer_verify must be handled");
  const body = src.slice(at, at + 1600);
  assert.ok(/ok is about whether the CHECK RAN/i.test(body), "the reasoning must be stated where someone would change it");
  assert.ok(/return axText\([\s\S]*?,\s*true,?\s*\);/.test(body), "the verdict is data; the call itself succeeded");
});

test("a batch says when its writes moved nothing, but only when the tree agrees", () => {
  const ran = ["step 1 (press #4)", "step 2 (type \"abc\")"];
  const quiet = ["step 2 (type \"abc\")"];
  // Both signals: the values did not move AND nothing in the tree moved.
  const both = summarizeBatch({ ran, failed: null, remaining: 0, diff: "(no changes)", quiet });
  assert.ok(both.includes("wrote nothing that can be observed"), both);
  assert.ok(both.includes("step 2"), "it names which step: " + both);
  // One signal only: the tree moved, so the write did something even though
  // the value reads the same — the case that made refusing this wrong.
  const moved = summarizeBatch({ ran, failed: null, remaining: 0, diff: "~4 button \"OK\"", quiet });
  assert.ok(!moved.includes("wrote nothing"), "a tree that changed acquits the write: " + moved);
  // No quiet steps: unchanged from before.
  const clean = summarizeBatch({ ran, failed: null, remaining: 0, diff: "(no changes)" });
  assert.ok(!clean.includes("wrote nothing"), clean);
  assert.ok(clean.includes(ACTION_NO_CHANGE_SENTENCE), clean);
});

test("a launch that showed the app and a blank picture are marked in the call line", async () => {
  const { describeAxCall } = await import("./ax-bridge");
  const base = { method: "launch", app: "Maps", ms: 3000, waitedMs: null, bytes: 900, lines: 20, flags: "", marks: "shown", error: null, code: null, targetId: null };
  assert.ok(describeAxCall(base).includes("[shown]"));
  assert.ok(describeAxCall({ ...base, method: "screenshot", marks: "blank" }).includes("[blank]"));
  assert.ok(describeAxCall({ ...base, method: "pointer", marks: "backgrounded" }).includes("[backgrounded]"));
  // Both spellings of "this write did nothing". A settling call reports the
  // verdict; a batch step reports the one signal it has. Watching for only the
  // first counted zero across two runs in which every write was batched.
  assert.ok(describeAxCall({ ...base, method: "setValue", marks: "wroteNothing" }).includes("[wroteNothing]"));
  assert.ok(describeAxCall({ ...base, method: "setValue", marks: "valueUnchanged" }).includes("[valueUnchanged]"));
  assert.ok(!describeAxCall({ ...base, marks: "" }).includes("["));
});


// Candidates: several plausible routes to one state, tried locally, so a wrong
// guess costs a bridge call instead of a model turn.

test("a candidate is a route: one step or a short list, and two routes minimum", () => {
  const ok = parseCandidates([{ do: "press", id: 88 }, [{ do: "key", key: "down" }, { do: "key", key: "return" }]]);
  assert.ok(!("error" in ok), JSON.stringify(ok));
  assert.equal(ok.candidates.length, 2);
  assert.equal(ok.candidates[0].length, 1);
  assert.equal(ok.candidates[1].length, 2, "down then return is ONE route, not two");
  const one = parseCandidates([{ do: "press", id: 1 }]);
  assert.ok("error" in one && one.error.includes("at least two"), JSON.stringify(one));
  const many = parseCandidates(Array.from({ length: MAX_CANDIDATES + 1 }, () => ({ do: "key", key: "return" })));
  assert.ok("error" in many && many.error.includes("too many"), JSON.stringify(many));
  const tooDeep = parseCandidates([{ do: "press", id: 1 }, Array.from({ length: MAX_CANDIDATE_STEPS + 1 }, () => ({ do: "key", key: "down" }))]);
  assert.ok("error" in tooDeep && tooDeep.error.includes("candidate 2"), JSON.stringify(tooDeep));
});

test("a read can never be a candidate, and the refusal says which one", () => {
  const bad = parseCandidates([{ do: "press", id: 1 }, [{ do: "key", key: "down" }, { do: "read" }]]);
  assert.ok("error" in bad && bad.error.includes("candidate 2 step 2") && bad.error.includes("read"), JSON.stringify(bad));
});

test("a route counts as working only when the settled tree really moved", () => {
  assert.equal(candidateWorked("+ 12 button \"Directions\""), true);
  assert.equal(candidateWorked("(no changes)"), false);
  assert.equal(candidateWorked("  (no changes)  "), false);
  assert.equal(candidateWorked(""), false);
});

test("the summary names the winner, what each loser did, and does not overclaim success", () => {
  const out = summarizeCandidates({
    tried: [
      { label: "1. press #23", outcome: "nothing" },
      { label: "2. key then key", outcome: "worked" },
    ],
    winner: 1,
    diff: "+ 99 heading \"AMC River East 21\"",
    remaining: 1,
  });
  assert.ok(out.includes("Route 2 changed the app"), out);
  assert.ok(out.includes("check it is the state you wanted"), "changing something is not the same as working");
  assert.ok(out.includes("1. press #23 did nothing"), out);
  assert.ok(out.includes("→ 2. key then key changed the app"), out);
  assert.ok(out.includes("1 later route(s) were not tried"), out);
  assert.ok(out.includes("AMC River East 21"), out);
});

test("when nothing worked the model is told that, with the do-not-repeat guidance", () => {
  const out = summarizeCandidates({
    tried: [
      { label: "1. press #23", outcome: "nothing" },
      { label: "2. act #24", outcome: "Element 24 does not offer \"focus\"" },
    ],
    winner: null,
    diff: "",
    remaining: 0,
  });
  assert.ok(out.startsWith("None of the 2 route(s) changed the app."), out);
  assert.ok(out.includes("failed: Element 24 does not offer"), out);
  assert.ok(out.includes(ACTION_NO_CHANGE_SENTENCE), out);
});

test("the approval card shows routes as alternatives, so one press is never approved as four", () => {
  const routes = parseCandidates([{ do: "press", id: 88 }, [{ do: "key", key: "down" }, { do: "key", key: "return" }]]);
  assert.ok(!("error" in routes));
  const card = describeCandidates("Maps", routes.candidates, new Map([[88, 'button "AMC River East 21"']]));
  assert.ok(card.startsWith("2 alternative route(s) in Maps, stopping at the first that changes anything:"), card);
  assert.ok(card.includes("AMC River East 21"), "the card names what would be pressed");
  assert.ok(/2\.\n/.test(card), `the two-step route is shown as two lines: ${card}`);
});

test("steps and candidates are different shapes and cannot be sent together", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  assert.ok(src.includes("Pass steps for a sequence or candidates for alternatives, not both."));
  assert.ok(src.includes("runCandidates(appName, routes.candidates, remember)"));
  assert.ok(MAX_CANDIDATES < MAX_BATCH_STEPS, "the route cap is tighter than the sequence cap");
});

// Prose lost. Three texts told the model to use the keyboard on a parked
// window and it raised twice anyway, so the reply now ends with the call.

test("a click that died on a parked window ends with the calls to send next", () => {
  const hint = "Stage Manager has parked Maps's window in the side strip as a thumbnail.";
  const out = renderActionResult("(no changes)", hint, parkedNextCall("Maps"));
  assert.ok(out.startsWith("Done. " + hint), out);
  assert.ok(out.includes(ACTION_NO_CHANGE_SENTENCE), out);
  // Both paths, each concrete: one for choosing out of a list, one for
  // reaching a control that cannot be pressed at all.
  assert.ok(out.includes('computer_do {"app":"Maps","steps":[{"do":"key","key":"down"},{"do":"key","key":"return"}]}'), out);
  assert.ok(out.includes("whole intent") && out.includes('"directions to <place>"'), out);
});

test("down and return are one call, because down alone only moves the selection", () => {
  const call = parkedNextCall("Maps");
  const steps = /"steps":(\[.*\])/.exec(call);
  assert.ok(steps, call);
  const parsed = JSON.parse(steps[1]) as { do: string; key?: string }[];
  assert.deepEqual(parsed, [{ do: "key", key: "down" }, { do: "key", key: "return" }]);
  assert.ok(!call.includes("candidates"), "one measured route beats a set of guesses here");
  assert.ok(call.includes("finished action"), "and the second path, for a control that cannot be pressed");
});

test("an app name with a quote in it cannot break the call it is embedded in", () => {
  assert.ok(parkedNextCall('Bob\'s "App"').includes(JSON.stringify('Bob\'s "App"')));
});

test("nothing is appended when the action worked, or when it was itself a key", () => {
  assert.equal(renderActionResult("+ 9 heading \"Card\"", "parked", parkedNextCall("Maps")), 'Done.\n+ 9 heading "Card"');
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  assert.ok(src.includes('tool === "computer_press" || tool === "computer_act" || tool === "computer_set_value"'), "only the verbs that hit-test");
  assert.ok(src.includes("hint && clicked ? parkedNextCall(appName) : null"));
});

// The parked state used to be discovered by pressing something and watching it
// fail. One run then spent sixteen seconds shelling out to read the skill.

test("a read of a parked window names the readable/interactable split and both working paths", () => {
  const note = parkedReadNote([{ id: 1, parked: true }]);
  assert.ok(note && note.startsWith("[parked] "), String(note));
  // The distinction that matters: reads are exact, presses may not land.
  assert.ok(note.includes("READABLE") && note.includes("INTERACTABLE"), note);
  assert.ok(note.includes('[{"do":"key","key":"down"},{"do":"key","key":"return"}]'), note);
  assert.ok(note.includes('"directions to <place>"'), "the intent query is the path for a control you cannot press");
  assert.ok(note.includes("menu bar") || note.includes("Menu bar"), note);
  assert.ok(note.includes("Do not raise") && note.includes("move or resize"), note);
});

test("nothing is said when no window is parked, whatever the shape of the input", () => {
  assert.equal(parkedReadNote([{ id: 1, parked: false }]), null);
  assert.equal(parkedReadNote([{ id: 1 }]), null);
  assert.equal(parkedReadNote([]), null);
  assert.equal(parkedReadNote(undefined), null);
  assert.equal(parkedReadNote("nonsense"), null);
  assert.equal(parkedReadNote([null, 3, "x"]), null);
});

test("one parked window among several is enough to say it", () => {
  assert.ok(parkedReadNote([{ id: 1, parked: false }, { id: 2, parked: true }]));
});

test("the read result carries the note, next to the Space guidance", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const head = src.slice(src.indexOf("const head = ["), src.indexOf("].filter(Boolean).join"));
  assert.ok(head.includes("parkedReadNote(w.windows)"), `the read head must carry it: ${head}`);
  assert.ok(head.includes("otherSpaceNote"), "and still carry the Space note");
});

// The model does open the skill on its own — twice in the measured runs — but
// both times mid-task, after it had already stalled, once costing 16 seconds.
// So the first desktop call of a conversation hands it over.

test("the frontmatter is stripped, because it addresses the loader and not the reader", () => {
  const body = skillBody("---\nname: computer-use\ndescription: x\n---\n\n# Driving apps\n\nBody here.\n");
  assert.equal(body, "# Driving apps\n\nBody here.");
  assert.ok(!body.includes("description:"));
});

test("a file with no frontmatter is passed through, and an empty one sends nothing", () => {
  assert.equal(skillBody("# Just a heading"), "# Just a heading");
  assert.equal(skillPreamble("   \n  "), null);
  assert.equal(skillPreamble("---\nname: x\n---\n"), null, "frontmatter alone is not content");
});

test("the preamble is framed so it cannot be read as tool output, and the result stays last", () => {
  const preamble = skillPreamble("---\nname: computer-use\n---\n# Guide\nDo this.");
  assert.ok(preamble && preamble.startsWith("=== How to drive desktop apps"), String(preamble));
  assert.ok(preamble.includes("sent once per conversation"), preamble);
  assert.ok(preamble.trimEnd().endsWith("=== end ==="), preamble);
  const out = prependSkill({ contentItems: [{ type: "inputText", text: "the tree" }], success: true }, preamble);
  assert.equal(out.contentItems.length, 2);
  assert.equal((out.contentItems[0] as { text: string }).text, preamble);
  assert.equal((out.contentItems[1] as { text: string }).text, "the tree", "the tool result is still the last thing read");
  assert.equal(out.success, true);
});

test("a runaway skill file cannot flood a turn", () => {
  const body = skillBody("x".repeat(MAX_SKILL_PREAMBLE + 5_000));
  assert.ok(body.length <= MAX_SKILL_PREAMBLE + 20, String(body.length));
  assert.ok(body.endsWith("(truncated)"));
});

test("it goes with a desktop tool, once, and never with anything else", () => {
  assert.equal(shouldSendSkill("computer_app_state", false), true);
  assert.equal(shouldSendSkill("computer_apps", false), true, "listing apps is often the first call");
  assert.equal(shouldSendSkill("computer_screenshot", false), true, "the screenshot family counts too");
  assert.equal(shouldSendSkill("computer_app_state", true), false, "once per conversation");
  assert.equal(shouldSendSkill("schedule_create", false), false);
  assert.equal(shouldSendSkill("memory_write", false), false);
  assert.equal(shouldSendSkill("browser_navigate", false), false);
});

test("the real bundled skill survives the round trip", () => {
  const md = readFileSync(join(__dirname, "..", "..", "resources", "skills", "computer-use", "SKILL.md"), "utf8");
  const preamble = skillPreamble(md);
  assert.ok(preamble, "the shipped skill must produce a preamble");
  assert.ok(!preamble.includes("description: How to drive"), "frontmatter gone");
  for (const needle of ["Stage Manager", "PARKED", "computer_app_screenshot", "menu bar"]) {
    assert.ok(preamble.includes(needle) || preamble.toLowerCase().includes(needle.toLowerCase()), `lost ${needle}`);
  }
  assert.ok(preamble.length < MAX_SKILL_PREAMBLE, `the shipped skill is ${preamble.length} bytes and must not be truncated`);
});

test("the dispatch site sends it once, before the tool result", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  assert.ok(src.includes("shouldSendSkill(tool, axSkillSent.has(skillRoot))"), "decided per conversation");
  assert.ok(src.includes("axSkillSent.add(skillRoot)"), "and only once");
  assert.ok(src.includes("appendSkill(response, preamble)"), "the skill rides after the result, so the result is not missed");
  // An unreadable file must not break a turn.
  assert.ok(src.includes("first-call preamble disabled"), "a missing skill file degrades quietly");
});

// Drawing. Two agents stalled on the same Figma task: the pen tool is behind
// the letter `p` with no element, and the canvas has nothing to press.

test("the pointer is an AX tool: routed, gated like an action, and never takes the screen by itself", () => {
  assert.ok(routesToAx("computer_pointer"));
  assert.equal(axNeedsFocus("computer_pointer", {}), false, "it does not raise; the bridge refuses when the window is not visible");
  assert.equal(axConsent({ tool: "computer_pointer", mode: "ask", granted: false }), "ask");
});

test("the approval card says the pointer MOVES, names the anchor, and distinguishes a drag", () => {
  const lines = new Map([[33, 'web area "Untitled – Figma"']]);
  const click = describeAxAction("computer_pointer", { app: "Figma", id: 33, path: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }] }, lines);
  assert.equal(click, 'Click the pointer at 2 point(s) inside #33 — web area "Untitled – Figma" in Figma');
  const drag = describeAxAction("computer_pointer", { app: "Figma", id: 33, path: [{ x: 0, y: 0 }], hold: true }, lines);
  assert.ok(drag.startsWith("Drag the pointer at 1 point(s)"), drag);
  const bare = describeAxAction("computer_pointer", { app: "Figma", id: 9, path: [] });
  assert.equal(bare, "Click the pointer at 0 point(s) inside #9 in Figma");
});

test("a key is one letter, one digit or a named key — no enum to fence the pen out", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const start = src.indexOf('name: "computer_press_key"');
  const schema = src.slice(start, src.indexOf("required:", start));
  assert.ok(!schema.includes('enum: ["return"'), "the old enum would have refused p");
  assert.ok(schema.includes("One letter (a-z)"), schema.slice(0, 400));
  assert.ok(schema.includes("command"), "modifiers are part of the same call");
});

test("the pointer handler needs an anchor, defaults to its centre, and validates the click count", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const start = src.indexOf('case "computer_pointer"');
  const body = src.slice(start, src.indexOf('case "computer_app_screenshot"', start));
  // A path is now OPTIONAL: clicking a field to put a caret in it is the
  // commonest use and should not require spelling out {"x":0.5,"y":0.5}.
  assert.ok(!body.includes("path is required"), "an omitted path means the element's centre");
  assert.ok(body.includes("clicks must be 1 to"), "a silly click count is refused before the bridge");
  assert.ok(body.includes("id is required"));
  assert.ok(body.includes("Landed at"), "the reply reports where the fractions landed");
  assert.ok(body.includes('"pointer"'), "and it goes to the bridge's pointer verb");
});

// A Figma icon built from native shapes: 91 key presses and 63 value sets,
// nearly all one per turn, at 15 seconds a turn. computer_do existed and was
// barely used, so the app notices the run and hands back the literal call.

test("a run of single edits on one app becomes the batch call that would have done them", () => {
  const recent: RecentEdit[] = [
    { tool: "computer_set_value", app: "Figma", id: 10, text: "500" },
    { tool: "computer_set_value", app: "Figma", id: 11, text: "65" },
    { tool: "computer_set_value", app: "Figma", id: 12, text: "280" },
  ];
  const out = batchNudge(recent);
  assert.ok(out, "three in a row is worth saying");
  assert.ok(out.includes("3 separate calls to Figma"), out);
  assert.ok(out.includes('computer_do {"app":"Figma","steps":[{"do":"set_value","id":10,"text":"500"}'), out);
  assert.ok(out.includes("not five"), out);
});

test("it stays quiet below the threshold, and starts the count again on a different app", () => {
  assert.equal(batchNudge([]), null);
  const two: RecentEdit[] = [
    { tool: "computer_press", app: "Figma", id: 1 },
    { tool: "computer_press", app: "Figma", id: 2 },
  ];
  assert.equal(batchNudge(two), null, `fewer than ${BATCH_NUDGE_AFTER} is not a pattern`);
  const switched: RecentEdit[] = [
    { tool: "computer_press", app: "Maps", id: 1 },
    { tool: "computer_press", app: "Maps", id: 2 },
    { tool: "computer_press", app: "Figma", id: 3 },
  ];
  assert.equal(batchNudge(switched), null, "only the trailing run on one app counts");
});

test("every batchable verb is rendered as its step, and an unbatchable one cancels the nudge", () => {
  const mixed: RecentEdit[] = [
    { tool: "computer_press", app: "Figma", id: 5 },
    { tool: "computer_act", app: "Figma", id: 6, action: "show menu" },
    { tool: "computer_press_key", app: "Figma", key: "return" },
  ];
  const out = batchNudge(mixed);
  assert.ok(out, String(out));
  assert.ok(out.includes('{"do":"press","id":5}') && out.includes('{"do":"act","id":6,"action":"show menu"}') && out.includes('{"do":"key","key":"return"}'), out);
  const withRaise: RecentEdit[] = [...mixed, { tool: "computer_raise", app: "Figma" }];
  assert.equal(batchNudge(withRaise), null, "raise is not batchable, so there is no single call to suggest");
});

// Run 6, 2026-09-08: 122 turns, 84 of them one call each; 30 were single
// computer_pointer calls and 46 of 53 computer_do batches edited ONE field —
// the four-keystroke recipe wrapped in a batch. The nudge saw none of it: it did
// not know pointer, it counted a one-field batch as batching, and it had said
// its one sentence before the first compaction erased it. It now counts logical
// edits, whatever call carried them, and is re-armed when a compaction has
// taken the earlier one away.
test("a single pointer click counts as one edit; a drawn path does not, because it has no batch step", () => {
  const clicks: RecentEdit[] = [
    { tool: "computer_pointer", app: "Figma", id: 88, clicks: 2 },
    { tool: "computer_pointer", app: "Figma", id: 89, clicks: 2 },
    { tool: "computer_pointer", app: "Figma", id: 90 },
  ];
  const out = batchNudge(clicks);
  assert.ok(out && out.includes('{"do":"pointer","id":88,"clicks":2}') && out.includes('{"do":"pointer","id":90}'), String(out));
  const drawn: RecentEdit[] = [...clicks.slice(0, 2), { tool: "computer_pointer", app: "Figma", id: 14, path: true }];
  assert.equal(batchNudge(drawn), null, "a stroke with a path cannot be written as a batch step");
});

test("a batch that edits one field is one edit, and its steps are spliced into the suggested call", () => {
  const oneField: BatchStep[] = [
    { do: "pointer", id: 88, clicks: 2, waitMs: 0 }, { do: "key", key: "a", modifiers: ["command"], waitMs: 0 },
    { do: "type", text: "460", waitMs: 0 }, { do: "key", key: "return", waitMs: 0 }, { do: "read", waitMs: 0 },
  ];
  assert.equal(isSingleEdit(oneField), true, "four keystrokes into one field is one edit");
  assert.equal(isSingleEdit([{ do: "set_value", id: 10, text: "1", waitMs: 0 }, { do: "set_value", id: 11, text: "2", waitMs: 0 }]), false, "two fields is batching");
  assert.equal(isSingleEdit([{ do: "key", key: "return", waitMs: 0 }]), false, "nothing edited: nothing to combine");
  assert.equal(isSingleEdit([{ do: "screenshot", waitMs: 0 }, { do: "read", waitMs: 0 }]), false);
  assert.deepEqual(stepsForNudge(oneField), [
    { do: "pointer", id: 88, clicks: 2 }, { do: "key", key: "a", modifiers: ["command"] }, { do: "type", text: "460" }, { do: "key", key: "return" }, { do: "read" },
  ], "waitMs is dropped when zero and the wire name is used otherwise");
  assert.deepEqual(stepsForNudge([{ do: "press", id: 3, waitMs: 500 }]), [{ do: "press", id: 3, wait_ms: 500 }]);
  const recent: RecentEdit[] = [
    { tool: "computer_pointer", app: "Figma", id: 87, clicks: 2 },
    { tool: "computer_do", app: "Figma", steps: stepsForNudge(oneField) },
    { tool: "computer_set_value", app: "Figma", id: 91, text: "512" },
  ];
  const out = batchNudge(recent);
  assert.ok(out && out.includes("3 separate calls to Figma"), String(out));
  assert.ok(out && out.includes('{"do":"pointer","id":87,"clicks":2},{"do":"pointer","id":88,"clicks":2},{"do":"key","key":"a","modifiers":["command"]}'), "the batch's own steps appear inline, in order: " + String(out));
  assert.ok(out && out.includes('{"do":"set_value","id":91,"text":"512"}'), String(out));
});

test("the nudge is said once per compaction cycle; a real batch resets the count, a one-edit batch does not", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  assert.ok(src.includes("axBatchNudged.has(root) ? null : batchNudge(axRecentEdits)"), "gated on the armed set");
  const compaction = src.slice(src.indexOf('item?.type === "contextCompaction"'), src.indexOf('item?.type === "fileChange"'));
  assert.ok(compaction.includes("axBatchNudged.delete(root)"), "a compaction erased the earlier nudge, so it is said again");
  const batch = src.slice(src.indexOf('case "computer_do": {'), src.indexOf('case "computer_scroll_view": {'));
  assert.ok(batch.includes("isSingleEdit(steps)") && batch.includes("stepsForNudge(steps)"), "a one-edit batch is recorded as one edit");
  assert.ok(!src.includes("axRecentEdits = []; // the caller batched"), "the unconditional reset is gone");
  const pointer = src.slice(src.indexOf('case "computer_pointer": {'), src.indexOf('case "computer_app_screenshot": {'));
  assert.ok(pointer.includes('tool: "computer_pointer"') && pointer.includes("recordEditAndNudge("), "a single click is recorded as one edit through the shared helper");
});

test("a batch skips the settle wait on every step but the last", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  assert.ok(src.includes("runBatchStep(appName: string, st: BatchStep, settle = true)"));
  assert.ok(src.includes("settle: false"), "the flag reaches the bridge");
  assert.ok(src.includes("runBatchStep(appName, st, i === steps.length - 1)"), "only the last step settles");
  // Candidates are judged BY their diffs, so they must keep the wait.
  const runner = src.slice(src.indexOf("async function runCandidates"), src.indexOf("async function handleAxCall"));
  assert.ok(runner.includes("runBatchStep(appName, st)") && !runner.includes("settle: false"), "candidate routes still settle");
});

// Codex's densest turn on the same Figma icon ran 17 primitive actions: four
// inspector fields, each click + select-all + type + Return, then a colour
// click. A ten-step cap split that across turns at ~15s each.

test("a batch takes 30 steps, and says what to do with more", () => {
  const step = { do: "press", id: 1 };
  const at30 = parseBatchSteps(Array.from({ length: 30 }, () => step));
  assert.ok(!("error" in at30), "30 fits a shape's whole geometry");
  const at31 = parseBatchSteps(Array.from({ length: 31 }, () => step));
  assert.ok("error" in at31 && at31.error.includes("max 30"), JSON.stringify(at31));
});

test("a batch key step carries a tool shortcut and its modifiers", () => {
  // Both were unreachable in a batch before: the schema enum listed nine named
  // keys, so "p" (Figma's pen) was invalid, and modifiers were dropped without
  // a word — which made the select-all remedy for an appending field
  // inexpressible as a batch at all.
  const r = parseBatchSteps([
    { do: "key", key: "p" },
    { do: "key", key: "a", modifiers: ["command"], id: 88 },
  ]);
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.deepEqual(r.steps[0], { do: "key", key: "p", waitMs: 0 });
  assert.deepEqual(r.steps[1], { do: "key", key: "a", id: 88, modifiers: ["command"], waitMs: 0 });
});

test("an unknown modifier is refused by name rather than dropped", () => {
  const r = parseBatchSteps([{ do: "key", key: "a", modifiers: ["cmd"] }]);
  assert.ok("error" in r && r.error.includes("cmd") && r.error.includes("command"), JSON.stringify(r));
});

test("the trace names the field and value, not just the verb", () => {
  assert.equal(traceStep({ do: "set_value", id: 109, text: "180", waitMs: 0 }), 'set_value #109 = "180"');
  assert.equal(traceStep({ do: "key", key: "a", modifiers: ["command"], id: 88, waitMs: 0 }), "key command+a in #88");
  assert.equal(traceStep({ do: "act", id: 6, action: "show menu", waitMs: 0 }), 'act #6 "show menu"');
  assert.equal(traceStep({ do: "press", id: 22, waitMs: 0 }), "press #22");
  assert.equal(traceStep({ do: "read", waitMs: 0 }), "read");
});

// Measured 2026-09-08: the four-step stepper recipe (pointer, ⌘a, type, return)
// bypassed setValue's read-back, so after every batch the model read the app
// again to check the fields — 32 finds in one run, a model turn each. The
// batch now reads back every field it touched and prints them.
test("a batch names the fields it touched so they can be read back", () => {
  const steps: BatchStep[] = [
    { do: "pointer", id: 88, clicks: 2, waitMs: 0 }, { do: "key", key: "a", modifiers: ["command"], waitMs: 0 },
    { do: "type", text: "460", waitMs: 0 }, { do: "key", key: "return", waitMs: 0 },
    { do: "set_value", id: 101, text: "360", waitMs: 0 }, { do: "type", text: "x", id: 88, waitMs: 0 },
    { do: "press", id: 5, waitMs: 0 }, { do: "read", waitMs: 0 },
  ];
  assert.deepEqual(touchedFieldIds(steps), [88, 101], "pointer, set_value and type-with-id are field edits; press and read are not; ids are unique in first-seen order");
  const many = Array.from({ length: 20 }, (_, i) => ({ do: "set_value", id: i, text: "1", waitMs: 0 }) as BatchStep);
  assert.equal(touchedFieldIds(many).length, MAX_FIELDS_READ_BACK, "capped");
});

test("field values render one line per id, with what the bridge knows about it", () => {
  const values: FieldValue[] = [
    { id: 88, role: "incrementor", title: "X-position", value: "460" },
    { id: 101, role: "text field", title: "Width", value: "360" },
    { id: 7, role: null, title: null, value: null },
  ];
  assert.equal(renderFieldValues(values), 'Fields now:\n#88 incrementor "X-position" = 460\n#101 text field "Width" = 360\n#7 = (no value)');
});

test("a multi-step batch reports the fields it read back instead of a caveat about presses", () => {
  const ran = ["step 1 (set_value #88 = \"550\")", "step 2 (press #12)"];
  const out = summarizeBatch({ ran, failed: null, remaining: 0, diff: "~ 12 button", unwatched: true, fields: 'Fields now:\n#88 text field "Width" = 550' });
  assert.ok(out.includes("Only the closing diff was watched"), out);
  assert.ok(!out.includes("not watched individually") && !out.includes("Every value written was read back"), out);
  assert.ok(out.endsWith('\nFields now:\n#88 text field "Width" = 550'), out);
  // A single step DID settle and its diff is its own, so no caveat.
  const one = summarizeBatch({ ran: [ran[0]], failed: null, remaining: 0, diff: "~ 88", unwatched: true });
  assert.ok(!one.includes("closing diff"), one);
});
test("a stopped batch still reports which steps ran and which did not", () => {
  const out = summarizeBatch({
    ran: ["step 1 (set_value #88 = \"550\")"],
    failed: { step: "step 2 (set_value #109 = \"180\")", message: 'setValue did not land: asked for "180", the field now reads "120180"' },
    remaining: 3,
    diff: "~ 88 stepper",
  });
  assert.ok(out.includes("Stopped at step 2 (set_value #109"), out);
  assert.ok(out.includes("120180"), out);
  assert.ok(out.includes("The remaining 3 step(s) did NOT run."), out);
});

// Setting a value in a web app's inspector takes four primitives — click the
// field, select all, type, commit — and until `type` and `pointer` were batch
// verbs it could not be written as one call. Measured on Figma: set_value
// lands on a "text field" and is silently ignored on a "stepper".

test("the four-step field recipe parses as a single batch", () => {
  const r = parseBatchSteps([
    { do: "pointer", id: 83 },
    { do: "key", key: "a", modifiers: ["command"] },
    { do: "type", text: "-19.6875" },
    { do: "key", key: "return" },
  ]);
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.deepEqual(r.steps[0], { do: "pointer", id: 83, waitMs: 0 });
  assert.deepEqual(r.steps[2], { do: "type", text: "-19.6875", waitMs: 0 });
});

test("a pointer step needs an element, and takes a double click", () => {
  assert.ok("error" in parseBatchSteps([{ do: "pointer" }]), "no id, no target");
  const two = parseBatchSteps([{ do: "pointer", id: 5, clicks: 2 }]);
  assert.ok(!("error" in two), JSON.stringify(two));
  const step = (two as { steps: BatchStep[] }).steps[0];
  assert.ok(step.do === "pointer" && step.clicks === 2, JSON.stringify(step));
  const silly = parseBatchSteps([{ do: "pointer", id: 5, clicks: 99 }]);
  assert.ok("error" in silly && silly.error.includes("double click"), JSON.stringify(silly));
});

test("a type step needs text, and refuses a document", () => {
  assert.ok("error" in parseBatchSteps([{ do: "type" }]));
  const long = parseBatchSteps([{ do: "type", text: "x".repeat(MAX_TYPE_LENGTH + 1) }]);
  assert.ok("error" in long && long.error.includes("not a document"), JSON.stringify(long));
});

test("four fields plus a colour fit one call, which is the point", () => {
  // Codex's densest turn on the same icon: 4 fields x (click, select all,
  // type, commit) + 1 colour click = 17 primitives. That has to fit.
  const steps = [];
  for (const [id, val] of [[83, "460"], [84, "-19.6875"], [101, "360"], [104, "360"]]) {
    steps.push({ do: "pointer", id }, { do: "key", key: "a", modifiers: ["command"] },
               { do: "type", text: val }, { do: "key", key: "return" });
  }
  steps.push({ do: "press", id: 126 });
  assert.equal(steps.length, 17);
  const r = parseBatchSteps(steps);
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.ok(steps.length <= MAX_BATCH_STEPS, `${steps.length} steps must fit the cap of ${MAX_BATCH_STEPS}`);
});

test("the trace names the typed string and the click", () => {
  assert.equal(traceStep({ do: "type", text: "460", id: 83, waitMs: 0 }), 'type "460" in #83');
  assert.equal(traceStep({ do: "pointer", id: 83, clicks: 2, waitMs: 0 }), "click x2 #83");
  assert.equal(traceStep({ do: "pointer", id: 83, waitMs: 0 }), "click #83");
});

test("computer_do tells the model which field kind takes which route", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const start = src.indexOf('name: "computer_do"');
  const decl = src.slice(start, start + 6000);
  assert.ok(decl.includes("text field") && decl.includes("stepper"), "name both kinds");
  assert.ok(decl.includes("100100"), "and what going wrong looks like");
  // The description is a TS string literal, so its quotes are escaped in source.
  assert.ok(decl.includes(String.raw`{\"do\":\"type\",\"text\":\"460\"}`), "hand over the literal recipe");
  assert.ok(decl.includes("clicks:2"), "and the double-click fallback");
});

// Second Figma run, 2026-09-08: 90 turns, of which 34 were finds for the id of an
// inspector field so the next click could be aimed, 12 were screenshots that
// each cost a turn, and one re-read the skill through the shell after the
// compaction had summarized it away. Three mechanisms, one per waste.

test("a screenshot can ride inside a batch, so a look does not cost a turn", () => {
  assert.ok((BATCH_VERBS as readonly string[]).includes("screenshot"));
  const r = parseBatchSteps([{ do: "press", id: 4 }, { do: "screenshot" }, { do: "screenshot", window: 2 }]);
  assert.ok(!("error" in r), JSON.stringify(r));
  const steps = (r as { steps: BatchStep[] }).steps;
  assert.deepEqual(steps[1], { do: "screenshot", waitMs: 0 });
  assert.deepEqual(steps[2], { do: "screenshot", window: 2, waitMs: 0 });
  assert.equal(traceStep(steps[1]), "screenshot");
  assert.ok(describeBatch("Figma", steps).includes("photograph"), describeBatch("Figma", steps));
  assert.deepEqual(touchedFieldIds(steps), [], "a picture touches no field");
});

// Run 3, 2026-09-08: 49 inspector blocks, ~60KB, about a fifth of all tool
// output, and it bought a second compaction. Most of each block repeats the
// block before it — X and Y change, the other thirty lines do not.
test("an inspector that follows another sends only what changed", () => {
  const before: InspectorField[] = [
    { id: 155, role: "incrementor", title: "X-position", value: "0" },
    { id: 156, role: "incrementor", title: "Y-position", value: "0" },
    { id: 183, role: "text field", title: "Width", value: "1024" },
  ];
  const after: InspectorField[] = [
    { id: 155, role: "incrementor", title: "X-position", value: "256" },
    { id: 156, role: "incrementor", title: "Y-position", value: "0" },
    { id: 183, role: "text field", title: "Width", value: "1024" },
    { id: 190, role: "check box", title: "Clip content", value: "1" },
  ];
  assert.equal(renderInspector(after, false, before),
    'Inspector changes:\n#155 incrementor "X-position" = 256\n+#190 check box "Clip content" = 1\n(2 unchanged)');
  // Nothing moved at all: one line, not thirty.
  assert.equal(renderInspector(before, false, before), "Inspector unchanged (3 fields, same values).");
  // A field that disappeared is named, because its id is now dead.
  assert.equal(renderInspector([before[0]], false, before),
    'Inspector changes:\n(gone: #156, #183)\n(1 unchanged)');
  // No previous block: the whole thing, as before.
  const whole = renderInspector(after, false);
  assert.ok(whole !== null && whole.startsWith("Inspector now:"), whole ?? "");
});

test("the inspector block lists settable controls with ids, in tree order, capped", () => {
  const out = renderInspector([
    { id: 563, role: "text field", title: "Width", value: "510" },
    { id: 545, role: "incrementor", title: "X-position", value: "257" },
    { id: 9, role: "checkbox", title: "Clip content", value: "1" },
  ], false);
  assert.equal(out, 'Inspector now:\n#563 text field "Width" = 510\n#545 incrementor "X-position" = 257\n#9 checkbox "Clip content" = 1');
  assert.equal(renderInspector([], false), null, "nothing settable: no block");
  const cut = renderInspector([{ id: 1, role: "text field", title: "A", value: "" }], true);
  assert.ok(cut !== null && cut.endsWith(`(… more than ${MAX_INSPECTOR_FIELDS}; use query for the rest)`), cut ?? "");
});

test("the three mechanisms are wired: inspector after selection-changing actions and batches, pictures inside batches, the skill re-sent after compaction", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const compaction = src.slice(src.indexOf('item?.type === "contextCompaction"'), src.indexOf('item?.type === "fileChange"'));
  assert.ok(compaction.includes("axSkillSent.delete(root)"), "a summary eats the skill; the next desktop call must carry it again");
  const batch = src.slice(src.indexOf('case "computer_do": {'), src.indexOf('case "computer_scroll_view": {'));
  assert.ok(batch.includes('case "screenshot"') || src.slice(src.indexOf("async function runBatchStep")).includes('case "screenshot"'), "a screenshot step reaches the bridge");
  assert.ok(batch.includes('type: "inputImage"'), "the batch result carries the pictures it took");
  assert.ok(batch.includes("inspectorBlock("), "a batch ends with the inspector");
  const pointer = src.slice(src.indexOf('case "computer_pointer": {'), src.indexOf('case "computer_app_screenshot": {'));
  assert.ok(pointer.includes("inspectorBlock("), "a click changes the selection; the inspector follows");
  const press = src.slice(src.indexOf('case "computer_press":'), src.indexOf('default:\n        return axText(`Unknown tool ${tool}`'));
  assert.ok(press.includes("inspectorBlock("), "a press changes the selection; the inspector follows");
});

// The mechanisms are app-neutral — there is no per-app branching anywhere in
// the desktop path — but the PROSE had drifted: one third-party app was named
// nine times across the tool descriptions and the bundled skill, which is
// tuning the model toward one app in the layer this codebase has repeatedly
// measured to be the weakest. Evidence belongs in comments, where naming the
// app makes it checkable; guidance should describe the shape of the problem.
test("model-facing text describes shapes of apps, not one app by name", () => {
  const src = readFileSync(join(__dirname, "index.ts"), "utf8");
  const decls = src.slice(src.indexOf("const AX_TOOLS = ["), src.indexOf("// Declared and routed must be the same set"));
  const strings = decls.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const app of ["Figma", "Sketch", "Photoshop", "Illustrator"]) {
    assert.ok(!strings.includes(app), `tool descriptions name ${app}; say what KIND of app it is instead`);
  }
  const skill = readFileSync(join(__dirname, "..", "..", "resources", "skills", "computer-use", "SKILL.md"), "utf8");
  const named = (skill.match(/Figma/g) ?? []).length;
  assert.ok(named === 0, `the skill names Figma ${named} time(s); describe the kind of app instead`);
});

// Measured 2026-09-08: return, delete, return, delete in one unwatched batch;
// the second delete removed the frame the task lived in, the closing diff said
// "- removed: 859-880", and the model wrote "the frame is clean now".
test("a step the bridge watched on its own is reported with its own diff, before the closing diff", () => {
  const out = summarizeBatch({
    ran: ["step 1 (key return)", "step 2 (key delete)", "step 3 (key return)", "step 4 (key delete)"],
    failed: null, remaining: 0, diff: "- removed: 859-880", unwatched: true,
    watched: [
      { step: "step 2 (key delete)", diff: "(no changes)" },
      { step: "step 4 (key delete)", diff: '- removed: 859-880, among them: application group "Unbiased, Design frame"; term "Dimensions" and 20 more' },
    ],
  });
  assert.match(out, /Watched on its own, because a delete outside a text field removes objects — step 4 \(key delete\) did this:\n- removed: 859-880, among them: application group "Unbiased, Design frame"/);
  assert.equal((out.match(/Watched on its own/g) ?? []).length, 1, "a watched step that changed nothing is not reported");
  assert.ok(out.indexOf("Watched on its own") < out.indexOf("\n- removed: 859-880\n") || out.trim().endsWith("- removed: 859-880"), "the step's diff comes before the closing diff");
});

// Measured 2026-09-09: the bridge stopped a 106-point pen trace at click 63,
// in front of a toolbar that had appeared over the surface, and said so in
// its `note`. The app printed "Clicked 106 point(s)" and dropped the note. The
// model, seeing 47 anchors on screen after the next pass, concluded the bridge
// "executes only the first 47 anchors per call" and spent the rest of the run
// deleting and redrawing. The count must be what landed, and the note must ride.
test("a pointer result counts what landed, not what was asked, and carries the bridge's note", () => {
  assert.equal(pointerHeadline({ app: "Figma", hold: false, asked: 106, landed: 63, note: null }), "Clicked 63 of 106 point(s) in Figma.");
  assert.equal(pointerHeadline({ app: "Figma", hold: false, asked: 5, landed: 5, note: null }), "Clicked 5 point(s) in Figma.");
  assert.equal(pointerHeadline({ app: "Figma", hold: true, asked: 90, landed: 90, note: null }), "Dragged 90 point(s) in Figma.");
  assert.equal(pointerHeadline({ app: "Figma", hold: false, asked: null, landed: 1, note: null }), "Clicked the centre in Figma.");
  const withNote = pointerHeadline({ app: "Figma", hold: false, asked: 106, landed: 63, note: "Clicked 63 of 106 points, then stopped: point 64 lands on toggle button \"Cut\"." });
  assert.ok(withNote.startsWith("Clicked 63 of 106 point(s) in Figma.\n"), withNote);
  assert.ok(withNote.includes("then stopped: point 64"), "the bridge's own words come through: " + withNote);
});

// Measured 2026-09-09: five runs, every first pass lost to a toolbar that
// appears once drawing begins; the rule was in the skill and the tool
// description and the model still drew first. The refusal is what it acted on.
test("the first long click path in a conversation is held once, with the clear-the-surface rule, and only that one", () => {
  const first = drawGate({ points: 92, hold: false, used: false });
  assert.ok(first && /Held once/.test(first) && /92 points/.test(first), String(first));
  assert.ok(/hide the app's panels and toolbars or go full screen/.test(String(first)) && /fit the target to the view/.test(String(first)));
  assert.ok(/Nothing was clicked/.test(String(first)) && /send the same path again/.test(String(first)), "says the action did not run and how to proceed");
  assert.equal(drawGate({ points: 92, hold: false, used: true }), null, "the second long path goes through");
  assert.equal(drawGate({ points: DRAW_GATE_POINTS - 1, hold: false, used: false }), null, "a short path is a few clicks, not a drawing");
  assert.equal(drawGate({ points: 92, hold: true, used: false }), null, "a drag is one gesture and is never held");
});

// Measured 2026-09-10: given only the advice, the model looked the commands
// up, ran them, read the tree, took a screenshot and re-chose its tool before
// resending — 80 seconds between the hold and the redraw. With the commands
// in the hold it is two calls.
test("when the app's menu has the commands, the hold names them in order and says the same path stays valid", () => {
  const items = [
    "App > Hide App  ⌘H", "App > Hide Others  ⌥⌘H",
    "Object > Show/Hide Selection  ⇧⌘H  (disabled)",
    "View > Zoom In  ⌘+", "View > Zoom to Fit  ⇧1", "View > Zoom to Selection  ⇧2",
    "View > Toggle Full Screen  F", "View > Show/Hide UI  ⌘\\",
  ];
  const picked = surfaceCommands(items);
  assert.deepEqual(picked, ["View > Show/Hide UI  ⌘\\", "View > Toggle Full Screen  F", "View > Zoom to Selection  ⇧2"]);
  const held = String(drawGate({ points: 83, hold: false, used: false, commands: picked }));
  assert.ok(/1\. View > Show\/Hide UI/.test(held) && /3\. View > Zoom to Selection/.test(held), held);
  assert.ok(/SAME path again, unchanged/.test(held) && /No read or screenshot is needed/.test(held), held);
  assert.ok(!/query "hide"/.test(held), "no lookup is asked for when the answer is in hand");
  assert.equal(surfaceCommands(["App > Hide App  ⌘H", "Object > Show/Hide Selection  ⇧⌘H  (disabled)"]).length, 0, "hiding the app or a greyed item is not clearing the surface");
  // Measured on a live menu: the preference toggles list first and matched.
  const withPrefs = ["App > Preferences > Hide Canvas UI During Changes", "App > Preferences > Keyboard Zooms into Selection", ...items];
  assert.deepEqual(surfaceCommands(withPrefs), picked, "a preference is a setting, never picked");
  assert.deepEqual(surfaceCommands(["View > Zoom to Fit  ⇧1"]), ["View > Zoom to Fit  ⇧1"], "fitting everything is the fallback when nothing fits the selection");
  const plain = String(drawGate({ points: 83, hold: false, used: false, commands: [] }));
  assert.ok(/query "hide"/.test(plain), "without commands the hold says how to find them");
});

test("the skill rides after the tool's own result, so a list is not missed under it", () => {
  const out = appendSkill({ contentItems: [{ type: "inputText", text: "the apps" }], success: true }, "=== skill ===");
  assert.equal(out.contentItems.length, 2);
  assert.equal((out.contentItems[0] as { text: string }).text, "the apps");
  assert.equal((out.contentItems[1] as { text: string }).text, "=== skill ===");
});
