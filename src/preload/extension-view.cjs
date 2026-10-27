// App-owned child preload. No request, filesystem, backend or terminal bridge.
const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  let visible = false;
  const listeners = new Set();
  ipcRenderer.on("extension-view:visibility", (_event, value) => {
    if (typeof value !== "boolean") return;
    visible = value;
    for (const listener of listeners) listener(visible);
  });
  contextBridge.exposeInMainWorld("omxHostedContent", {
    onVisibility(listener) {
      if (typeof listener !== "function" || listeners.size >= 32)
        throw new TypeError("Invalid visibility subscription");
      listeners.add(listener);
      listener(visible);
      return () => listeners.delete(listener);
    },
  });
}
