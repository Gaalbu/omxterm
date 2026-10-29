import { expect, it, vi } from "vitest";
import type { TerminalBridge } from "../../src/shared/terminal-bridge";
import { terminalIpc } from "../../src/shared/terminal-ipc";
const electron = vi.hoisted(() => ({
  bridge: undefined as TerminalBridge | undefined,
  invoke: vi.fn(async () => "s1"),
}));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld(_key: string, value: { terminal: TerminalBridge }) {
      electron.bridge = value.terminal;
    },
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: vi.fn(),
    send: vi.fn(),
    removeListener: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}));
it("sends an exclusive restore intent through the actual preload without interpreting it as SSH", async () => {
  await import("../../src/preload/index");
  const token = "00000000-0000-0000-0000-000000000001";
  const bridge = electron.bridge!;
  expect(bridge.layout).toBeDefined();
  expect(await bridge.start(undefined, undefined, undefined, token)).toBe("s1");
  expect(electron.invoke).toHaveBeenLastCalledWith(terminalIpc.start, {
    restoreToken: token,
  });
  await expect(
    bridge.start(undefined, undefined, token, token),
  ).rejects.toThrow("Invalid layout");
  await expect(bridge.start(undefined, "s1", undefined, token)).rejects.toThrow(
    "Invalid layout",
  );
});
