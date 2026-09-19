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
  type RunRecord,
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
    parts: {},
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

function run(phase: "started" | "completed", at: string, id = "u1"): RunRecord {
  return { ...base, at, kind: "run", turn: id, phase, status: phase === "completed" ? "completed" : null };
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
  assert.deepEqual(typed, { verb: "type", size: 7, unit: "chars", parts: { chars: 7 } });
  assert.ok(!JSON.stringify(typed).includes("hunter2"));

  const set = payloadOf("computer_set_value", { id: 4, value: "someone@example.invalid" });
  assert.equal(set.size, 23);
  assert.ok(!JSON.stringify(set).includes("someone"));
});

test("a pen path is counted in points, and a drag is told from a click", () => {
  const path = Array.from({ length: 105 }, (_, i) => [i / 105, 0.5]);
  assert.deepEqual(payloadOf("computer_pointer", { path, hold: true }), { verb: "pointer:drag", size: 105, unit: "points", parts: { points: 105 } });
  assert.deepEqual(payloadOf("computer_pointer", { path: [[0.5, 0.5]] }), { verb: "pointer", size: 1, unit: "points", parts: { points: 1 } });
});

test("a batch is counted in steps", () => {
  assert.deepEqual(payloadOf("computer_do", { steps: [{ do: "press" }, { do: "key" }] }), {
    verb: "do",
    size: 2,
    unit: "steps",
    parts: { steps: 2, keys: 1 },
  });
});

test("a batch says what is inside it, not just how many steps", () => {
  // The four-step recipe for setting a field in a web app's inspector: click,
  // select all, type, commit. Counted as steps alone this is "4" and the text
  // is invisible — which is how a whole run of field edits measured as zero
  // characters typed while plainly typing all afternoon.
  const p = payloadOf("computer_do", {
    app: "Figma",
    steps: [
      { do: "pointer", id: 71 },
      { do: "key", key: "a", modifiers: ["command"] },
      { do: "type", text: "D97757" },
      { do: "key", key: "return" },
    ],
  });
  assert.equal(p.verb, "do");
  assert.equal(p.size, 4, "the headline is still what the call IS");
  assert.deepEqual(p.parts, { steps: 4, clicks: 1, keys: 2, chars: 6 });
  assert.ok(!JSON.stringify(p).includes("D97757"), "the value typed never reaches the record");
});

test("a double click inside a batch counts both clicks", () => {
  const p = payloadOf("computer_do", { steps: [{ do: "pointer", id: 3, clicks: 2 }] });
  assert.equal(p.parts.clicks, 2);
});

test("a batch of nonsense steps is measured as best it can be, never thrown on", () => {
  const p = payloadOf("computer_do", { steps: [null, 7, { do: "type" }, { do: "type", text: "ok" }] });
  assert.equal(p.size, 4);
  assert.deepEqual(p.parts, { steps: 4, chars: 2 });
});

test("a call with nothing to measure still names its verb", () => {
  assert.deepEqual(payloadOf("computer_app_state", { app: "Figma" }), { verb: "app_state", size: 0, unit: "none", parts: {} });
});

test("malformed arguments do not throw", () => {
  assert.equal(payloadOf("computer_pointer", null).size, 0);
  assert.equal(payloadOf("computer_do", { steps: "nope" }).size, 0);
  assert.equal(payloadOf("computer_type", { text: 7 }).size, 0);
});

