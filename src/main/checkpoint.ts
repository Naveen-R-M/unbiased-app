import { join } from "node:path";

/** A working-memory checkpoint that survives context compaction.
 *
 *  Measured 2026-09-08 (Figma logo run, 124,518-token window): two automatic
 *  compactions at 15:40 and 15:49 cost 3.4 minutes of dead time and about 5.5
 *  minutes of re-orientation — after the second the model no longer knew it
 *  had drawn its shapes rather than duplicated them, and spent three minutes on
 *  a duplicate that could not be seen.
 *
 *  The engine compacts on its own and tells the app only afterwards, so
 *  "before" has to be pre-emptive: at CHECKPOINT_PERCENT the first ACTION is
 *  held once and the model is handed the literal call to save its decisions;
 *  the app records measured facts on its own regardless; and the first tool
 *  result after a compaction carries the file back. Decisions and measured
 *  facts only — trees and screenshots are refused, because they are exactly
 *  what filled the window. */
export const CHECKPOINT_PERCENT = 60;
export const MAX_CHECKPOINT_NOTES = 4_000;
export const MAX_LEDGER = 80;
export const MAX_FACT_CHARS = 200;
export const MAX_CHECKPOINT_PREAMBLE = 16_000;

export type LedgerEntry = { at: string; text: string };

/** `./memories/<root thread>.md` under the conversation's working directory. */
export function checkpointPath(cwd: string, rootThreadId: string): string {
  return join(cwd, "memories", `${rootThreadId}.md`);
}

/** An element line as the bridge prints it: id, indentation, a lowercase role,
 *  then a title, value, flag or action list. */
