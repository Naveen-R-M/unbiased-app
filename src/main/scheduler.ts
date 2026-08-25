// Scheduled tasks: the store and the calendar arithmetic.
//
// The engine has no scheduler. `ScheduledTaskSummary` exists in the protocol
// schema, but only inside `plugin/read` — it is metadata a plugin declares
// about tasks it offers, and there is no method to create, list, or fire one.
// So the clock lives here, in the app.
//
// The schedule shapes below are deliberately the engine's own
// (`ScheduledTaskSchedule` in schema/v2/PluginReadResponse.json): hourly,
// daily, weekdays, weekly, with two-letter weekdays. If the engine ever grows
// a real scheduling API, these records cross the wire unchanged.
//
// This module is pure except for the two file functions, so the date maths —
// the part that is actually easy to get wrong — can be exercised on its own.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

/** Index by JS `Date.getDay()` (0 = Sunday). */
const WEEKDAY_BY_DAY: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR"];

export type ScheduleSpec =
  | { type: "hourly"; intervalHours: number; days?: Weekday[] | null }
  | { type: "daily"; time: string }
  | { type: "weekdays"; time: string }
  | { type: "weekly"; days: Weekday[]; time: string };

export type RunStatus = "completed" | "failed" | "interrupted";

export type ScheduledTask = {
  key: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
  enabled: boolean;
  /** Working directory for the run. null = the default chat directory. */
  projectPath: string | null;
  createdAt: string;
  /** Where the next due time is measured from. Advanced by a run AND by a
   *  catch-up deferral, which is why it is not the same field as lastRunAt:
   *  conflating them either re-fires a missed task immediately on launch or
   *  records a run that never happened. */
  cursorAt: string;
  /** Last real execution. null until the task has actually run once. */
  lastRunAt: string | null;
  lastStatus: RunStatus | null;
  lastError: string | null;
  lastThreadId: string | null;
  /** Set when the schedule came due while the app was closed. Cleared by the
   *  next run. The UI turns this into a "Missed" row with Run now. */
  missedAt: string | null;
};

export const MAX_TASKS = 50;
export const MAX_PROMPT_CHARS = 8000;
export const MAX_NAME_CHARS = 80;

// ── Validation ──────────────────────────────────────────────────────────

/** "HH:MM" in 24-hour form → minutes since midnight, or null if malformed. */
export function parseTime(time: unknown): { h: number; m: number } | null {
  if (typeof time !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

function isWeekday(v: unknown): v is Weekday {
  return typeof v === "string" && (WEEKDAY_BY_DAY as string[]).includes(v);
}

/** Narrow unknown JSON into a ScheduleSpec, or explain why it isn't one. */
export function validateSchedule(raw: unknown): { schedule: ScheduleSpec } | { error: string } {
  const s = raw as { type?: unknown };
  if (!s || typeof s !== "object") return { error: "A schedule is required." };
  if (s.type === "hourly") {
    const n = (s as { intervalHours?: unknown }).intervalHours;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 24) {
      return { error: "Repeat every N hours needs a whole number from 1 to 24." };
    }
    const rawDays = (s as { days?: unknown }).days;
    if (rawDays !== undefined && rawDays !== null) {
      if (!Array.isArray(rawDays) || !rawDays.every(isWeekday)) return { error: "Unrecognised day." };
      // An empty list would never fire; treat it as "no restriction" rather
      // than silently accepting a task that can never run.
      return { schedule: { type: "hourly", intervalHours: n, days: rawDays.length ? [...new Set(rawDays)] : null } };
    }
    return { schedule: { type: "hourly", intervalHours: n, days: null } };
  }
  if (s.type === "daily" || s.type === "weekdays") {
    const t = parseTime((s as { time?: unknown }).time);
    if (!t) return { error: "Time needs to look like 08:00." };
    return { schedule: { type: s.type, time: `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}` } };
  }
  if (s.type === "weekly") {
    const t = parseTime((s as { time?: unknown }).time);
    if (!t) return { error: "Time needs to look like 16:00." };
    const days = (s as { days?: unknown }).days;
    if (!Array.isArray(days) || days.length === 0 || !days.every(isWeekday)) {
      return { error: "Pick at least one day of the week." };
    }
    return {
      schedule: {
        type: "weekly",
        days: [...new Set(days)],
        time: `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`,
      },
    };
  }
  return { error: "Unrecognised schedule type." };
}

// ── The calendar ────────────────────────────────────────────────────────

function atTime(day: Date, h: number, m: number): Date {
  // Local time on purpose: "8am" means 8am where the user is, and it should
  // keep meaning that across a DST boundary. Constructing from local parts
  // (rather than adding 24h to a timestamp) is what makes that true.
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), 0, 0);
}

