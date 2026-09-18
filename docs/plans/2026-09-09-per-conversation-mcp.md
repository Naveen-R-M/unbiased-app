# Per-conversation MCP servers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** MCP servers are off in every conversation until the user turns them on for that conversation, from a chip in the composer; switching mid-conversation takes effect in seconds without an engine restart.

**Architecture:** The engine (codex 0.147, "pareto-app-server") fixes a thread's MCP set when the thread is created or loaded, and `thread/start`, `thread/resume` and `thread/fork` all accept a `config` override map in which `mcp_servers.<name>.enabled = false` removes one server for that thread only. The app keeps, per root thread id, the set of servers the user enabled, persists it in `userData/thread-mcp.json`, and passes the override on every start/resume/fork. Changing the set on a live thread is `thread/unsubscribe` followed by `thread/resume` with the new override when no turn is running, or queued until `turn/completed` when one is. The renderer gets one chip and one popover; Settings → MCP servers keeps add/remove/sign-in and only gains a sentence.

**Tech Stack:** Electron main (`src/main/index.ts`, TypeScript, `node:test` via `npm test`), preload (`src/preload/index.ts`), React renderer (`src/renderer/src/App.tsx`, single file), codex app-server JSON-RPC over stdio.

---

## Measured facts this plan rests on (2026-09-09, standalone `pareto-app-server` against `~/.unbiased/app-engine/home`)

- First request of the Figma run 9 was 56,495 tokens before the model said a word. ~35k of that was MCP tool schemas: Figma remote 41 tools ≈ 20.7k tokens, Honeycomb 23 tools ≈ 21.1k, PostHog 1 tool ≈ 8.9k, Figma desktop 10 tools ≈ 5.1k (o200k tokenizer; only servers holding a valid login count, which is why the same config started at 33k in the morning). The compaction trigger is 96,000, so the working room was 40k.
- `thread/start` with `config: {"mcp_servers": {"<name>": {"enabled": false}, …}}` started none of the disabled servers (zero `mcpServer/startupStatus/updated` notifications); the same call without the override started all five. The notifications carry `threadId`.
- `thread/resume` on an already-loaded thread returns the loaded session and does NOT re-apply config.
- `thread/unsubscribe {threadId}` then `thread/resume {threadId, config}` re-created the session: `thread/status/changed → notLoaded`, then only the newly enabled server reported `starting` → `ready`, then `idle`. Same thread id, history intact, ~2 s.
- `thread/resume` needs a rollout on disk: a thread that never ran a turn cannot be resumed ("no rollout found"). A thread held by another engine instance fails with "already has an active writer".
- `ThreadForkParams` and `ThreadResumeParams` both have `config`; `ThreadStartParams` too. The engine ignores unknown params, and the app already relies on that for `dynamicTools`.

## Design summary

