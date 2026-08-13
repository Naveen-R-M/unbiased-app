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

  sendMessage: (paneId: string, text: string, attachments?: { name: string; path: string; kind?: string }[]) =>
    ipcRenderer.invoke("chat:send", { paneId, text, attachments }),
  chooseAttachments: () => ipcRenderer.invoke("attach:choose"),
  clipboardHasImage: () => ipcRenderer.invoke("clipboard:has-image"),
  clipboardImage: () => ipcRenderer.invoke("attach:clipboard-image"),
  interrupt: (paneId: string) => ipcRenderer.invoke("chat:interrupt", paneId),
  onTurnStarted: (cb: (p: unknown) => void) => subscribe("chat:turn-started", cb),
  onDelta: (cb: (p: unknown) => void) => subscribe("chat:delta", cb),
  onTurnCompleted: (cb: (p: unknown) => void) => subscribe("chat:turn-completed", cb),

  decideApproval: (requestId: string, decision: "accept" | "decline") =>
    ipcRenderer.invoke("chat:approve", { requestId, decision }),
  onApprovalRequest: (cb: (p: unknown) => void) => subscribe("chat:approval-request", cb),
  onCommand: (cb: (p: unknown) => void) => subscribe("chat:command", cb),

  listThreads: () => ipcRenderer.invoke("threads:list"),
  openThread: (id: string) => ipcRenderer.invoke("threads:open", id),
  detachThread: (cwd?: string) => ipcRenderer.invoke("threads:detach", cwd),
  deleteThread: (id: string) => ipcRenderer.invoke("threads:delete", id),
  resetSideChat: () => ipcRenderer.invoke("side:reset"),
  chooseProject: () => ipcRenderer.invoke("project:choose"),
  readFile: (path: string) => ipcRenderer.invoke("file:read", path),
  readImage: (path: string) => ipcRenderer.invoke("file:read-image", path),
  listDir: (dir?: string) => ipcRenderer.invoke("fs:list", dir),
  searchRefs: (word: string) => ipcRenderer.invoke("fs:search-refs", word),
});
