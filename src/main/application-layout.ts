import { ipcMain, type BrowserWindow } from "electron";
import { registerTerminalLayoutIpc } from "./terminal-layout-ipc";
import { createTerminalLayoutTransfer } from "./terminal-layout-transfer";
import type { TerminalApplication } from "./terminal-application";
import type { IpcEvent } from "./terminal-ipc-types";

export function startApplicationLayout(options: {
  trusted(event: IpcEvent): boolean;
  home: string;
  application(): TerminalApplication<BrowserWindow> | undefined;
}) {
  const ipc = registerTerminalLayoutIpc({
    ipc: ipcMain,
    trusted: options.trusted,
    platform: process.platform as "linux" | "darwin" | "win32",
    quitting: () => options.application()?.isQuitting() === true,
  });
  const transfer = createTerminalLayoutTransfer<BrowserWindow>({
    platform: process.platform,
    home: options.home,
    alive: (window) =>
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      options.application()?.isQuitting() !== true,
    available: () => !ipc.constructing(),
    create: (plan, focus, accepted) =>
      options.application()!.newWindow({ plan, focus, accepted }),
  });
  return {
    capture: ipc.capture,
    open: transfer.open,
    register: ipc.register,
    consume: ipc.consume,
    dispose() {
      transfer.dispose();
      ipc.dispose();
    },
  };
}
