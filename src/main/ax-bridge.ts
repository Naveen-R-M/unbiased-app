import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

/** The accessibility bridge: apps, windows, and element trees as text with
 *  stable ids, plus actions on those elements. Lives in the unbiased-ax repo;
 *  this file is everything the app needs to find it, talk to it, and describe
 *  what it is about to do. No electron import, so it is tested under node. */

export const AX_PROTOCOL_VERSION = 1;
export const AX_REQUEST_TIMEOUT_MS = 10_000;
/** A hello while the cross-Space verdict is undecided runs the bridge's
 *  self-check: the bridge budgets it at five seconds and one slow app can
 *  stretch it; 15 s leaves headroom without hanging a turn. */
export const AX_HELLO_TIMEOUT_MS = 15_000;

export type AxManifest = { entryPath: string; args: string[]; version: string; protocolVersion: number };

/** manifest.json beside the binary. Same shape as the learning sidecar's
 *  manifest, except runtime is "native": the entry is executed directly. */
export function readAxManifest(dir: string): AxManifest | { error: string } | null {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return { error: `manifest.json is not readable JSON: ${String(err)}` };
  }
  if (typeof raw.protocolVersion !== "number") return { error: "manifest.json has no numeric protocolVersion" };
  if (raw.protocolVersion !== AX_PROTOCOL_VERSION) {
    return { error: `bridge speaks protocol ${raw.protocolVersion}, this app speaks ${AX_PROTOCOL_VERSION}` };
  }
  if (raw.runtime !== "native") return { error: `unsupported bridge runtime ${JSON.stringify(raw.runtime)}` };
  if (typeof raw.entry !== "string" || !raw.entry) return { error: "manifest.json has no entry" };
  const entryPath = resolve(dir, raw.entry);
  if (!entryPath.startsWith(resolve(dir) + sep)) return { error: `entry escapes the bundle: ${raw.entry}` };
  if (!existsSync(entryPath)) return { error: `entry does not exist: ${entryPath}` };
  return {
    entryPath,
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [],
    protocolVersion: raw.protocolVersion,
    version: typeof raw.version === "string" ? raw.version : "unknown",
  };
}

/** Override → packaged Contents/Resources/ax → a sibling checkout found by
 *  walking up from appPath, so a git worktree under .claude/worktrees finds
 *  it too (the plain `..` guess does not). */
