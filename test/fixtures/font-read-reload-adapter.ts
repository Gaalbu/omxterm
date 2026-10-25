import { createElectronTerminalAdapter as createReal } from "../../src/renderer/electron-terminal-adapter";
import { readReloadEvidence } from "./font-read-reload-evidence";

// Observe the real bridge start receipt before the pane hides sessionId behind
// its portable Adapter. Construction order matches the fixture's mount order,
// including cancelled owners; start completion order need not match either.
export const createElectronTerminalAdapter: typeof createReal = (...args) => {
  const adapter = createReal(...args);
  const index = readReloadEvidence.sessionIds.length;
  readReloadEvidence.sessionIds.push(undefined);
  return {
    ...adapter,
    async start(handlers) {
      await adapter.start(handlers);
      readReloadEvidence.sessionIds[index] = adapter.sessionId();
    },
  };
};
