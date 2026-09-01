// The learning sidecar client: observe-only.
//
// The sidecar (Work/learning-algorithm) records what the agent did, scores it,
// and distills lessons. This phase FEEDS it and nothing else — no lesson ever
// rides a real prompt from here. That order is deliberate: the sidecar's own
// gate for injection is a replay report saying lessons would have been
// available and sane, and on real data that report currently says the
// deterministic scorer puts most tasks at the ceiling and that its retrieval
// hit rate is an in-sample artifact. So we build the corpus first — including
// the signals only this side has (approvals, interrupts, and the user's own
// verdict on a saved memory) — and decide about injection from evidence.
//
// Two rules govern everything below:
//   1. Learning must never stall the UI. Every call is fire-and-forget, the
//      queue is bounded and drops rather than grows, and a dead sidecar is a
//      no-op rather than an error path the user can see.
//   2. The app declares scope and identity; the sidecar never infers them.
//      projectKey is resolved here the way memory resolves it (a worktree
//      belongs to its parent project), because cwd cannot tell /a/api from
//      /b/api and the sidecar has no worktree knowledge.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** The protocol version this client speaks. A sidecar advertising anything
 *  else is refused rather than guessed at — the version lives in the bundle's
 *  manifest precisely so the two cannot drift silently. */
export const LEARNING_PROTOCOL_VERSION = 1;

/** Matches the sidecar's own SUMMARY_MAX. A summary is a label, not a log. */
export const LEARNING_SUMMARY_MAX = 400;

// ── The manifest ──────────────────────────────────────────────────────────
// `npm run bundle` in the sidecar emits dist/sidecar/{sidecar.json,entry}.
// The manifest says HOW to run it; this file only decides WHERE to look. A
// future compiled build changes the manifest, not this client.

export type SidecarManifest = {
  entryPath: string;
  args: string[];
  protocolVersion: number;
  version: string;
  minNodeVersion: string | null;
};

/** null = no sidecar installed, which is a normal state and not an error.
 *  `{error}` = a sidecar is there but we will not run it, with a reason worth
 *  logging once. */
export function readSidecarManifest(dir: string): SidecarManifest | { error: string } | null {
  const manifestPath = join(dir, "sidecar.json");
  if (!existsSync(manifestPath)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    return { error: `sidecar.json is not readable JSON: ${String(err)}` };
  }
  if (typeof raw.protocolVersion !== "number") return { error: "sidecar.json has no numeric protocolVersion" };
  if (raw.protocolVersion !== LEARNING_PROTOCOL_VERSION) {
    return {
      error: `sidecar speaks protocol ${raw.protocolVersion}, this app speaks ${LEARNING_PROTOCOL_VERSION}`,
    };
  }
  // Only "node" today: spawn the host's own runtime. Electron does that with
  // ELECTRON_RUN_AS_NODE=1, set by the launcher below.
  if (raw.runtime !== "node") return { error: `unsupported sidecar runtime ${JSON.stringify(raw.runtime)}` };
  if (typeof raw.entry !== "string" || !raw.entry) return { error: "sidecar.json has no entry" };
  // The entry is a path from a file on disk, so it gets the same treatment any
  // other such path gets: it must stay inside the bundle.
  const entryPath = resolve(dir, raw.entry);
  if (!entryPath.startsWith(resolve(dir) + sep)) return { error: `entry escapes the bundle: ${raw.entry}` };
  if (!existsSync(entryPath)) return { error: `entry does not exist: ${entryPath}` };
  return {
    entryPath,
    args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [],
    protocolVersion: raw.protocolVersion,
    version: typeof raw.version === "string" ? raw.version : "unknown",
    minNodeVersion: typeof raw.minNodeVersion === "string" ? raw.minNodeVersion : null,
  };
}

// ── Redaction ─────────────────────────────────────────────────────────────
// The sidecar REFUSES any event whose summary still looks like a secret, so an
// unredacted summary is a silently dropped event. Its redactor is the source
// of truth (learning-algorithm/src/core/redact.ts); these patterns mirror it,
// and the duplication is deliberate — the alternative is shipping a secret to
// a store that then feeds it back into prompts. Keep the two in step.

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bgh[poust]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abps]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
];
const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))\s*[=:]\s*\S+/gi;