test("a named element that has gone is the stale failure we are counting", () => {
  assert.equal(classifyFailure("no_such_element"), "stale");
  assert.equal(classifyFailure("no_such_window"), "stale");
  assert.equal(classifyFailure("element_gone"), "stale");
  // Ambiguity is its own kind: "read again" repairs a stale id and does
  // nothing for this one, so a metric that merges them hides the difference
  // between a UI that moved and a caller that has not said what it meant.
  assert.equal(classifyFailure("ambiguous_element"), "ambiguous");
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
    tool({ ms: 27_000, verb: "pointer:drag", size: 105, unit: "points", parts: { points: 105 } }),
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

test("a record written before batches were measured still rolls up", () => {
  // 381 of these are already on disk. Dropping them because they predate the
  // field would throw away the only baseline we have.
  const old = tool({ verb: "pointer:drag", size: 105, unit: "points" });
  delete (old as { parts?: unknown }).parts;
  const r = rollup([old]);
  assert.equal(r.largest.points, 105, "size and unit still answer when parts is absent");
  assert.equal(r.shape, "draw");
});

test("wall time comes from the engine's turn boundaries", () => {
  const r = rollup([
    run("started", "2026-09-15T12:00:00.000Z"),
    tool({ ms: 500 }),
    run("completed", "2026-09-15T12:06:55.000Z"),
  ]);
  assert.deepEqual(r.wall, { ms: 415_000, runs: 1, unfinished: 0 });
});

test("a late record on the same thread no longer stretches the run", () => {
  // The defect this replaced: wall was first-record-to-last-record, so a
  // drawing run measured 910s just after it finished and 3113s an hour later,
  // when one stray token-usage record landed on the same thread. The boundary
  // records are indifferent to anything that arrives after them.
  const boundaries = [run("started", "2026-09-15T12:00:00.000Z"), run("completed", "2026-09-15T12:06:55.000Z")];
  const prompt = rollup(boundaries);
  const anHourLater = rollup([...boundaries, turn({ at: "2026-09-15T13:00:00.000Z" })]);
  assert.deepEqual(anHourLater.wall, prompt.wall);
});

test("two runs on one thread add up, and are counted", () => {
  const r = rollup([
    run("started", "2026-09-15T12:00:00.000Z", "u1"),
    run("completed", "2026-09-15T12:01:00.000Z", "u1"),
    run("started", "2026-09-15T12:05:00.000Z", "u2"),
    run("completed", "2026-09-15T12:07:30.000Z", "u2"),
  ]);
  assert.deepEqual(r.wall, { ms: 210_000, runs: 2, unfinished: 0 });
});

test("a run that never finished is counted, not guessed at", () => {
  const r = rollup([
    run("started", "2026-09-15T12:00:00.000Z", "u1"),
    run("completed", "2026-09-15T12:01:00.000Z", "u1"),
    run("started", "2026-09-15T12:05:00.000Z", "u2"),
  ]);
  assert.deepEqual(r.wall, { ms: 60_000, runs: 1, unfinished: 1 });
});

test("a completion with no start is ignored rather than invented", () => {
  // The app was restarted mid-turn: the start record is in the previous
  // process's run and there is nothing here to measure from.
  const r = rollup([run("completed", "2026-09-15T12:01:00.000Z", "orphan")]);
  assert.deepEqual(r.wall, { ms: 0, runs: 0, unfinished: 0 });
});

test("records with no boundaries say so instead of reporting zero", () => {
  // 654 of these predate the boundary records. Null tells a reader to fall
  // back to the span and say that it is doing so; 0 would read as instant.
  assert.equal(rollup([tool({ ms: 500 }), turn()]).wall, null);
});

test("a retry that re-emits the same usage is not a second turn", () => {
  // Measured on a run killed by upstream 429s: eight usage reports, two
  // distinct. Counted naively that is 8 turns and 170,860 billed tokens; two
  // requests were actually sent, for 40,522.
  const one = turn({ input: 18_799, cached: 0, output: 35, total: 18_834 });
  const two = turn({ input: 21_723, cached: 0, output: 17, total: 21_740 });
  const r = rollup([one, two, { ...two }, { ...two }, { ...two }, { ...two }, { ...two }, { ...two }]);
  assert.equal(r.turns, 2);
  assert.equal(r.retries, 6);
  assert.equal(r.tokens.billed.input, 40_522);
  assert.equal(r.tokens.context, 21_723, "the context is the last real request, not a repeat of it");
});

test("the repeat flag is believed over the guess when it is present", () => {
  // A genuine second request that happens to cost exactly the same is a turn,
  // not a retry — the writer knows which, and says so.
  const a = turn({ input: 1000, output: 10, total: 1010 });
  const b = turn({ input: 1000, output: 10, total: 1010, repeat: false });
  assert.equal(rollup([a, b]).turns, 2);
  assert.equal(rollup([a, b]).retries, 0);
});

test("identical usage on two different threads is two turns, not a repeat", () => {
  const a = turn({ thread: "t1", input: 500, output: 5, total: 505 });
  const b = turn({ thread: "t2", input: 500, output: 5, total: 505 });
  assert.equal(rollup([a, b]).turns, 2);
});

test("a write that did nothing is counted apart from a call that failed", () => {
  // The half of "accepted but nothing changed" that no selector work can fix:
  // the target was right and the write still did not happen. Separating it is
  // what makes the rest of that bucket attributable to anything.
  const r = rollup([
    driver({ silent: true }),
    driver({ silent: true }),
    driver({ failure: "stale" }),
    driver(),
    tool({ noChange: true }),
  ]);
  assert.equal(r.silentWrites, 2);
  assert.deepEqual(r.failures.driver, { stale: 1 }, "a quiet write is not a failure — nothing was refused");
  assert.equal(r.noChange, 1);
});

test("a batch step's half-signal is not counted; the batch's verdict is", () => {
  // The bug this replaced: a batch step reports "the value did not move",
  // which on this platform is stale-prone, and counting it alone read ten
  // landed writes as ten failures on a run that succeeded. The verdict needs
  // the closing diff too, and the closing diff belongs to the tool call.
  const stepFactOnly = rollup([
    driver({ method: "setValue", targetRole: "text field" }), // reported valueUnchanged; NOT silent
    tool({ tool: "computer_do", verb: "do" }),                 // no verdict: the tree moved
  ]);
  assert.equal(stepFactOnly.silentWrites, 0, "a half-signal counts for nothing");

  const withVerdict = rollup([
    driver({ method: "setValue", targetRole: "text field" }),
    tool({
      tool: "computer_do",
      verb: "do",
      quietWrites: [
        { id: 95, role: "text field" },
        { id: 103, role: "incrementor" },
      ],
    }),
  ]);
  assert.equal(withVerdict.silentWrites, 2);
  assert.deepEqual(withVerdict.silentByRole, { "text field": 1, incrementor: 1 });
});

test("a rollup reports the records' version, not the code's", () => {
  // A run written before the rule changed must not be read as though it were
  // written after it. Four published numbers came from records that counted a
  // half-signal; they keep what they said, and say when they said it.
  const old = rollup([{ ...driver({ silent: true }), v: 1 }]);
  assert.equal(old.v, 1);
  assert.equal(rollup([driver({ silent: true })]).v, METRICS_VERSION);
  assert.equal(rollup([]).v, METRICS_VERSION, "an empty run is not retroactively old");
});

test("a standalone call still reaches the verdict on its own", () => {
  // It has a diff of its own, so it needs no batch to judge it.
  const r = rollup([driver({ silent: true, targetRole: "pop up button" })]);
  assert.equal(r.silentWrites, 1);
  assert.deepEqual(r.silentByRole, { "pop up button": 1 });
});

test("writes that did nothing are broken down by what they were aimed at", () => {
  // The breakdown is the point. Eight silent writes reads as "writes are
  // broken"; five against a stepper and three against a pop-up button reads as
  // "two control types refuse AXValue", which is the true and much smaller
  // claim. Reporting the first when the second was the case cost a whole
  // afternoon's conclusion.
  const r = rollup([
    driver({ silent: true, targetRole: "incrementor" }),
    driver({ silent: true, targetRole: "incrementor" }),
    driver({ silent: true, targetRole: "pop up button" }),
    driver({ silent: true }),
    driver({ targetRole: "text field" }),
  ]);
  assert.equal(r.silentWrites, 4);
  assert.deepEqual(r.silentByRole, {
    incrementor: 2,
    "pop up button": 1,
    "(role unknown)": 1,
  });
});

test("an empty run rolls up to zeroes rather than throwing", () => {
  const r = rollup([] as MetricRecord[]);
  assert.equal(r.shape, "none");
  assert.equal(r.tokens.billed.total, 0);
  assert.equal(r.tokens.context, 0);
  assert.equal(r.toolMs.p95, 0);
  assert.deepEqual(r.failures, { tool: {}, driver: {} });
  assert.equal(r.wall, null);
  assert.equal(r.retries, 0);
  assert.equal(r.silentWrites, 0);
  assert.deepEqual(r.silentByRole, {});
});
