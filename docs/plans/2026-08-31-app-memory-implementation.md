# Agent Memory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persistent per-project memory: the model saves notes via a `memory_save` dynamic tool, and every new conversation in that project starts with the memory index in its developer instructions.

**Architecture:** A pure store module (`src/main/memory.ts`, scheduler.ts-style) owns format/validation/index logic; `index.ts` wires it into the existing dynamic-tool dispatch, developer-instructions channel, and one new IPC (`memory:list`). The renderer adds one `Entry` kind, one event subscription, and an Environment-popover section — all riding existing surfaces (file tabs, `envSection` expansion). Design: `docs/plans/2026-08-31-app-memory-design.md`.

**Tech Stack:** TypeScript, Electron main + React renderer, `node --import tsx --test` for tests. No new dependencies (frontmatter is a hand parser, per the `readSkillFrontmatter` precedent).

---

### Task 1: `src/main/memory.ts` — pure logic, test-first

**Files:**
- Create: `src/main/memory.ts`
- Create: `src/main/memory.test.ts` (picked up automatically by `npm test`'s `src/main/*.test.ts` glob)

Public API (pure, no fs — fs comes in Task 2):

```ts
export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryNote = {
  name: string;          // slug: /^[a-z0-9][a-z0-9-]{0,63}$/
  description: string;   // 1..200 chars, single line
  type: MemoryType;
  body: string;          // 1..10_000 chars
  originThreadId?: string | null;
  modified?: string | null;      // ISO
  extra?: Record<string, string>; // unknown frontmatter keys, preserved verbatim
};
export const MEMORY_MAX_NOTES = 200;
export const MEMORY_MAX_BODY = 10_000;
export const MEMORY_INDEX_CAP = 4_000; // bytes of injected section

export function validateMemory(raw: unknown): { note: MemoryNote } | { error: string };
export function renderMemoryFile(note: MemoryNote): string;         // frontmatter + body
export function parseMemoryFile(text: string): MemoryNote | null;   // tolerant; null only if unusable
export function renderIndex(notes: MemoryNote[]): string;           // MEMORY.md content
export function renderMemorySection(notes: MemoryNote[], dir: string): string; // "" when no notes
export function projectMemoryDir(root: string, projectPath: string): string;
  // slug = projectPath.replace(/[^\w.-]/g, "_")  — the transcriptFile() convention (index.ts:4943)
```

**Step 1: failing tests.** Cover, in `describe` blocks:
- `validateMemory`: rejects bad slug (`"Has Spaces"`, empty, >64), bad type, empty/oversized description and body; accepts a good note; trims fields.
- round-trip: `parseMemoryFile(renderMemoryFile(note))` preserves all fields including `extra`.
- tolerance: a file with top-level `type:` (old Claude Code layout, no `metadata:` block) still parses; unknown keys land in `extra` and survive a re-render; a file with no frontmatter at all returns a note with body-only + null fields rather than null.
- `renderIndex`: one `- name — description` line per note, sorted by name.
- `renderMemorySection`: empty string for zero notes; contains dir path and every description; hard-truncates at `MEMORY_INDEX_CAP` with a `(N more — list the directory)` tail line.
- `projectMemoryDir`: slug flattening; two different paths never collide on the obvious cases.

**Step 2:** `npm test` → new file fails with "Cannot find module './memory.ts'".

**Step 3:** implement `memory.ts`. Frontmatter format written:

```markdown
---
name: <slug>
description: "<escaped>"
metadata:
  type: project
  originThreadId: <id>
  modified: <iso>
---

<body>
```

Parser: split on the `---` fence pair; line-based `key: value`, two-space-indented keys under `metadata:` treated flat; strip optional surrounding quotes; anything unrecognized → `extra`. No YAML library (the `readSkillFrontmatter` rationale, index.ts:5946).

**Step 4:** `npm test` → all pass (device-auth suite must still pass).

**Step 5:** commit `feat(memory): pure store module — format, validation, index`.

### Task 2: fs layer in `memory.ts`

**Step 1: failing tests** using a scratch dir (`fs.mkdtempSync(join(tmpdir(), "mem-"))`):
- `saveMemoryNote(dir, note)`: creates dir, writes `<name>.md` write-then-rename, rebuilds `MEMORY.md`; saving same name overwrites (edit mechanism); refuses at `MEMORY_MAX_NOTES`.
- `loadMemoryNotes(dir)`: missing dir → `[]`; skips `MEMORY.md` and unparsable files.
- `deleteMemoryNote(dir, name)`: removes file + index line; unknown name → `{ error }`; rejects a name that fails the slug check (path traversal guard — never join unvalidated input).

**Step 2:** run, fail. **Step 3:** implement (`writeFileSync` temp + `renameSync`, the `saveTasks` pattern, scheduler.ts:192-238). **Step 4:** run, pass. **Step 5:** commit `feat(memory): fs layer — save/load/delete with atomic writes`.

### Task 3: main-process wiring (`src/main/index.ts`)

**Files:** Modify `src/main/index.ts` only. Verify with `npm run typecheck` + `npm test` (no unit harness reaches index.ts; the pure logic is already covered).

3a. **Paths + thread cwd tracking.** Top of the engine-state region (~line 1996, beside `mainCwd`):
```ts
const memoryRoot = () => join(homedir(), ".unbiased", "memory");
// threadId → the cwd it was started with. mainCwd only tracks the active main
// pane; memory writes from scheduled runs and side threads need their own.
const threadCwds = new Map<string, string>();
const memoryDirForThread = (threadId: string | null): string => {
  const cwd = (threadId && threadCwds.get(rootThreadOf(threadId))) || mainCwd || defaultChatDir();
  const project = loadWorktrees()[cwd]?.project ?? cwd; // worktree → its project
  return projectMemoryDir(memoryRoot(), project);
};
```
Populate `threadCwds.set(started.thread.id, cwd)` at every `thread/start`/`fork` site: chat send (~4901 — side/fork threads record `mainCwd ?? defaultChatDir()`), `runScheduledTask` (~4425), prompt tuner (~5142, harmless), and `thread/resume` reopen (6563 — record the reopened thread's cwd from `thread/read` if available, else skip; fallback chain covers it).

3b. **`developerInstructionsFor(cwd)`.** Replace the 4 `developerInstructions: APP_DEVELOPER_INSTRUCTIONS` sites (4860, 4870, 4894, and the `thread/resume` at ~6583):
```ts
function developerInstructionsFor(cwd: string | null): string {
  const dir = /* projectMemoryDir via worktree resolution, as above */;
  const section = renderMemorySection(loadMemoryNotes(dir), dir);
  return section ? `${APP_DEVELOPER_INSTRUCTIONS}\n\n${section}` : APP_DEVELOPER_INSTRUCTIONS;
}
```
The section text (in memory.ts) states: the dir path, the index lines, "read a memory's file before relying on it", and the save discipline (corrections/preferences/project facts + Why; not things the repo records; hook-quality description).

3c. **Tool declarations.** `MEMORY_TOOLS` beside `SCHEDULE_TOOLS` (~1052): `memory_save { name, description, type, content }` (description field text demands the one-sentence hook; note that re-using a name updates it) and `memory_forget { name }`. Add to `threadDynamicTools()` (1064): `[...SCHEDULE_TOOLS, ...MEMORY_TOOLS, ...(agentBrowserTools() ?? [])]`.

3d. **Handler + dispatch.** `handleMemoryToolCall(tool, rawArgs, threadId): Promise<DynamicToolResponse>` beside `handleScheduleToolCall` (4246), same `text()` helper shape:
- `memory_save`: `validateMemory` → stamp `originThreadId: rootThreadOf(threadId)`, `modified: new Date().toISOString()` → `redactSecrets` the body and description → `saveMemoryNote` → transcript row `send("chat:memory-saved", { paneId, name, description, path })` with `paneId = paneForThread(rootThreadOf(threadId)) ?? "main"` (the 4340 pattern) → success text naming the file.
- `memory_forget`: slug-check → `deleteMemoryNote` → success/failure text.
- No approval card (design §capture). Errors return `success: false` prose the model can act on.

Dispatch at 4073, extending the existing prefix ladder:
```ts
tool.startsWith("memory_") ? handleMemoryToolCall(tool, args, approvalThread) :
```

3e. **`memory:list` IPC** in `app.whenReady()` (near the skills handlers, ~5739):
```ts
ipcMain.handle("memory:list", (_e, threadId: unknown) => {
  const dir = memoryDirForThread(typeof threadId === "string" ? threadId : null);
  const notes = loadMemoryNotes(dir);
  return redactSecrets({
    dir,
    memories: notes.map((n) => ({
      name: n.name, description: n.description, type: n.type,
      path: join(dir, `${n.name}.md`),
      thisThread: n.originThreadId === (typeof threadId === "string" ? rootThreadOf(threadId) : null),
    })),
  });
});
```

Commit: `feat(memory): wire store into tools, instructions and IPC`.

### Task 4: preload (`src/preload/index.ts`)

Beside `onScheduledCreated` (95) and the skills invokes:
```ts
memoryList: (threadId: string | null) => ipcRenderer.invoke("memory:list", threadId),
onMemorySaved: (cb: (p: unknown) => void) => subscribe("chat:memory-saved", cb),
```
Commit with Task 5 (typecheck needs both sides).

### Task 5: renderer (`src/renderer/src/App.tsx`)

5a. **Types.** Entry union (~50, after `scheduled`): `| { kind: "memory"; name: string; description: string; path: string }`. `declare global` surface (~558): `memoryList` + `onMemorySaved` mirroring `onScheduledCreated`'s shape.

5b. **ChatPane subscription** beside `onScheduledCreated` (8205): append `{ kind: "memory", name, description, path }` on matching `paneId`.

5c. **Transcript row** in `renderBlock` beside the `scheduled` branch (8637): dim "Saved memory —" + description; the name is an accent-colored button calling `onOpenFile(e.path)` — ChatPane already receives `onOpenFile` (wired at 3733 to `openFileInPanel`), which opens a side-panel file tab with markdown preview. Reuse the scheduled row's inline-button styling verbatim.

5d. **Environment popover.** State beside `envDiff` (~2207): `envMemories: { name; description; path; thisThread }[] | null`. Fetch in `openEnvMenu()` (2241-2252 fill-in pattern): `void window.unbiased.memoryList(activeThreadId).then(...)`. Render: after the branch row, an expandable "Agent memory" row (extend the `envSection` union with `"memory"`, 2213) showing `Agent memory · N this conversation` (from `thisThread` count; omit the row entirely when the store is empty); expanded, one row per memory — description text, name as link → `void openFileInPanel(m.path)` then `setEnvOpen(false)`.

Verify: `npm run typecheck` clean, `npm test` green. Commit: `feat(memory): renderer — transcript row, click-through, Environment popover section`.

### Task 6: end-to-end sanity + docs

- `npm run build` compiles.
- Manual smoke (requires signed-in engine — skip if unavailable, note it): ask the agent to "remember that X", confirm the transcript row, the file under `~/.unbiased/memory/`, the popover section, and that a NEW chat's first turn knows X.
- Append a CHANGELOG entry per `resources/skills/changelog-entry/SKILL.md` (em-dash format is load-bearing for release CI) — only when this ships in a release; skip for the feature branch.
- Commit any remainder.
