import type { TerminalContextMenuTarget } from "../shared/terminal-contract";
import type { TerminalSurface } from "../terminal-surface/terminal-surface";
import type { TerminalPane } from "./terminal-panes";

// One popup owns one exact pane/Surface. Its token only correlates main's
// notification; neither a later focus nor a replacement popup may adopt it.
export function createPaneContextMenu(options: {
  readonly focusedPane: () => TerminalPane | undefined;
  readonly disposed: () => boolean;
  readonly canInteract: () => boolean;
}) {
  let captured:
    | {
        target: TerminalContextMenuTarget;
        pane: TerminalPane;
        surface: TerminalSurface;
      }
    | undefined;
  let nextMenuId = 1;
  return {
    capture(pane: TerminalPane): TerminalContextMenuTarget | undefined {
      const sessionId = pane.adapter.sessionId();
      if (
        options.disposed() ||
        !options.canInteract() ||
        pane.removed ||
        pane.ended ||
        !pane.surface ||
        pane !== options.focusedPane() ||
        sessionId === undefined
      )
        return undefined;
      const target = { sessionId, menuId: nextMenuId++ };
      captured = { target, pane, surface: pane.surface };
      return target;
    },
    take(target: TerminalContextMenuTarget): TerminalPane | undefined {
      if (
        !captured ||
        captured.target.menuId !== target.menuId ||
        captured.target.sessionId !== target.sessionId
      )
        return undefined;
      const { pane, surface } = captured;
      captured = undefined;
      return !options.disposed() &&
        !pane.removed &&
        !pane.ended &&
        !pane.tab.removed &&
        pane === options.focusedPane() &&
        pane.surface === surface
        ? pane
        : undefined;
    },
    selectionChanged() {
      if (captured && captured.pane !== options.focusedPane())
        captured = undefined;
    },
    dispose() {
      captured = undefined;
    },
  };
}