/** Redact, collapse whitespace, then bound. Bounded last so a redaction can
 *  never be cut in half and leave a fragment of the secret behind. */
export function redactForLearning(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "«redacted»");
  out = out.replace(SECRET_ASSIGNMENT, (_m, name: string) => `${name}=«redacted»`);
  return out.replace(/\s+/g, " ").trim().slice(0, LEARNING_SUMMARY_MAX);
}

// ── Events ────────────────────────────────────────────────────────────────

export type LearningEventKind =
  | "task_meta"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_output"
  | "file_change"
  | "approval_requested"
  | "approval_decision"
  | "token_usage"
  | "turn_completed";

export type LearningEvent = {
  id: string;
  taskId: string;
  turnId: string | null;
  seq: number;
  at: string;
  kind: LearningEventKind;
  source: "app";
  summary: string;
  data: Record<string, unknown>;
};

let seqCounter = 0;

export function buildEvent(args: {
  kind: LearningEventKind;
  threadId: string;
  turnId?: string | null;
  summary: string;
  data?: Record<string, unknown>;
}): LearningEvent {
  const seq = ++seqCounter;
  return {
    // Unique per app run and per event; the store treats a duplicate id as a
    // no-op, so a retry can never double-count.
    id: `app-${Date.now().toString(36)}-${seq.toString(36)}`,
    taskId: args.threadId,
    turnId: args.turnId ?? null,
    seq,
    at: new Date().toISOString(),
    kind: args.kind,
    source: "app",
    summary: redactForLearning(args.summary),
    data: args.data ?? {},
  };
}

/** The scope-bearing event. projectKey is what makes a lesson belong to a
 *  project rather than to a directory. */
export function buildTaskMeta(args: {
  threadId: string;
  cwd: string | null;
  projectKey: string | null;
  model?: string | null;
}): LearningEvent {
  return buildEvent({
    kind: "task_meta",
    threadId: args.threadId,
    summary: args.projectKey ?? args.cwd ?? "(no project)",
    data: {
      cwd: args.cwd,
      projectKey: args.projectKey,
      ...(args.model ? { model: args.model } : {}),
    },
  });
}

// ── The queue ─────────────────────────────────────────────────────────────

/** Bounded, drop-oldest, never-throwing. The sidecar's own protocol doc says
 *  the UI must never stall on learning; this is that promise on our side.
 *  Drop-oldest rather than drop-newest because a full queue means the sidecar
 *  is wedged, and the recent events are the ones still worth having. */
export class EventQueue {
  private buf: LearningEvent[] = [];
  private flushing: Promise<void> | null = null;
  dropped = 0;

  constructor(private opts: { capacity: number; send: (batch: LearningEvent[]) => Promise<void> }) {}

  get size(): number {
    return this.buf.length;
  }

  push(e: LearningEvent): void {
    this.buf.push(e);
    while (this.buf.length > this.opts.capacity) {
      this.buf.shift();
      this.dropped++;
    }
  }

  /** Never rejects. A send failure loses that batch and the queue stays
   *  usable — a sidecar that died mid-session must not take the app with it. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.buf.length) return;
    const batch = this.buf;
    this.buf = [];
    this.flushing = (async () => {
      try {
        await this.opts.send(batch);
      } catch {
        /* the batch is gone; the queue lives on */
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }
}

// ── The client ────────────────────────────────────────────────────────────

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Mirrors EngineClient's framing and its process-identity guard: a dead
 *  child's exit must never reject the live child's calls. */
