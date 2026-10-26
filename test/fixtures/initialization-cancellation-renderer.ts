import { startTerminalWindow } from "../../src/renderer/start-terminal-window";
import { observeHostTabCommands } from "./host-tab-command-readiness";

const bridge = window.omxterm;
const host = observeHostTabCommands(
  bridge.terminal.onTabCommand,
  new URLSearchParams(location.search).has("holdHostRegistration"),
);
Object.defineProperty(globalThis, "__omxtermInitializationHost", {
  value: { isReady: () => host.ready, wait: host.wait, release: host.release },
});
window.addEventListener("pagehide", host.dispose, { once: true });
startTerminalWindow({
  ...bridge,
  terminal: { ...bridge.terminal, onTabCommand: host.subscribe },
});
