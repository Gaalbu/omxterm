// Keep the main fixture's first B command sequence executable headlessly.
export async function startCancellationTab(
  renderer: Pick<Electron.WebContents, "executeJavaScript">,
  createTab: () => void,
): Promise<void> {
  // A's child can be ready before its Surface returns and the host subscribes.
  // This is a receipt from that actual subscription, never an arrival observer.
  await renderer.executeJavaScript(
    "globalThis.__omxtermInitializationHost.wait()",
  );
  createTab();
}
