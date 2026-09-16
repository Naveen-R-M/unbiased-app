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

/** The units a call's work is measured in. A 105-point pen path and a
 *  105-character password are both "105" and have nothing to do with each
 *  other, so the unit always travels with the number. */
export type Unit = "points" | "steps" | "chars" | "keys" | "clicks";

/** How big a call was.
 *
 *  `size`/`unit` is the headline — what the call IS. `parts` is everything it
 *  carries, including work nested inside a batch, and the two differ exactly
 *  where it matters: a ten-step batch is "10 steps", which says nothing about
 *  why it took four seconds. The reliable way to set a field in a web app's
 *  inspector is the four-step recipe — click, select all, type, commit — so
 *  batches are where almost all typing happens, and counting only the steps
 *  made every batched edit look like zero characters of text. */
export type Payload = {
  verb: string;
  size: number;
  unit: Unit | "none";
  parts: Partial<Record<Unit, number>>;
};

function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

function textLength(v: unknown): number {
  return typeof v === "string" ? v.length : 0;
}

/** What a batch's steps add up to. Reads the raw step objects the model sent,
 *  not parsed ones, so a malformed batch is measured as best it can be rather
 *  than throwing inside a diagnostics path. Never returns the text itself. */
function batchParts(raw: unknown): Partial<Record<Unit, number>> {
  const steps = Array.isArray(raw) ? raw : [];
  const parts: Partial<Record<Unit, number>> = { steps: steps.length };
  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const step = s as Record<string, unknown>;
    switch (step.do) {
      case "type":
      case "set_value":
        parts.chars = (parts.chars ?? 0) + textLength(step.text);
        break;
      case "key":
        parts.keys = (parts.keys ?? 0) + 1;
        break;
      case "pointer":
        parts.clicks = (parts.clicks ?? 0) + (typeof step.clicks === "number" ? step.clicks : 1);
        break;
      default:
        break;
    }
  }
  return parts;
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
    case "computer_pointer": {
      // The one that matters most: a long path is a drawing, and a drawing is
      // the case where a single binding legitimately runs for half a minute.
      const points = count(a.path);
      return { verb: a.hold === true ? "pointer:drag" : "pointer", size: points, unit: "points", parts: { points } };
    }
    case "computer_do":
      return { verb: "do", size: count(a.steps), unit: "steps", parts: batchParts(a.steps) };
    case "computer_type": {
      const chars = textLength(a.text);
      return { verb: "type", size: chars, unit: "chars", parts: { chars } };
    }
    case "computer_set_value": {
      const chars = textLength(a.value);
      return { verb: "set_value", size: chars, unit: "chars", parts: { chars } };
    }
    case "computer_key":
    case "computer_press_key":
      return { verb, size: 1, unit: "keys", parts: { keys: 1 } };
    default:
      return { verb, size: 0, unit: "none", parts: {} };
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
export type Failure = "stale" | "ambiguous" | "gone" | "timeout" | "refused" | "crashed" | "bad_call" | "other";

/** Classified from the bridge's error CODE, never from its prose. The messages
 *  are written for the model and get rewritten; the codes are the contract. */
