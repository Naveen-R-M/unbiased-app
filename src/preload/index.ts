import { contextBridge, ipcRenderer, webUtils } from "electron";

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
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  applyUpdate: () => ipcRenderer.invoke("update:apply"),
  changelogReleases: () => ipcRenderer.invoke("changelog:releases"),
  updatePrefs: () => ipcRenderer.invoke("update:prefs"),
  setUpdatePrefs: (p: { autoDownload: boolean }) => ipcRenderer.invoke("update:set-prefs", p),
  onUpdateAvailable: (cb: (p: unknown) => void) => subscribe("update:available", cb),
  onUpdateStaged: (cb: (p: unknown) => void) => subscribe("update:staged", cb),
  onUpdateProgress: (cb: (p: unknown) => void) => subscribe("update:progress", cb),
  onUpdateError: (cb: (p: unknown) => void) => subscribe("update:error", cb),

  authStatus: () => ipcRenderer.invoke("auth:status"),
  authValidate: (key?: string) => ipcRenderer.invoke("auth:validate", key),
  authLogin: (key?: string) => ipcRenderer.invoke("auth:login", { key }),
  authLogout: (removeKey?: boolean) => ipcRenderer.invoke("auth:logout", { removeKey }),

  sendMessage: (paneId: string, text: string, attachments?: { name: string; path: string; kind?: string }[]) =>
    ipcRenderer.invoke("chat:send", { paneId, text, attachments }),
  chooseAttachments: () => ipcRenderer.invoke("attach:choose"),
  attachPaths: (paths: string[]) => ipcRenderer.invoke("attach:paths", { paths }),
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
  removeWorktree: (dir: string) => ipcRenderer.invoke("worktrees:remove", dir),
  conversationInfo: () => ipcRenderer.invoke("conversation:info"),
  saveTranscript: (threadId: string, entries: unknown) =>
    ipcRenderer.invoke("transcript:save", { threadId, entries }),
  loadTranscript: (threadId: string) => ipcRenderer.invoke("transcript:load", threadId),
  decideApproval: (requestId: string, decision: "accept" | "acceptForSession" | "decline") =>
    ipcRenderer.invoke("chat:approve", { requestId, decision }),
  liveApprovals: () => ipcRenderer.invoke("chat:live-approvals"),
  mcpList: () => ipcRenderer.invoke("mcp:list"),
  mcpSave: (servers: unknown[]) => ipcRenderer.invoke("mcp:save", { servers }),
  mcpApply: () => ipcRenderer.invoke("mcp:apply"),
  onMcpStatus: (cb: (p: unknown) => void) => subscribe("mcp:status", cb),
  skillsList: (cwd?: string | null) => ipcRenderer.invoke("skills:list", { cwd }),
  skillsSetEnabled: (path: string, enabled: boolean) =>
    ipcRenderer.invoke("skills:set-enabled", { path, enabled }),
  skillsReveal: (path: string, isDir?: boolean) => ipcRenderer.invoke("skills:reveal", { path, isDir }),
  skillsChoose: () => ipcRenderer.invoke("skills:choose"),
  skillsValidate: (path: string) => ipcRenderer.invoke("skills:validate", { path }),
  skillsInstall: (p: { path: string; name: string; scope: "global" | "project"; cwd: string | null }) =>
    ipcRenderer.invoke("skills:install", p),
  skillsRemove: (path: string, cwd: string | null) => ipcRenderer.invoke("skills:remove", { path, cwd }),
  skillsFetch: (url: string) => ipcRenderer.invoke("skills:fetch", { url }),
  skillsLimits: () => ipcRenderer.invoke("skills:limits"),
  scheduledList: () => ipcRenderer.invoke("scheduled:list"),
  scheduledSave: (p: {
    key?: string | null;
    name: string;
    prompt: string;
    schedule: unknown;
    projectPath?: string | null;
  }) => ipcRenderer.invoke("scheduled:save", p),
  scheduledSetEnabled: (key: string, enabled: boolean) =>
    ipcRenderer.invoke("scheduled:set-enabled", { key, enabled }),
  scheduledDelete: (key: string) => ipcRenderer.invoke("scheduled:delete", key),
  scheduledRunNow: (key: string) => ipcRenderer.invoke("scheduled:run-now", key),
  scheduledLastRun: (key: string) => ipcRenderer.invoke("scheduled:last-run", key),
  onScheduledUpdated: (cb: (p: unknown) => void) => subscribe("scheduled:updated", cb),
  onScheduledRunState: (cb: (p: unknown) => void) => subscribe("scheduled:run-state", cb),
  onScheduledCreated: (cb: (p: unknown) => void) => subscribe("chat:scheduled-created", cb),
  // A dropped File carries no usable path of its own in Electron 32+; only
  // this side can resolve one.
  pathForDroppedFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  onApprovalRequest: (cb: (p: unknown) => void) => subscribe("chat:approval-request", cb),
  onApprovalCanceled: (cb: (p: unknown) => void) => subscribe("chat:approval-canceled", cb),
  onCommand: (cb: (p: unknown) => void) => subscribe("chat:command", cb),
  onCompaction: (cb: (p: unknown) => void) => subscribe("chat:compaction", cb),
  onTokenUsage: (cb: (p: unknown) => void) => subscribe("chat:token-usage", cb),
  readBilling: () => ipcRenderer.invoke("usage:billing"),
  contextUsage: (threadId: string) => ipcRenderer.invoke("usage:context", threadId),
  resourceStats: () => ipcRenderer.invoke("stats:resources"),
  storageStats: () => ipcRenderer.invoke("stats:storage"),

  listThreads: () => ipcRenderer.invoke("threads:list"),
  openThread: (id: string) => ipcRenderer.invoke("threads:open", id),
  detachThread: (cwd?: string) => ipcRenderer.invoke("threads:detach", cwd),
  deleteThread: (id: string) => ipcRenderer.invoke("threads:delete", id),
  resetSideChat: (paneId?: string) => ipcRenderer.invoke("side:reset", paneId),
  subagentsList: (parent: string) => ipcRenderer.invoke("subagents:list", parent),
  subagentTranscript: (id: string) => ipcRenderer.invoke("subagents:transcript", id),
  onSubAgents: (cb: (p: unknown) => void) => subscribe("chat:subagents", cb),
  onSubAgentDelta: (cb: (p: unknown) => void) => subscribe("chat:subagent-delta", cb),
  onSubAgentActivity: (cb: (p: unknown) => void) => subscribe("chat:subagent-activity", cb),
  onSubAgentRenames: (cb: (p: unknown) => void) => subscribe("chat:subagent-renames", cb),
  onSubAgentEvent: (cb: (p: unknown) => void) => subscribe("chat:subagent-event", cb),
  onMessageBoundary: (cb: (p: unknown) => void) => subscribe("chat:message-boundary", cb),
  chooseProject: () => ipcRenderer.invoke("project:choose"),
  createProject: (record: unknown) => ipcRenderer.invoke("project:create", record),
  pickProjectLocation: () => ipcRenderer.invoke("project:pick-location"),
  renameThread: (threadId: string, name: string) => ipcRenderer.invoke("threads:rename", { threadId, name }),
  assignThreadProject: (threadId: string, projectPath: string) =>
    ipcRenderer.invoke("threads:assign-project", { threadId, projectPath }),
  archiveProjectChats: (path: string) => ipcRenderer.invoke("project:archive-chats", path),
  removeProject: (path: string) => ipcRenderer.invoke("project:remove", path),
  updateProject: (path: string, record: unknown) => ipcRenderer.invoke("project:update", { path, record }),
  revealProject: (path: string) => ipcRenderer.invoke("project:reveal", path),
  readFile: (path: string) => ipcRenderer.invoke("file:read", path),
  fileExists: (path: string) => ipcRenderer.invoke("file:exists", path),
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
  favicon: (host: string) => ipcRenderer.invoke("link:favicon", host),
  agentMirrorStart: (p: { width: number; height: number; dpr: number }) => ipcRenderer.invoke("agentmirror:start", p),
  agentMirrorStop: () => ipcRenderer.invoke("agentmirror:stop"),
  agentMirrorResize: (p: { width: number; height: number; dpr: number }) => ipcRenderer.invoke("agentmirror:resize", p),
  agentMirrorInput: (ev: unknown) => ipcRenderer.invoke("agentmirror:input", ev),
  onAgentMirrorFrame: (cb: (p: unknown) => void) => subscribe("agentmirror:frame", cb),
  onAgentMirrorState: (cb: (p: unknown) => void) => subscribe("agentmirror:state", cb),
  onAgentMirrorActivity: (cb: (p: unknown) => void) => subscribe("agentmirror:activity", cb),

  openBrowser: (p: { id: number; url?: string }) => ipcRenderer.invoke("browser:open", p),
  setBrowserBounds: (b: { id: number; x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("browser:bounds", b),
  setBrowserVisible: (p: { id: number; visible: boolean }) => ipcRenderer.invoke("browser:visible", p),
  navigateBrowser: (p: { id: number; url?: string; action?: string }) => ipcRenderer.invoke("browser:navigate", p),
  closeBrowser: (id: number) => ipcRenderer.invoke("browser:close", id),
  startBrowserAnnotate: (id: number) => ipcRenderer.invoke("browser:annotate-mode", id),
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
