import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { expect, it, vi } from "vitest";
import { registerTerminalLayoutIpc } from "../../src/main/terminal-layout-ipc";
import { layoutIpc } from "../../src/shared/terminal-layout";
import type { TerminalIpcController } from "../../src/main/terminal-ipc-types";
import { createIpcHarness } from "../fixtures/terminal-ipc-harness";
const token = "00000000-0000-0000-0000-000000000001";
const layout = {
  selected: 0,
  omitted: 1,
  tabs: [{ root: 0, focused: 0, panes: ["s1"], nodes: [{ pane: 0 }] }],
};
function setup() {
  const ipc = createIpcHarness();
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
  }) as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  let quitting = false;
  const service = registerTerminalLayoutIpc({
    ipc: ipc.ipcMain,
    platform: "linux",
    quitting: () => quitting,
    trusted: (value) => value.senderFrame === value.sender.mainFrame,
  });
  const directory = vi.fn(() => ({
    kind: "launch-local" as const,
    path: "/synthetic",
  }));
  const controller = {
    layoutDirectory: directory,
  } as unknown as TerminalIpcController;
  service.register(window, controller, {
    initial: {
      selected: 0,
      fallbacks: 0,
      tabs: [{ ...layout.tabs[0]!, panes: [token] }],
    },
    directories: new Map([[token, "/synthetic"]]),
  });
  return {
    ipc,
    window,
    contents,
    event,
    service,
    directory,
    quit() {
      quitting = true;
    },
  };
}
it("binds initial plan and single-use/cancellable allocations to the actual window", () => {
  const test = setup();
  expect(test.service.constructing()).toBe(true);
  expect(test.ipc.handlers.get(layoutIpc.initial)!(test.event)).toMatchObject({
    selected: 0,
  });
  expect(() => test.ipc.handlers.get(layoutIpc.initial)!(test.event)).toThrow();
  expect(() =>
    test.service.consume({ webContents: {} } as BrowserWindow, token),
  ).toThrow();
  expect(test.service.consume(test.window, token)).toBe("/synthetic");
  expect(() => test.service.consume(test.window, token)).toThrow();
  expect(test.service.constructing()).toBe(false);
  test.service.dispose();
});
it("captures only matching sender/request and enriches the renderer clone in main", async () => {
  const test = setup();
  const pending = test.service.capture(
    test.window,
    new AbortController().signal,
  );
  const id: unknown = test.contents.send.mock.calls[0]![1];
  test.ipc.listeners.get(layoutIpc.captured)!(
    { ...test.event, senderFrame: {} },
    { id, layout },
  );
  expect(test.directory).not.toHaveBeenCalled();
  test.ipc.listeners.get(layoutIpc.captured)!(test.event, {
    id: "wrong",
    layout,
  });
  expect(test.directory).not.toHaveBeenCalled();
  test.ipc.listeners.get(layoutIpc.captured)!(test.event, { id, layout });
  expect(await pending).toMatchObject({
    version: 1,
    platform: "linux",
    omitted: 1,
    tabs: [{ panes: [{ kind: "launch-local", path: "/synthetic" }] }],
  });
  expect(test.directory).toHaveBeenCalledWith("s1");
  test.service.dispose();
});
it.each(["abort", "loss", "quit"])(
  "retires capture/allocations on %s",
  async (mode) => {
    const test = setup();
    const abort = new AbortController();
    const pending = test.service.capture(test.window, abort.signal);
    const rejected = expect(pending).rejects.toThrow();
    if (mode === "abort") {
      abort.abort();
      test.ipc.listeners.get(layoutIpc.cancel)!(test.event, token);
    } else if (mode === "loss") test.contents.emit("render-process-gone");
    else {
      test.quit();
      test.service.dispose();
    }
    await rejected;
    expect(() => test.service.consume(test.window, token)).toThrow();
    test.service.dispose();
  },
);
