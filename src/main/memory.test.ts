import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_INDEX_CAP,
  type MemoryNote,
  parseMemoryFile,
  projectMemoryDir,
  renderIndex,
  renderMemoryFile,
  renderMemorySection,
  validateMemory,
} from "./memory";

const good = {
  name: "release-needs-em-dash",
  description: "CHANGELOG headings must use the em dash — release CI slices on it",
  type: "project",
  content: "The release workflow slices CHANGELOG.md by `## <version> — `.\n\n**Why:** CI fails otherwise.",
};

// ── validateMemory ──────────────────────────────────────────────────────

test("validateMemory accepts a well-formed note and trims fields", () => {
  const r = validateMemory({ ...good, name: "  release-needs-em-dash  ", description: ` ${good.description} ` });
  assert.ok("note" in r, JSON.stringify(r));
  assert.equal(r.note.name, "release-needs-em-dash");
  assert.equal(r.note.description, good.description);
  assert.equal(r.note.type, "project");
  assert.equal(r.note.body, good.content);
});

for (const [label, bad] of [
  ["spaces in name", { ...good, name: "has spaces" }],
  ["uppercase name", { ...good, name: "HasCaps" }],
  ["empty name", { ...good, name: "" }],
  ["name over 64 chars", { ...good, name: "a".repeat(65) }],
  ["leading hyphen", { ...good, name: "-starts-with-hyphen" }],
  ["path traversal name", { ...good, name: "../escape" }],
  ["unknown type", { ...good, type: "wisdom" }],
  ["empty description", { ...good, description: "  " }],
  ["multiline description", { ...good, description: "line one\nline two" }],
  ["description over 200 chars", { ...good, description: "d".repeat(201) }],
  ["empty body", { ...good, content: "" }],
  ["body over cap", { ...good, content: "x".repeat(10_001) }],
  ["not an object", "just a string"],
] as const) {
  test(`validateMemory rejects ${label}`, () => {
    const r = validateMemory(bad);
    assert.ok("error" in r, `expected an error for ${label}`);
    assert.ok(r.error.length > 0);
  });
}

// ── file format round-trip ──────────────────────────────────────────────

test("renderMemoryFile → parseMemoryFile round-trips every field", () => {
  const note: MemoryNote = {
    name: "n1",
    description: 'has "quotes" and — dashes',
    type: "feedback",
    body: "The fact.\n\n**Why:** because.\n\n**How to apply:** do it.",
    originThreadId: "thr_123",
    modified: "2026-08-31T12:00:00.000Z",
  };
  const parsed = parseMemoryFile(renderMemoryFile(note));
  assert.ok(parsed);
  assert.equal(parsed.name, note.name);
  assert.equal(parsed.description, note.description);
  assert.equal(parsed.type, note.type);
  assert.equal(parsed.body, note.body);
  assert.equal(parsed.originThreadId, note.originThreadId);
  assert.equal(parsed.modified, note.modified);
});

test("parseMemoryFile tolerates the old top-level `type:` layout", () => {
  const old = [
    "---",
    "name: old-note",
    "description: written by an earlier format",
    "type: reference",
    "---",
    "",
    "Body text.",
  ].join("\n");
  const parsed = parseMemoryFile(old);
  assert.ok(parsed);
  assert.equal(parsed.name, "old-note");
  assert.equal(parsed.type, "reference");
  assert.equal(parsed.body, "Body text.");
});

test("unknown frontmatter keys land in extra and survive a re-render", () => {
  const foreign = [
    "---",
    "name: foreign",
    "description: from another tool",
    "metadata:",
    "  type: project",
    "  node_type: memory",
    "  originSessionId: abc-123",
    "---",
    "",
    "Body.",
  ].join("\n");
  const parsed = parseMemoryFile(foreign);
  assert.ok(parsed);
  assert.equal(parsed.extra?.node_type, "memory");
  assert.equal(parsed.extra?.originSessionId, "abc-123");
  const reparsed = parseMemoryFile(renderMemoryFile(parsed));
  assert.equal(reparsed?.extra?.originSessionId, "abc-123");
});

test("a file with no frontmatter parses as body-only rather than null", () => {
  const parsed = parseMemoryFile("Just some prose someone dropped in the folder.");
  assert.ok(parsed);
  assert.equal(parsed.body, "Just some prose someone dropped in the folder.");
  assert.equal(parsed.name, "");
});

// ── index + injected section ────────────────────────────────────────────

const notes: MemoryNote[] = [
  { name: "beta", description: "second fact", type: "project", body: "b" },
  { name: "alpha", description: "first fact", type: "user", body: "a" },
];

test("renderIndex emits one line per note, sorted by name", () => {
  const idx = renderIndex(notes);
  const lines = idx.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("- alpha — "));
  assert.ok(lines[1].startsWith("- beta — "));
  assert.ok(lines[0].includes("first fact"));
});

test("renderMemorySection is empty for zero notes", () => {
  assert.equal(renderMemorySection([], "/tmp/mem"), "");
});

test("renderMemorySection names the directory and every description", () => {
  const s = renderMemorySection(notes, "/home/u/.unbiased/memory/proj");
  assert.ok(s.includes("/home/u/.unbiased/memory/proj"));
  assert.ok(s.includes("first fact"));
  assert.ok(s.includes("second fact"));
  assert.ok(s.includes("memory_save"));
});

test("renderMemorySection truncates at the cap and says how many were dropped", () => {
  const many: MemoryNote[] = Array.from({ length: 100 }, (_, i) => ({
    name: `note-${String(i).padStart(3, "0")}`,
    description: "d".repeat(120),
    type: "project",
    body: "x",
  }));
  const s = renderMemorySection(many, "/tmp/mem");
  assert.ok(s.length <= MEMORY_INDEX_CAP, `section is ${s.length} bytes`);
  assert.match(s, /\d+ more — list the directory/);
});

// ── projectMemoryDir ────────────────────────────────────────────────────

test("projectMemoryDir flattens the project path into one slug directory", () => {
  const dir = projectMemoryDir("/root/mem", "/Users/u/Projects/Work/app");
  assert.ok(dir.startsWith("/root/mem/"));
  const slug = dir.slice("/root/mem/".length);
  assert.ok(!slug.includes("/"), `slug contains a separator: ${slug}`);
  assert.notEqual(
    projectMemoryDir("/root/mem", "/Users/u/a"),
    projectMemoryDir("/root/mem", "/Users/u/b"),
  );
});
