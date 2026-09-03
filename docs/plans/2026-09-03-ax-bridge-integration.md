# AX Bridge Integration Plan (stage A of unbiased-ax/docs/INTEGRATION.md)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the model two tools — `computer_app_state` and `computer_act` — backed by the unbiased-ax bridge, so it reads an app's structure as text and acts on elements by id, reaching for a screenshot only when the tree has nothing to say.

**Architecture:** A new pure module `src/main/ax-bridge.ts` (no electron import; tested under node like `learning.ts`) holds the manifest reader, the directory resolver, a newline-JSON stdio client with request ids and timeouts, and the approval-text helper. `index.ts` spawns the bridge once after the engine connects, declares the tools per thread only while the bridge is alive, routes calls through `requestLocalApproval` like every other computer tool, and keeps the last tree text per app so approvals can show the element line the model is about to press.

**Tech Stack:** Electron main, TypeScript, `node:test` via `npm test`. The bridge binary is `unbiased-ax/dist/unbiased-ax` (signed, `manifest.json` beside it, `runtime: "native"`).

**Measured motivation:** unbiased-ax end to end against real Brave — raise, find, setValue, key, find link, press — 8 calls, 9.3 s, no screenshot, versus 27 calls and 6.7 minutes for the screenshot path (2026-09-03).

---

### Task 0: The pure module and its tests
Create `src/main/ax-bridge.ts`, `src/main/ax-bridge.test.ts`. Tests cover: manifest validation (missing → null; wrong runtime, wrong protocol, escaping or missing entry → error), worktree-aware directory resolution, the client against a fake bridge (hello, a result, an error becomes `AxError` with its code, a silent method times out, an exit rejects pending requests and marks the client dead), and approval text that names the element. Commit: `feat(ax): bridge client, manifest, resolver, approval text`.

### Task 1: Wire into index.ts
- `startAxBridge()` after `void startLearning();` — resolve, read manifest, spawn, `hello`; log `[ax] bridge <v> ready (trusted|NOT trusted)`; silent when not installed.
- `AX_TOOLS` declared; `threadDynamicTools()` includes them only when `ax?.alive`.
- `handleAxCall(tool, args, threadId)`: `computer_apps` (no approval); `computer_app_state`, `computer_raise`, `computer_act` via `requestLocalApproval(..., { allowForSession: false, kind: "computer" })` with `describeAxAction`. Errors from the bridge come back as tool text with `success: false`, never thrown.
- `dynamicToolCommandText` cases for the four tools. Dispatch `tool.startsWith("computer_")` already routes here; branch on the AX names first.
- Tool descriptions tell the model: read state before a screenshot; ids are stable per app; `tree` is a diff after the first call; if `offscreen` > 0 call `computer_raise`.
Commit: `feat(ax): computer_app_state and computer_act tools`.

### Task 2: Live verification
`npm run dev` from this worktree (the launcher now forwards env; the resolver finds `../../../unbiased-ax/dist` by walking up). Prompt: *Play a youtube video from the opened tab in my brave browser.* Success: the rollout shows `computer_app_state` / `computer_act` calls, no `computer_screenshot` before the first act, and Brave's title ends in "Audio playing". Record call count and wall time in the PR.

### Task 3: PR
Base `main`. Body: the measured before/after and the run's tool sequence.
