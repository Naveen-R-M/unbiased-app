/** Recovering the window when its renderer process dies.
 *
 *  Electron does not recreate a dead render frame. Without a handler the
 *  window stays white for the rest of the session while the main process
 *  keeps sending into a frame that is gone — which is exactly what happened
 *  on 2026-09-02: one native crash, then 501 "Render frame was disposed"
 *  errors and a blank app until it was closed by hand.
 *
 *  Reloading is the whole recovery. The only thing that needs judgement is
 *  when to STOP reloading, because a renderer that dies during load would
 *  otherwise be reloaded forever. That judgement lives here, free of
 *  Electron, so it can be tested. */

/** `RenderProcessGoneDetails["reason"]`, restated so this module does not
 *  have to import electron (and so the tests can run under plain node). The
 *  handler in index.ts passes electron's own value straight in, so tsc fails
 *  the build if this list ever falls behind — which is how "memory-eviction"
 *  was caught missing. */
export type CrashReason =
  | "clean-exit"
  | "abnormal-exit"
  | "killed"
  | "crashed"
  | "oom"
  | "memory-eviction"
  | "launch-failed"
  | "integrity-failure";

/** Reloads allowed inside CRASH_WINDOW_MS before we stop trying. Three is
 *  enough to ride out a transient failure and few enough that a genuine
 *  crash-on-load surfaces to the user in a couple of seconds. */
export const CRASH_RELOAD_LIMIT = 3;
/** Crashes further apart than this are unrelated events, not a loop. */
export const CRASH_WINDOW_MS = 60_000;

export type CrashDecision =
  | { action: "ignore" }
  | { action: "reload"; attempt: number }
  | { action: "give-up"; attempts: number };

export class RendererCrashRecovery {
  private crashes: number[] = [];
  private surrendered = false;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.limit = opts.limit ?? CRASH_RELOAD_LIMIT;
    this.windowMs = opts.windowMs ?? CRASH_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  onGone(reason: CrashReason): CrashDecision {
    // The frame also goes away on every ordinary quit and window close. That
    // is not a crash, and reloading there would fight the app's shutdown.
    if (reason === "clean-exit") return { action: "ignore" };

    const now = this.now();
    this.crashes = this.crashes.filter((t) => now - t < this.windowMs);
    this.crashes.push(now);

    // Having given up once, stay given up: the user has been told, and
    // silently resuming would put us back in the loop we just escaped.
    if (this.surrendered || this.crashes.length > this.limit) {
      this.surrendered = true;
      return { action: "give-up", attempts: this.crashes.length };
    }
    return { action: "reload", attempt: this.crashes.length };
  }

  /** Forget the history — for a reload the user explicitly asked for, having
   *  been shown that the window kept crashing. */
  reset(): void {
    this.crashes = [];
    this.surrendered = false;
  }
}
