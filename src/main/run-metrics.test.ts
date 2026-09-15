import { test } from "node:test";
import assert from "node:assert/strict";
import {
  METRICS_VERSION,
  MetricsLog,
  classifyFailure,
  metricsEnabled,
  payloadOf,
  percentile,
  rollup,
  taskShape,
  type DriverRecord,
  type MetricRecord,
  type ToolRecord,
  type TurnRecord,
} from "./run-metrics";

const base = { v: METRICS_VERSION, at: "2026-09-15T12:00:00.000Z", thread: "t1" };

function tool(over: Partial<ToolRecord> = {}): ToolRecord {
  return {
    ...base,
    kind: "tool",
    turn: "u1",
    tool: "computer_press",
    app: "Figma",
    verb: "press",
    size: 0,
    unit: "none",
    ms: 100,
    ok: true,
    noChange: false,
    failure: null,
    ...over,
  };
}

function driver(over: Partial<DriverRecord> = {}): DriverRecord {
  return { ...base, kind: "driver", method: "act", app: "Figma", ms: 50, waitedMs: 20, bytes: 400, lines: 8, route: null, failure: null, ...over };
}

function turn(over: Partial<TurnRecord> = {}): TurnRecord {
  return { ...base, kind: "turn", turn: "u1", input: 1000, cached: 800, output: 100, total: 1100, ...over };
}

test("the switch is its own, not the debug log's", () => {
  assert.equal(metricsEnabled({ UNBIASED_AX_METRICS: "1" }), true);
  assert.equal(metricsEnabled({ UNBIASED_AX_DEBUG: "1" }), false);
  assert.equal(metricsEnabled({}), false);
});

test("a payload is a shape, never the screen's text", () => {
  const typed = payloadOf("computer_type", { text: "hunter2", app: "1Password" });
  assert.deepEqual(typed, { verb: "type", size: 7, unit: "chars" });
  assert.ok(!JSON.stringify(typed).includes("hunter2"));

  const set = payloadOf("computer_set_value", { id: 4, value: "naveen@circuitandchisel.com" });
  assert.equal(set.size, 27);
  assert.ok(!JSON.stringify(set).includes("naveen"));
});

test("a pen path is counted in points, and a drag is told from a click", () => {
  const path = Array.from({ length: 105 }, (_, i) => [i / 105, 0.5]);
  assert.deepEqual(payloadOf("computer_pointer", { path, hold: true }), { verb: "pointer:drag", size: 105, unit: "points" });
  assert.deepEqual(payloadOf("computer_pointer", { path: [[0.5, 0.5]] }), { verb: "pointer", size: 1, unit: "points" });
});

test("a batch is counted in steps", () => {
  assert.deepEqual(payloadOf("computer_do", { steps: [{ do: "press" }, { do: "key" }] }), { verb: "do", size: 2, unit: "steps" });
});

test("a call with nothing to measure still names its verb", () => {
  assert.deepEqual(payloadOf("computer_app_state", { app: "Figma" }), { verb: "app_state", size: 0, unit: "none" });
});

test("malformed arguments do not throw", () => {
  assert.equal(payloadOf("computer_pointer", null).size, 0);
  assert.equal(payloadOf("computer_do", { steps: "nope" }).size, 0);
  assert.equal(payloadOf("computer_type", { text: 7 }).size, 0);
});

test("a named element that has gone is the stale failure we are counting", () => {
  assert.equal(classifyFailure("no_such_element"), "stale");
  assert.equal(classifyFailure("no_such_window"), "stale");
  assert.equal(classifyFailure("no_such_app"), "gone");
  assert.equal(classifyFailure("timeout"), "timeout");
  assert.equal(classifyFailure("not_trusted"), "refused");
  assert.equal(classifyFailure("bridge_exited"), "crashed");
  assert.equal(classifyFailure("bad_params"), "bad_call");
  assert.equal(classifyFailure("action_failed"), "other");
  assert.equal(classifyFailure(null), null);
  assert.equal(classifyFailure("something_new"), "other");
});

test("a failure with only prose is still a failure", () => {
  assert.equal(classifyFailure(null, "tool crashed: boom"), "other");
});

