import type { ElectronTerminalAdapter } from "./electron-terminal-adapter";
import type {
  TerminalSessionAdapter,
  TerminalSessionHandlers,
} from "../terminal-surface/terminal-session-adapter";
import type { TerminalSurface } from "../terminal-surface/terminal-surface";

export interface TerminalTab {
  readonly container: HTMLElement;
  readonly adapter: ElectronTerminalAdapter;
  readonly mountAbort: AbortController;
  surface: TerminalSurface | undefined;
  label: string;
  removed: boolean;
  ended: boolean;
  readonly snippetTargetListeners: Set<() => void>;
  startRequested: boolean;
}

// A failed tab may remain owned for acknowledgement, but cannot receive input.
export function endTab(tab: TerminalTab): void {
  if (tab.ended) return;
  tab.ended = true;
  for (const listener of tab.snippetTargetListeners) listener();
  tab.snippetTargetListeners.clear();
}

export function closePendingTab(tab: TerminalTab): void {
  tab.mountAbort.abort();
  tab.adapter.close();
}

export function tabSessionAdapter(
  tab: TerminalTab,
  removeTab: (tab: TerminalTab) => void,
  onStarted: () => void,
): TerminalSessionAdapter {
  const { adapter } = tab;
  return {
    start: async (handlers: TerminalSessionHandlers) => {
      tab.startRequested = true;
      await adapter.start({
        onOutput: handlers.onOutput,
        onExit(exit) {
          endTab(tab);
          handlers.onExit(exit);
          // Unexpected exits retain the dead tab until main acknowledges it.
          if (exit.signal === 0 && !exit.startupFailed) removeTab(tab);
        },
      });
      onStarted();
    },
    write: (data) => adapter.write(data),
    resize: (size) => adapter.resize(size),
    close: (reason) => adapter.close(reason),
  };
}
