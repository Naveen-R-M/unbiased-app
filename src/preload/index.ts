import { contextBridge, ipcRenderer } from "electron";

// The renderer's entire view of the engine. Typed, minimal, and additive:
// each milestone (turns, approvals, threads) extends this surface rather
// than exposing ipcRenderer directly.
contextBridge.exposeInMainWorld("unbiased", {
  getEngineStatus: () => ipcRenderer.invoke("engine:status"),
  onEngineStatus: (cb: (status: unknown) => void) => {
    const listener = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on("engine:status", listener);
    return () => ipcRenderer.removeListener("engine:status", listener);
  },
});