- **State:** `Map<rootThreadId, Set<serverName>>` in main, persisted to `userData/thread-mcp.json` as `{ [rootThreadId]: string[] }` (write-then-rename, same as `mcp-servers.json`). Default: no entry = nothing enabled. A conversation that has no thread yet (composer open, nothing sent) keeps its choice in `pendingNewThreadMcp: string[] | null`, consumed by the next `thread/start` in `chat:send` for the main pane.
- **Override builder (pure):** `mcpConfigOverride(configuredNames, enabledNames)` → `{ mcp_servers: { name: { enabled: false } } }` for every configured server not in the enabled set. Always an object; when nothing is configured it is `{ mcp_servers: {} }` and harmless.
- **Every thread creation path passes the override:** main `thread/start` (chat:send), side `thread/start`, side `thread/fork` (inherits the parent's set — a side chat sees what its conversation sees), `thread/resume` (threads:open), scheduled-run `thread/start` (all off), authoring `thread/start` (all off).
- **Apply on a live thread:** `applyThreadMcp(threadId)`: if `runningTurns.has(threadId)` → mark pending and answer `"queued"`; else `thread/unsubscribe` + `thread/resume` with the same params `threads:open` uses + the override, answer `"applied"`. `turn/completed` flushes pending for that thread. `threads:delete` drops the entry.
- **Renderer:** a chip in the composer's left cluster next to the `+` button: `MCP off` / `MCP: figma_mcp` / `MCP: 3 on`. Click → popover listing configured servers (name, connection status and tool count from `mcp:list`, switch). Footer line while a turn runs: "Changes apply when this turn finishes" with a "Stop and apply now" button (existing `chat:interrupt`). Settings → MCP servers gains one line: "Servers are off in each conversation until you turn them on from the MCP chip in the composer."
- **Not in scope:** per-server tool pruning (`enabledTools` already exists), changing the engine's default config, tool_search.

---

### Task 1: Pure module — override builder, store codec, chip label

**Files:**
- Create: `src/main/thread-mcp.ts`
- Test: `src/main/thread-mcp.test.ts`

**Step 1: Write the failing tests**

```ts
// src/main/thread-mcp.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpConfigOverride, parseThreadMcp, serializeThreadMcp, mcpChipLabel, THREAD_MCP_FILE } from "./thread-mcp";

// Measured 2026-09-09: the Figma run started at 56,495 tokens, ~35k of them
// MCP tool schemas from four connected servers the task never used. The
// engine takes a per-thread override, so a conversation carries only what
// the user switched on for it.

test("the override disables every configured server the conversation has not enabled", () => {
  assert.deepEqual(mcpConfigOverride(["Honeycomb", "figma", "figma_mcp"], new Set(["figma_mcp"])), {
    mcp_servers: { Honeycomb: { enabled: false }, figma: { enabled: false } },
  });
});

test("nothing enabled disables everything; nothing configured is an empty table, never undefined", () => {
  assert.deepEqual(mcpConfigOverride(["a", "b"], new Set()), { mcp_servers: { a: { enabled: false }, b: { enabled: false } } });
  assert.deepEqual(mcpConfigOverride([], new Set(["ghost"])), { mcp_servers: {} });
});

test("an enabled name that is no longer configured is ignored, not written", () => {
  assert.deepEqual(mcpConfigOverride(["a"], new Set(["a", "gone"])), { mcp_servers: {} });
});

test("the store round-trips and tolerates garbage", () => {
  const m = new Map([["root-1", new Set(["figma_mcp", "Honeycomb"])], ["root-2", new Set<string>()]]);
  const text = serializeThreadMcp(m);
  assert.equal(text, JSON.stringify({ "root-1": ["Honeycomb", "figma_mcp"] }, null, 2), "sorted, and empty sets are dropped");
  assert.deepEqual(parseThreadMcp(text), new Map([["root-1", new Set(["Honeycomb", "figma_mcp"])]]));
  assert.deepEqual(parseThreadMcp("not json"), new Map());
  assert.deepEqual(parseThreadMcp('{"r":"nope","s":[1,"ok"]}'), new Map([["s", new Set(["ok"])]]), "non-arrays and non-strings are skipped");
  assert.equal(THREAD_MCP_FILE, "thread-mcp.json");
});

test("the chip says off, the one name, or a count", () => {
  assert.equal(mcpChipLabel([]), "MCP off");
  assert.equal(mcpChipLabel(["figma_mcp"]), "MCP: figma_mcp");
  assert.equal(mcpChipLabel(["a", "b", "c"]), "MCP: 3 on");
});
```

**Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "thread-mcp|✖|ℹ (pass|fail)"`
Expected: failures with `Cannot find module './thread-mcp'`.

**Step 3: Write the module**

```ts
// src/main/thread-mcp.ts
/** Per-conversation MCP servers.
 *
 *  Measured 2026-09-09 on a Figma task: the first request was 56,495 tokens
 *  before the model said a word, and ~35k of that was the tool schemas of
 *  four connected MCP servers the task never used (Figma remote 41 tools,
 *  Honeycomb 23, PostHog 1, Figma desktop 10). The engine fixes a thread's
 *  MCP set when the thread is created or loaded, and takes a per-thread
 *  `config` override in which `mcp_servers.<name>.enabled = false` removes a
 *  server for that thread only. So: nothing is on until the user turns it on
 *  for THIS conversation, and the override rides every start, resume and fork. */

export const THREAD_MCP_FILE = "thread-mcp.json";

/** The `config` override for one thread: every configured server the
 *  conversation has not enabled is switched off. Always an object — the
 *  engine accepts an empty table, and a caller that has to special-case
 *  undefined will one day forget to. Names that are enabled but no longer
 *  configured are simply not mentioned. */
export function mcpConfigOverride(configured: readonly string[], enabled: ReadonlySet<string>): { mcp_servers: Record<string, { enabled: false }> } {
  const mcp_servers: Record<string, { enabled: false }> = {};
  for (const name of configured) if (!enabled.has(name)) mcp_servers[name] = { enabled: false };
  return { mcp_servers };
}

export function serializeThreadMcp(m: ReadonlyMap<string, ReadonlySet<string>>): string {
  const out: Record<string, string[]> = {};
  for (const [root, names] of m) if (names.size) out[root] = [...names].sort();
  return JSON.stringify(out, null, 2);
}

export function parseThreadMcp(text: string): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return m; }
  if (!parsed || typeof parsed !== "object") return m;
  for (const [root, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue;
    const names = new Set(v.filter((x): x is string => typeof x === "string"));
    if (names.size) m.set(root, names);
  }
  return m;
}

