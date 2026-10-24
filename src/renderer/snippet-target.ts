import type { TerminalSurface } from "../terminal-surface/terminal-surface";

// The terminal a snippet was chosen for, captured when the user acts. It never
// follows the selection to another tab: once its tab closes it delivers nothing.
export interface SnippetTarget {
  live(): boolean;
  deliver(body: string, submit: boolean): void;
}

export function snippetTarget(
  tab:
    | {
        readonly removed: boolean;
        readonly surface?: TerminalSurface | undefined;
      }
    | undefined,
): SnippetTarget | undefined {
  if (!tab?.surface || tab.removed) return undefined;
  const live = () => !tab.removed && tab.surface !== undefined;
  return {
    live,
    deliver(body, submit) {
      if (live()) void tab.surface?.inject(body, { submit });
    },
  };
}