export function resolveAxDir(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  const override = process.env.UNBIASED_AX_DIR;
  if (override) return override;
  if (opts.isPackaged) return join(opts.resourcesPath, "ax");
  let at = opts.appPath;
  for (let i = 0; i < 8; i++) {
    const candidate = join(at, "unbiased-ax", "dist");
    if (existsSync(candidate)) return candidate;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return join(opts.appPath, "..", "unbiased-ax", "dist");
}

export function axLooksInstalled(dir: string): boolean {
  try {
    return isAbsolute(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export class AxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AxError";
  }
}

/** Whether an AX call needs a consent card. The access mode already answers
 *  this: `full` is `approvalPolicy: "never"`, and asking anyway ignores what
 *  the user set. Same shape as the browser gate — mode first, then a
 *  per-conversation grant. Reading UI text is as sensitive as acting on it
 *  (window titles and field contents reach the model), so both are gated
 *  together; only listing app names is free. */
export function axConsent(opts: { tool: string; mode: "ask" | "auto" | "full"; granted: boolean }): "allow" | "ask" {
  if (opts.tool === "computer_apps") return "allow";
  if (opts.mode === "full") return "allow";
  return opts.granted ? "allow" : "ask";
}

/** Whether an action takes over the user's screen. Reading and pressing never
 *  do: the Accessibility API works on background apps, and a key posted to the
 *  pid reaches one — both verified against a backgrounded Brave that stayed
 *  backgrounded. Raising is the sole exception, and it exists because an app
 *  whose every window is on another Space is not in the tree at all. */
export function axNeedsFocus(tool: string, _args: Record<string, unknown>): boolean {
  return tool === "computer_raise";
}

/** What a read asked for, remembered per app. The bridge diffs an action's
 *  after-snapshot against the last one it took, so an action that snapshots
 *  with a different filter than the read manufactures a diff: measured on
 *  Maps, one press reported +73 added elements and the next read reported the
 *  same 73 as removed. The model was told the card it had just opened was
 *  gone. Anything that ends in the bridge's afterAction — every action, and
 *  raise with it — takes a snapshot AND stores it as the baseline the next
 *  diff is measured from, so all of them must see what the reads see. */
export type AxReadOpts = { interactive: boolean; web: boolean; depth?: number };
/** Frozen: one object is handed out by reference to every caller that acts on
 *  an app nothing has read yet, so a single mutation would rewrite the default
 *  for all of them. */
export const AX_DEFAULT_READ_OPTS: AxReadOpts = Object.freeze({ interactive: true, web: false });
export function axReadOptsFrom(args: { interactive?: unknown; web?: unknown; depth?: unknown }): AxReadOpts {
  return {
    interactive: args.interactive !== false,
    web: args.web === true,
    // depth is a filter like the other two — the bridge reads it in the same
    // options() — and the read's own reply says "truncated: use query or
    // depth", so the model is invited to change it. Read at depth 5, press,
    // and an action snapshotting at the default 14 adds everything deeper;
    // the next read at 5 removes it all again. Only carried when given: the
    // bridge's own default (14) is not ours to restate.
    ...(typeof args.depth === "number" ? { depth: args.depth } : {}),
  };
}


/** The app a computer step acted on, so the transcript can show that app's own
 *  icon instead of a generic terminal glyph. */
const APP_STEP_TOOLS = new Set([
  "computer_app_state",
  "computer_act",
  "computer_raise",
  "computer_launch",
  "computer_press",
  "computer_set_value",
  "computer_press_key",
  "computer_scroll_view",
  "computer_do",
]);

export function appOfStep(tool: string, args: Record<string, unknown>): string | null {
  if (!APP_STEP_TOOLS.has(tool)) return null;
  const app = typeof args.app === "string" ? args.app.trim() : "";
  return app || null;
}

/** One step of a batch. Every verb here is an existing single-step tool; a
 *  batch is only a way to spend one model round trip instead of five. The
 *  bridge itself needs nothing: a call to it costs 3-70ms over a local pipe
 *  (measured), while a round trip through the model costs seconds. Batching
 *  belongs on this side of that gap, not in the bridge. */
export type BatchStep =
  | { do: "press"; id: number; waitMs: number }
  | { do: "set_value"; id: number; text: string; waitMs: number }
  | { do: "key"; key: string; id?: number; modifiers?: string[]; waitMs: number }
  | { do: "scroll"; id: number; direction: string; amount?: number; waitMs: number }
  | { do: "act"; id: number; action: string; waitMs: number }
  | { do: "type"; text: string; id?: number; waitMs: number }
  | { do: "pointer"; id: number; clicks?: number; waitMs: number }
  | { do: "screenshot"; window?: number; waitMs: number }
  | { do: "read"; waitMs: number };

/** Deliberately NOT batchable: launch and raise both take over the user's
 *  screen, and each deserves its own approval rather than riding along inside
 *  a list of presses. */
/** A field value or a short label, matching the bridge's own cap. */
export const MAX_TYPE_LENGTH = 500;
/** 2 is a double click, which some controls honour where one click does not. */
export const MAX_CLICKS = 3;
export const KEY_MODIFIERS = ["command", "shift", "option", "control"];
/** `type` and `pointer` are here because the only reliable way to set a value
 *  in a web app's inspector is the four-step recipe — click the field, select
 *  all, type, commit — and without both verbs it cannot be written as one
 *  call. Measured on Figma: setValue lands on a `text field` and is silently
 *  ignored on a `stepper`, and Codex's own run hit the identical split.
 *
 *  Still NOT batchable: launch and raise, which take over the user's screen. */
export const BATCH_VERBS = ["press", "set_value", "key", "type", "pointer", "screenshot", "scroll", "act", "read"] as const;
/** Measured against Codex on the same Figma icon: its densest single turn ran
 *  17 primitive actions (four fields, each a click + select-all + type +
 *  Return, then a colour click). A cap of 10 split work like that across turns
 *  at ~15s each, which was the whole cost being optimised away. 30 fits any
 *  one shape's geometry and colour with room to spare, and every step is still
 *  an approved bridge primitive with its own refusals. */
export const MAX_BATCH_STEPS = 30;
/** Per-step pause, for content that arrives after the action — Maps shows
 *  "Loading…" for a second or two on the Transit tab. Capped so a batch cannot
 *  be used to park the desktop tools for a minute. */
export const MAX_BATCH_WAIT_MS = 4_000;

export function parseBatchSteps(raw: unknown): { steps: BatchStep[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "steps must be an array." };
  if (raw.length === 0) return { error: "steps is empty — pass at least one step." };
  if (raw.length > MAX_BATCH_STEPS) {
    return { error: `${raw.length} steps is too many (max ${MAX_BATCH_STEPS}). Send the first ${MAX_BATCH_STEPS}, read the result, then continue.` };
  }
  const steps: BatchStep[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `step ${i + 1}`;
    if (!entry || typeof entry !== "object") return { error: `${at} is not an object.` };
    const e = entry as Record<string, unknown>;
    const verb = typeof e.do === "string" ? e.do : "";
    if (!(BATCH_VERBS as readonly string[]).includes(verb)) {
      return { error: `${at}: do must be one of ${BATCH_VERBS.join(", ")}${verb ? ` (got "${verb}")` : ""}. Opening or raising an app is not batchable — call computer_launch or computer_raise on its own.` };
    }
    const waitRaw = typeof e.wait_ms === "number" ? e.wait_ms : 0;
    const waitMs = Math.max(0, Math.min(Math.round(waitRaw), MAX_BATCH_WAIT_MS));
    const id = typeof e.id === "number" ? e.id : null;
    switch (verb) {
      case "read":
        steps.push({ do: "read", waitMs });
        break;
      case "screenshot": {
        // A look that rides inside the batch. Second Figma run: 12 screenshots,
        // each a whole turn, when the picture could have come back with the
        // actions that made it worth taking.
        const window = typeof e.window === "number" ? e.window : undefined;
        steps.push({ do: "screenshot", ...(window !== undefined ? { window } : {}), waitMs });
        break;
      }
      case "type": {
        if (typeof e.text !== "string" || !e.text) return { error: `${at}: text is required for do=type.` };
        if (e.text.length > MAX_TYPE_LENGTH) {
          return { error: `${at}: text is ${e.text.length} characters (max ${MAX_TYPE_LENGTH}). Type a field value, not a document.` };
        }
        steps.push({ do: "type", text: e.text, ...(id !== null ? { id } : {}), waitMs });
        break;
      }
      case "pointer": {
        if (id === null) return { error: `${at}: id is required for do=pointer — the element to click.` };
        const clicks = typeof e.clicks === "number" ? Math.round(e.clicks) : 1;
        if (clicks < 1 || clicks > MAX_CLICKS) return { error: `${at}: clicks must be 1 to ${MAX_CLICKS}; 2 is a double click.` };
        steps.push({ do: "pointer", id, ...(clicks > 1 ? { clicks } : {}), waitMs });
        break;
      }
      case "key": {
        if (typeof e.key !== "string" || !e.key) return { error: `${at}: key is required.` };
        // Modifiers belong in a batch as much as anywhere: clearing a field
        // before typing is command+a, and without this the batch dropped them
        // silently — so the one remedy for a field that appends instead of
        // replacing could not be expressed as a batch at all.
        const mods = Array.isArray(e.modifiers) ? e.modifiers.filter((m): m is string => typeof m === "string") : [];
        const bad = mods.filter((m) => !KEY_MODIFIERS.includes(m));
        if (bad.length) return { error: `${at}: unknown modifier(s) ${bad.join(", ")}. Use ${KEY_MODIFIERS.join(", ")}.` };
        steps.push({ do: "key", key: e.key, ...(id !== null ? { id } : {}), ...(mods.length ? { modifiers: mods } : {}), waitMs });
        break;
      }
      case "press": {
        if (id === null) return { error: `${at}: id is required.` };
        steps.push({ do: "press", id, waitMs });
        break;
      }
      case "set_value": {
        if (id === null) return { error: `${at}: id is required.` };
        if (typeof e.text !== "string") return { error: `${at}: text is required.` };
        steps.push({ do: "set_value", id, text: e.text, waitMs });
        break;
      }
      case "scroll": {
        if (id === null) return { error: `${at}: id is required.` };
        const direction = typeof e.direction === "string" ? e.direction : "";
        if (!["down", "up", "left", "right"].includes(direction)) {
          return { error: `${at}: direction must be down, up, left or right.` };
        }
        steps.push({ do: "scroll", id, direction, ...(typeof e.amount === "number" ? { amount: e.amount } : {}), waitMs });
        break;
      }
      case "act": {
        if (id === null) return { error: `${at}: id is required.` };
        if (typeof e.action !== "string" || !e.action) return { error: `${at}: action is required.` };
        steps.push({ do: "act", id, action: e.action, waitMs });
        break;
      }
    }
  }
  return { steps };
}

/** Alternative routes to one state, for the case measured over and over on
 *  Maps: several plausible ways to get somewhere and no way to tell from the
 *  tree which one the app will honour. Pressing a search-result row does
 *  nothing while the window is parked; down then return does; typing the whole
 *  intent into the field does. Sending those as candidates costs one model
 *  turn instead of three.
 *
 *  A candidate is a SEQUENCE of steps, not a single one, because the route
 *  that works is often two moves: down selects, return opens. Judging one step
 *  at a time would have stopped at the selection and called it done.
 *
 *  The winner is decided mechanically, by the same test that already decides
 *  when an action is finished: did the settled tree change materially. No
 *  success predicate from the caller, because something would have to evaluate
 *  it, and a string match on a tree the model has not seen yet is a guess. The
 *  caller reads the diff and judges whether the state is the one it wanted. */
export const MAX_CANDIDATES = 4;
export const MAX_CANDIDATE_STEPS = 4;

export function parseCandidates(raw: unknown): { candidates: BatchStep[][] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "candidates must be an array of routes; each route is a step or a list of steps." };
  if (raw.length < 2) return { error: "candidates needs at least two routes — with one there is nothing to choose between, so use steps instead." };
  if (raw.length > MAX_CANDIDATES) {
    return { error: `${raw.length} candidates is too many (max ${MAX_CANDIDATES}) — every route that does nothing costs a full wait for the app. Send your best ${MAX_CANDIDATES}.` };
  }
  const candidates: BatchStep[][] = [];
  for (const [i, entry] of raw.entries()) {
    const list = Array.isArray(entry) ? entry : [entry];
    if (list.length === 0) return { error: `candidate ${i + 1} is empty.` };
    if (list.length > MAX_CANDIDATE_STEPS) return { error: `candidate ${i + 1} has ${list.length} steps (max ${MAX_CANDIDATE_STEPS}).` };
    const parsed = parseBatchSteps(list);
    if ("error" in parsed) return { error: `candidate ${i + 1}: ${parsed.error}` };
    const read = parsed.steps.findIndex((st) => st.do === "read");
    if (read >= 0) return { error: `candidate ${i + 1} step ${read + 1} is a read. A read changes nothing, so it can never be the route that works; candidates must be actions.` };
    candidates.push(parsed.steps);
  }
  return { candidates };
}

/** Whether a candidate's step actually did something. The bridge has already
 *  waited for the app to settle by the time we see this, so "no changes" means
 *  the app was asked and declined, not that it is still thinking. */
export function candidateWorked(diff: string): boolean {
  const body = diff.trim();
  return body.length > 0 && body !== "(no changes)";
}

/** The approval card for a set of routes. It has to be unmistakable that these
 *  are alternatives and that the run stops at the first that does something,
 *  so the user is never shown four presses and asked to approve one. */
export function describeCandidates(app: string, candidates: BatchStep[][], lines?: Map<number, string>): string {
  const rendered = candidates.map((steps, i) => {
    const inner = describeBatch(app, steps, lines).split("\n").slice(1).map((l) => `   ${l.replace(/^\d+\.\s*/, "")}`);
    return `${i + 1}.${inner.length === 1 ? ` ${inner[0].trim()}` : `\n${inner.join("\n")}`}`;
  });
  return `${candidates.length} alternative route(s) in ${app}, stopping at the first that changes anything:\n${rendered.join("\n")}`;
}

export function summarizeCandidates(opts: {
  tried: { label: string; outcome: "worked" | "nothing" | string }[];
  winner: number | null;
  diff: string;
  remaining: number;
}): string {
  const lines = opts.tried.map((t, i) => {
    const mark = i === (opts.winner ?? -1) ? "→" : " ";
    const said = t.outcome === "worked" ? "changed the app" : t.outcome === "nothing" ? "did nothing" : `failed: ${t.outcome}`;
    return `${mark} ${t.label} ${said}`;
  });
  const skipped = opts.remaining > 0 ? `\n${opts.remaining} later route(s) were not tried.` : "";
  if (opts.winner === null) {
    return `None of the ${opts.tried.length} route(s) changed the app.\n${lines.join("\n")}\n${ACTION_NO_CHANGE_SENTENCE}`;
  }
  return `Route ${opts.winner + 1} changed the app. Read the diff and check it is the state you wanted.\n${lines.join("\n")}${skipped}\n${opts.diff}`;
}

/** One line per step. The user approves the WHOLE sequence with one card, so
 *  the card has to show every step — a batch must never be a way to slip an
 *  irreversible press in behind four harmless reads. */
export function describeBatch(app: string, steps: BatchStep[], lines?: Map<number, string>): string {
  const clip = (t: string) => (t.length > 48 ? t.slice(0, 48) + "…" : t);
  const target = (id: number) => {
    const line = lines?.get(id);
    return line ? `#${id} — ${clip(line)}` : `#${id}`;
  };
  const rendered = steps.map((st, i) => {
    const n = `${i + 1}.`;
    const pause = st.waitMs > 0 ? ` (then wait ${st.waitMs}ms)` : "";
    switch (st.do) {
      case "read": return `${n} read ${app}${pause}`;
      case "screenshot": return `${n} photograph the window${pause}`;
      case "press": return `${n} press ${target(st.id)}${pause}`;
      case "set_value": return `${n} set ${target(st.id)} to "${clip(st.text)}"${pause}`;
      case "key": return `${n} press ${st.key}${st.id !== undefined ? ` in ${target(st.id)}` : ""}${pause}`;
      case "scroll": return `${n} scroll ${st.direction} at ${target(st.id)}${pause}`;
      case "act": return `${n} ${st.action} ${target(st.id)}${pause}`;
    }
  });
  return `${steps.length} step(s) in ${app}:\n${rendered.join("\n")}`;
}

/** What the model is told afterwards. A batch that stops halfway is the case
 *  that matters: it must be unmistakable which steps ran, which one failed and
 *  why, and that the rest did NOT run. */
/** What one step did, for the trace: the verb plus the thing it acted on. A
 *  failure at "step 3" is unreadable when the other 29 steps are also just
 *  numbers; "step 3 (set_value #109 = 180)" says which field to look at. */
export function traceStep(st: BatchStep): string {
  switch (st.do) {
    case "read": return "read";
    case "screenshot": return "screenshot";
    case "key": return `key ${st.modifiers?.length ? st.modifiers.join("+") + "+" : ""}${st.key}${st.id !== undefined ? ` in #${st.id}` : ""}`;
    case "press": return `press #${st.id}`;
    case "act": return `act #${st.id} "${st.action}"`;
    case "set_value": return `set_value #${st.id} = ${JSON.stringify(st.text)}`;
    case "type": return `type ${JSON.stringify(st.text)}${st.id !== undefined ? ` in #${st.id}` : ""}`;
    case "pointer": return `click${(st.clicks ?? 1) > 1 ? ` x${st.clicks}` : ""} #${st.id}`;
    case "scroll": return `scroll #${st.id} ${st.direction ?? ""}`.trim();
    default: return (st as { do: string }).do;
  }
}

/** The ids a batch wrote into: set_value, type aimed at an id, and pointer
 *  (the click that starts the four-step stepper recipe). Presses are not field
 *  edits. Unique, first-seen order, capped — thirty edits read back the first
 *  dozen, which is every field on one Figma shape.
 *
 *  Measured 2026-09-08: that recipe bypassed setValue's read-back, so after
 *  every batch the model read the app again to check the fields — 32 finds in
 *  one run, a model turn each. The batch now hands the values over itself. */
export const MAX_FIELDS_READ_BACK = 12;
export function touchedFieldIds(steps: BatchStep[]): number[] {
  const ids: number[] = [];
  for (const st of steps) {
    const id = st.do === "set_value" || st.do === "pointer" || st.do === "type" ? st.id : undefined;
    if (typeof id === "number" && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_FIELDS_READ_BACK) break;
  }
  return ids;
}

/** One entry of the bridge's `values` reply. */
export type FieldValue = { id: number; role: string | null; title: string | null; value: string | null };
export function renderFieldValues(values: FieldValue[]): string {
  const lines = values.map((v) => {
    const what = [v.role, v.title ? JSON.stringify(v.title) : null].filter(Boolean).join(" ");
    return `#${v.id}${what ? ` ${what}` : ""} = ${v.value ?? "(no value)"}`;
  });
  return `Fields now:\n${lines.join("\n")}`;
}

/** The settable controls in the app's latest snapshot, with their ids. Sent
 *  after every action that can change the selection and after every batch, so
 *  the next step can be aimed without a read. Second Figma run, 2026-09-08:
 *  34 of 90 turns were finds for exactly these ids. */
export const MAX_INSPECTOR_FIELDS = 40;
export type InspectorField = { id: number; role: string | null; title: string | null; value: string | null };
export function renderInspector(fields: InspectorField[], truncated: boolean, previous?: InspectorField[]): string | null {
  if (!fields.length) return null;
  const line = (f: InspectorField) => `#${f.id}${f.role ? ` ${f.role}` : ""}${f.title ? ` ${JSON.stringify(f.title)}` : ""} = ${f.value ?? ""}`;
  const tail = truncated ? [`(… more than ${MAX_INSPECTOR_FIELDS}; use query for the rest)`] : [];
  if (!previous?.length) return ["Inspector now:", ...fields.map(line), ...tail].join("\n");
  // Only what moved. Measured 2026-09-08: 49 blocks, ~60KB, a fifth of all tool
  // output, and most of each block repeated the one before it — two coordinates
  // changed and thirty lines did not.
  const was = new Map(previous.map((f) => [f.id, line(f)]));
  const changed: string[] = [];
  let same = 0;
  for (const f of fields) {
    const now = line(f);
    if (!was.has(f.id)) changed.push(`+${now}`);
    else if (was.get(f.id) !== now) changed.push(now);
    else same += 1;
    was.delete(f.id);
  }
  const gone = [...was.keys()];
  if (!changed.length && !gone.length) return `Inspector unchanged (${same} fields, same values).`;
  return [
    "Inspector changes:",
    ...changed,
    ...(gone.length ? [`(gone: ${gone.map((id) => `#${id}`).join(", ")})`] : []),
    ...(same ? [`(${same} unchanged)`] : []),
    ...tail,
  ].join("\n");
}

export function summarizeBatch(opts: {
  ran: string[];
  failed: { step: string; message: string } | null;
  remaining: number;
  diff: string;
  /** renderFieldValues() of every field the batch touched, read back after it. */
  fields?: string;
  /** True when mid-sequence steps skipped their settle wait, so the only
   *  evidence about them is the closing diff. Said out loud rather than
   *  implied: a press that quietly did nothing at step 4 is invisible here,
   *  and a summary that reads "Done" for all 30 would be overclaiming. */
  unwatched?: boolean;
  /** Steps the bridge watched on its own despite the sequence — a delete
   *  outside a text field — with each one's own diff. Measured 2026-09-08: a
   *  frame deleted at step 4 of an unwatched batch left "- removed: 859-880"
   *  in the closing diff and the model wrote "the frame is clean now". */
  watched?: { step: string; diff: string }[];
}): string {
  const head = opts.failed
    ? [
        `Stopped at ${opts.failed.step}: ${opts.failed.message}`,
        opts.ran.length ? `Ran first: ${opts.ran.join("; ")}.` : "Nothing ran before it.",
        opts.remaining > 0 ? `The remaining ${opts.remaining} step(s) did NOT run.` : "",
        "Read the app again before retrying — the ids may have moved.",
      ].filter(Boolean).join(" ")
    : [
        `Done: ${opts.ran.join("; ")}.`,
        opts.unwatched && opts.ran.length > 1
          ? opts.fields
            ? "Only the closing diff was watched; the field values below were read back afterwards."
            : "Only the closing diff was watched."
          : "",
      ].filter(Boolean).join(" ");
  const body = opts.diff.trim() === "(no changes)" ? ACTION_NO_CHANGE_SENTENCE : opts.diff || "(nothing in the tree changed)";
  const watched = (opts.watched ?? [])
    .filter((w) => w.diff.trim() && w.diff.trim() !== "(no changes)")
    .map((w) => `Watched on its own, because a delete outside a text field removes objects — ${w.step} did this:\n${w.diff}`);
  return [head, ...watched, body, opts.fields].filter(Boolean).join("\n");
}

/** The desktop tools the accessibility bridge owns. This list lives next to
 *  the routing helper on purpose. It used to be a hand-maintained Set beside
 *  the declarations in index.ts, and the two drifted: five tools were added to
 *  the declarations and not to the Set, so every one of them fell through to
 *  the coordinate-based screenshot handler — "click at undefined, undefined" —
 *  and a model spent twelve minutes trying to open an app whose launch verb
 *  silently went nowhere. One list, one test, one startup check. */
export const AX_TOOL_NAMES = [
  "computer_apps",
  "computer_app_screenshot",
  "computer_pointer",
  "computer_app_state",
  "computer_raise",
  "computer_launch",
  "computer_press",
  "computer_set_value",
  "computer_press_key",
  "computer_scroll_view",
  "computer_act",
  "computer_do",
] as const;

/** The older coordinate-and-screenshot tools. All of them when there is no
 *  bridge; while one is alive only computer_screenshot survives, because
 *  looking is the one thing the tree cannot replace — see
 *  screenshotToolsOffered. No name may appear in both lists. Dispatch is by
 *  name, so a shared name goes to whichever family the router checks first,
 *  regardless of which one the model thought it was calling — and the two take
 *  completely different arguments (an element id versus screen coordinates). */
export const SCREENSHOT_TOOL_NAMES = [
  "computer_screenshot",
  "computer_click",
  "computer_type",
  "computer_move",
  "computer_key",
  "computer_scroll",
] as const;

export function routesToAx(tool: string): boolean {
  return (AX_TOOL_NAMES as readonly string[]).includes(tool);
}

/** Whether to put the user in front of the Accessibility switch. macOS will not
 *  grant this from code — a person has to flip it — so the most the app can do
 *  is open the pane. Once per session: a second open yanks focus back out of
 *  the very window they are standing in, and the first one already got them
 *  there. */
export function shouldOpenAccessibilitySettings(opts: { code: string | null; openedBefore: boolean }): boolean {
  return opts.code === "not_trusted" && !opts.openedBefore;
}

/** What the model is told when the grant is missing. Deliberately not a list of
 *  steps: the pane is already open in front of the user, and a five-bullet
 *  walkthrough of a window they are looking at reads as noise. It also no
 *  longer says to fall back to computer_screenshot: a picture of the pane the
 *  user is already looking at does not get the switch flipped, and the point
 *  of this message is the switch. */
export function axNotTrustedText(appName: string, opened: boolean): string {
  const next = opened
    ? `System Settings is now open at Privacy & Security > Accessibility. In one short sentence, tell the user to switch ${appName} on there and say when it is done.`
    : `Tell the user, in one short sentence, to switch ${appName} on in System Settings > Privacy & Security > Accessibility.`;
  return (
    `macOS has not granted Accessibility access to ${appName}, so the desktop tools cannot read or operate other apps. ` +
    `${next} Do not list the steps, and do not retry the desktop tools until they say it is granted.`
  );
}

/** Which of the older screenshot tools to offer. The coordinate and typing
 *  verbs stay off while the bridge is alive — measured: the model reached for
 *  Spotlight and command+k when they were on the menu, while the tree had the
 *  list it needed the whole time. computer_screenshot is different: it is the
 *  only way to SEE something the tree cannot express, computer_app_state's own
 *  description tells the model to reach for it, and without it a stuck model
 *  raises the app to look — measured, once, in a run that otherwise never
 *  raised. Without a bridge they are all that can touch the desktop. */
export function screenshotToolsOffered(opts: { axAlive: boolean }): "all" | "screenshot-only" {
  return opts.axAlive ? "screenshot-only" : "all";
}

/** Whether a coordinate or typing verb may actually RUN. Withholding a tool
 *  from the declarations is not the same as disabling it: the dispatcher sends
 *  every computer_* name that is not an AX tool to the coordinate handler, and
 *  in Full access the consent gate answers "allow" — so a model that remembers
 *  computer_type from an earlier turn, or simply invents it, types at the
 *  desktop with no card and no bridge behind it. That is the Spotlight and
 *  command+k path this whole split exists to close, so the same decision has
 *  to be made twice: once when the menu is built, once at the door. */
export function coordinateToolAllowed(tool: string, mode: "all" | "screenshot-only"): boolean {
  return mode === "all" || tool === "computer_screenshot";
}

/** computer_screenshot's description, in two halves. With the bridge alive the
 *  image is for LOOKING; there is no coordinate verb left to aim with, and a
 *  description that promises "the exact coordinate frame to use for later
 *  computer actions" is an invitation to call a tool that is now refused.
 *  Swapped by value, exactly like the Space sentences. */
/** What an action reports when the bridge's wait ran out with the tree
 *  unchanged. "(no changes)" is a fine answer to a READ; after an ACTION the
 *  model heard it as "nothing there" and pressed again — which, on a Maps
 *  result, opened the card the first press had already asked for, and on a
 *  settings row toggled Location Tracking back.
 *
 *  Voice: facts and options, no imperatives and no anecdotes. Rollout 01a081a0
 *  (2026-09-08) showed the model answering the previous wording — "Do NOT
 *  repeat it… five retries of one dead button cost six turns" — with
 *  "You're right — let me stop…" and a re-plan, three times, with no human in
 *  the loop. A tool result read as a reviewer starts detours. */
export const ACTION_NO_CHANGE_SENTENCE =
  "The app accepted the action and nothing in the tree changed while the bridge waited. The same action again would do the same. Other paths that reach a control: the keyboard (arrows and return choose from a list, escape closes), or a menu bar item — both are in the tree.";

/** The literal call to send after a click died on a parked window.
 *
 *  Prose did not work. Three separate texts told the model to use the keyboard
 *  on a parked window — the bridge's hint, computer_raise's own description
 *  and the bundled skill — and it sent `down` without `return` and then raised
 *  twice anyway. A concrete call is followed where a recommendation is not, so
 *  the reply now ends with the exact thing to send. `down` then `return` in
 *  ONE call, because down alone only moves the selection. */
export function parkedNextCall(app: string): string {
  const keys = '[{"do":"key","key":"down"},{"do":"key","key":"return"}]';
  return (
    `Send one of these next. To pick the item you meant out of the list: computer_do {"app":${JSON.stringify(app)},"steps":${keys}}. ` +
    `To reach a control you cannot press, ask the app for the finished action instead of hunting for the button — set its search field to the whole intent (e.g. "directions to <place>", not "<place>") and commit with the same two keys.`
  );
}

/** The computer-use skill, delivered with the first desktop call of a
 *  conversation instead of hoping the model opens it.
 *
 *  It does open it — twice in the runs measured on 2026-09-06 — but both times
 *  by shelling out to `cat` in the middle of a task, after it had already
 *  stalled, once costing sixteen seconds. Nothing makes a listed skill the
 *  first thing read, so the constraint arrived after the first failure rather
 *  than before the first action. Handing it over on the first call costs its
 *  length once per conversation and removes that whole detour.
 *
 *  The file is the single source of truth; this only strips the frontmatter,
 *  which is addressed to the skill loader rather than to the reader, and
 *  frames the rest so it cannot be mistaken for tool output. */
export const MAX_SKILL_PREAMBLE = 16_000;

export function skillBody(markdown: string): string {
  const withoutFrontmatter = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const trimmed = withoutFrontmatter.trim();
  return trimmed.length > MAX_SKILL_PREAMBLE ? `${trimmed.slice(0, MAX_SKILL_PREAMBLE)}\n…(truncated)` : trimmed;
}

export function skillPreamble(markdown: string): string | null {
  const body = skillBody(markdown);
  if (!body) return null;
  return `=== How to drive desktop apps (read this before acting; sent once per conversation) ===\n${body}\n=== end ===`;
}

/** Whether this call should carry it: a desktop tool, and not sent yet. */
export function shouldSendSkill(tool: string, alreadySent: boolean): boolean {
  if (alreadySent) return false;
  return routesToAx(tool) || tool.startsWith("computer_");
}

/** Put it in front of whatever the tool returned, as its own block, so the
 *  result itself is still the last thing read. */
export function prependSkill<T extends { contentItems: { type: string }[] }>(response: T, preamble: string): T {
  return { ...response, contentItems: [{ type: "inputText" as const, text: preamble }, ...response.contentItems] };
}

/** One line at the top of a read when the app's window is parked.
 *
 *  Until now this was discovered by pressing something and watching it fail.
 *  Measured: one run shelled out to read the bundled skill mid-task — sixteen
 *  seconds — after its first attempts stalled, then redid the search from the
 *  top. Saying it at read time removes the dead press and the whole discovery
 *  detour, and costs nothing: the `windows` call every read already makes
 *  carries the flag.
 *
 *  It names the call rather than describing the route, for the same reason
 *  parkedNextCall does: prose about the keyboard was ignored three times, a
 *  literal call was followed twice. */
export function parkedReadNote(windows: unknown): string | null {
  const list = Array.isArray(windows) ? windows : [];
  const anyParked = list.some((w) => !!w && typeof w === "object" && (w as { parked?: unknown }).parked === true);
  if (!anyParked) return null;
  return (
    "[parked] This window is READABLE but not reliably INTERACTABLE: Stage Manager has shrunk it to a thumbnail, so reads are exact while a press on a row, a card button or a tab is accepted and changes nothing. " +
    "Two paths do work. " +
    'To choose from a list: computer_do with steps [{"do":"key","key":"down"},{"do":"key","key":"return"}]. ' +
    'To reach a control you cannot press: ask the app for the finished action in its search field — set the field to the whole INTENT rather than the object, e.g. "directions to <place>" instead of "<place>", then commit it with those same two keys. Menu bar items are in the tree and also work, and text fields can always be set directly. ' +
    "Do not raise it and do not try to move or resize it: parking follows which app is active, not where the window is."
  );
}

/** One single-action desktop call, remembered so a run of them can be noticed.
 *
 *  Measured on a Figma icon built with native shapes: 91 key presses and 63
 *  value sets, nearly all one per model turn, and turns were running at 15
 *  seconds. Setting one shape's position, size and colour is five turns done
 *  singly and one done as a batch. computer_do already existed and was barely
 *  used, and telling the model to batch has the same record as every other
 *  piece of advice here, so the app notices the run and hands back the literal
 *  call instead. */
export interface RecentEdit {
  tool: string;
  app: string;
  id?: number;
  text?: string;
  key?: string;
  action?: string;
  /** A single pointer click: how many clicks; `path` true means a drawn stroke,
   *  which has no batch step and so cannot be part of a suggested call. */
  clicks?: number;
  path?: boolean;
  /** A computer_do that edited ONE thing: its steps, already in wire form, so
   *  the suggested call can splice them in. Run 6, 2026-09-08: 46 of 53 batches
   *  were the four-keystroke recipe on a single field — one edit per turn wearing
   *  a batch's clothes. */
  steps?: Record<string, unknown>[];
}

export const BATCH_NUDGE_AFTER = 3;

function asStep(e: RecentEdit): Record<string, unknown> | null {
  switch (e.tool) {
    case "computer_press": return e.id === undefined ? null : { do: "press", id: e.id };
    case "computer_act": return e.id === undefined || !e.action ? null : { do: "act", id: e.id, action: e.action };
    case "computer_set_value": return e.id === undefined || e.text === undefined ? null : { do: "set_value", id: e.id, text: e.text };
    case "computer_press_key": return !e.key ? null : { do: "key", key: e.key, ...(e.id !== undefined ? { id: e.id } : {}) };
    case "computer_pointer": return e.id === undefined || e.path ? null : { do: "pointer", id: e.id, ...(e.clicks && e.clicks > 1 ? { clicks: e.clicks } : {}) };
    default: return null;
  }
}

/** The trailing run of single edits on ONE app, as the call that would have
 *  done them together. Null until there are enough of them to be worth saying. */
export function batchNudge(recent: RecentEdit[]): string | null {
  if (recent.length === 0) return null;
  const app = recent[recent.length - 1].app;
  const run: RecentEdit[] = [];
  for (let i = recent.length - 1; i >= 0 && recent[i].app === app; i -= 1) run.unshift(recent[i]);
  if (run.length < BATCH_NUDGE_AFTER) return null;
  const steps = run.flatMap((e) => (e.steps ? e.steps : [asStep(e)]));
  if (steps.some((st) => st === null)) return null;
  return (
    `You have sent ${run.length} separate calls to ${app} in a row, each editing one thing, and each costs a whole turn. ` +
    `They fit in one call: computer_do {"app":${JSON.stringify(app)},"steps":${JSON.stringify(steps)}}. ` +
    "Batch the moves you already know — setting one object's position, size and colour is one call, not five."
  );
}

/** Whether a batch edited a single thing — one field, one control — however
 *  many keystrokes it took. Steps without an id (keys, reads, pictures) are the
 *  means, not the edit. Zero ids is nothing to combine. */
export function isSingleEdit(steps: BatchStep[]): boolean {
  const ids = new Set<number>();
  for (const st of steps) if ("id" in st && typeof st.id === "number") ids.add(st.id);
  return ids.size === 1;
}

/** Batch steps as the wire shape the model would send: `wait_ms` only when
 *  set, internal field names dropped. For splicing into a suggested call. */
export function stepsForNudge(steps: BatchStep[]): Record<string, unknown>[] {
  return steps.map((st) => {
    const { waitMs, ...rest } = st as BatchStep & { waitMs: number };
    return waitMs > 0 ? { ...rest, wait_ms: waitMs } : { ...rest };
  });
}

export function renderActionResult(diff: string, hint?: string | null, nextCall?: string | null): string {
  const body = diff.trim();
  // The bridge's own explanation comes first when it has one: it knows WHY the
  // app ignored the press and which paths work, which is more useful than the
  // generic sentence. The concrete call comes last, where it is read.
  if (!body || body === "(no changes)") {
    return [`Done.`, hint, ACTION_NO_CHANGE_SENTENCE, nextCall].filter(Boolean).join(" ");
  }
  return `Done.\n${body}`;
}

/** Scope, spelled out on the tools the model reads first.
 *
 *  Measured four times: a run finishes the asked-for task and then keeps
 *  going. The worst spent 35 of its 127 seconds pressing Walk, Transit, Drive,
 *  Cycle and Drive again for a request that named no travel mode; another
 *  enabled Location Tracking on its own.
 *
 *  Framed as what FINISHED looks like rather than as a list of prohibitions.
 *  The prohibition wording lost every time, and a model that knows the answer
 *  is already on screen has a reason to stop, where one told not to explore
 *  only has a rule to weigh. Still prose, so still unproven — the mechanisms
 *  around it are what actually hold. */
export const TASK_DISCIPLINE_SENTENCE =
  "When the app already shows what was asked for, that IS the answer: report it from the tree and stop. A request for directions is answered by the route on screen, not by comparing every travel mode; a request to find something is answered when it is on screen. Nothing else is part of the task: do not change the app's settings (location, permissions, preferences), and do not send an action twice to be sure it took. ";

export const SCREENSHOT_FRAME_SENTENCE =
  "The result states the exact coordinate frame to use for later computer actions; it is scaled down from the display, so never assume the display resolution.";
export const SCREENSHOT_LOOK_ONLY_SENTENCE =
  "Use it to SEE what the tree cannot express — whether a video is actually playing, a canvas, a rendered chart. It is not for aiming: there are no coordinate actions while the accessibility bridge is running, so act through element ids from computer_app_state.";

/** Appended to computer_screenshot while the bridge reads across Spaces. In
 *  run 3 of the Maps task the model wanted to LOOK, took a screenshot of a
 *  Space Maps was not on, and raised Maps to see it — twice. The picture of a
 *  window on another Space is computer_app_screenshot's job. */
export const SCREENSHOT_SPACE_SENTENCE =
  " It shows the CURRENT Space only: an app whose windows are on another Space is not in this picture, and raising it to look takes over the user's screen. To see that app, call computer_app_screenshot instead.";

export function withScreenshotGuidance<T extends { name: string; description: string }>(tool: T, mode: "all" | "screenshot-only", crossSpace = false): T {
  if (tool.name !== "computer_screenshot") return tool;
  let description = tool.description;
  if (mode === "screenshot-only") description = description.replace(SCREENSHOT_FRAME_SENTENCE, SCREENSHOT_LOOK_ONLY_SENTENCE);
  if (crossSpace) description += SCREENSHOT_SPACE_SENTENCE;
  return description === tool.description ? tool : { ...tool, description };
}

/** Whether a read that found nothing should raise and try again by itself.
 *  Only for an app this conversation already raised: the user consented to
 *  that app coming forward once, and it drifting back off-Space between two
 *  actions is not a new decision — it is the same one, undone. Measured: one
 *  working run spent a third of its calls re-asking for a raise it had
 *  already been given.
 *  Never when the bridge reads across Spaces: the window is in the tree where
 *  it is, and "0 windows here" is no longer a problem to recover from.
 *  Measured before that: 9 automatic raises in four minutes, each one undoing
 *  the user's return to their own Space. */
export function shouldRecoverRaise(s: { windowsHere: number; offscreen: number; raisedBefore: boolean; crossSpace: boolean }): boolean {
  return !s.crossSpace && s.raisedBefore && s.windowsHere === 0 && s.offscreen > 0;
}

export type AxResult = Record<string, unknown>;
type Pending = { resolve: (r: AxResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** One finished bridge call, for diagnostics. The point is to see where a
 *  slow task spends its time: the Maps run that took 2m36s had ~16 model turns
 *  and every bridge call under two seconds, but the log only showed acting
 *  calls, with start times and nothing else — so reads were invisible and
 *  bridge time could not be told from model time. */
export interface AxCallInfo {
  method: string;
  app: string | null;
  /** Wall time of the round trip, including the bridge's settle wait. */
  ms: number;
  /** How long the bridge waited for the app to react (actions only). */
  waitedMs: number | null;
  /** Size of the reply and lines in the tree or diff it carried. */
  bytes: number;
  lines: number;
  /** Read options in force, e.g. "interactive,query". */
  flags: string;
  /** Result facts worth a glance in the log: "shown" for a launch that showed
   *  the app once, "blank" for a picture with nothing in it. */
  marks: string;
  error: string | null;
}

export function describeAxCall(c: AxCallInfo): string {
  const where = c.app ? ` ${c.app}` : "";
  const flags = c.flags ? ` [${c.flags}]` : "";
  const waited = c.waitedMs !== null ? ` (waited ${c.waitedMs}ms)` : "";
  const err = c.error ? ` ERROR ${c.error}` : "";
  const marks = c.marks ? ` [${c.marks}]` : "";
  return `call ${c.method}${where}${flags} ${c.ms}ms${waited} ${c.lines} lines ${c.bytes}B${marks}${err}`;
}

/** One long-running bridge process. Ids and diffs live in that process, so it
 *  is spawned once and kept. A request that gets no answer times out rather
 *  than hanging a turn; an exit rejects everything in flight. */
export class AxClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  alive = false;
  trusted = false;
  /** Whether the bridge reads windows on other Spaces. False means today's
   *  behaviour: reads carry raise hints and the app keeps its raise recovery.
   *  The bridge decides this lazily and can turn it on after start — see
   *  refreshCrossSpace. */
  crossSpace = false;
  /** How long refreshCrossSpace waits for its hello. A field, not a
   *  constructor argument, so a test can shorten it without a new ctor shape. */
  helloTimeoutMs = AX_HELLO_TIMEOUT_MS;
  /** Called once per finished request with its timing and size. */
  onCall: ((call: AxCallInfo) => void) | null = null;

  constructor(
    private readonly manifest: AxManifest,
    private readonly timeoutMs = AX_REQUEST_TIMEOUT_MS,
  ) {}

  async start(): Promise<{ trusted: boolean; crossSpace: boolean; version: string }> {
    const proc = spawn(this.manifest.entryPath, this.manifest.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    this.alive = true;
    createInterface({ input: proc.stdout! }).on("line", (line) => this.onLine(line));
    createInterface({ input: proc.stderr! }).on("line", (line) => console.warn(`[ax] ${line}`));
    const died = (why: string) => {
      this.alive = false;
      // Node closes a dead child's stdout/stderr readers but never its stdin
      // writer; that one open pipe is enough to keep the event loop alive.
      proc.stdin?.destroy();
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new AxError("bridge_exited", why));
      }
      this.pending.clear();
    };
    proc.on("exit", (code, signal) => died(`unbiased-ax exited (${code ?? signal})`));
    proc.on("error", (err) => died(`unbiased-ax failed to start: ${err.message}`));
    // The bridge is normally spawned already trusted, so THIS hello is the one
    // that runs its cross-Space self-check — give it the self-check's budget,
    // not the ordinary request budget. A timeout here kills the bridge.
    const hello = await this.request("hello", {}, this.helloTimeoutMs);
    if (hello.protocolVersion !== AX_PROTOCOL_VERSION) {
      this.stop();
      throw new AxError("protocol", `bridge speaks protocol ${String(hello.protocolVersion)}`);
    }
    this.readHello(hello);
    return { trusted: this.trusted, crossSpace: this.crossSpace, version: this.manifest.version };
  }

  private readHello(hello: AxResult): void {
    this.trusted = hello.trusted === true;
    this.crossSpace = hello.crossSpace === true;
  }

  /** Ask again whether the bridge reads across Spaces. Its verdict is decided
   *  on the first trusted call that finds an app to witness with, so a bridge
   *  spawned before the Accessibility grant, or on an empty Space, says false
   *  at start and true later. One cheap IPC while false; nothing once true.
   *  Silent on failure: the flag simply stays where it was. Returns true the
   *  one time the flag turns on. */
  async refreshCrossSpace(): Promise<boolean> {
    if (this.crossSpace || !this.alive) return false;
    try {
      this.readHello(await this.request("hello", {}, this.helloTimeoutMs));
    } catch {
      // the bridge may be busy or gone; the next read will say so
      return false;
    }
    // The early return guaranteed the flag was false, so true here is the flip.
    return this.crossSpace;
  }

  /** `timeoutMs` overrides the client default for one call: a `windows` read
   *  can afford far less patience than a `tree` of a browser with fifty tabs. */
  request(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<AxResult> {
    if (!this.alive || !this.proc?.stdin) return Promise.reject(new AxError("bridge_exited", "unbiased-ax is not running"));
    const id = this.nextId++;
    const started = Date.now();
    return new Promise<AxResult>((resolve, reject) => {
      const done = (r: AxResult | null, e: Error | null) => {
        this.report(method, params, started, r, e);
        if (e) reject(e);
        else resolve(r ?? {});
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done(null, new AxError("timeout", `${method} did not answer within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (r) => done(r, null), reject: (e) => done(null, e), timer });
      this.proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private report(method: string, params: Record<string, unknown>, started: number, r: AxResult | null, e: Error | null): void {
    if (!this.onCall) return;
    const text = typeof r?.diff === "string" ? r.diff : typeof r?.tree === "string" ? r.tree : null;
    const flags: string[] = [];
    for (const k of ["full", "web", "interactive"]) if (params[k] === true) flags.push(k);
    if (typeof params.query === "string") flags.push("query");
    try {
      this.onCall({
        method,
        app: typeof params.app === "string" ? params.app : null,
        ms: Date.now() - started,
        waitedMs: typeof r?.waitedMs === "number" ? r.waitedMs : null,
        bytes: r ? JSON.stringify(r).length : 0,
        lines: text ? text.split("\n").length : 0,
        flags: flags.join(","),
        marks: (["shown", "blank"] as const).filter((k) => r?.[k] === true).join(","),
        error: e ? e.message : null,
      });
    } catch {
      // diagnostics must never break a request
    }
  }

  private onLine(line: string): void {
    let msg: { id?: unknown; result?: AxResult; error?: { code?: string; message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours; the bridge only writes JSON to stdout
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new AxError(msg.error.code ?? "error", msg.error.message ?? "bridge error"));
    else p.resolve(msg.result ?? {});
  }

  stop(): void {
    this.proc?.stdin?.end();
    this.proc?.kill();
    this.alive = false;
  }
}

/** id -> element line, accumulated across every tree and diff the model saw of
 *  an app. A diff omits unchanged elements, so the last text alone cannot name
 *  an id the model read two turns ago; the index can. */
export function indexElementLines(text: string, into: Map<number, string> = new Map()): Map<number, string> {
  for (const line of text.split("\n")) {
    const m = /^[~+]?\s*(\d+)\s+(.*)$/.exec(line);
    if (m) into.set(Number(m[1]), m[2]!.trim());
  }
  return into;
}

/** What the approval card says: `press #643 in Brave — link "Tame Impala…"`,
 *  not a bare number. Kept short; the reason text below carries the rest. */
export function describeAxAction(tool: string, rawArgs: unknown, lines?: Map<number, string>): string {
  const a = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const app = typeof a.app === "string" && a.app ? a.app : "the app";
  const clip = (s: string) => (s.length > 60 ? s.slice(0, 60) + "…" : s);
  switch (tool) {
    case "computer_apps":
      return "List running apps";
    case "computer_app_state":
      return `Read the UI of ${app}`;
    case "computer_app_screenshot":
      return `Photograph ${app}'s window`;
    case "computer_pointer": {
      const path = Array.isArray((a as { path?: unknown }).path) ? ((a as { path: unknown[] }).path) : [];
      const id = typeof a.id === "number" ? a.id : null;
      const line = id !== null ? lines?.get(id) : null;
      const inside = line ? ` inside #${id} — ${clip(line)}` : id !== null ? ` inside #${id}` : "";
      // The card has to say this MOVES THE POINTER: it is the only desktop
      // verb that touches the user's own cursor rather than the app's tree.
      return `${a.hold === true ? "Drag" : "Click"} the pointer at ${path.length} point(s)${inside} in ${app}`;
    }
    case "computer_raise":
      return `Bring ${app} to the front`;
    case "computer_launch":
      return `Open ${app}`;
    case "computer_do": {
      const parsed = parseBatchSteps((a as { steps?: unknown }).steps);
      // A batch whose steps do not parse still has to produce a card, because
      // the card is shown before the call is made.
      if ((a as { candidates?: unknown }).candidates !== undefined) {
        const routes = parseCandidates((a as { candidates?: unknown }).candidates);
        return "error" in routes ? `Try alternatives in ${app}` : describeCandidates(app, routes.candidates, lines);
      }
      return "error" in parsed ? `Run steps in ${app}` : describeBatch(app, parsed.steps, lines);
    }
    case "computer_press":
    case "computer_set_value":
    case "computer_press_key":
    case "computer_scroll_view":
    case "computer_act": {
      const id = typeof a.id === "number" ? a.id : null;
      const line = id !== null ? lines?.get(id) ?? null : null;
      const target = id !== null ? `#${id} in ${app}${line ? ` — ${clip(line)}` : ""}` : app;
      if (tool === "computer_scroll_view") return `Scroll ${typeof a.direction === "string" ? a.direction : "down"} in ${app}`;
      // The verb comes from the tool now, but a model with older habits still
      // sends value/key on computer_act. Those are routed rather than silently
      // turned into a press, so the card has to describe them truthfully too.
      const text = typeof a.text === "string" ? a.text : typeof a.value === "string" ? a.value : null;
      const key = typeof a.key === "string" ? a.key : null;
      if (tool === "computer_press_key" || (tool === "computer_act" && key)) return `Press ${key ?? "a key"} in ${app}`;
      if (tool === "computer_set_value" || (tool === "computer_act" && text !== null)) return `Set ${target} to "${clip(text ?? "")}"`;
      if (tool === "computer_press") return `Press ${target}`;
      return `${typeof a.action === "string" ? a.action : "press"} ${target}`;
    }
    default:
      return tool;
  }
}

/** The parts of the tool descriptions that are about Spaces, and what they
 *  become once the bridge reads across them. Kept here, not in index.ts, so
 *  they are tested; index.ts builds its literal AX_TOOLS from the "off"
 *  versions and rewrites at the point the list is handed to the model. */
export const APP_STATE_SPACE_SENTENCE =
  "If the result says every window is on another Space, the app is NOT in the tree — call computer_raise once, then read again. If windows ARE listed, work with them and do not raise. ";
export const APP_STATE_SPACE_SENTENCE_CROSS =
  "Windows on another Space are in the tree and work like any other — never raise to read or act; a window line marked [other Space] is still fully usable. ";
export const RAISE_DESCRIPTION =
  "Bring an app to the front, switching Spaces if its windows are elsewhere. This TAKES OVER the user's screen, so use it in exactly one case: computer_app_state reported that every window of the app is on another Space, which means the app is not in the tree and cannot be read or acted on until it is raised. Never raise to read or press an app whose windows are already listed. Never raise because presses are not landing: when Stage Manager has parked a window as a thumbnail, raising un-parks it only while the app is in front and it re-parks the moment focus moves on, so use the keyboard and the menu bar instead. This always requires explicit user approval.";
export const RAISE_DESCRIPTION_CROSS =
  "Bring an app to the front, switching Spaces if its windows are elsewhere. This TAKES OVER the user's screen. Reading and acting never need it — every window is in the tree wherever it is — so use it only when the user asked to SEE the app. Not to look at it either: computer_app_screenshot photographs the window where it is, and what that picture leaves blank is content the app draws only on screen — report that to the user rather than raising. This always requires explicit user approval.";
export const LAUNCH_FRONT_SENTENCE =
  "This brings the app to the front, which is what opening an app means.";
export const LAUNCH_FRONT_SENTENCE_CROSS =
  "It opens in the background: the tree is readable without bringing the app forward, and the user keeps their screen.";

export function withSpaceGuidance<T extends { name: string; description: string }>(tool: T, crossSpace: boolean): T {
  if (!crossSpace) return tool;
  switch (tool.name) {
    case "computer_raise":
      return { ...tool, description: RAISE_DESCRIPTION_CROSS };
    case "computer_app_state":
      return { ...tool, description: tool.description.replace(APP_STATE_SPACE_SENTENCE, APP_STATE_SPACE_SENTENCE_CROSS) };
    case "computer_launch":
      return { ...tool, description: tool.description.replace(LAUNCH_FRONT_SENTENCE, LAUNCH_FRONT_SENTENCE_CROSS) };
    default:
      return tool;
  }
}

/** What the read appends when it lists windows on another Space. The tool
 *  descriptions are fixed when a thread starts, so a thread opened while the
 *  bridge was still undecided keeps the "off" text — which tells the model to
 *  raise when every window is elsewhere, exactly what a read full of
 *  [other Space] lines looks like. The result is composed per call, so the
 *  guidance there is always current. Empty when there is nothing to say. */
export function otherSpaceNote(crossSpace: boolean, windowsText: string): string {
  return crossSpace && windowsText.includes("[other Space]") ? "Windows marked [other Space] are in the tree and readable; do not raise." : "";
}

/** What a launch result means. The bridge returns ok:true at its deadline as
 *  long as the app is RUNNING; only a window line in the tree proves it is
 *  readable. A tree of the application and its menu bar alone is not. The
 *  line shape is the bridge's Formatter.line: `<id> <indent><role> "title" …`,
 *  and a real window renders as one of these three lowercase roles. */
export function launchOutcome(tree: string): "readable" | "running" {
  return /^\s*\d+\s+(standard window|window|dialog)\b/m.test(tree) ? "readable" : "running";
}
