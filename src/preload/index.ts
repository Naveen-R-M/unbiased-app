import { contextBridge, ipcRenderer } from "electron";

// The renderer's entire view of the engine. Typed, minimal, and additive:
// each milestone (approvals, threads) extends this surface rather than
// exposing ipcRenderer directly.

function subscribe(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("unbiased", {
  getEngineStatus: () => ipcRenderer.invoke("engine:status"),
  onEngineStatus: (cb: (status: unknown) => void) => subscribe("engine:status", cb),

  sendMessage: (text: string) => ipcRenderer.invoke("chat:send", text),
  interrupt: () => ipcRenderer.invoke("chat:interrupt"),
  onTurnStarted: (cb: (p: unknown) => void) => subscribe("chat:turn-started", cb),
  onDelta: (cb: (p: unknown) => void) => subscribe("chat:delta", cb),
  onTurnCompleted: (cb: (p: unknown) => void) => subscribe("chat:turn-completed", cb),

  decideApproval: (requestId: string, decision: "accept" | "decline") =>
    ipcRenderer.invoke("chat:approve", { requestId, decision }),
  onApprovalRequest: (cb: (p: unknown) => void) => subscribe("chat:approval-request", cb),
  onCommand: (cb: (p: unknown) => void) => subscribe("chat:command", cb),

  listThreads: () => ipcRenderer.invoke("threads:list"),
  openThread: (id: string) => ipcRenderer.invoke("threads:open", id),
  detachThread: () => ipcRenderer.invoke("threads:detach"),
  deleteThread: (id: string) => ipcRenderer.invoke("threads:delete", id),
});