/**
 * The first firing strictly after `from`.
 *
 * `anchor` only matters for hourly schedules, which have no wall-clock time to
 * latch onto — they step from the task's creation instant so that "every 3
 * hours" stays on the same offsets instead of drifting with each run.
 */
export function nextDueAt(schedule: ScheduleSpec, from: Date, anchor: Date): Date {
  if (schedule.type === "hourly") {
    const step = schedule.intervalHours * 3_600_000;
    const elapsed = from.getTime() - anchor.getTime();
    // Strictly after `from`: floor+1 rather than ceil, so landing exactly on a
    // boundary yields the NEXT one instead of returning `from` itself.
    const k = elapsed < 0 ? 0 : Math.floor(elapsed / step) + 1;
    let next = new Date(anchor.getTime() + k * step);
    const allowed = schedule.days;
    if (allowed && allowed.length) {
      // Walk forward whole steps until the slot lands on a permitted day. The
      // bound is generous but finite — a day filter can skip at most a week,
      // and an unbounded loop here would hang the tick.
      for (let i = 0; i < 24 * 8 && !allowed.includes(WEEKDAY_BY_DAY[next.getDay()]); i++) {
        next = new Date(next.getTime() + step);
      }
    }
    return next;
  }

  const t = parseTime(schedule.time)!;
  const allowed: Weekday[] | null =
    schedule.type === "daily" ? null : schedule.type === "weekdays" ? WEEKDAYS : schedule.days;

  // Today, then the next seven days — enough to satisfy any weekday set.
  for (let i = 0; i <= 8; i++) {
    const candidate = atTime(addDays(from, i), t.h, t.m);
    if (candidate.getTime() <= from.getTime()) continue;
    if (allowed && !allowed.includes(WEEKDAY_BY_DAY[candidate.getDay()])) continue;
    return candidate;
  }
  // Unreachable for a validated schedule (every set has a day within a week),
  // but returning a real date beats returning undefined into date maths.
  return atTime(addDays(from, 9), t.h, t.m);
}

/** The moment this task is next expected to fire. */
export function dueAt(task: ScheduledTask): Date {
  return nextDueAt(task.schedule, new Date(task.cursorAt), new Date(task.createdAt));
}

export function isDue(task: ScheduledTask, now: Date): boolean {
  return task.enabled && dueAt(task).getTime() <= now.getTime();
}

// ── The store ───────────────────────────────────────────────────────────

export function scheduledTasksFile(userDataDir: string): string {
  return join(userDataDir, "scheduled-tasks.json");
}

/** Drop anything that isn't a well-formed task rather than letting one bad
 *  record take the whole list down — the same "unreadable means empty"
 *  posture the app's other stores take, but per row. */
export function loadTasks(userDataDir: string): ScheduledTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(scheduledTasksFile(userDataDir), "utf8"));
  } catch {
    return [];
  }
  const rows = (parsed as { tasks?: unknown })?.tasks;
  if (!Array.isArray(rows)) return [];
  const out: ScheduledTask[] = [];
  for (const row of rows) {
    const r = row as Partial<ScheduledTask>;
    if (typeof r.key !== "string" || typeof r.name !== "string" || typeof r.prompt !== "string") continue;
    const checked = validateSchedule(r.schedule);
    if ("error" in checked) continue;
    const createdAt = typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString();
    out.push({
      key: r.key,
      name: r.name,
      prompt: r.prompt,
      schedule: checked.schedule,
      enabled: r.enabled !== false,
      projectPath: typeof r.projectPath === "string" ? r.projectPath : null,
      createdAt,
      cursorAt: typeof r.cursorAt === "string" ? r.cursorAt : createdAt,
      lastRunAt: typeof r.lastRunAt === "string" ? r.lastRunAt : null,
      lastStatus:
        r.lastStatus === "completed" || r.lastStatus === "failed" || r.lastStatus === "interrupted"
          ? r.lastStatus
          : null,
      lastError: typeof r.lastError === "string" ? r.lastError : null,
      lastThreadId: typeof r.lastThreadId === "string" ? r.lastThreadId : null,
      missedAt: typeof r.missedAt === "string" ? r.missedAt : null,
    });
  }
  return out;
}

/** Write-then-rename, matching mcp-servers.json: a crash mid-write leaves the
 *  previous list intact rather than a truncated file. Not 0600 — these hold no
 *  secret, and the prompts are the user's own words. */
export function saveTasks(userDataDir: string, tasks: ScheduledTask[]): void {
  const path = scheduledTasksFile(userDataDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ tasks }, null, 2) + "\n");
  renameSync(tmp, path);
}
