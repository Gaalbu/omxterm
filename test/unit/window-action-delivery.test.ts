import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { expect, it, vi } from "vitest";
import {
  createCoreActionCatalog,
  type TerminalApplicationMenuActions,
} from "../../src/main/action-catalog";
import { startCommandPalette } from "../../src/main/command-palette";
import { registerWindowActionDelivery } from "../../src/main/window-action-delivery";
import { createKeybindCapture } from "../../src/main/keybind-capture";
import { terminalDefaultKeybinds } from "../../src/shared/terminal-keybinds";
import { paletteIpc } from "../../src/shared/command-palette";
import type { IpcEvent } from "../../src/main/terminal-ipc-types";

it("keeps same-content focus but invalidates palette leases on owner/selection loss", () => {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const window = Object.assign(new EventEmitter(), { webContents: contents });
  const handlers = new Map<
    string,
    (event: IpcEvent, ...args: unknown[]) => unknown
  >();
  const invoke = vi.fn();
  const catalog = createCoreActionCatalog(
    "OMXTerm",
    new Proxy({} as TerminalApplicationMenuActions, { get: () => invoke }),
    terminalDefaultKeybinds(process.platform),
  );
  const palette = startCommandPalette({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    },
    isTrustedSender: () => true,
    selectedContents: () => contents,
    catalog: () => catalog,
  });
  const owner = registerWindowActionDelivery(
    window as unknown as BrowserWindow,
    () => catalog,
    createKeybindCapture(process.platform),
    () => palette,
  );
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const snapshot = () =>
    handlers.get(paletteIpc.snapshot)!(event) as { token: string };
  const run = (token: string) =>
    handlers.get(paletteIpc.invoke)!(event, token, "toggleTabBar");
  owner.select("session-a");
  const retained = snapshot();
  owner.select("session-a");
  run(retained.token);
  expect(invoke).toHaveBeenCalledOnce();
  invoke.mockClear();
  const old = snapshot();
  owner.select("settings");
  owner.select("session-a");
  run(old.token);
  expect(invoke).not.toHaveBeenCalled();
  for (const [emitter, name] of [
    [window, "blur"],
    [contents, "did-start-loading"],
    [contents, "render-process-gone"],
    [contents, "destroyed"],
  ] as const) {
    const lease = snapshot();
    emitter.emit(name);
    run(lease.token);
    expect(invoke).not.toHaveBeenCalled();
  }
  palette.dispose();
});
