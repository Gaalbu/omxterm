import { startTerminalWindow } from "../../src/renderer/start-terminal-window";
import { readReloadEvidence } from "./font-read-reload-evidence";

const bridge = window.omxterm;
startTerminalWindow({
  ...bridge,
  terminal: {
    ...bridge.terminal,
    onTabCommand(listener) {
      const remove = bridge.terminal.onTabCommand(listener);
      // Only successful registration by the actual host establishes readiness.
      readReloadEvidence.hostReady = true;
      return remove;
    },
  },
});
