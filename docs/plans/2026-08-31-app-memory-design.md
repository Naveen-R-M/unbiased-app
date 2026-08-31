# Persistent memory for Unbiased

Give the agent durable, per-project memory in the style of Claude Code's memory
directory: the model saves small facts as it works, and every later
conversation in that project starts already knowing them. Today each thread
starts blank — the only carriers of anything durable are the engine's rollout
files (per-thread, never re-read into new threads) and skills (user-authored,
not model-written).

The reference implementation was surveyed on a real machine (2026-08-31,
`~/.claude/projects/*/memory/`): 11 projects with memory, 27 files total, the
largest project store 32 KB. Two facts from that survey shaped revisions below:
Claude Code has **no global/user-level memory directory** at all, and sessions
running in git worktrees resolve memory to the **main project's** store, not
the worktree path.

The feature splits into three sub-problems: where memory lives (storage), how
it reaches the model (recall), and how the model writes it (capture). Each
rides an extension surface the app already has; no new machinery classes are
needed.

## Shape of a memory

Mirrors Claude Code's format, which has proven out:

```
~/.unbiased/memory/
  <project-slug>/              # per project (slug from the project path,
    MEMORY.md                  #   sanitized like transcriptFile() does)
    release-needs-em-dash.md
```

**Project scope only in phase 1.** An earlier draft added a `global/` scope for
user-level preferences; the survey shows Claude Code ships without one — user-type
memories simply live in the project where they surfaced — so it is deferred
until cross-project preferences actually come up (YAGNI).

One file per fact, markdown with a small frontmatter block:

```markdown
---
name: release-needs-em-dash
description: CHANGELOG headings must use the em dash — release CI slices on it
metadata:
  type: project              # user | feedback | project | reference
  originThreadId: <threadId> # provenance: which conversation saved it
  modified: <ISO timestamp>
---

<body: the fact, a Why, and how to apply it>
```

`originThreadId` and `modified` are stamped by the handler, not supplied by the
model (Claude Code stamps `originSessionId` the same way — cheap provenance
that answers "where did this belief come from" when a memory turns out wrong).
The frontmatter **parser must be tolerant**: read known keys, preserve unknown
ones, never reject a file over extra fields. The surveyed store has two
frontmatter generations coexisting because the format evolved and old files
were never migrated — plan for the same.

`MEMORY.md` is regenerated from the directory (never read-modify-write — see
Concurrency) and holds one line per memory: `- name — description`. Only the
index is injected into context; bodies are read on demand. The survey confirms
this scales: 27 memories across 11 projects cost a few hundred bytes each
in-context.

## Storage: `~/.unbiased/memory/<project-slug>/`, keyed by project

- Follows the existing `~/.unbiased/` convention (`skills/`, `mcp-servers.json`,
  `credentials.json`).
- **Keyed by project, not cwd.** A worktree conversation must share its
  project's memory: resolve through the same mapping `turnSandbox()` uses
  (`loadWorktrees()[cwd].project`), falling back to the cwd itself. Keying by
  cwd would give every worktree an amnesiac private store. This matches
  observed Claude Code behavior: a session whose cwd is a worktree loads and
  writes the main project's memory directory.
- Chats with no project (`~/Unbiased` default dir): treat `~/Unbiased` as a
  project like any other — it gets its own slug and store.

Rejected locations:

- **In-repo (`<project>/.codex/memories/` or `AGENTS.md`)** — the engine would
  read `AGENTS.md` natively, which is tempting, but it pollutes `git status`,
  ships one user's memories to every teammate, and the `defaultChatDir()`
  postmortem (index.ts:114-121) is a standing warning about config the engine
  merges from cwd.
- **`userData/`** — wrong tier; memory is user data about projects, not app
  state, and `~/.unbiased/` is already the user-visible home (Finder reveal,
  documented in HOW-IT-WORKS).

## Recall: inject the index via `developerInstructions`

`APP_DEVELOPER_INSTRUCTIONS` (index.ts:796) becomes
`developerInstructionsFor(projectPath: string | null)`: the existing static
block plus a bounded memory section —

```
## Memory
You have a persistent memory directory for this project at <abs path>. Its index:
<project MEMORY.md lines>
Read a memory's file before relying on it. Save new memories with memory_save
(see tool description for what belongs there).
```

