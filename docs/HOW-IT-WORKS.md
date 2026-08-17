# How Unbiased App works

A high-level tour of what happens between typing a message and a file
appearing on disk. Read this before changing anything that crosses a layer
boundary; `README.md` covers the app's own source layout in more detail.

## The short version

Unbiased is a **client**. It draws the interface and owns nothing about
being an agent: no model calls, no tool execution, no conversation storage.
All of that belongs to an engine the app launches as a child process.

```
┌─────────────────────────────────────────────────────────────┐
│ Unbiased.app (Electron)                                     │
│                                                             │
│   renderer ──IPC──► main process                            │
│   (React UI)        (windows, files, git, browser, PTYs)    │
│                            │                                │
└────────────────────────────┼────────────────────────────────┘
                             │ JSON-RPC over stdio
                    ┌────────▼──────────────┐
                    │ unbiased-app-engine   │  Go supervisor
                    │  (thin wrapper)       │  ~3 MB
                    └────────┬──────────────┘
                             │ spawns
                    ┌────────▼──────────────┐
                    │ pareto-app-server     │  Codex app-server
                    │  (the actual agent)   │  ~174 MB, Rust
                    └────────┬──────────────┘
                             │ HTTPS
                    ┌────────▼──────────────┐
                    │ api.unbiased.ai       │  the gateway
                    └────────┬──────────────┘
                             │
                    ┌────────▼──────────────┐
                    │ Pareto (the model)    │
                    └───────────────────────┘
```

Everything above the gateway line ships inside the `.app`. There is nothing
else to install.

## The layers

### 1. The renderer — the entire UI

One React file (`src/renderer/src/App.tsx`) draws everything: the sidebar,
chat, side panel, diff review, file tree, terminal, and settings. There are
no CSS files; styling is inline against CSS variables set from the active
theme. It has no direct access to Node, the filesystem, or the engine — it
can only call what the preload exposes.

### 2. The main process — everything privileged

`src/main/index.ts` owns the window, and every capability the renderer
can't have itself: reading files, running `git`, spawning terminal shells,
the embedded browser, the API key, and the child engine process.
`src/main/engine.ts` is the only code that knows a child process exists —
it spawns the engine, matches replies to requests, and forwards the
engine's notifications onward.

`src/preload/index.ts` is the seam: a small, typed `window.unbiased` object
that is the renderer's complete view of the world.

### 3. `unbiased-app-engine` — the supervisor

A small Go program (separate private repo) whose whole job is to make the
engine **Pareto-only by construction**. On every launch it:

- resolves your API key — `UNBIASED_API_KEY`, else `~/.unbiased/credentials.json`
- rewrites `~/.unbiased/app-engine/home/config.toml` from a template, pinning
  `model = "pareto"` and the gateway URL
- launches the real engine with `CODEX_HOME` pointed at that directory

Because the config is regenerated every start and the engine never reads
`~/.codex`, no leftover user configuration can point it at another provider,
and an upgrade can't inherit stale settings.

### 4. `pareto-app-server` — the actual agent

This is OpenAI's Codex app-server (Rust), pinned by version and checksum in
the engine repo's `engine.lock`. It is the brain:

- owns conversations (threads, turns, history, on-disk storage)
- assembles every request to the model — system prompt, history, tools
- runs **the agent loop**: the model asks for a tool, the engine executes it,
  feeds the result back, and repeats
- enforces the sandbox and raises approval requests
- summarizes history when the context window fills (compaction)

The app talks to it over newline-delimited JSON-RPC on stdin/stdout —
`thread/start`, `turn/start`, `item/*` notifications, and server-initiated
requests when something needs your approval.

### Beyond the app: the gateway

`api.unbiased.ai` fronts the Unbiased gateway, which resolves the model name
`pareto` to a deployment and forwards the call. Today that path runs through
a router into a **cascade**: cheap models answer easy requests, and harder or
tool-heavy ones escalate to frontier models. From the app's point of view
none of this is visible — it asks for `pareto` and gets an answer.

