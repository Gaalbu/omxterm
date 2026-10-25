import { beforeAll, describe, expect, it, vi } from "vitest";
import { clipboardRequests } from "../../src/main/terminal-ipc-boundaries";
import type { TerminalBridge } from "../../src/shared/terminal-bridge";
import { terminalIpc } from "../../src/shared/terminal-ipc";

const electron = vi.hoisted(() => ({
  bridge: undefined as TerminalBridge | undefined,
  send: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld(_key: string, value: { terminal: TerminalBridge }) {
      electron.bridge = value.terminal;
    },
  },
  webUtils: { getPathForFile: vi.fn() },
  ipcRenderer: {
    send: electron.send,
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

beforeAll(async () => {
  await import("../../src/preload/index");
});

const forgedOffers = [
  { closePane: false },
  { closePane: "yes" },
  { closePane: true, extra: 1 },
  [true],
];

describe("Close Pane context menu offer", () => {
  it("leaves preload only with no request or the exact offer", () => {
    const bridge = electron.bridge!;
    const channel = terminalIpc.clipboardContextMenu;
    bridge.requestClipboardContextMenu();
    expect(electron.send).toHaveBeenLastCalledWith(channel);
    bridge.requestClipboardContextMenu({ closePane: true });
    expect(electron.send).toHaveBeenLastCalledWith(channel, {
      closePane: true,
    });
    electron.send.mockClear();
    for (const forged of forgedOffers)
      expect(() => bridge.requestClipboardContextMenu(forged as never)).toThrow(
        TypeError,
      );
    expect(electron.send).not.toHaveBeenCalled();
  });

  it("reaches main's menu only as the exact offer", () => {
    const showClipboardContextMenu = vi.fn();
    const reject = vi.fn();
    const requests = clipboardRequests(
      {
        writeClipboardText: vi.fn(),
        readClipboardText: () => "",
        confirmPaste: async () => false,
        showClipboardContextMenu,
      },
      reject,
    );
    for (const forged of forgedOffers)
      requests.showClipboardContextMenu(forged);
    expect(showClipboardContextMenu).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(forgedOffers.length);
    expect(reject).toHaveBeenLastCalledWith("clipboard", "invalid-payload");

    requests.showClipboardContextMenu();
    expect(showClipboardContextMenu).toHaveBeenLastCalledWith();
    requests.showClipboardContextMenu({ closePane: true });
    expect(showClipboardContextMenu).toHaveBeenLastCalledWith({
      closePane: true,
    });
  });
});
