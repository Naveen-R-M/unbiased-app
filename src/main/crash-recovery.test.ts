import { test } from "node:test";
import assert from "node:assert/strict";
import { CRASH_RELOAD_LIMIT, CRASH_WINDOW_MS, RendererCrashRecovery } from "./crash-recovery";

// Measured, 2026-09-02: the renderer died once after 4h45m of use
// (EXC_BREAKPOINT on a thread-pool worker) and the window stayed white for
// the rest of the session. Electron does not recreate a dead frame, and the
// app had no handler, so the main process simply kept pushing engine events
// into it — 501 "Render frame was disposed before WebFrameMain could be
// accessed" before the app was closed by hand. One crash cost the session.
//
// This policy is the difference between a crash costing a reload and a crash
// costing everything after it.

const at = (...times: number[]) => {
  let i = 0;
  return new RendererCrashRecovery({ now: () => times[Math.min(i++, times.length - 1)]! });
};

test("a crash asks for a reload — a dead frame never comes back on its own", () => {
  const r = at(1000);
  assert.deepEqual(r.onGone("crashed"), { action: "reload", attempt: 1 });
});

test("every abnormal reason recovers, including the one that actually happened", () => {
  // The real crash reported `crashed`; OOM and killed are the same story from
  // the user's side — a white window with no way back.
  const abnormal = [
    "crashed",
    "oom",
    "memory-eviction",
    "killed",
    "abnormal-exit",
    "launch-failed",
    "integrity-failure",
  ] as const;
  for (const reason of abnormal) {
    assert.equal(at(1000).onGone(reason).action, "reload", `${reason} should recover`);
  }
});

test("a clean exit is NOT a crash — the frame goes away on every quit", () => {
  // Reloading here would fight the app's own shutdown, and would reopen a
  // window the user just closed.
  assert.deepEqual(at(1000).onGone("clean-exit"), { action: "ignore" });
});

test("a crash loop gives up rather than reloading forever", () => {
  // A renderer that dies on load would otherwise reload, die, reload... The
  // give-up carries the count so the caller can say something true to the user.
  const times = Array.from({ length: CRASH_RELOAD_LIMIT + 1 }, (_, i) => 1000 + i * 100);
  const r = at(...times);
  for (let i = 1; i <= CRASH_RELOAD_LIMIT; i++) {
    assert.deepEqual(r.onGone("crashed"), { action: "reload", attempt: i });
  }
  assert.deepEqual(r.onGone("crashed"), { action: "give-up", attempts: CRASH_RELOAD_LIMIT + 1 });
});

test("once it has given up it stays given up, instead of quietly resuming", () => {
  const base = 1000;
  const r = at(...Array.from({ length: CRASH_RELOAD_LIMIT + 2 }, (_, i) => base + i * 100));
  for (let i = 0; i < CRASH_RELOAD_LIMIT; i++) r.onGone("crashed");
  assert.equal(r.onGone("crashed").action, "give-up");
  assert.equal(r.onGone("crashed").action, "give-up");
});

test("crashes far apart are not a loop — yesterday's crash is not held against today's", () => {
  // The real incident was a single crash after nearly five hours. A second one
  // tomorrow must still get its reload.
  const r = at(1000, 1000 + CRASH_WINDOW_MS + 1);
  assert.deepEqual(r.onGone("crashed"), { action: "reload", attempt: 1 });
  assert.deepEqual(r.onGone("crashed"), { action: "reload", attempt: 1 });
});

test("a reload the user asks for clears the history", () => {
  // The give-up dialog offers a reload; taking it means the user accepted the
  // risk of another loop, and the next crash should be treated as the first.
  const r = at(...Array.from({ length: CRASH_RELOAD_LIMIT + 2 }, (_, i) => 1000 + i * 100));
  for (let i = 0; i < CRASH_RELOAD_LIMIT; i++) r.onGone("crashed");
  assert.equal(r.onGone("crashed").action, "give-up");
  r.reset();
  assert.deepEqual(r.onGone("crashed"), { action: "reload", attempt: 1 });
});
