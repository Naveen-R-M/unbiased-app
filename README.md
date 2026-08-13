# Unbiased

Unbiased desktop — a Pareto-powered coding agent in an Electron shell. The
app is a pure client: all agent intelligence lives in a separate
[`unbiased-app-engine`](https://github.com/R-M-Naveen/unbiased-app-engine)
binary (a Pareto-locked codex app-server wrapper) that the app spawns and
speaks to over stdio.

<p align="center">
  <img src="resources/icon.png" alt="Unbiased icon" width="128" />
</p>

## Features

- **Streaming chat** with markdown rendering, Prism-highlighted code
  blocks, elapsed-time "thinking" indicator, and turn interruption.
- **Supervised agent loop** — commands the agent wants to run surface as
  cards with Approve/Decline buttons; consecutive steps fold into a
  collapsible group with per-step output. Threads run with an `untrusted`
  approval policy and a `read-only` sandbox.
- **Projects & Recents sidebar** — chats bound to a chosen project folder
  group under it (hover ✎ starts a new chat there); plain chats pin to the
  home directory and list under Recents.
- **Side chat** — an ephemeral fork of the main conversation (full context
  copied; the engine forgets it on exit). Select any text to *Ask in side
  chat*, or *Add to chat* to stage it as an annotation.
- **Annotations** — Codex-style: an inline comment box on the selection,
  numbered badges pinned to the excerpts (CSS Custom Highlight API keeps
  them tinted), multiple annotations ride the next send.
- **Attachments** — files/folders via the composer's **+** menu (sent as
  engine `mention` items) and images via clipboard paste or file pick
  (sent as `localImage`, so the model sees pixels). Cards show thumbnails;
  clicking one previews full-size in the side panel.
- **Files view** (project chats only) — a split pane: file viewer +
  lazy-loading workspace tree with indent guides and a name filter.
  Breadcrumb segments open a sibling-switcher dropdown.
- **Theming** — every chrome shade derives from surface + ink + accent +
  contrast. Settings → Appearance edits them live; `codex-theme-v1:{…}`
  exports import directly.

## Architecture

```
┌────────────────────────────┐   IPC (contextBridge)   ┌──────────────────┐
│ renderer (React 19)        │ ◄─────────────────────► │ preload          │
│ src/renderer/src/App.tsx   │                         │ window.unbiased  │
└────────────────────────────┘                         └────────┬─────────┘
                                                                │
┌────────────────────────────┐  JSON-RPC over stdio   ┌─────────▼─────────┐
│ unbiased-app-engine        │ ◄────────────────────► │ main process      │
│ (spawned child process)    │  (newline-delimited)   │ src/main/index.ts │
└────────────────────────────┘                        │ src/main/engine.ts│
                                                      └───────────────────┘
```

- `src/main/engine.ts` — `EngineClient`: the only code that knows a child
  process exists. Spawns the engine, correlates requests/responses,
  surfaces notifications and server-initiated requests (approvals).
- `src/main/index.ts` — window, IPC handlers, pane routing (`main`/`side`
  share one engine, keyed by threadId), project persistence, file access.
- `src/preload/index.ts` — the renderer's whole engine surface, typed and
  minimal.
- `src/renderer/src/App.tsx` — the entire UI. No CSS files; styling is
  inline against CSS variables set from the active theme.

## Development

Requires Node.js and a sibling checkout of the engine:

```
Work/
├── unbiased-app/          # this repo
└── unbiased-app-engine/   # run `make bundle` there first
```

```bash
# 1. Build the engine bundle (once, and after engine changes)
cd ../unbiased-app-engine && make bundle

# 2. Install and run
npm install
npm run dev
```

`UNBIASED_ENGINE_DIR` overrides the engine location for testing. In a
packaged app the engine is expected beside the app in `extraResources`.

Other scripts:

```bash
npm run build      # electron-vite production build → out/
npm run typecheck  # tsc --noEmit
npx electron .     # run the built app
```

## License

UNLICENSED — private.