test("the log writes NDJSON and counts what it wrote", () => {
  const lines: string[] = [];
  const log = new MetricsLog((l) => lines.push(l));
  log.record(tool());
  log.record(driver());
  assert.equal(lines.length, 2);
  assert.equal(log.written, 2);
  assert.deepEqual(JSON.parse(lines[0]!).kind, "tool");
  assert.ok(!lines[0]!.includes("\n"));
});

test("a log with no sink is off, and a sink that throws never reaches the turn", () => {
  const off = new MetricsLog(null);
  off.record(tool());
  assert.equal(off.enabled, false);
  assert.equal(off.written, 0);

  const angry = new MetricsLog(() => {
    throw new Error("disk full");
  });
  assert.doesNotThrow(() => angry.record(tool()));
  assert.equal(angry.written, 0);
});

test("a long path makes the run a drawing", () => {
  assert.equal(taskShape([{ verb: "pointer:drag", size: 105 }, { verb: "press", size: 0 }]), "draw");
  assert.equal(taskShape([{ verb: "pointer", size: 3 }, { verb: "press", size: 0 }]), "navigate");
});

test("a run that only read is a read, not a navigation", () => {
  assert.equal(taskShape([{ verb: "app_state", size: 0 }, { verb: "screenshot", size: 0 }]), "read");
  assert.equal(taskShape([]), "none");
});

test("typing and pressing together is mixed, and neither alone is", () => {
  assert.equal(taskShape([{ verb: "type", size: 12 }, { verb: "app_state", size: 0 }]), "edit");
  assert.equal(taskShape([{ verb: "type", size: 12 }, { verb: "press", size: 0 }]), "mixed");
});

test("a percentile names a number some call actually took", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 95), 0);
});

test("billed tokens sum every turn; context is only the last one", () => {
  // Three turns over a growing context. The run cost 6600 input tokens even
  // though the conversation never held more than 3000 — that re-send is the
  // quantity code mode claims to remove, so the two must not be conflated.
  const r = rollup([
    turn({ input: 1000, cached: 0, output: 100, total: 1100 }),
    turn({ input: 2000, cached: 900, output: 200, total: 2200 }),
    turn({ input: 3000, cached: 1800, output: 300, total: 3300 }),
  ]);
  assert.equal(r.tokens.billed.input, 6000);
  assert.equal(r.tokens.billed.output, 600);
  assert.equal(r.tokens.billed.cached, 2700);
  assert.equal(r.tokens.context, 3000);
  assert.equal(r.turns, 3);
});

test("the rollup separates tool time from driver time", () => {
  const r = rollup([
    tool({ ms: 200 }),
    driver({ ms: 50 }),
    driver({ ms: 90 }),
    tool({ ms: 27_000, verb: "pointer:drag", size: 105, unit: "points" }),
  ]);
  assert.equal(r.toolCalls, 2);
  assert.equal(r.driverCalls, 2);
  assert.equal(r.toolMs.total, 27_200);
  assert.equal(r.toolMs.max, 27_000);
  assert.equal(r.driverMs.total, 140);
  // The number a per-binding timeout has to clear.
  assert.equal(r.largest.points, 105);
  assert.equal(r.shape, "draw");
});

test("failures are counted by class across both layers", () => {
  const r = rollup([
    tool({ ok: false, failure: "stale" }),
    driver({ failure: "stale" }),
    driver({ failure: "timeout" }),
    tool({ noChange: true }),
  ]);
  assert.deepEqual(r.failures.tool, { stale: 1 });
  assert.deepEqual(r.failures.driver, { stale: 1, timeout: 1 });
  assert.equal(r.noChange, 1);
});

test("an empty run rolls up to zeroes rather than throwing", () => {
  const r = rollup([] as MetricRecord[]);
  assert.equal(r.shape, "none");
  assert.equal(r.tokens.billed.total, 0);
  assert.equal(r.tokens.context, 0);
  assert.equal(r.toolMs.p95, 0);
  assert.deepEqual(r.failures, { tool: {}, driver: {} });
});
