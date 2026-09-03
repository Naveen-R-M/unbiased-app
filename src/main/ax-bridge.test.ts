import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxClient, AxError, describeAxAction, elementLine, readAxManifest, resolveAxDir } from "./ax-bridge";

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
  const text = describeAxAction("computer_act", { app: "Brave", id: 643, action: "press" }, TREE);
  assert.ok(text.startsWith('press #643 in Brave — link "Tame Impala - Loser (Official Video)'), text);
  assert.ok(text.endsWith("…") && text.length < 100, `clipped for a one-line card: ${text}`);
  assert.equal(elementLine(TREE, 13), 'text field "Address and search bar" = youtube.com {press}', "a ~ diff line is still a line");
  assert.equal(elementLine(TREE, 999), null);
});

test("set and key read as what they are", () => {
  assert.equal(describeAxAction("computer_act", { app: "Brave", id: 13, value: "https://youtube.com" }, TREE),
    'Set #13 in Brave — text field "Address and search bar" = youtube.com {press} to "https://youtube.com"');
  assert.equal(describeAxAction("computer_act", { app: "Brave", key: "return" }), "Press return in Brave");
  assert.equal(describeAxAction("computer_app_state", { app: "Brave" }), "Read the UI of Brave");
  assert.equal(describeAxAction("computer_raise", { app: "Brave" }), "Bring Brave to the front");
});
