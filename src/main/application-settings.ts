import { app, BrowserWindow, ipcMain } from "electron";
import { createSettingsService } from "./settings-service";
import { startSettings } from "./settings-wiring";
import type {
  TerminalIpcRouter,
  TrustedWebContents,
} from "./terminal-ipc-types";
import type { KeybindCapture } from "./keybind-capture";
import type { LoadUserConfigurationOptions } from "./user-configuration";
import type { UserConfigurationReloader } from "./user-configuration-reloader";

export function startApplicationSettings(
  router: TerminalIpcRouter,
  loadOptions: LoadUserConfigurationOptions,
  reloader: UserConfigurationReloader,
  capture: Pick<KeybindCapture, "set">,
  sendAction?: (
    sender: TrustedWebContents,
    channel: string,
    payload?: unknown,
  ) => void,
) {
  const settings = startSettings({
    ipcMain,
    ...(sendAction ? { sendAction } : {}),
    isTrustedSender: router.isTrustedSender,
    service: createSettingsService({
      loadOptions,
      reload: () => reloader.reload(),
    }),
    selectedContents: () => BrowserWindow.getFocusedWindow()?.webContents,
    capture,
  });
  app.once("will-quit", settings.dispose);
  return settings.show;
}
