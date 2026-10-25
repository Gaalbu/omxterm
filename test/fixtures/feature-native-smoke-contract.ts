// One maintained native case, selected literally during focused qualification.
export const FEATURE_SMOKE_CASE =
  "checks pane geometry and live language drafts without leaking a native dialog or process";
export const FEATURE_SMOKE_FLAG = "--fixture-feature-smoke";
export const FEATURE_SMOKE_PHASE_PREFIX = "__OMXTERM_FEATURE_SMOKE_PHASE__";
export const FEATURE_SMOKE_PHASES = [
  "split",
  "focus-and-input",
  "divider-and-grids",
  "close-and-survivor",
  "language-and-drafts",
] as const;
export const FEATURE_SMOKE_RESULT = {
  split: "two-real-panes-one-tab",
  focus: "dom-and-command-main-ownership",
  input: "two-native-program-acknowledgements",
  resize: "divider-bounds-and-both-pty-grids",
  close: "one-native-exit-survivor-retained",
  language: "settings-save-file-reload-two-hosts",
  drafts: "same-editors-bytes-selection-scroll-and-dom-focus",
  continuity: "same-windows-canvases-and-surviving-sessions",
} as const;
