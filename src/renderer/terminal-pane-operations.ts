import {
  MAX_PANES_PER_TAB,
  MIN_PANE_COLUMNS,
  MIN_PANE_ROWS,
  type TerminalPaneCommand,
  type TerminalPaneFocusTarget,
  type TerminalSplitDirection,
} from "../shared/terminal-panes";
import {
  adjacentPane,
  directionalPane,
  equalizeParent,
  leaf,
  minimumExtent,
  removePane as removeLayoutPane,
  resizeSplit,
  splitPane,
  type PaneLayout,
  type SplitAxis,
} from "./pane-layout";
import { applyPaneWeights, renderPaneLayout } from "./pane-view";
import {
  createPane,
  disposePane,
  tabPanes,
  type CreatePaneAdapter,
  type TerminalPane,
  type TerminalTab,
} from "./terminal-panes";

// Pane operations for the window's tabs. The tabs layer owns selection,
// session start and the last-tab lifecycle; panes own split, focus and size.
export function createPaneOperations(deps: {
  readonly selectedTab: () => TerminalTab | undefined;
  readonly removeTab: (tab: TerminalTab, notify?: boolean) => void;
  readonly createAdapter: CreatePaneAdapter;
  readonly mountPane: (pane: TerminalPane) => Promise<void>;
  // Focus the pane's Surface when the window may move focus there.
  // passive: a background change, which never takes focus from panel or
  // overlay controls.
  readonly focusSurface: (pane: TerminalPane, passive?: boolean) => void;
  // The focused pane or the tab's set of sessions changed.
  readonly onFocusChange: (tab: TerminalTab) => void;
  readonly disposed: () => boolean;
}) {
  const renderTab = (tab: TerminalTab) => {
    const panes = tabPanes(tab);
    tab.container.toggleAttribute("data-split", panes.length > 1);
    for (const pane of panes)
      pane.container.classList.toggle(
        "pane-focused",
        panes.length > 1 && pane === tab.focused,
      );
    renderPaneLayout(tab.container, tab.layout, {
      onResize(path, index, delta, length) {
        if (tab.removed || length <= 0) return;
        tab.layout = resizeSplit(tab.layout, path, index, delta, (child) =>
          minimumFraction(tab, child, axisAt(tab.layout, path), length),
        );
        applyPaneWeights(tab.container, tab.layout);
      },
    });
  };

  const focusPane = (tab: TerminalTab, pane: TerminalPane, move = false) => {
    if (pane.removed || tab.removed) return;
    const changed = tab.focused !== pane;
    tab.focused = pane;
    if (changed) {
      for (const candidate of tabPanes(tab))
        candidate.container.classList.toggle(
          "pane-focused",
          tabPanes(tab).length > 1 && candidate === pane,
        );
      deps.onFocusChange(tab);
    }
    if (move) deps.focusSurface(pane);
  };

  const trackFocus = (pane: TerminalPane) => {
    pane.container.addEventListener("focusin", () => {
      if (!deps.disposed() && !pane.removed) focusPane(pane.tab, pane);
    });
  };

  // Removing a tab's last pane follows the existing last-tab lifecycle.
  const removePane = (pane: TerminalPane, notify = true) => {
    const { tab } = pane;
    if (pane.removed || tab.removed) return;
    if (tabPanes(tab).length <= 1) {
      pane.removed = true;
      deps.removeTab(tab, notify);
      return;
    }
    const fallback =
      adjacentPane(tab.layout, pane, -1) ?? adjacentPane(tab.layout, pane, 1)!;
    pane.removed = true;
    tab.layout = removeLayoutPane(tab.layout, pane) ?? leaf(fallback);
    pane.container.remove();
    const wasFocused = tab.focused === pane;
    if (wasFocused) tab.focused = fallback;
    renderTab(tab);
    deps.onFocusChange(tab);
    if (wasFocused && tab === deps.selectedTab())
      deps.focusSurface(fallback, true);
  };

  const closePane = (pane: TerminalPane | undefined) => {
    if (!pane || pane.removed) return;
    removePane(pane);
    disposePane(pane);
  };
  // The focused pane retained by "prepare-close-pane", never a later focus.
  let pendingClose: TerminalPane | undefined;

  const operations = {
    renderTab,
    trackFocus,
    focusPane,
    removePane,
    closePane,
    // A split needs room for two minimum panes in the focused pane's grid; a
    // refused split starts no session.
    split(direction: TerminalSplitDirection) {
      const tab = deps.selectedTab();
      if (!tab || tabPanes(tab).length >= MAX_PANES_PER_TAB) return;
      const source = tab.focused;
      const size = source.size;
      if (
        !size ||
        (direction === "right"
          ? size.cols < MIN_PANE_COLUMNS * 2 + 1
          : size.rows < MIN_PANE_ROWS * 2 + 1)
      )
        return;
      const pane = createPane(
        tab,
        deps.createAdapter,
        source.adapter.sessionId(),
      );
      tab.layout = splitPane(
        tab.layout,
        source,
        pane,
        direction === "right" ? "row" : "column",
      );
      tab.focused = pane;
      renderTab(tab);
      trackFocus(pane);
      deps.onFocusChange(tab);
      // A failed spawn already dropped its pane; main shows the native
      // failure dialog, so the renderer only swallows here.
      void deps.mountPane(pane).catch(() => {});
    },
    focusTarget(target: TerminalPaneFocusTarget) {
      const tab = deps.selectedTab();
      if (!tab) return;
      const next =
        target === "next" || target === "previous"
          ? adjacentPane(tab.layout, tab.focused, target === "next" ? 1 : -1)
          : directionalPane(tabPanes(tab), tab.focused, target, (pane) =>
              pane.container.getBoundingClientRect(),
            );
      if (next) focusPane(tab, next, true);
    },
    equalize() {
      const tab = deps.selectedTab();
      if (!tab) return;
      tab.layout = equalizeParent(tab.layout, tab.focused);
      applyPaneWeights(tab.container, tab.layout);
    },
    handleCommand(command: TerminalPaneCommand) {
      switch (command.action) {
        case "split":
          operations.split(command.direction);
          return;
        case "focus-pane":
          operations.focusTarget(command.target);
          return;
        case "equalize-panes":
          operations.equalize();
          return;
        case "close-pane":
          closePane(deps.selectedTab()?.focused);
          return;
        case "prepare-close-pane":
          pendingClose = deps.selectedTab()?.focused;
          return;
        case "resolve-close-pane": {
          const target = pendingClose;
          pendingClose = undefined;
          if (command.confirmed) closePane(target);
        }
      }
    },
  };
  return operations;
}

function axisAt(
  layout: PaneLayout<TerminalPane>,
  path: readonly number[],
): SplitAxis {
  let node = layout;
  for (const index of path)
    if (node.kind === "split") node = node.children[index]!;
  return node.kind === "split" ? node.direction : "row";
}

// The share of `length` a subtree needs so each of its panes keeps the
// reference minimum, from a mounted pane's current cell size. Without a
// measured cell (hidden or not yet sized), any share is allowed.
function minimumFraction(
  tab: TerminalTab,
  child: PaneLayout<TerminalPane>,
  axis: SplitAxis,
  length: number,
): number {
  const measured = tabPanes(tab).find(
    (pane) => pane.size && pane.container.clientWidth > 0,
  );
  if (!measured?.size) return 0;
  const cell =
    axis === "row"
      ? (measured.container.clientWidth / measured.size.cols) * MIN_PANE_COLUMNS
      : (measured.container.clientHeight / measured.size.rows) * MIN_PANE_ROWS;
  return Math.min(0.5, minimumExtent(child, axis, cell) / length);
}
