import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunVerdict, VERDICT_CONTRACT } from "./scheduler";

/** The real failed run this contract was written for. */
const REAL_FAILURE = `STATUS: failed

Slack status was not updated.

After clicking the specified Circuit & Chisel launch action, Slack remained on "Launching Circuit & Chisel" and instructed "Click 'Open Slack' to launch the desktop app." The main Slack interface never loaded, so I stopped safely and closed the browser.`;

test("the real failed run reads as failed, with its own first sentence as the note", () => {
  const r = parseRunVerdict(REAL_FAILURE);
  assert.equal(r.verdict, "failed");
  assert.equal(r.note, "Slack status was not updated.");
});

test("the status and its explanation on ONE line — the shape the agent actually sent", () => {
  const r = parseRunVerdict(
    'STATUS: failed Slack remained on "Launching Circuit & Chisel" after three checks. The workspace interface never loaded, so no status was changed.',
  );
  assert.equal(r.verdict, "failed");
  assert.ok(r.note?.startsWith("Slack remained on"), r.note ?? "(no note)");
});

test("a leading success reads as done", () => {
  const r = parseRunVerdict("STATUS: succeeded\n\nPosted the standup summary to #general.");
  assert.equal(r.verdict, "done");
  assert.equal(r.note, "Posted the standup summary to #general.");
});

test("a reason on the status line itself wins over the prose below", () => {
  const r = parseRunVerdict("STATUS: failed - Slack never launched\n\nLonger explanation follows.");
  assert.equal(r.note, "Slack never launched");
});

test("the leading line outranks a status quoted later in the prose", () => {
  const r = parseRunVerdict("STATUS: succeeded\n\nEarlier I planned to write STATUS: failed if the page broke.");
  assert.equal(r.verdict, "done");
});

test("a trailing status is still read when the agent appends instead of leading", () => {
  assert.equal(parseRunVerdict("Did the work.\n\nSTATUS: succeeded").verdict, "done");
});

test("survives the formatting models actually produce", () => {
  for (const line of [
    "**STATUS: failed**",
    "`STATUS: failed`",
    "> STATUS: FAILED",
    "status: fail",
    "STATUS - failure",
    "TASK_RESULT: failed", // the earlier wording stays readable
  ])
    assert.equal(parseRunVerdict(`${line}\n\nSomething went wrong.`).verdict, "failed", line);
});

test("no status line is null — never an assumed success", () => {
  for (const text of ["", "I updated your Slack status.", "Everything went fine!"])
    assert.deepEqual(parseRunVerdict(text), { verdict: null, note: null });
});

test("a long explanation is trimmed for the list, not dropped", () => {
  const r = parseRunVerdict(`STATUS: failed\n\n${"x".repeat(400)}`);
  assert.ok(r.note && r.note.length <= 160, `note was ${r.note?.length}`);
  assert.ok(r.note!.endsWith("…"));
});

test("only the first paragraph of the explanation becomes the note", () => {
  const r = parseRunVerdict("STATUS: failed\n\nFirst para.\n\nSecond para should not appear.");
  assert.equal(r.note, "First para.");
});

test("the contract's own examples parse as the parser expects", () => {
  for (const want of ["succeeded", "failed"]) {
    const line = VERDICT_CONTRACT.split("\n").find((l) => l.trim() === `STATUS: ${want}`);
    assert.ok(line, `contract must show STATUS: ${want}`);
    assert.equal(parseRunVerdict(`${line}\n\nreason`).verdict, want === "failed" ? "failed" : "done");
  }
});
