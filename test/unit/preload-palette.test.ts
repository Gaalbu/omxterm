import { beforeAll, expect, it, vi } from "vitest";
import type { TerminalBridge } from "../../src/shared/terminal-bridge";
import { paletteIpc } from "../../src/shared/command-palette";
import { terminalIpc } from "../../src/shared/terminal-ipc";

const mock = vi.hoisted(() => ({
  bridge: undefined as TerminalBridge | undefined,
  listeners: new Map<string, Set<(event: unknown, payload: unknown) => void>>(),
}));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, value: { terminal: TerminalBridge }) => {
      mock.bridge = value.terminal;
    },
  },
  webUtils: {},
  ipcRenderer: {
    invoke: vi.fn(async () => undefined),
    send: vi.fn(),
    on(channel: string, listener: (event: unknown, payload: unknown) => void) {
      let listeners = mock.listeners.get(channel);
      if (!listeners)
        mock.listeners.set(
          channel,
          (listeners = new Set<(event: unknown, payload: unknown) => void>()),
        );
      listeners.add(listener);
    },
    removeListener(
      channel: string,
      listener: (event: unknown, payload: unknown) => void,
    ) {
      mock.listeners.get(channel)?.delete(listener);
    },
  },
}));
beforeAll(async () => {
  await import("../../src/preload/index");
});
function emit(channel: string, payload?: unknown) {
  for (const listener of mock.listeners.get(channel) ?? [])
    listener({}, payload);
}
it("feeds guarded palette tab dispatch into the production subscription validator", () => {
  const bridge = mock.bridge!;
  const command = vi.fn();
  const remove = bridge.onTabCommand(command);
  const dispatch = (token: unknown, payload: unknown) =>
    emit(paletteIpc.dispatch, {
      token,
      channel: terminalIpc.tabCommand,
      payload,
    });
  dispatch("one", { action: "new" });
  expect(command).not.toHaveBeenCalled();
  bridge.palette!.setDispatchGuard((token) => token === "one");
  dispatch("other", { action: "new" });
  dispatch("one", { action: "arbitrary" });
  expect(command).not.toHaveBeenCalled();
  dispatch("one", { action: "new" });
  expect(command).toHaveBeenLastCalledWith({ action: "new" });
  emit(terminalIpc.tabCommand, { action: "next" });
  expect(command).toHaveBeenLastCalledWith({ action: "next" });
  remove();
  dispatch("one", { action: "new" });
  emit(terminalIpc.tabCommand, { action: "new" });
  expect(command).toHaveBeenCalledTimes(2);
  bridge.palette!.setDispatchGuard(undefined);
});
