import type { SavedLayout } from "../../src/shared/terminal-layout";
export function savedLayout(): SavedLayout {
  return {
    version: 1,
    platform: "linux",
    savedAt: "2026-07-01T10:00:00.000Z",
    selected: 0,
    omitted: 1,
    tabs: [
      {
        root: 0,
        focused: 1,
        nodes: [
          { direction: "row", children: [1, 2, 3], weights: [0.2, 0.3, 0.5] },
          { pane: 0 },
          { pane: 1 },
          { pane: 2 },
        ],
        panes: [
          { kind: "reported-local", path: "/synthetic/reported" },
          { kind: "launch-local", path: "/synthetic/launch" },
          { kind: "home" },
        ],
      },
    ],
  };
}
