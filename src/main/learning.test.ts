import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEARNING_SUMMARY_MAX,
  EventQueue,
  buildTaskMeta,
  readSidecarManifest,
  redactForLearning,
  resolveSidecarDir,
} from "./learning";

const scratch = () => mkdtempSync(join(tmpdir(), "sidecar-"));

// ── The manifest: the sidecar declares how it runs, we only resolve where ──

function writeManifest(dir: string, manifest: unknown): string {
  const out = join(dir, "sidecar");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "sidecar.json"), JSON.stringify(manifest));
  writeFileSync(join(out, "learning-sidecar.mjs"), "// stub\n");
  return out;
}

test("a valid manifest resolves to an absolute entry and its protocol version", () => {
  const dir = writeManifest(scratch(), {
    name: "learning-algorithm",
    version: "0.1.0",
    protocolVersion: 1,
    runtime: "node",
    entry: "learning-sidecar.mjs",
    args: [],
    minNodeVersion: "22.5.0",
  });
  const m = readSidecarManifest(dir);
  assert.ok(m && !("error" in m), JSON.stringify(m));
  assert.equal(m.protocolVersion, 1);
  assert.equal(m.entryPath, join(dir, "learning-sidecar.mjs"));
  assert.deepEqual(m.args, []);
});

test("a missing sidecar is not an error — the feature is simply absent", () => {
  assert.equal(readSidecarManifest(join(scratch(), "nothing-here")), null);
});

for (const [label, manifest] of [
  ["an unknown runtime", { protocolVersion: 1, runtime: "wasm", entry: "x.mjs" }],
  ["a missing entry", { protocolVersion: 1, runtime: "node" }],
  ["a non-numeric protocolVersion", { protocolVersion: "1", runtime: "node", entry: "x.mjs" }],
  ["an entry escaping the bundle", { protocolVersion: 1, runtime: "node", entry: "../../etc/passwd" }],
] as const) {
  test(`${label} is refused, with a reason`, () => {
    const dir = writeManifest(scratch(), manifest);
    const m = readSidecarManifest(dir);
    assert.ok(m && "error" in m, `expected a refusal for ${label}`);
  });
}

test("a manifest whose protocol version we do not speak is refused, not guessed at", () => {
  const dir = writeManifest(scratch(), { protocolVersion: 99, runtime: "node", entry: "learning-sidecar.mjs" });
  const m = readSidecarManifest(dir);
  assert.ok(m && "error" in m);
  assert.match(m.error, /protocol/i);
});

// ── Redaction: the sidecar refuses an event that still carries a secret ────

test("redactForLearning strips the token shapes the sidecar refuses, and bounds length", () => {
  for (const secret of [
    "Bearer abcdefghijklmnopqrst",
    "sk-abcdefghijklmnopqrstuvwx",
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
    "xoxb-1234567890-abcdefghij",
    "AKIAIOSFODNN7EXAMPLE",
  ]) {
    const out = redactForLearning(`run with ${secret} please`);
    assert.ok(!out.includes(secret), `survived: ${out}`);
  }
  assert.equal(redactForLearning("API_KEY=supersecretvalue").includes("supersecretvalue"), false);
  assert.ok(redactForLearning("x".repeat(5000)).length <= LEARNING_SUMMARY_MAX);
  assert.equal(redactForLearning("  plain   text  "), "plain text");
});

// ── task_meta carries the scope, resolved the way memory resolves it ───────

test("task_meta carries the project key, not the cwd, so a worktree is not its own project", () => {
  const e = buildTaskMeta({
    threadId: "thr_1",
    cwd: "/work/app/.worktrees/wt-1",
    projectKey: "/work/app",
    model: "pareto",
  });
  assert.equal(e.kind, "task_meta");
  assert.equal(e.taskId, "thr_1");
  assert.equal(e.data.cwd, "/work/app/.worktrees/wt-1");
  assert.equal(e.data.projectKey, "/work/app");
  assert.equal(e.source, "app");
  assert.ok(e.id && e.at && typeof e.seq === "number");
});

// ── The queue: learning must never stall the UI ────────────────────────────

test("the queue batches, flushes on demand, and drops the oldest when full", async () => {
  const sent: unknown[][] = [];
  const q = new EventQueue({ capacity: 3, send: async (batch) => void sent.push(batch) });
  q.push({ id: "1" } as never);
  q.push({ id: "2" } as never);
  q.push({ id: "3" } as never);
  q.push({ id: "4" } as never); // over capacity: the OLDEST goes
  await q.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0] as { id: string }[]).map((e) => e.id), ["2", "3", "4"]);
  assert.equal(q.dropped, 1);
});

test("a failing send never throws into the caller and never wedges the queue", async () => {
  let calls = 0;
  const q = new EventQueue({
    capacity: 10,
    send: async () => {
      calls++;
      throw new Error("sidecar died");
    },
  });
  q.push({ id: "1" } as never);
  await q.flush(); // must not reject
  assert.equal(calls, 1);
  q.push({ id: "2" } as never);
  await q.flush();
  assert.equal(calls, 2, "the queue keeps working after a failed flush");
});

test("flushing an empty queue sends nothing", async () => {
  let calls = 0;
  const q = new EventQueue({ capacity: 5, send: async () => void calls++ });
  await q.flush();
  assert.equal(calls, 0);
});

test("the dev fallback finds a sibling checkout from a worktree, not just a plain clone", () => {
  // A single `..` from appPath is correct only in a plain checkout; from
  // .claude/worktrees/<name> it lands in worktrees/. That is why running the
  // engine from a worktree needs an env override every time, and it is a trap
  // worth not copying.
  const root = scratch();
  const bundle = join(root, "learning-algorithm", "dist", "sidecar");
  mkdirSync(bundle, { recursive: true });
  const deep = join(root, "unbiased-app", ".claude", "worktrees", "wt-1");
  mkdirSync(deep, { recursive: true });
  assert.equal(
    resolveSidecarDir({ isPackaged: false, resourcesPath: "/unused", appPath: deep }),
    bundle,
  );
});