- All four senders already pass `developerInstructions` — `thread/start` ×2,
  `thread/fork`, `thread/resume` — so the change is one function signature.
  Forks and sub-agents inherit it, which is correct: a side chat should know
  what the main chat knows.
- **Hard cap ~4 KB** for the memory section: developer instructions ride every
  request. One line per memory keeps ~100 memories under that; past the cap,
  truncate oldest-first and append a "(N more — list the directory)" line.
- **Bodies need no new tool.** Reads run free in every mode (`ask` is
  `on-request` + read-only precisely so reads don't prompt), so the model's own
  file tools can open `~/.unbiased/memory/**` once the index gives it paths.
- Staleness: the injection is fixed at thread start, same as Claude Code's
  per-session index. `thread/resume` re-sends it, with the known caveat that
  experimental params on resume are unverified (index.ts:6575-6577) — the
  failure mode is "index not refreshed mid-thread", which is acceptable.

## Capture: a `memory_` dynamic-tool family

Two tools, added to `threadDynamicTools()` (index.ts:1063) exactly as
`SCHEDULE_TOOLS` was, dispatched by prefix in the `item/tool/call` branch
(index.ts:4068):

- `memory_save { name, description, type, content }` — flat fields, one enum,
  for the same reason `schedule_create` flattened the engine's tagged union
  (index.ts:1012-1016). The `description` field's schema text must demand a
  hook-quality single sentence ("what it says and when to reach for it"): the
  description line is the ONLY part of a memory the model sees before deciding
  to read it, so a vague one makes the memory invisible forever. Saving over an
  existing `name` updates it — that is the edit mechanism.
- `memory_forget { name }` — delete one memory. Needed because a wrong memory
  re-injected into every future thread is worse than no memory.

**Why a tool and not model file-writes:** `MODE_TURN_SANDBOX`
(index.ts:2018-2032) makes `~/.unbiased/memory` unwritable in both standard
modes — `ask` turns are `readOnly`, `auto` is `workspaceWrite` whose only extra
roots are Go caches. Free-form writes would mean an approval card per save in
`ask` and a sandbox failure in `auto`. The app-side handler works identically
in every mode — including scheduled runs, which are read-only with
`approvalPolicy: "never"` and are exactly the threads that most need to leave
notes for next time. (Adding the memory dir to `writableRoots` was considered
and rejected: it only helps `auto`, and it trades validated, capped, indexed
writes for arbitrary ones.)

Handler behavior (`handleMemoryToolCall`, beside `handleScheduleToolCall`):

1. Validate: `name` must match the skill-frontmatter-style slug rule
   (`[a-z0-9-]{1,64}`), `type` in the enum, caps below.
2. **Redact before persisting.** `redactSecrets()` currently guards only the
   display boundary (index.ts:3078). Memory persists and is re-injected into
   every future prompt, so a leaked key would round-trip forever; run the same
   redaction over `content` at write time.
3. Stamp provenance (`originThreadId`, `modified`) into the frontmatter, then
   write the file write-then-rename (the `saveTasks` / `mcp-servers.json`
   pattern), then rebuild `MEMORY.md` from a directory scan.
4. Return `{ contentItems: [{ type: "inputText", text: "Saved." }], success: true }`;
   failures return `success: false` with a reason so the model adapts instead
   of the turn dying (same contract as the browser tools).

**No approval card, but full visibility.** `schedule_create` gates on approval
because a scheduled task acts unattended later; a memory only ever becomes
prompt text, and `memory_forget` bounds the damage. Instead, emit a transcript
row the way `chat:scheduled-created` does — a `{ kind: "memory", name,
description, path }` entry rendered as "Saved memory: …" — so every write is
visible in the conversation where it happened.

**The row is a click-through, not just a notice.** Clicking it opens the
memory's file in a side-panel `file:` tab, where FileViewer's existing
markdown preview renders it human-readable (frontmatter + Why + How-to-apply),
with the raw-text toggle for free. This reuses the exact path-chip → file-tab
mechanism the transcript already has (`InlineCodeChip` → FileViewer), so it
costs a `path` field on the entry and an onClick — no new UI machinery. It
also covers the reverse direction automatically: when the model *reads* a
memory, the file path in the transcript is already a clickable chip today.

**Environment popover: "Agent memory" section.** The header's Environment
popover is the conversation's status summary (changes, worktree, branch, ship
actions), and memory saved during the conversation belongs in it. Add an
expandable row — the popover already has exactly this mechanism (`envSection`
toggles the "work in" and branch subsections, App.tsx:2213) — labeled "Agent
memory", showing the count of memories saved in this conversation. Expanded,
it lists each memory's description line with the name as a clickable link
that opens the file in a side-panel `file:` tab (the same click-through as the
transcript row — and App owns the tab model, so this is a direct `openTab`,
no ref escape hatch needed). Data comes from one new IPC, `memory:list
{ threadId }`, which reads the project's store and filters on the
`originThreadId` frontmatter stamp — the provenance field earns its keep here.
It loads the way everything else in `openEnvMenu()` does: popover opens
immediately, rows fill in when the fetch lands (App.tsx:2241-2252). Zero
memories saved → the row shows "Agent memory — none this conversation" or is
simply omitted, matching the popover's terse register.