## Following one message end to end

You type *"Create a file named demo.py"* and press Enter.

1. **Renderer → main.** The composer calls `sendMessage`, which crosses the
   preload into `chat:send`.
2. **Main → engine.** If the conversation is new, the app calls
   `thread/start` with the working directory and the current access mode,
   then `turn/start` with your text.
3. **Engine → gateway.** The engine builds an OpenAI *Responses* API call and
   POSTs it to `api.unbiased.ai/v1/responses`. The body is mostly not your
   message: ~20 KB of Codex system instructions, an environment block (cwd,
   shell, date, sandbox policy), the tool definitions, and finally your
   sentence.
4. **Model replies with an intent, not prose.** It returns a *tool call* —
   e.g. `exec_command` with `{"cmd": "touch demo.py"}`.
5. **Engine checks the sandbox.** Allowed under the current mode? Run it.
   Needs more access? Pause and ask you (an approval card appears).
6. **Engine runs it and loops.** The command's output is appended to the
   conversation and sent back to the model, which decides what to do next.
   This repeats until the model answers instead of calling a tool.
7. **Streaming back.** Throughout, the engine emits notifications — message
   deltas, command cards, plan updates, token usage — which the main process
   forwards to the renderer, which draws them.

The important line: **the model never touches your machine.** It can only
ask the engine to act, and the engine decides whether that's allowed.

## The sandbox and access modes

Every turn carries a sandbox policy and an approval policy. The app exposes
three combinations:

| Mode | Reads | Writes in the project | Network / outside the project |
|---|---|---|---|
| Ask for approval | free | asks | asks |
| Approve for me | free | **runs** | asks (network is allowed) |
| Full access | free | runs | runs |

Plan mode overrides all of it with a read-only policy for the turn.

Approvals are a *server-initiated request*: the engine blocks the turn, the
app renders a card, and your decision is sent back as the reply. Declining
is a normal answer, not an error.

## Where things live on disk

| Path | What |
|---|---|
| `~/.unbiased/credentials.json` | your API key (shared with the CLI) |
| `~/.unbiased/app-engine/home/` | the engine's home: generated config, session logs, state DB |
| `…/sessions/**/rollout-*.jsonl` | append-only log of every conversation, by thread id |
| `<userData>/transcripts/` | the app's own rendered-transcript cache |
| `<userData>/worktrees.json` | git worktrees created per conversation |
| `<userData>/window-state.json` | window size and position |

Rollouts only ever grow — compaction shortens what's *sent to the model*,
not what's on disk. Settings → Resources shows the real footprint per
conversation.

## Signing in

The engine refuses to start without an API key, so the app gates on it: the
login screen validates the key against the platform's `/api/cli/whoami`
(free, no model call) and only then starts the engine with that key pinned
into its environment. Sign out stops the engine and removes the stored key.

## Releases and updates

`npm run dist` produces a single arm64 DMG with the engine inside it,
ad-hoc signed (the build fails if the signature doesn't verify). Pushing a
`v*` tag runs the release workflow, which builds on macOS and publishes
cross-repo to the public `unbiased-app-releases`.

In-app updates are two-phase: the app downloads and checksums the new build
into a hidden staged copy beside itself, then swaps it in and relaunches
when you choose. Applying is a single `mv`, so the moment where the app
could be left broken is milliseconds rather than the length of a 190 MB
copy.

## Where to look

| To change… | Go to |
|---|---|
| anything visual | `src/renderer/src/App.tsx` |
| the renderer's capabilities | `src/preload/index.ts` (then a handler in main) |
| files, git, terminal, browser, updates | `src/main/index.ts` |
| how the engine process is driven | `src/main/engine.ts` |
| which engine version ships | `engine.lock` in `unbiased-app-engine` |
| the installer or release pipeline | `scripts/install.sh`, `.github/workflows/release.yml` |
