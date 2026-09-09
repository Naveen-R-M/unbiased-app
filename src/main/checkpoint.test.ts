import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkpointPath, validateCheckpointNotes, renderCheckpoint, pushFact, checkpointDue, checkpointGateText,
  checkpointPreamble, isGatedTool, CHECKPOINT_PERCENT, MAX_CHECKPOINT_NOTES, MAX_LEDGER, MAX_FACT_CHARS,
  CHECKPOINT_TOOLS, type LedgerEntry,
} from "./checkpoint";

// Measured 2026-09-08 (Figma logo run, 124,518-token window): two automatic
// compactions cost 3.4 minutes of dead time and about 5.5 minutes of
// re-orientation — after the second the model no longer knew it had drawn its
// shapes rather than duplicated them. The engine compacts on its own and tells
// the app only afterwards, so "before" has to be pre-emptive.

test("the checkpoint lives in ./memories under the conversation's cwd, named by the root thread", () => {
  assert.equal(checkpointPath("/Users/n/Unbiased", "01a0-root"), "/Users/n/Unbiased/memories/01a0-root.md");
});

test("notes must be decisions and measured facts: short, no trees, no images", () => {
  assert.deepEqual(validateCheckpointNotes("palette: #10100F bg; top ring #FC7864 at (256,228) 512x512 DONE"), { ok: true });
  const err = (r: ReturnType<typeof validateCheckpointNotes>) => ("error" in r ? r.error : "");
  assert.match(err(validateCheckpointNotes("   ")), /empty/);
  assert.match(err(validateCheckpointNotes("x".repeat(MAX_CHECKPOINT_NOTES + 1))), /characters/);
  const tree = Array.from({ length: 6 }, (_, i) => `${i + 10}     button "Pad ${i}" {press}`).join("\n");
  assert.match(err(validateCheckpointNotes(`decisions\n${tree}`)), /element tree/);
  assert.match(err(validateCheckpointNotes("look: data:image/jpeg;base64,/9j/4AAQ")), /image/);
  assert.match(err(validateCheckpointNotes("A".repeat(240))), /image|encoded/);
  // Four element-looking lines are a quote, not a dump.
  assert.deepEqual(validateCheckpointNotes(`the field is\n12   text field "Width" = 512\n13   text field "Height" = 512`), { ok: true });
});

test("the ledger keeps the newest facts, clipped, and never grows past its cap", () => {
  const ledger: LedgerEntry[] = [];
  for (let i = 0; i < MAX_LEDGER + 5; i++) pushFact(ledger, `fact ${i} ${"y".repeat(300)}`, `15:${String(i % 60).padStart(2, "0")}:00`);
  assert.equal(ledger.length, MAX_LEDGER);
  assert.ok(ledger[0].text.startsWith("fact 5 "), "the oldest five were dropped");
  assert.ok(ledger[0].text.length <= MAX_FACT_CHARS);
  assert.equal(ledger[0].at, "15:05:00");
});

test("the rendered file has the model's section and the app's section, and says when and why it was written", () => {
  const md = renderCheckpoint({
    root: "r1", notes: "top ring done; bottom next",
    facts: [{ at: "15:44:20", text: 'Figma #2582 "Width" = 512' }],
    savedAt: "2026-09-08T15:45:00Z", percent: 62, compactions: 0,
  });
  assert.ok(md.startsWith("# Working memory"), md);
  assert.ok(md.includes("62% of the context window") && md.includes("compactions so far: 0"), md);
  assert.ok(md.includes("## Decisions and plan (written by the model)\ntop ring done; bottom next"), md);
  assert.ok(md.includes('## Measured facts (recorded by the app)\n- 15:44:20 Figma #2582 "Width" = 512'), md);
  const empty = renderCheckpoint({ root: "r1", notes: null, facts: [], savedAt: "t", percent: 61, compactions: 1 });
  assert.ok(empty.includes("(no notes written yet)") && empty.includes("(none yet)"), empty);
});

test("the gate opens once per cycle, at the threshold, until a checkpoint is saved", () => {
  assert.equal(checkpointDue({ percent: CHECKPOINT_PERCENT - 1, savedThisCycle: false, gateUsed: false }), false);
  assert.equal(checkpointDue({ percent: CHECKPOINT_PERCENT, savedThisCycle: false, gateUsed: false }), true);
  assert.equal(checkpointDue({ percent: 90, savedThisCycle: true, gateUsed: false }), false, "saved: nothing to ask");
  assert.equal(checkpointDue({ percent: 90, savedThisCycle: false, gateUsed: true }), false, "asked once already: the second action goes through");
  assert.equal(checkpointDue({ percent: null, savedThisCycle: false, gateUsed: false }), false);
});

test("the gate text is a literal call, says the action did not run, and says what belongs in it", () => {
  const t = checkpointGateText(64, "/Users/n/Unbiased/memories/r1.md");
  assert.ok(t.includes("64%") && t.includes("not run"), t);
  assert.ok(t.includes('checkpoint_save {"notes":"'), t);
  assert.ok(/decisions/i.test(t) && /measured/i.test(t) && /no tree lines/i.test(t), t);
  assert.ok(t.includes("/Users/n/Unbiased/memories/r1.md") && t.includes("Then send the action again"), t);
});

test("only actions are gated; reads and the checkpoint itself are not", () => {
  for (const t of ["computer_press", "computer_set_value", "computer_press_key", "computer_do", "computer_pointer", "computer_act", "computer_scroll_view", "computer_launch", "computer_raise"]) {
    assert.equal(isGatedTool(t), true, t);
  }
  for (const t of ["computer_app_state", "computer_apps", "computer_app_screenshot", "computer_screenshot", "checkpoint_save", "memory_save", "browser_click"]) {
    assert.equal(isGatedTool(t), false, t);
  }
});

test("the preamble frames the file so it cannot be mistaken for tool output, and is capped", () => {
  const p = checkpointPreamble("# Working memory\nstuff");
  assert.ok(p.startsWith("=== Working memory you saved before the context was summarized"), p);
  assert.ok(p.includes("# Working memory\nstuff") && p.endsWith("=== end ==="), p);
  assert.ok(checkpointPreamble("x".repeat(40_000)).length < 17_000);
});

test("checkpoint_save is declared with notes as its only required field", () => {
  assert.equal(CHECKPOINT_TOOLS.length, 1);
  const t = CHECKPOINT_TOOLS[0] as { name: string; description: string; inputSchema: { required: string[]; properties: Record<string, unknown> } };
  assert.equal(t.name, "checkpoint_save");
  assert.deepEqual(t.inputSchema.required, ["notes"]);
  assert.ok("notes" in t.inputSchema.properties);
  assert.ok(/decisions/i.test(t.description) && /refused/i.test(t.description), "the description says what belongs and what is refused");
});