**Prompting.** The developer-instructions memory section states what belongs in
memory (user corrections and preferences, project facts not derivable from the
repo, feedback with its Why) and what does not (anything the repo or git
history already records, session-local details). It also sets the body shape
Claude Code's stores converge on in practice: the fact, a **Why** (the
evidence or incident behind it), and a **How to apply**. This is where Claude
Code gets its save behavior; without it the tools go unused.

Caps: 200 memories per project, 10 KB per body, name/description length limits —
enforced in the handler, mirroring `MAX_TASKS`/`MAX_PROMPT_CHARS` in
scheduler.ts. (For calibration: a heavily-used real store is 27 files across
11 projects — the caps are a backstop, not an expected ceiling.)

## Concurrency

Multiple threads (main, side chats, scheduled runs) can save concurrently.
Per-file write-then-rename makes each memory atomic, and `MEMORY.md` is always
rebuilt from a fresh directory scan — never edited in place — so the worst
race is a momentarily stale index, repaired by the next write. No locks.

## Module layout and testing

- **`src/main/memory.ts`** — pure logic, scheduler.ts-style: frontmatter
  parse/serialize, slug and cap validation, index rendering, path resolution
  from (projectPath, scope). Only `loadMemories`/`saveMemory`/`deleteMemory`
  touch the filesystem, injectable for tests.
- **`src/main/index.ts`** — wiring only: tool declarations, the `memory_`
  dispatch branch, `developerInstructionsFor`, the transcript-row push.
- **`src/main/memory.test.ts`** — under the existing `node --test` harness
  (device-auth.test.ts is the model): slug/cap rejection, index rebuild from a
  scan, truncation at the injection cap, redaction applied to content,
  worktree→project resolution, and frontmatter tolerance (a file with unknown
  keys or an older field layout still parses and keeps its extra fields on
  rewrite).

## Phasing

1. **Phase 1 (the feature):** store + `memory_save`/`memory_forget` +
   injection + clickable transcript row + the Environment popover's "Agent
   memory" section. No new UI surfaces — every piece rides an existing one
   (file tabs, the popover's expandable rows); the storage page in Settings →
   Resources gains a "Reveal memory in Finder" row.
2. **Phase 2 (management UI, and global scope if warranted):** a Memory panel
   in the SkillsPanel mold — list, view body, delete, edit-as-text; the
   natural place for a per-project "forget everything" action. A `global/`
   user-level scope joins here only if cross-project preferences prove to be a
   real gap (Claude Code ships without one).

## Alternatives considered

| Approach | Why not |
|---|---|
| `AGENTS.md` / files in the repo | Engine reads it for free, but it's shared, versioned, and pollutes the repo; memory is per-user. |
| `writableRoots` + instructed file writes | Only works in `auto`/`full`; invisible, unvalidated, uncapped. |
| An MCP memory server | A process and a config surface for what is ~200 lines of app code; MCP calls also gate behind per-call elicitation approvals. |
| Engine-side (Go supervisor) | Wrong layer — the supervisor execs itself away before any per-thread state exists (index.ts:4649-4651 records this exact constraint for skills roots). |
| Auto-capture (summarize every turn into memory) | Rejected for v1: noisy, costly, and the tool + prompting path is how Claude Code proved the concept. Revisit once real usage shows gaps. |