export function classifyFailure(code: string | null, message?: string | null): Failure | null {
  if (!code && !message) return null;
  switch (code) {
    case "no_such_element":
    case "no_such_window":
    case "element_gone":
      return "stale";
    // The bridge refused to guess between several controls matching the one
    // the caller named. Counted apart from stale because it is a different
    // problem with a different repair — and because until the bridge said
    // which it was, every one of these was recorded as a missing element.
    case "ambiguous_element":
      return "ambiguous";
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
  /** Everything the call carried, batch contents included. Optional because
   *  records written before batches were measured do not have it, and those
   *  are on disk and still worth reading — every writer here sets it. */
  parts?: Partial<Record<Unit, number>>;
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
  /** The write was accepted and changed nothing observable. Not a failure —
   *  nothing was refused — but not a success either, and it is the half of
   *  "accepted but nothing changed" that no selector work can fix: the target
   *  was right and the write still did not happen. Counting it apart is what
   *  makes the rest of that bucket attributable. */
  silent?: boolean;
  /** What the call was aimed at. Without these, a count of writes that did
   *  nothing cannot be turned into WHICH writes — and a number nobody can
   *  break down is a number that gets generalised wrongly. */
  targetId?: number | null;
  targetRole?: string | null;
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
  /** The engine re-emitted the same usage without a new request completing —
   *  what a retry loop looks like from here. Measured on a run killed by
   *  upstream 429s: eight usage reports, two distinct, six of them the same
   *  numbers again. Counting those as turns would have reported 170,860 billed
   *  tokens where 40,522 were actually sent, and eight model turns where there
   *  were two. Kept rather than dropped, because the repeats ARE the evidence
   *  that something retried. */
  repeat?: boolean;
};

/** A run's actual boundaries, as the engine reports them.
 *
 *  Wall time used to be inferred as first-record-to-last-record for a thread,
 *  and that is only right if you read it immediately. Measured: a drawing run
 *  reported 910s just after it finished and 3113s an hour later, because one
 *  late token-usage record joined the same thread and stretched the span. A
 *  number that decays after you stop looking at it is not a measurement. */
export type RunRecord = Base & {
  kind: "run";
  turn: string | null;
  phase: "started" | "completed";
  /** What the engine said became of it — completed, aborted, failed. Null on
   *  the start record, where nothing is known yet. */
  status: string | null;
};

export type MetricRecord = ToolRecord | DriverRecord | TurnRecord | RunRecord;

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
type Shaped = { verb: string; size: number; parts?: Partial<Record<Unit, number>> };

export function taskShape(tools: readonly Shaped[]): TaskShape {
  if (tools.length === 0) return "none";
  const points = (t: Shaped) => t.parts?.points ?? (t.verb.startsWith("pointer") ? t.size : 0);
  if (tools.some((t) => points(t) >= DRAW_POINTS)) return "draw";
  const kinds = new Set<string>();
  for (const t of tools) {
    const v = t.verb;
    // Text anywhere makes it an edit, batch contents included: the reliable
    // way to set a field is click, select all, type, commit, so the presses in
    // such a batch are in service of the typing rather than a navigation of
    // their own. Counting them separately reported every field edit as mixed.
    if ((t.parts?.chars ?? 0) > 0 || v === "type" || v === "set_value") kinds.add("edit");
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
  /** Of the driver calls, how many were writes that did nothing observable. */
  silentWrites: number;
  /** Those same writes by the role they were aimed at. The whole point: five
   *  against a stepper and three against a pop-up button is a control-type
   *  story, and the same eight without roles reads as "writes are broken". */
  silentByRole: Record<string, number>;
  /** Biggest payload seen, per unit — what a payload-derived budget gets set from. */
  largest: Record<string, number>;
  /** Usage reports that repeated the previous numbers — retries that never
   *  completed. Excluded from `turns` and from `tokens`, counted here. */
  retries: number;
  /** Measured from the engine's own turn boundaries, so it does not drift when
   *  the thread is touched again later. Null for records written before those
   *  boundaries were logged: a reader should fall back to the record span and
   *  say that it is doing so. `unfinished` counts starts with no completion —
   *  an interrupted run, or one the app was restarted in the middle of. */
  wall: { ms: number; runs: number; unfinished: number } | null;
};

/** Pairs start records with their completions by turn id. Out-of-order arrival
 *  is fine; a completion with no start is ignored rather than guessed at. */
function wallOf(runs: readonly RunRecord[]): Rollup["wall"] {
  if (runs.length === 0) return null;
  const started = new Map<string, number>();
  let ms = 0;
  let paired = 0;
  for (const r of runs) {
    const key = r.turn ?? "";
    const at = new Date(r.at).getTime();
    if (r.phase === "started") started.set(key, at);
    else {
      const from = started.get(key);
      if (from === undefined) continue;
      started.delete(key);
      ms += Math.max(0, at - from);
      paired++;
    }
  }
  return { ms, runs: paired, unfinished: started.size };
}

function sum(ns: readonly number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

export function rollup(records: readonly MetricRecord[]): Rollup {
  const tools = records.filter((r): r is ToolRecord => r.kind === "tool");
  const drivers = records.filter((r): r is DriverRecord => r.kind === "driver");
  const allTurns = records.filter((r): r is TurnRecord => r.kind === "turn");
  const runs = records.filter((r): r is RunRecord => r.kind === "run");
  // Records written before `repeat` existed do not carry it, and the run that
  // motivated the field is among them — so consecutive identical usage for one
  // thread is treated as a repeat when the flag is absent.
  const seen = new Map<string, string>();
  const repeats = new Set<TurnRecord>();
  for (const t of allTurns) {
    const key = t.thread ?? "";
    const sig = `${t.input}/${t.cached}/${t.output}/${t.total}`;
    if (t.repeat === true || (t.repeat === undefined && seen.get(key) === sig)) repeats.add(t);
    seen.set(key, sig);
  }
  const turns = allTurns.filter((t) => !repeats.has(t));
  const tally = (rs: readonly { failure: Failure | null }[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of rs) if (r.failure) out[r.failure] = (out[r.failure] ?? 0) + 1;
    return out;
  };
  const largest: Record<string, number> = {};
  for (const t of tools) {
    const parts = t.parts ?? (t.unit !== "none" ? ({ [t.unit]: t.size } as Partial<Record<Unit, number>>) : {});
    for (const [unit, n] of Object.entries(parts)) {
      if (typeof n === "number" && n > 0) largest[unit] = Math.max(largest[unit] ?? 0, n);
    }
  }
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
    retries: repeats.size,
    toolCalls: tools.length,
    driverCalls: drivers.length,
    toolMs: span(tools.map((t) => t.ms)),
    driverMs: span(drivers.map((d) => d.ms)),
    failures: { tool: tally(tools), driver: tally(drivers) },
    noChange: tools.filter((t) => t.noChange).length,
    silentWrites: drivers.filter((d) => d.silent === true).length,
    silentByRole: drivers.filter((d) => d.silent === true).reduce<Record<string, number>>((acc, d) => {
      const k = d.targetRole ?? "(role unknown)";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    largest,
    wall: wallOf(runs),
  };
}
