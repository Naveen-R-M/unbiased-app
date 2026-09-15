/** Phase 0 instrumentation: what a desktop run costs, measured rather than argued.
 *
 *  The question on the table is whether to move the computer tools from batched
 *  tool calls to a code mode — a kernel that calls bindings in a loop instead of
 *  a model that calls tools in a turn. That is a large change, and the case for
 *  it rests on numbers nobody has yet: how many model turns a run takes, how
 *  many tokens they carry, how much of the wall clock is the model thinking
 *  rather than the driver working, and how often a call fails because the
 *  snapshot it named had already moved on.
 *
 *  So: log first, decide after. Nothing here changes behaviour. Every function
 *  is a pure description of something that already happened, and the writer
 *  swallows its own errors — diagnostics must never break a turn.
 *
 *  What these records deliberately do NOT carry: any text from the user's
 *  screen. Not a field's contents, not an element's label, not a window title,
 *  not the bytes of a picture. Verbs, counts and durations answer the question
 *  on their own, and a log that is only shapes is one that can be left running.
 *  A log that quotes the screen is one that has to be argued about first. */

/** Bumped when a field changes meaning, so a later reader can tell two runs
 *  apart instead of averaging them together. */
export const METRICS_VERSION = 1;

/** The env switch. Separate from UNBIASED_AX_DEBUG on purpose: that log quotes
 *  element lines and belongs to one debugging session, this one is shapes only
 *  and is meant to accumulate across many runs until the baseline is real. */
export function metricsEnabled(env: Record<string, string | undefined>): boolean {
  return env.UNBIASED_AX_METRICS === "1";
}

// ---------------------------------------------------------------- payloads

/** How big a call was, in the unit that call is actually measured in. A
 *  105-point pen path and a 105-character password are both "105" and have
 *  nothing to do with each other, so the unit travels with the number. */
export type Payload = { verb: string; size: number; unit: "points" | "steps" | "chars" | "keys" | "none" };

const NO_PAYLOAD: Payload = { verb: "", size: 0, unit: "none" };

function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/** The verb and size of one tool call, from its arguments alone.
 *
 *  Never returns the arguments themselves. `computer_type {text: "hunter2"}`
 *  becomes `{verb: "type", size: 7, unit: "chars"}` and the password does not
 *  reach the log. That property is a test, not a convention. */
export function payloadOf(tool: string, rawArgs: unknown): Payload {
  const a = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const verb = tool.startsWith("computer_") ? tool.slice("computer_".length) : tool;
  switch (tool) {
    case "computer_pointer":
      // The one that matters most: a long path is a drawing, and a drawing is
      // the case where a single binding legitimately runs for half a minute.
      return { verb: a.hold === true ? "pointer:drag" : "pointer", size: count(a.path), unit: "points" };
    case "computer_do":
      return { verb: "do", size: count(a.steps), unit: "steps" };
    case "computer_type":
      return { verb: "type", size: typeof a.text === "string" ? a.text.length : 0, unit: "chars" };
    case "computer_set_value":
      return { verb: "set_value", size: typeof a.value === "string" ? a.value.length : 0, unit: "chars" };
    case "computer_key":
    case "computer_press_key":
      return { verb: verb, size: 1, unit: "keys" };
    default:
      return { verb, size: 0, unit: "none" };
  }
}

// ---------------------------------------------------------------- failures

/** Why a call did not do what was asked.
 *
 *  `stale` is the one this whole exercise exists to count: the model named an
 *  element id out of a snapshot the app has since moved past. It is the failure
 *  a code mode makes MORE of, because a kernel holds ids across many more
 *  operations than a model does between turns — so if it is already common,
 *  the generation-bound handles have to land before the kernel does, and if it
 *  is rare, that ordering is a free choice rather than a prerequisite. */
export type Failure = "stale" | "gone" | "timeout" | "refused" | "crashed" | "bad_call" | "other";

/** Classified from the bridge's error CODE, never from its prose. The messages
 *  are written for the model and get rewritten; the codes are the contract. */