export function mcpChipLabel(enabled: readonly string[]): string {
  if (enabled.length === 0) return "MCP off";
  if (enabled.length === 1) return `MCP: ${enabled[0]}`;
  return `MCP: ${enabled.length} on`;
}
```

**Step 4: Run to verify it passes**

Run: `npm test 2>&1 | grep -E "✖|ℹ (pass|fail)"`
Expected: `ℹ fail 0`, pass count up by 5 (267 → 272).

**Step 5: Commit**

```bash
git add src/main/thread-mcp.ts src/main/thread-mcp.test.ts
git commit -m "feat: per-conversation MCP — override builder, store codec, chip label"
```

---

### Task 2: Main state — store, root resolution, one place that builds the override

**Files:**
- Modify: `src/main/index.ts` — near `threadProjectsFile()` (~line 3899) add the store; near `rootThreadOf` (~line 5112) nothing changes, we reuse it.

**Step 1: Add the store next to the thread-projects store (after `loadThreadProjects`, ~line 3910)**

```ts
// ── Per-conversation MCP servers ──────────────────────────────────────────
// See src/main/thread-mcp.ts for the measurement. Keyed by ROOT thread so a
// side chat or sub-agent sees what its conversation sees.
import { mcpConfigOverride, parseThreadMcp, serializeThreadMcp, THREAD_MCP_FILE } from "./thread-mcp"; // put with the other imports at the top

function threadMcpFile(): string {
  return join(app.getPath("userData"), THREAD_MCP_FILE);
}
const threadMcp: Map<string, Set<string>> = (() => {
  try { return parseThreadMcp(readFileSync(threadMcpFile(), "utf8")); } catch { return new Map(); }
})();
/** What the user chose for the conversation they have not sent a message in
 *  yet: consumed by the next main-pane thread/start. */
let pendingNewThreadMcp: string[] | null = null;

function saveThreadMcp(): void {
  const tmp = `${threadMcpFile()}.tmp`;
  writeFileSync(tmp, serializeThreadMcp(threadMcp), { mode: 0o600 });
  renameSync(tmp, threadMcpFile());
}
function enabledMcpFor(threadId: string | null): string[] {
  if (!threadId) return pendingNewThreadMcp ?? [];
  return [...(threadMcp.get(rootThreadOf(threadId)) ?? [])].sort();
}
/** The `config` override for a thread: every server in mcp-servers.json the
 *  conversation has not enabled is off. */
function mcpOverrideFor(threadId: string | null): Record<string, unknown> {
  const configured = readMcpConfig().servers.filter((s) => s.enabled !== false).map((s) => s.name);
  return mcpConfigOverride(configured, new Set(enabledMcpFor(threadId)));
}
```

`readMcpConfig` is declared inside the `whenReady` block (~line 7783) as a nested function. Either hoist it to module scope (preferred: move `type UserMcpServer`, `mcpConfigPath`, `readMcpConfig` up to module scope above `threadMcpFile`, no behaviour change) or place these helpers inside the same block after it. Hoisting is a pure move; run `npm run typecheck` after.

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Unused-function warnings are not errors here.)

**Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: per-conversation MCP — store keyed by root thread, override builder"
```

---

### Task 3: Pass the override on every thread creation and load

**Files:**
- Modify: `src/main/index.ts` at the six engine calls below. Line numbers are as of commit 87056d5; search by the quoted text.

**Step 1: `chat:send`, main-pane `thread/start` (~7084, `started = (await engine.request("thread/start", { ...threadPolicy(), cwd,`)**

Add `config: mcpOverrideFor(null),` to the params. Right after `pane.threadId = started.thread.id;` (~7097) add:

