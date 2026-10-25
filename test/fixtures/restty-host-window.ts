import { app, BrowserWindow } from "electron";
import path from "node:path";
import { recordResttyHostPhase as phase } from "./restty-host-phases";

export async function initializeResttyHostWindow(
  window: BrowserWindow,
  root: string,
  sessionReady: () => boolean,
  waitFor: (
    predicate: () => boolean | Promise<boolean>,
    label: string,
  ) => Promise<void>,
) {
  phase("window-load", "begin");
  await window.loadFile(path.join(root, "renderer", "index.html"));
  phase("window-load", "complete");
  window.showInactive();
  phase("first-session", "begin");
  await waitFor(sessionReady, "default Restty session");
  phase("first-session", "complete");
  const onFocus = () => phase("native-focus-event", "complete");
  window.once("focus", onFocus);
  try {
    phase("native-focus-request", "begin");
    // This host scenario asserts active-window DOM focus. Native activation lets
    // the production page-focus owner restore it without forcing a DOM target.
    // Activate the owned macOS app only at initial readiness, not during blur tests.
    if (process.platform === "darwin" && !app.isActive()) {
      app.focus({ steal: true });
    }
    window.focus();
    phase("native-focus-request", "complete");
    phase("native-focus", "begin");
    await waitFor(() => window.isFocused(), "native host window activation");
    phase("native-focus", "complete");
    let queried = false;
    let responded = false;
    phase("dom-focus", "begin");
    await waitFor(async () => {
      if (!queried) {
        queried = true;
        phase("dom-focus-query", "begin");
      }
      const focused: unknown = await window.webContents.executeJavaScript(
        "document.activeElement?.closest('.restty-terminal-surface') !== null",
        true,
      );
      // First response to the EXISTING query proves responsiveness, even if
      // false. No added probe, periodic watcher or extra focus action.
      if (!responded) {
        responded = true;
        phase("dom-focus-query", "complete");
      }
      return focused as boolean;
    }, "initial terminal focus");
    phase("dom-focus", "complete");
  } finally {
    window.removeListener("focus", onFocus);
  }
}

export function createResttyHostWindows(
  root: string,
  onWindowOpen: () => void,
  onNavigate: () => void,
) {
  const keeper = new BrowserWindow({ show: false });
  const window = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.join(root, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => {
    onWindowOpen();
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    onNavigate();
    event.preventDefault();
  });
  return { keeper, window };
}
