import type { BrowserWindow } from "electron";
import type { ExtensionTarget } from "./extension-manager";

/** Capture main-observed OSC7 provenance and native lifetime before async work.
 * Selection changes do not retarget existing invocations. Session death revokes
 * them; no renderer-supplied path or later selected pane is consulted. */
export function extensionInvocationTarget(window: BrowserWindow) {
  const lifetime = new AbortController();
  const sessions = new Map<string, AbortController>();
  let selected: string | null = null;
  window.once("closed", () => lifetime.abort());
  window.webContents.once("destroyed", () => lifetime.abort());
  return {
    started(id: string) {
      sessions.set(id, new AbortController());
    },
    ended(id: string) {
      sessions.get(id)?.abort();
      sessions.delete(id);
    },
    selected(id: string | null) {
      selected = id;
    },
    capture(
      directory: (id: string) => string | undefined,
      source = selected ?? undefined,
    ): ExtensionTarget {
      const session = source ? sessions.get(source) : undefined;
      return {
        owner: window,
        signal: source
          ? session
            ? AbortSignal.any([lifetime.signal, session.signal])
            : AbortSignal.abort()
          : lifetime.signal,
        terminalDirectory:
          source && session ? (directory(source) ?? null) : null,
      };
    },
  };
}