```ts
      // The choice made in the composer before the first message belongs to
      // the thread that message created.
      if (paneId === "main" && pendingNewThreadMcp) {
        if (pendingNewThreadMcp.length) threadMcp.set(started.thread.id, new Set(pendingNewThreadMcp));
        pendingNewThreadMcp = null;
        saveThreadMcp();
      }
```

**Step 2: side `thread/fork` (~7041) and side `thread/start` (~7061)**

Fork: add `config: mcpOverrideFor(panes.main.threadId),` — the side chat inherits the conversation's set. Plain side start: add `config: mcpOverrideFor(null),`.

**Step 3: `threads:open` `thread/resume` (~9722)**

Extract the resume params into a function so Task 4 can reuse them verbatim:

```ts
/** Everything a thread/resume must re-declare — tools are per session, not
 *  stored with the thread (see the comment that used to live inline here) —
 *  plus the conversation's MCP set. One function so the reopen path and the
 *  MCP-switch path can never disagree. */
function resumeParamsFor(id: string): Record<string, unknown> {
  return {
    threadId: id,
    ...threadPolicy(),
    dynamicTools: threadDynamicTools(),
    developerInstructions: threadCwds.has(id) ? developerInstructionsFor(threadCwds.get(id) ?? null) : APP_DEVELOPER_INSTRUCTIONS,
    experimentalRawEvents: true,
    config: mcpOverrideFor(id),
  };
}
```

and replace the inline object with `await engine.request("thread/resume", resumeParamsFor(id))`. Keep the existing explanatory comment above the function.

**Step 4: scheduled-run `thread/start` (~6539) and authoring `thread/start` (~7380)**

Both get `config: mcpConfigOverride(readMcpConfig().servers.map((s) => s.name), new Set()),` — everything off. A scheduled task that needs a server is a later feature; today they paid for all of them.

**Step 5: Typecheck and run the suite**

Run: `npm run typecheck && npm test 2>&1 | grep -E "✖|ℹ (pass|fail)"`
Expected: no type errors, `ℹ fail 0`.

**Step 6: Manual check against the dev app (see "Running the dev app" at the end)**

Start the dev app, open a new conversation, send "hello". In `/tmp/unbiased-ax-diag.log` nothing changes; instead look at the newest rollout under `~/.unbiased/app-engine/home/sessions/<date>/` and print the first `token_count`:

```bash
f=$(ls -t ~/.unbiased/app-engine/home/sessions/*/*/*/rollout-*.jsonl | head -1); python3 -c "
import json,sys
for l in open('$f'):
    p=json.loads(l).get('payload',{})
    if p.get('type')=='token_count' and (p.get('info') or {}).get('last_token_usage'):
        print(p['info']['last_token_usage']['input_tokens']); break"
```

Expected: about 20k, not 56k. Also, in the dev log, no `mcpServer/startupStatus/updated` for that thread.