export function classifyFailure(code: string | null, message?: string | null): Failure | null {
  if (!code && !message) return null;
  switch (code) {
    case "no_such_element":
    case "no_such_window":
      return "stale";
    case "no_such_app":
      return "gone";
    case "timeout":
      return "timeout";
    case "not_trusted":
      return "refused";
    case "bridge_exited":
    case "protocol":
      return "crashed";
    case "bad_params":
    case "unknown_method":
      return "bad_call";
    case "action_failed":
    case "launch_failed":
      return "other";
    default:
      return code || message ? "other" : null;
  }
}

// ---------------------------------------------------------------- records

type Base = { v: number; at: string; thread: string | null };

/** One tool call, start to finish — the code-mode "binding" unit. Its ms is
 *  what a per-binding timeout would have to be set against, which is the
 *  number the timeout policy is currently being guessed from. */
export type ToolRecord = Base & {
  kind: "tool";
  turn: string | null;
  tool: string;
  app: string | null;
  verb: string;
  size: number;
  unit: Payload["unit"];
  ms: number;
  ok: boolean;
  /** True when the call succeeded and the app's tree did not move. The
   *  observable cousin of "pressed the wrong thing": we cannot see ambiguity
   *  yet, because nothing resolves an element by label — that arrives with the
   *  handles. A press that changed nothing is what ambiguity looks like today. */
  noChange: boolean;
  failure: Failure | null;
};

/** One bridge round trip. Several of these can sit inside one ToolRecord — a
 *  batch is one tool call and many driver calls — and telling them apart is the
 *  point: it separates driver time from model time. */
export type DriverRecord = Base & {
  kind: "driver";
  method: string;
  app: string | null;
  ms: number;
  /** How long the bridge spent waiting for the app to react, inside ms. */
  waitedMs: number | null;
  bytes: number;
  lines: number;
  /** Which pointer route carried it, when the reply said. Phase 1 adds the
   *  snapshot generation next to this; it does not exist yet and is left out
   *  rather than faked. */
  route: string | null;
  failure: Failure | null;
};

/** One model turn's tokens. `cached` is a SUBSET of `input`, matching what the
 *  engine reports — not an extra bucket to be added in. */
export type TurnRecord = Base & {
  kind: "turn";
  turn: string | null;
  input: number;
  cached: number;
  output: number;
  total: number;
};

export type MetricRecord = ToolRecord | DriverRecord | TurnRecord;

export function nowIso(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}

// ---------------------------------------------------------------- the log

/** Appends records as NDJSON. The sink is injected so a test never touches the
 *  filesystem, and so the caller owns the privacy decision about where the file
 *  lives — userData, not a world-readable /tmp. */
export class MetricsLog {
  private count = 0;

  constructor(private readonly sink: ((line: string) => void) | null) {}

  get enabled(): boolean {
    return this.sink !== null;
  }

  get written(): number {
    return this.count;
  }

  record(r: MetricRecord): void {
    if (!this.sink) return;
    try {
      this.sink(JSON.stringify(r));
      this.count++;
    } catch {
      // diagnostics must never break a turn
    }
  }
}

// ---------------------------------------------------------------- rollup

export type TaskShape = "draw" | "edit" | "navigate" | "read" | "mixed" | "none";

/** A path this long is a drawing rather than a click. Mirrors the bridge's own
 *  DRAW_GATE_POINTS; duplicated rather than imported so this module stays pure. */
export const DRAW_POINTS = 20;

/** What kind of work a run was, so two runs are not averaged into one number
 *  that describes neither. A 105-point drawing run and a six-press form run
 *  have almost nothing in common economically: without this tag a token
 *  comparison between tool mode and code mode reports whatever the mix of
 *  tasks happened to be that week. */