export class LearningClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ready = false;
  private queue: EventQueue;
  private idle = true;
  /** One log line per failure mode, not one per event. */
  private warned = new Set<string>();

  constructor(private manifest: SidecarManifest, private dbPath: string) {
    this.queue = new EventQueue({
      capacity: 2000,
      send: (batch) => this.request("event/batchAppend", { events: batch }).then(() => undefined),
    });
  }

  get isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    const proc = spawn(process.execPath, [this.manifest.entryPath, ...this.manifest.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // The manifest's "node" runtime, in Electron terms.
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    this.proc = proc;
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      if (this.proc !== proc) return; // a previous child, still talking
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        return; // the sidecar may log non-JSON; not ours to interpret
      }
      if (typeof msg.id !== "number") return; // no server→client requests exist
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "sidecar error"));
      else p.resolve(msg.result);
    });
    proc.stderr?.on("data", (d) => this.warnOnce("stderr", `[learning] ${String(d).trim()}`));
    proc.on("exit", (code) => {
      if (this.proc !== proc) return;
      this.ready = false;
      this.proc = null;
      for (const [, p] of this.pending) p.reject(new Error("sidecar exited"));
      this.pending.clear();
      this.warnOnce("exit", `[learning] sidecar exited (${code}); learning is off for this session`);
    });

    const res = (await this.request("learning/initialize", {
      protocolVersion: LEARNING_PROTOCOL_VERSION,
      clientInfo: { name: "unbiased_app", version: process.env.npm_package_version ?? "0.0.0" },
      dbPath: this.dbPath,
      // Paid judging stays off here. Phase 1 is about building a corpus; the
      // judge is a separate, explicit decision with a budget attached.
      judge: { mode: "mock", enabled: false, maxInFlight: 1, onlyWhenIdle: true, monthlyBudgetUsd: 0 },
    })) as { protocolVersion?: number };
    if (res?.protocolVersion !== LEARNING_PROTOCOL_VERSION) {
      throw new Error(`sidecar handshake returned protocol ${res?.protocolVersion}`);
    }
    this.ready = true;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const proc = this.proc;
    if (!proc?.stdin?.writable) return Promise.reject(new Error("sidecar not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.stdin!.write(JSON.stringify({ method, id, params }) + "\n");
      // The sidecar answers synchronously for everything except judge/run,
      // which we never call. A timeout still exists so a wedged child cannot
      // leave a promise (and its batch) pinned forever.
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 10_000).unref?.();
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const proc = this.proc;
    if (!proc?.stdin?.writable) return;
    try {
      proc.stdin.write(JSON.stringify({ method, params }) + "\n");
    } catch {
      /* fire-and-forget by definition */
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  /** Observe an event. Never awaits, never throws. */
  observe(e: LearningEvent): void {
    if (!this.ready) return;
    this.queue.push(e);
  }

  /** Flush what has been observed. Called at turn boundaries — the natural
   *  point where the app is between pieces of work. */
  flush(): void {
    if (!this.ready) return;
    void this.queue.flush();
  }

  /** The governor treats unknown as busy, so this must be reported honestly:
   *  a judge call must never compete with the user's own turn for the
   *  gateway's per-org concurrency. */
  setIdle(idle: boolean): void {
    if (!this.ready || idle === this.idle) return;
    this.idle = idle;
    this.notify("health/idle", { idle });
  }

  /** The user rejected what a lesson became. This is the negative label the
   *  corpus has none of, and it is free. */
  refuteLesson(lessonId: string, reason: string): void {
    if (!this.ready) return;
    void this.request("lessons/refute", { lessonId, reason }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    await this.queue.flush().catch(() => undefined);
    this.ready = false;
    this.proc = null;
    try {
      proc.stdin?.end();
    } catch {
      /* already gone */
    }
    // The sidecar finishes in-flight work before exiting, and it owns no work
    // we are waiting on, so this grace is short and then it is killed.
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
    timer.unref?.();
  }
}

/** Where to look for the bundle: an override first (development, tests, CI),
 *  then the packaged resources, then a sibling checkout.
 *
 *  The sibling search walks UP rather than counting `..` the way
 *  resolveEngineDir does. That single `..` is correct only in a plain
 *  checkout: from a git worktree it lands in `.claude/worktrees/`, which is
 *  why running the engine from a worktree needs UNBIASED_ENGINE_DIR every
 *  time. Walking up finds the sibling from either. */
export function resolveSidecarDir(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  const override = process.env.UNBIASED_LEARNING_DIR;
  if (override) return override;
  if (opts.isPackaged) return join(opts.resourcesPath, "sidecar");
  let at = opts.appPath;
  for (let i = 0; i < 8; i++) {
    const candidate = join(at, "learning-algorithm", "dist", "sidecar");
    if (existsSync(candidate)) return candidate;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  // Nothing found: return the plain-checkout guess so the caller's "not
  // installed" path reports a sensible location.
  return join(opts.appPath, "..", "learning-algorithm", "dist", "sidecar");
}

/** True when the path is a directory we could plausibly load. Kept separate
 *  so the caller can stay silent about an absent sidecar. */
export function sidecarLooksInstalled(dir: string): boolean {
  try {
    return isAbsolute(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
