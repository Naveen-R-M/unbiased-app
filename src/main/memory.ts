// Agent memory: a per-project directory of small markdown notes the model
// saves via the memory_save dynamic tool, indexed by a MEMORY.md whose lines
// are injected into every thread's developer instructions. This module is the
// pure half — format, validation, index — kept free of Electron and (in this
// section) the filesystem so the parts that are easy to get wrong can be
// exercised on their own, the same split scheduler.ts uses. The fs layer at
// the bottom is the only part that touches disk.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export type MemoryNote = {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  originThreadId?: string | null;
  modified?: string | null;
  /** Frontmatter keys this app does not know. Preserved verbatim on rewrite:
   *  the surveyed Claude Code stores have two frontmatter generations
   *  coexisting, so a reader that drops unknown keys destroys data. */
  extra?: Record<string, string>;
};

export const MEMORY_MAX_NOTES = 200;
export const MEMORY_MAX_BODY = 10_000;
export const MEMORY_MAX_DESCRIPTION = 200;
// Cap on the injected section: developer instructions ride every request.
export const MEMORY_INDEX_CAP = 4_000;

const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];
// Also the path-safety gate: every filesystem join uses the validated name.
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validateMemory(raw: unknown): { note: MemoryNote } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Arguments must be an object." };
  const a = raw as Record<string, unknown>;
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (!NAME_RE.test(name)) {
    return { error: "name must be a short kebab-case slug: lowercase letters, digits and hyphens, max 64 chars." };
  }
  const description = typeof a.description === "string" ? a.description.trim() : "";
  if (!description) return { error: "description is required — one sentence saying what this is and when to reach for it." };
  if (description.includes("\n")) return { error: "description must be a single line." };
  if (description.length > MEMORY_MAX_DESCRIPTION) {
    return { error: `Keep the description under ${MEMORY_MAX_DESCRIPTION} characters.` };
  }
  const type = typeof a.type === "string" ? (a.type.trim() as MemoryType) : ("" as MemoryType);
  if (!MEMORY_TYPES.includes(type)) {
    return { error: `type must be one of: ${MEMORY_TYPES.join(", ")}.` };
  }
  const body = typeof a.content === "string" ? a.content.trim() : "";
  if (!body) return { error: "content is required — the fact, why it holds, and how to apply it." };
  if (body.length > MEMORY_MAX_BODY) return { error: `Keep the content under ${MEMORY_MAX_BODY} characters.` };
  return { note: { name, description, type, body } };
}

// ── file format ─────────────────────────────────────────────────────────
// Frontmatter is a hand-rolled two-level subset of YAML, written and parsed
// here only — the same call skills ingestion made (index.ts readSkillFrontmatter):
// a YAML dependency would exist for a handful of scalar fields.

const quote = (v: string) => (/["\n:#]|^\s|\s$/.test(v) ? JSON.stringify(v) : v);

function unquote(v: string): string {
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* fall through to the raw value */
    }
  }
  return v;
}

export function renderMemoryFile(note: MemoryNote): string {
  const meta: string[] = [`  type: ${note.type}`];
  if (note.originThreadId) meta.push(`  originThreadId: ${quote(note.originThreadId)}`);
  if (note.modified) meta.push(`  modified: ${note.modified}`);
  for (const [k, v] of Object.entries(note.extra ?? {})) meta.push(`  ${k}: ${quote(v)}`);
  return [
    "---",
    `name: ${quote(note.name)}`,
    `description: ${quote(note.description)}`,
    "metadata:",
    ...meta,
    "---",
    "",
    note.body,
  ].join("\n");
}

/** Tolerant by design: reads the keys it knows at either nesting level,
 *  keeps the rest in `extra`, and treats a fence-less file as body-only
 *  rather than rejecting it. Returns null only for non-string garbage. */
export function parseMemoryFile(text: string): MemoryNote | null {
  if (typeof text !== "string") return null;
  const blank: MemoryNote = { name: "", description: "", type: "project", body: text.trim() };
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return blank;
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close < 0) return blank;

  const note: MemoryNote = { name: "", description: "", type: "project", body: "" };
  const extra: Record<string, string> = {};
  for (const line of lines.slice(1, close)) {
    const m = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[2];
    const value = unquote(m[3].trim());
    if (key === "metadata" && !value) continue; // the nesting marker itself
    if (key === "name") note.name = value;
    else if (key === "description") note.description = value;
    else if (key === "type" && MEMORY_TYPES.includes(value as MemoryType)) note.type = value as MemoryType;
    else if (key === "originThreadId") note.originThreadId = value;
    else if (key === "modified") note.modified = value;
    else if (value) extra[key] = value;
  }
  if (Object.keys(extra).length) note.extra = extra;
  const bodyLines = lines.slice(close + 1);
  if (bodyLines[0] === "") bodyLines.shift(); // the blank line the renderer emits
  note.body = bodyLines.join("\n").trimEnd();
  return note;
}