**Step 7: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: every thread start, resume and fork carries the conversation's MCP override; default off"
```

---

### Task 4: Switching on a live thread — IPC, apply-or-queue, flush on turn end

**Files:**
- Modify: `src/main/index.ts` — new IPC handlers near `ipcMain.handle("mcp:list"` (~7929); hook in the `turn/completed` case (~5750); cleanup in `threads:delete` (~10543).
- Test: `src/main/thread-mcp.test.ts` (pure decision function)

**Step 1: Write the failing test for the decision**

```ts
import { mcpApplyDecision } from "./thread-mcp";

test("a switch applies now on an idle thread, queues while a turn runs, and is only a note for a thread that has not started", () => {
  assert.equal(mcpApplyDecision({ threadId: null, running: false }), "pending-new-thread");
  assert.equal(mcpApplyDecision({ threadId: "t", running: false }), "apply");
  assert.equal(mcpApplyDecision({ threadId: "t", running: true }), "queue");
});
```

**Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "✖|ℹ fail"` → one failure, `mcpApplyDecision is not a function`.

**Step 3: Add to `src/main/thread-mcp.ts`**

```ts
/** Measured 2026-09-09: thread/resume on a LOADED thread hands back the
 *  loaded session and ignores config; thread/unsubscribe then thread/resume
 *  re-creates it with the new set in ~2 s, same id, history intact. A resume
 *  mid-turn would kill the turn, so a running thread waits for turn/completed. */
export type McpApplyDecision = "apply" | "queue" | "pending-new-thread";
export function mcpApplyDecision(s: { threadId: string | null; running: boolean }): McpApplyDecision {
  if (!s.threadId) return "pending-new-thread";
  return s.running ? "queue" : "apply";
}
```

**Step 4: Run tests** → pass.

**Step 5: Main-process handlers (inside `whenReady`, next to `mcp:list`)**

```ts
  /** Threads whose MCP set changed while a turn was running; applied at turn end. */
  const mcpApplyPending = new Set<string>();

  async function applyThreadMcp(threadId: string): Promise<void> {
    // The engine gives back the loaded session on a plain resume; only an
    // unloaded thread reads config. Measured 2026-09-09.
    await engine.request("thread/unsubscribe", { threadId });
    await engine.request("thread/resume", resumeParamsFor(threadId));
    send("mcp:thread-applied", { threadId, enabled: enabledMcpFor(threadId) });
  }

  ipcMain.handle("mcp:thread-get", (_e, threadId: string | null) => {
    const cfg = readMcpConfig();
    return {
      configured: cfg.servers.filter((s) => s.enabled !== false).map((s) => s.name),
      enabled: enabledMcpFor(threadId),
      pending: threadId ? mcpApplyPending.has(threadId) : false,
      running: threadId ? runningTurns.has(threadId) : false,
    };
  });

  ipcMain.handle("mcp:thread-set", async (_e, payload: { threadId: string | null; enabled: string[] }) => {
    const names = [...new Set(payload.enabled.filter((n) => typeof n === "string"))];
    const decision = mcpApplyDecision({ threadId: payload.threadId, running: payload.threadId ? runningTurns.has(payload.threadId) : false });
    if (decision === "pending-new-thread") {
      pendingNewThreadMcp = names;
      return { status: "pending-new-thread" as const };
    }
    const root = rootThreadOf(payload.threadId);
    if (names.length) threadMcp.set(root, new Set(names)); else threadMcp.delete(root);
    saveThreadMcp();
    if (decision === "queue") {
      mcpApplyPending.add(payload.threadId!);
      return { status: "queued" as const };
    }
    try {
      await applyThreadMcp(payload.threadId!);
      return { status: "applied" as const };
    } catch (err) {
      // "no rollout found": a thread that has not completed a turn cannot be
      // resumed. The set is saved; it applies on the next load.
      return { status: "saved" as const, error: String(err) };
    }
  });
```

In the `turn/completed` case, right after `runningTurns.delete(threadId);` (~5766):

```ts
          if (mcpApplyPending.delete(threadId)) {
            // Queued while the turn ran; the thread is idle now.
            void applyThreadMcp(threadId).catch((err) => send("mcp:thread-applied", { threadId, enabled: enabledMcpFor(threadId), error: String(err) }));
          }
```

`mcpApplyPending`, `applyThreadMcp` must be visible from that handler: declare them at module scope (next to `threadMcp`) rather than inside `whenReady` if the notification switch lives outside it.

In `threads:delete` after the interrupt block: `threadMcp.delete(id); mcpApplyPending.delete(id); saveThreadMcp();`.

**Step 6: Typecheck, tests**

Run: `npm run typecheck && npm test 2>&1 | grep -E "✖|ℹ (pass|fail)"` → clean.

**Step 7: Commit**

```bash
git add src/main/index.ts src/main/thread-mcp.ts src/main/thread-mcp.test.ts
git commit -m "feat: switch a conversation's MCP servers in place — unsubscribe+resume when idle, queued to turn end otherwise"
```

---

### Task 5: Preload API

**Files:**
- Modify: `src/preload/index.ts` next to `mcpList` (~line 66)
- Modify: `src/renderer/src/App.tsx` `window.unbiased` type block (~line 547)

**Step 1: Preload**

```ts
  mcpThreadGet: (threadId: string | null) => ipcRenderer.invoke("mcp:thread-get", threadId),
  mcpThreadSet: (threadId: string | null, enabled: string[]) => ipcRenderer.invoke("mcp:thread-set", { threadId, enabled }),
  onMcpThreadApplied: (cb: (p: unknown) => void) => subscribe("mcp:thread-applied", cb),
```

**Step 2: Renderer types (in the `unbiased` declaration next to `mcpList`)**

```ts
      mcpThreadGet: (threadId: string | null) => Promise<{ configured: string[]; enabled: string[]; pending: boolean; running: boolean }>;
      mcpThreadSet: (threadId: string | null, enabled: string[]) => Promise<{ status: "applied" | "queued" | "pending-new-thread" | "saved"; error?: string }>;
      onMcpThreadApplied: (cb: (p: { threadId: string; enabled: string[]; error?: string }) => void) => () => void;
```

**Step 3: Typecheck** → clean. **Commit:** `git commit -am "feat: preload surface for per-conversation MCP"`

---

### Task 6: Renderer — the chip and popover

**Files:**
- Modify: `src/renderer/src/App.tsx` — a new `ConversationMcp` component placed near `StatePill` (~16668); rendered inside `ChatPane`'s composer next to the `+` button (the `setPlusOpen` cluster, ~9700). `ChatPane` already receives `threadId` (see the main-pane render at ~3675, `threadId={activeThreadId}`).

**Step 1: The component** (complete; uses the file's existing `colors`, `MenuItem`-style layout, and `McpConnected` type; match the neighbouring popover's styling rather than inventing a new one — copy the plus-menu container styles)

```tsx
/** MCP servers for THIS conversation. Off by default: measured 2026-09-09,
 *  four connected servers cost ~35k tokens of a 124k window before the first
 *  message. A switch applies in place when the thread is idle, and at the end
 *  of the current turn otherwise — see mcp:thread-set. */
function ConversationMcp({ threadId, onStopTurn }: { threadId: string | null; onStopTurn: () => void }) {
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<string[]>([]);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [status, setStatus] = useState<Record<string, McpConnected>>({});
  const [pending, setPending] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.unbiased.mcpThreadGet(threadId).then((r) => {
      setConfigured(r.configured); setEnabled(r.enabled); setPending(r.pending); setRunning(r.running);
    });
    void window.unbiased.mcpList().then((r) => {
      const byName: Record<string, McpConnected> = {};
      for (const c of r.connected ?? []) byName[c.name] = c;
      setStatus(byName);
    });
  }, [threadId]);
  useEffect(refresh, [refresh]);
  useEffect(() => window.unbiased.onMcpThreadApplied((p) => {
    if (p.threadId !== threadId) return;
    setPending(false);
    setNote(p.error ? `Could not apply: ${p.error}` : null);
    refresh();
  }), [threadId, refresh]);

  const toggle = async (name: string) => {
    const next = enabled.includes(name) ? enabled.filter((n) => n !== name) : [...enabled, name];
    setEnabled(next);
    const r = await window.unbiased.mcpThreadSet(threadId, next);
    if (r.status === "queued") { setPending(true); setNote(null); }
    else if (r.status === "saved") setNote("Saved. It applies when the conversation is next opened.");
    else setNote(null);
    refresh();
  };

  return (
    <div style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen((o) => !o)} title="MCP servers for this conversation"
        style={{ /* copy the plus-button chip style used beside it */ }}>
        {mcpChipLabel(enabled)}
      </button>
      {open && (
        <div role="menu" style={{ /* copy the plus-menu popover container style */ }}>
          <div style={{ padding: "8px 12px", color: colors.dim, fontSize: 12 }}>
            Servers are off in each conversation until you turn them on here.
          </div>
          {configured.length === 0 && <div style={{ padding: 12, color: colors.dim }}>No MCP servers configured. Add one under MCP in the + menu.</div>}
          {configured.map((name) => {
            const s = status[name];
            const tools = s?.tools ? Object.keys(s.tools).length : null;
            const on = enabled.includes(name);
            return (
              <MenuItem key={name} icon={<McpIcon />} label={name}
                desc={s ? `${s.authStatus === "notLoggedIn" ? "Sign in required" : "Connected"}${tools !== null ? ` · ${tools} tools` : ""}` : "Not connected"}
                trailing={<StatePill on={on} />} onClick={() => void toggle(name)} />
            );
          })}
          {(pending || running) && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderTop: `1px solid ${colors.border}` }}>
              <span style={{ color: colors.warn, fontSize: 12 }}>{pending ? "Changes apply when this turn finishes." : "A turn is running; changes apply when it finishes."}</span>
              <button type="button" onClick={onStopTurn} style={{ /* secondary button style */ }}>Stop and apply now</button>
            </div>
          )}
          {note && <div style={{ padding: "6px 12px", color: colors.dim, fontSize: 12 }}>{note}</div>}
        </div>
      )}
    </div>
  );
}
```

Import `mcpChipLabel` from `../../main/thread-mcp` is NOT possible across the renderer boundary in this build; copy the three-line function into App.tsx as `mcpChipLabel` (keep the same tests on the main copy). `colors.warn` — use whatever the file's amber token is called (the "waiting for a restart" banner in the MCP settings panel uses it; search `waiting for a restart`).

**Step 2: Render it** in the composer's left cluster, immediately after the `+` button, passing `threadId={threadId}` and `onStopTurn={() => void window.unbiased.chatInterrupt?.(paneId)}` — check the actual preload name with `grep -n interrupt src/preload/index.ts` and use that.

**Step 3: Settings → MCP servers panel (~13139, header "MCP servers")**

Under the description paragraph add:

```tsx
<p style={{ color: colors.dim, marginTop: 4 }}>
  Servers are off in each conversation until you turn them on from the MCP chip in the composer.
</p>
```

**Step 4: Typecheck** → clean. Build the renderer once: `npx electron-vite build 2>&1 | tail -3` → no errors.

**Step 5: Manual check** (dev app running):
1. New conversation, chip reads "MCP off". Send "hello". First-call tokens ≈ 20k (Task 3 command).
2. Open chip, switch on `figma_mcp`. Expect the dev log to show `mcpServer/startupStatus/updated` for `figma_mcp` with this thread id, `starting` then `ready`, within ~3 s; chip reads "MCP: figma_mcp".
3. Send "what MCP tools do you have?" — the model lists Figma desktop tools only.
4. Start a long turn, switch `figma_mcp` off while it runs: footer says "Changes apply when this turn finishes"; when the turn ends the log shows the resume and the chip reads "MCP off".
5. Reopen an older conversation from the sidebar: chip reads "MCP off"; its first turn after reopening carries no MCP schemas.

**Step 6: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: MCP chip in the composer — per-conversation switches, apply-now or at turn end"
```

---

### Task 7: Docs and changelog

**Files:**
- Modify: `docs/HOW-IT-WORKS.md` — add a section "MCP servers are per conversation" next to the existing MCP section: the measurement, the override, unsubscribe+resume, the two engine facts that shape it (loaded threads ignore config; a thread needs a rollout to resume).
- CHANGELOG: run the `changelog-entry` skill (`resources/skills/changelog-entry/SKILL.md`) for the entry.

**Commit:** `git commit -am "docs: per-conversation MCP servers — how and why"`

---

### Task 8: Measure

Run the Figma logo task once more with the dev app (user clears the frame first) and record in the ledger: first-call input tokens, number of compactions, wall time. Expected: first call ≈ 20k, zero compactions, and the run no longer pays the 60 s compaction plus re-orientation seen in run 9.

---

## Running the dev app

From the app worktree:

```bash
UNBIASED_ENGINE_DIR=/path/to/unbiased-app-engine/dist/bundle UNBIASED_AX_DIR=/path/to/unbiased-ax/dist UNBIASED_AX_DEBUG=1 npm run dev
```

Restart = kill `open -W -n`, `MacOS/Unbiased Dev`, `electron-vite dev`, `dev-launcher.cjs`, then `pkill -9 -f pareto-app-server; pkill -9 -f dist/unbiased-ax`. The engine's stdio traffic is not in the dev log; MCP startup notifications are visible in the renderer via `mcp:status` and, for a thread, via the `mcp:thread-applied` event added here. To watch raw notifications, add a temporary `console.log(msg.method, JSON.stringify(msg.params).slice(0, 200))` inside the `engine.on("notification"` block at ~5871 and remove it before committing.

## Risks and how the plan handles them

- **Unsubscribe while a turn is running** would kill the turn: gated by `runningTurns`, queued to `turn/completed`.
- **Resume of a never-run thread fails** ("no rollout found"): caught, reported as `saved`, applied on next load.
- **Another engine instance holding the thread** ("already has an active writer"): only happens with a second app instance; surfaced in the popover note.
- **Sub-agents and side chats**: keyed by `rootThreadOf`, and the fork passes the parent's override, so they see the same servers as the conversation.
- **Scheduled runs** lose MCP tools entirely: intentional for now; called out in HOW-IT-WORKS.
- **Settings "Connected · N tools"** is engine-global and stays truthful: it reports the engine's own default connection, not a thread's.
