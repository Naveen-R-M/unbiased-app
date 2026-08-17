import { contextBridge, ipcRenderer } from "electron";

// The renderer's entire view of the engine. Typed, minimal, and additive.
// Chat traffic is pane-scoped: every event payload carries paneId and every
// action names the pane it drives.

function subscribe(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("unbiased", {
  getEngineStatus: () => ipcRenderer.invoke("engine:status"),
  onEngineStatus: (cb: (status: unknown) => void) => subscribe("engine:status", cb),

  checkUpdate: () => ipcRenderer.invoke("update:check"),
  pendingUpdate: () => ipcRenderer.invoke("update:pending"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateAvailable: (cb: (p: unknown) => void) => subscribe("update:available", cb),
  onUpdateProgress: (cb: (p: unknown) => void) => subscribe("update:progress", cb),
  onUpdateError: (cb: (p: unknown) => void) => subscribe("update:error", cb),

  authStatus: () => ipcRenderer.invoke("auth:status"),
  authValidate: (key?: string) => ipcRenderer.invoke("auth:validate", key),
  authLogin: (key?: string) => ipcRenderer.invoke("auth:login", { key }),
  authLogout: () => ipcRenderer.invoke("auth:logout"),

  sendMessage: (paneId: string, text: string, attachments?: { name: string; path: string; kind?: string }[]) =>
    ipcRenderer.invoke("chat:send", { paneId, text, attachments }),
  chooseAttachments: () => ipcRenderer.invoke("attach:choose"),
  clipboardHasImage: () => ipcRenderer.invoke("clipboard:has-image"),
  clipboardImage: () => ipcRenderer.invoke("attach:clipboard-image"),
  interrupt: (paneId: string) => ipcRenderer.invoke("chat:interrupt", paneId),
  compact: (paneId: string) => ipcRenderer.invoke("chat:compact", paneId),
  onTurnStarted: (cb: (p: unknown) => void) => subscribe("chat:turn-started", cb),
  onDelta: (cb: (p: unknown) => void) => subscribe("chat:delta", cb),
  onTurnCompleted: (cb: (p: unknown) => void) => subscribe("chat:turn-completed", cb),
  onThreadActivity: (cb: (p: unknown) => void) => subscribe("chat:thread-activity", cb),

  setAccessMode: (mode: string) => ipcRenderer.invoke("policy:set-mode", mode),
  setWorkMode: (mode: string, dir?: string) => ipcRenderer.invoke("workmode:set", { mode, dir }),
  setPlanMode: (on: boolean) => ipcRenderer.invoke("planmode:set", on),
  onPlan: (cb: (p: unknown) => void) => subscribe("chat:plan", cb),
  listWorktrees: (project: string) => ipcRenderer.invoke("worktrees:list", project),
  conversationInfo: () => ipcRenderer.invoke("conversation:info"),
  saveTranscript: (threadId: string, entries: unknown) =>
    ipcRenderer.invoke("transcript:save", { threadId, entries }),
  loadTranscript: (threadId: string) => ipcRenderer.invoke("transcript:load", threadId),
  decideApproval: (requestId: string, decision: "accept" | "acceptForSession" | "decline") =>
    ipcRenderer.invoke("chat:approve", { requestId, decision }),
  onApprovalRequest: (cb: (p: unknown) => void) => subscribe("chat:approval-request", cb),
  onCommand: (cb: (p: unknown) => void) => subscribe("chat:command", cb),
  onCompaction: (cb: (p: unknown) => void) => subscribe("chat:compaction", cb),
  onTokenUsage: (cb: (p: unknown) => void) => subscribe("chat:token-usage", cb),
  readUsage: () => ipcRenderer.invoke("usage:read"),
  contextUsage: (threadId: string) => ipcRenderer.invoke("usage:context", threadId),
  resourceStats: () => ipcRenderer.invoke("stats:resources"),
  storageStats: () => ipcRenderer.invoke("stats:storage"),

  listThreads: () => ipcRenderer.invoke("threads:list"),
  openThread: (id: string) => ipcRenderer.invoke("threads:open", id),
  detachThread: (cwd?: string) => ipcRenderer.invoke("threads:detach", cwd),
  deleteThread: (id: string) => ipcRenderer.invoke("threads:delete", id),
  resetSideChat: () => ipcRenderer.invoke("side:reset"),
  chooseProject: () => ipcRenderer.invoke("project:choose"),
  archiveProjectChats: (path: string) => ipcRenderer.invoke("project:archive-chats", path),
  removeProject: (path: string) => ipcRenderer.invoke("project:remove", path),
  revealProject: (path: string) => ipcRenderer.invoke("project:reveal", path),
  readFile: (path: string) => ipcRenderer.invoke("file:read", path),
  readImage: (path: string) => ipcRenderer.invoke("file:read-image", path),
  listDir: (dir?: string) => ipcRenderer.invoke("fs:list", dir),
  searchRefs: (word: string) => ipcRenderer.invoke("fs:search-refs", word),
  blameLine: (file: string, line: number) => ipcRenderer.invoke("git:blame-line", { file, line }),
  gitBranch: (path: string) => ipcRenderer.invoke("git:branch", path),
  gitBranches: (path: string) => ipcRenderer.invoke("git:branches", path),
  gitCheckout: (path: string, branch: string, create?: boolean) =>
    ipcRenderer.invoke("git:checkout", { path, branch, create }),
  gitCommitAll: (path: string, message: string) => ipcRenderer.invoke("git:commit-all", { path, message }),
  gitDiscard: (path: string) => ipcRenderer.invoke("git:discard", path),
  reviewDiff: (path: string, mode: "branch" | "working") => ipcRenderer.invoke("review:diff", { path, mode }),
  reviewCommitPush: (path: string) => ipcRenderer.invoke("review:commit-push", path),
  reviewCreatePr: (path: string) => ipcRenderer.invoke("review:create-pr", path),
  openExternal: (url: string) => ipcRenderer.invoke("browser:open-external", url),

  openBrowser: (url?: string) => ipcRenderer.invoke("browser:open", url),
  setBrowserBounds: (b: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("browser:bounds", b),
  setBrowserVisible: (visible: boolean) => ipcRenderer.invoke("browser:visible", visible),
  navigateBrowser: (p: { url?: string; action?: string }) => ipcRenderer.invoke("browser:navigate", p),
  closeBrowser: () => ipcRenderer.invoke("browser:close"),
  startBrowserAnnotate: () => ipcRenderer.invoke("browser:annotate-mode"),
  onBrowserState: (cb: (p: unknown) => void) => subscribe("browser:state", cb),
  onBrowserAnnotate: (cb: (p: unknown) => void) => subscribe("browser:annotate", cb),

  createTerminal: (cols: number, rows: number) => ipcRenderer.invoke("term:create", { cols, rows }),
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke("term:write", { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke("term:resize", { id, cols, rows }),
  killTerminal: (id: string) => ipcRenderer.invoke("term:kill", id),
  onTermData: (cb: (p: unknown) => void) => subscribe("term:data", cb),
  onTermExit: (cb: (p: unknown) => void) => subscribe("term:exit", cb),
});