// ── index + injected section ────────────────────────────────────────────

const indexLine = (n: MemoryNote) => `- ${n.name} — ${n.description}`;
const byName = (a: MemoryNote, b: MemoryNote) => a.name.localeCompare(b.name);

export function renderIndex(notes: MemoryNote[]): string {
  return notes.slice().sort(byName).map(indexLine).join("\n") + (notes.length ? "\n" : "");
}

/** The block appended to developer instructions. Empty string when there is
 *  nothing to remember — the base instructions ride alone. */
export function renderMemorySection(notes: MemoryNote[], dir: string): string {
  if (!notes.length) return "";
  const head = [
    "## Memory",
    `You have a persistent memory directory for this project at ${dir} — durable notes saved in`,
    "earlier conversations. One line per note below; read the note's file",
    `(${dir}/<name>.md) before relying on it. Save NEW durable facts with memory_save: user`,
    "corrections and preferences, project facts not written down anywhere, and hard-won lessons",
    "with their Why — never things the repo or git history already records, and never",
    "session-local details. A wrong note is worse than none: update it by saving the same name,",
    "or remove it with memory_forget.",
  ].join("\n");
  const sorted = notes.slice().sort(byName);
  const room = () => MEMORY_INDEX_CAP - head.length - 1;
  let body = "";
  let shown = 0;
  for (const n of sorted) {
    const line = indexLine(n) + "\n";
    // Reserve space for a worst-case tail line so adding it never overflows.
    if (body.length + line.length > room() - 48) break;
    body += line;
    shown++;
  }
  if (shown < sorted.length) body += `(${sorted.length - shown} more — list the directory)\n`;
  return `${head}\n${body.trimEnd()}`;
}

// ── location ────────────────────────────────────────────────────────────

/** One flat directory per project under the memory root. Same slug rule as
 *  the transcript cache (index.ts transcriptFile): flatten anything that is
 *  not a word char, dot or hyphen. */
export function projectMemoryDir(root: string, projectPath: string): string {
  return join(root, projectPath.replace(/[^\w.-]/g, "_"));
}

// ── fs layer ────────────────────────────────────────────────────────────

/** Every path built from a note name goes through this gate first — the
 *  validated slug alphabet has no separators, so a checked name cannot
 *  escape the directory. */
const noteFile = (dir: string, name: string): string | null =>
  NAME_RE.test(name) ? join(dir, `${name}.md`) : null;

// Write-to-temp + rename in the same directory, the saveTasks /
// mcp-servers.json pattern: a crash mid-write can never leave a truncated
// file behind.
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function loadMemoryNotes(dir: string): MemoryNote[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const notes: MemoryNote[] = [];
  for (const f of entries.sort()) {
    if (!f.endsWith(".md") || f === "MEMORY.md") continue;
    try {
      const parsed = parseMemoryFile(readFileSync(join(dir, f), "utf8"));
      // The filename is the identity; frontmatter that disagrees (or is
      // absent) still loads under the name the file actually has.
      if (parsed) notes.push({ ...parsed, name: f.slice(0, -3) });
    } catch {
      /* unreadable file: skip, never fail the whole store */
    }
  }
  return notes;
}

function rebuildIndex(dir: string): void {
  atomicWrite(join(dir, "MEMORY.md"), renderIndex(loadMemoryNotes(dir)));
}

export function saveMemoryNote(dir: string, note: MemoryNote): { path: string } | { error: string } {
  const path = noteFile(dir, note.name);
  if (!path) return { error: "Invalid memory name." };
  mkdirSync(dir, { recursive: true });
  const existing = loadMemoryNotes(dir);
  const isUpdate = existing.some((n) => n.name === note.name);
  if (!isUpdate && existing.length >= MEMORY_MAX_NOTES) {
    return { error: `This project is at the limit of ${MEMORY_MAX_NOTES} memories — forget one first.` };
  }
  atomicWrite(path, renderMemoryFile(note));
  rebuildIndex(dir);
  return { path };
}

export function deleteMemoryNote(dir: string, name: string): { ok: true } | { error: string } {
  const path = noteFile(dir, name);
  if (!path) return { error: "Invalid memory name." };
  if (!loadMemoryNotes(dir).some((n) => n.name === name)) {
    return { error: `No memory named "${name}" — check the index for the exact name.` };
  }
  rmSync(path);
  rebuildIndex(dir);
  return { ok: true };
}