export function taskShape(tools: readonly { verb: string; size: number }[]): TaskShape {
  if (tools.length === 0) return "none";
  const drew = tools.some((t) => t.verb.startsWith("pointer") && t.size >= DRAW_POINTS);
  if (drew) return "draw";
  const kinds = new Set<string>();
  for (const t of tools) {
    const v = t.verb;
    if (v === "type" || v === "set_value") kinds.add("edit");
    else if (v === "press" || v === "act" || v === "menu" || v === "key" || v === "press_key" || v === "do" || v.startsWith("pointer")) kinds.add("navigate");
    else if (v === "app_state" || v === "screenshot" || v === "app_screenshot" || v === "apps" || v === "scroll_view" || v === "scroll") kinds.add("read");
  }
  kinds.delete("read"); // reading accompanies everything; it only names a run when it is all there was
  if (kinds.size === 0) return "read";
  if (kinds.size === 1) return [...kinds][0] as TaskShape;
  return "mixed";
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  // Nearest-rank: with a handful of samples an interpolated p95 invents a
  // number no call actually took, and these samples are used to pick timeouts.
  const rank = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[rank]!;
}

export type Rollup = {
  v: number;
  shape: TaskShape;
  turns: number;
  /** Two different questions, and conflating them is how the code-mode case
   *  gets argued badly.
   *
   *  `billed` sums every turn: the context is re-sent on each one, so N turns
   *  over a 40k context cost ~N*40k input tokens however little the model said.
   *  That re-send is the entire quantity code mode claims to remove, so it is
   *  the number the decision turns on.
   *
   *  `context` is the last turn's input alone — how big the conversation got.
   *  It is the gauge the composer shows, and it is NOT a cost. */
  tokens: {
    billed: { input: number; cached: number; output: number; total: number };
    context: number;
  };
  toolCalls: number;
  driverCalls: number;
  /** Wall time inside tool calls, and inside bridge calls within them. The gap
   *  between them and the run's span is model time — the quantity code mode
   *  claims to remove, and the one nobody has measured. */
  toolMs: { total: number; p50: number; p95: number; max: number };
  driverMs: { total: number; p50: number; p95: number; max: number };
  /** Split by layer on purpose. One stale element id produces a driver failure
   *  AND a tool failure, and adding them reports two problems where there was
   *  one. They also mean different things on their own: a tool call fails with
   *  no driver call behind it when the arguments were bad, and a driver call
   *  fails inside a batch that goes on to succeed. */
  failures: { tool: Record<string, number>; driver: Record<string, number> };
  noChange: number;
  /** Biggest payload seen, per unit — what a payload-derived budget gets set from. */
  largest: Record<string, number>;
};

function sum(ns: readonly number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

export function rollup(records: readonly MetricRecord[]): Rollup {
  const tools = records.filter((r): r is ToolRecord => r.kind === "tool");
  const drivers = records.filter((r): r is DriverRecord => r.kind === "driver");
  const turns = records.filter((r): r is TurnRecord => r.kind === "turn");
  const tally = (rs: readonly { failure: Failure | null }[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of rs) if (r.failure) out[r.failure] = (out[r.failure] ?? 0) + 1;
    return out;
  };
  const largest: Record<string, number> = {};
  for (const t of tools) if (t.unit !== "none") largest[t.unit] = Math.max(largest[t.unit] ?? 0, t.size);
  const last = turns.at(-1);
  const span = (ms: number[]) => ({
    total: sum(ms),
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    max: ms.length ? Math.max(...ms) : 0,
  });
  return {
    v: METRICS_VERSION,
    shape: taskShape(tools),
    turns: turns.length,
    tokens: {
      billed: {
        input: sum(turns.map((t) => t.input)),
        cached: sum(turns.map((t) => t.cached)),
        output: sum(turns.map((t) => t.output)),
        total: sum(turns.map((t) => t.total)),
      },
      context: last?.input ?? 0,
    },
    toolCalls: tools.length,
    driverCalls: drivers.length,
    toolMs: span(tools.map((t) => t.ms)),
    driverMs: span(drivers.map((d) => d.ms)),
    failures: { tool: tally(tools), driver: tally(drivers) },
    noChange: tools.filter((t) => t.noChange).length,
    largest,
  };
}