const ELEMENT_LINE = /^\s*\d+\s+[a-z][a-z ]*(?: "|\s=|\s\[|\s\{|$)/;
const TREE_LINES_REFUSED = 5;

export function validateCheckpointNotes(notes: string): { ok: true } | { ok: false; error: string } {
  const t = notes.trim();
  if (!t) {
    return { ok: false, error: "notes is empty. Write the decisions made so far and the facts measured (numbers, names, colours, what is done and what is next)." };
  }
  if (t.length > MAX_CHECKPOINT_NOTES) {
    return { ok: false, error: `notes is ${t.length} characters; at most ${MAX_CHECKPOINT_NOTES}. Keep decisions and measured facts, drop everything that can be read again from the app.` };
  }
  const treeLines = t.split("\n").filter((l) => ELEMENT_LINE.test(l)).length;
  if (treeLines >= TREE_LINES_REFUSED) {
    return { ok: false, error: `notes contains ${treeLines} element tree lines. The tree can be read again; write what you decided and what you measured instead.` };
  }
  if (/data:image\//.test(t) || /[A-Za-z0-9+/]{200,}/.test(t)) {
    return { ok: false, error: "notes contains image or encoded data. A screenshot cannot be remembered this way; write what it showed." };
  }
  return { ok: true };
}

/** Append one measured fact, clipped, dropping the oldest past the cap. */
export function pushFact(ledger: LedgerEntry[], text: string, at: string = new Date().toISOString().slice(11, 19)): void {
  const clipped = text.length > MAX_FACT_CHARS ? `${text.slice(0, MAX_FACT_CHARS - 1)}…` : text;
  ledger.push({ at, text: clipped });
  if (ledger.length > MAX_LEDGER) ledger.splice(0, ledger.length - MAX_LEDGER);
}

export function renderCheckpoint(c: { root: string; notes: string | null; facts: LedgerEntry[]; savedAt: string; percent: number; compactions: number }): string {
  return [
    `# Working memory — conversation ${c.root}`,
    `Saved ${c.savedAt} at ${c.percent}% of the context window; compactions so far: ${c.compactions}.`,
    "",
    "## Decisions and plan (written by the model)",
    c.notes?.trim() || "(no notes written yet)",
    "",
    "## Measured facts (recorded by the app)",
    c.facts.length ? c.facts.map((f) => `- ${f.at} ${f.text}`).join("\n") : "(none yet)",
    "",
  ].join("\n");
}

/** Whether the next action should be held for a checkpoint: past the
 *  threshold, nothing saved this cycle, and not asked already this cycle —
 *  one refusal, then the action goes through, like the parked raise. */
export function checkpointDue(s: { percent: number | null; savedThisCycle: boolean; gateUsed: boolean }): boolean {
  return s.percent !== null && s.percent >= CHECKPOINT_PERCENT && !s.savedThisCycle && !s.gateUsed;
}

export function checkpointGateText(percent: number, path: string): string {
  return (
    `The context is at ${percent}%; it will be summarized soon and details not written down are lost. This action was not run. ` +
    `First save your working memory: checkpoint_save {"notes":"<decisions made, plan, measured numbers/names/colours, what is done, what is next>"} — ` +
    `decisions and measured facts only, no tree lines and no images (it is written to ${path} and handed back to you after the summary). Then send the action again.`
  );
}

/** Framed so it cannot be mistaken for tool output, like the skill preamble. */
export function checkpointPreamble(markdown: string): string {
  const room = MAX_CHECKPOINT_PREAMBLE - 200;
  const body = markdown.length > room ? `${markdown.slice(0, room - 20)}\n…(truncated)` : markdown;
  return `=== Working memory you saved before the context was summarized (read it, then continue) ===\n${body}\n=== end ===`;
}

/** The tools that change the app. Reads are never held: they are how the model
 *  finds out where it is, which is the one thing worth doing when memory is
 *  about to be lost. */
const GATED = new Set([
  "computer_press", "computer_set_value", "computer_press_key", "computer_scroll_view", "computer_act",
  "computer_do", "computer_pointer", "computer_launch", "computer_raise", "computer_menu",
]);
export function isGatedTool(tool: string): boolean {
  return GATED.has(tool);
}

export const CHECKPOINT_TOOLS = [
  {
    type: "function",
    name: "checkpoint_save",
    description:
      "Save your working memory for THIS conversation so it survives the context being summarized: the decisions you have made, the plan, the numbers, names and colours you measured, what is done and what is next. " +
      "It replaces the previous checkpoint, so write everything you would need to resume. Decisions and measured facts only — element trees and screenshots are refused; they can be read again. " +
      "Call it when a tool result asks you to, and whenever you finish a stage of a long task. The saved file is handed back to you automatically after a summary.",
    inputSchema: {
      type: "object",
      properties: { notes: { type: "string", description: `Markdown, at most ${MAX_CHECKPOINT_NOTES} characters.` } },
      required: ["notes"],
    },
  },
];

/** Absolute file paths a shell command names, deduplicated.
 *
 *  The charset stops at quotes, parentheses and spaces, which is what makes it
 *  work on a path buried inside a one-liner — `Image.open('/Users/n/a.png')`
 *  is the commonest shape by far. A path with no extension is not a file
 *  being measured (`/dev/null`, a directory), and a relative one cannot be
 *  compared between two commands run from different directories. */
export function pathsInCommand(command: string): string[] {
  const found = command.match(/\/[A-Za-z0-9._~/-]+\.[A-Za-z0-9]{1,6}\b/g) ?? [];
  return [...new Set(found)];
}

/** Said once per conversation, when the model measures the same file again.
 *
 *  Measured across three runs of one drawing task: the same source file was
 *  analysed 5, 4 and 3 times. One analysis printed 8.4k tokens and pushed the
 *  context from 85k to 103k, which is a compaction bought for nothing. The
 *  last run re-analysed with no compaction and the numbers still in context,
 *  so this is a reflex and not only a memory failure — hence a note that says
 *  the measurement stands, rather than a refusal. */
export function remeasureNudge(opts: { path: string; runs: number; savedCheckpoint: boolean }): string | null {
  if (opts.runs < 2) return null;
  const head = `You have now run ${opts.runs} commands against ${opts.path}.`;
  return opts.savedCheckpoint
    ? `${head} You already saved a checkpoint — read what you wrote there instead of measuring again. Measure again only if it is missing or something you can see proves it wrong.`
    : `${head} Measuring the same thing twice costs a turn and can disagree with itself. Save what you measured with checkpoint_save and read it back instead of measuring again.`;
}
