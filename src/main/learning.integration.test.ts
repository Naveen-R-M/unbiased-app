// The only test that proves the two repos actually interoperate: this app's
// client driving the sidecar's SHIPPED bundle over real pipes.
//
// It skips itself when the bundle is absent, because the sidecar is an
// optional companion — a checkout without it must still have a green suite.
// Build it with `npm run bundle` in Work/learning-algorithm, or point
// UNBIASED_LEARNING_DIR at a bundle elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LearningClient, buildEvent, buildTaskMeta, readSidecarManifest } from "./learning";

/** Walk up looking for a sibling checkout rather than counting `..`: this
 *  file runs both from a normal clone and from a git worktree, which sit at
 *  different depths. */
function findSiblingBundle(from: string): string | null {
  let at = from;
  for (let i = 0; i < 8; i++) {
    const candidate = join(at, "learning-algorithm", "dist", "sidecar");
    if (existsSync(candidate)) return candidate;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return null;
}

const dir = process.env.UNBIASED_LEARNING_DIR ?? findSiblingBundle(__dirname) ?? "(no sibling bundle)";
const manifest = readSidecarManifest(dir);
const usable = manifest !== null && !("error" in manifest);
const why = manifest === null ? "no sidecar bundle found" : usable ? "" : (manifest as { error: string }).error;

test(
  "the app's client drives the shipped sidecar: scope is declared, work is scored, lessons distil",
  { skip: usable ? false : `${why} (${dir})` },
  async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "learning-it-"));
    const dbPath = join(dbDir, "learning.db");
    const client = new LearningClient(manifest as Exclude<typeof manifest, null | { error: string }>, dbPath);
    try {
      await client.start();
      assert.ok(client.isReady, "handshake should complete");

      // A worktree conversation: the app declares the PARENT project as the
      // scope, which is the thing the sidecar cannot work out for itself.
      const thread = "thr_it_1";
      client.observe(
        buildTaskMeta({ threadId: thread, cwd: "/work/app/.worktrees/wt-1", projectKey: "/work/app" }),
      );
      client.observe(buildEvent({ kind: "user_message", threadId: thread, summary: "fix the failing test" }));
      client.observe(
        buildEvent({ kind: "tool_call", threadId: thread, summary: "npm test", data: { argsSummary: "npm test" } }),
      );
      client.observe(
        buildEvent({
          kind: "tool_output",
          threadId: thread,
          summary: "npm test",
          data: { exitCode: 1, commandSummary: "npm test" },
        }),
      );
      client.observe(
        buildEvent({ kind: "file_change", threadId: thread, summary: "src/a.ts", data: { files: ["src/a.ts"] } }),
      );
      client.observe(
        buildEvent({
          kind: "tool_output",
          threadId: thread,
          summary: "npm test",
          data: { exitCode: 0, commandSummary: "npm test" },
        }),
      );
      // The app-only signal: rollouts never record that the user was asked.
      client.observe(
        buildEvent({ kind: "approval_decision", threadId: thread, summary: "user accept", data: { decision: "accept" } }),
      );
      // The event the sidecar's scoring reflex hangs on.
      client.observe(
        buildEvent({ kind: "turn_completed", threadId: thread, summary: "turn completed", data: { status: "completed" } }),
      );
      client.flush();
      // Ingestion is a synchronous write on the far side; this is slack for
      // the pipe, not for the work.
      await new Promise((r) => setTimeout(r, 700));
      await client.stop();

      const db = new DatabaseSync(dbPath);
      try {
        const task = db.prepare("SELECT cwd, project_key, total_reward, raw_reward FROM tasks WHERE id = ?").get(thread) as
          | { cwd: string; project_key: string; total_reward: number; raw_reward: number }
          | undefined;
        assert.ok(task, "the task should exist");
        assert.equal(task.cwd, "/work/app/.worktrees/wt-1");
        assert.equal(task.project_key, "/work/app", "the worktree must resolve to its parent project");
        assert.ok(task.raw_reward >= task.total_reward, "raw survives the clamp that total hides");

        const rewards = db.prepare("SELECT COUNT(*) AS n FROM rewards WHERE event_id IS NOT NULL").get() as { n: number };
        assert.ok(rewards.n > 0, "signals should be attributed to the events they came from");

        const lessons = db.prepare("SELECT COUNT(*) AS n FROM lessons").get() as { n: number };
        assert.ok(lessons.n > 0, "the turn_completed reflex should have distilled lessons");
      } finally {
        db.close();
      }
    } finally {
      await client.stop();
      rmSync(dbDir, { recursive: true, force: true });
    }
  },
);
