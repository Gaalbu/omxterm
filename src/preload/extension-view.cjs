// App-owned child preload. Requests reach only this actual view's captured
// backend. No path-to-main filesystem or terminal bridge is exposed.
const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  let visible = false;
  const listeners = new Set();
  ipcRenderer.on("extension-view:visibility", (_event, value) => {
    if (typeof value !== "boolean") return;
    visible = value;
    for (const listener of listeners) listener(visible);
  });
  let pending = 0;
  contextBridge.exposeInMainWorld("omxHostedContent", {
    async request(value) {
      if (pending >= 32) throw new Error("Request capacity exceeded");
      pending++;
      try {
        return await ipcRenderer.invoke("extension-view:request", value);
      } finally {
        pending--;
      }
    },
    onVisibility(listener) {
      if (typeof listener !== "function" || listeners.size >= 32)
        throw new TypeError("Invalid visibility subscription");
      listeners.add(listener);
      listener(visible);
      return () => listeners.delete(listener);
    },
  });
}
