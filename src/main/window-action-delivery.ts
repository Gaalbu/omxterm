import type { BrowserWindow } from "electron";
import { coreActionKeybinds, type CoreActionCatalog } from "./action-catalog";
import type { startCommandPalette } from "./command-palette";
import type { KeybindCapture } from "./keybind-capture";
import { deliverKeybindsFromKeyEvents } from "./keybind-delivery";

// Window-owned key delivery and palette invalidation share native lifetime.
export function registerWindowActionDelivery(
  window: BrowserWindow,
  catalog: () => CoreActionCatalog,
  capture: KeybindCapture,
  palette: () => ReturnType<typeof startCommandPalette> | undefined,
) {
  const contents = window.webContents;
  deliverKeybindsFromKeyEvents(
    contents,
    () => coreActionKeybinds(catalog()),
    (action) => catalog()[action].invoke(),
    process.platform,
    capture,
  );
  const invalidate = () => palette()?.invalidate(contents);
  window.on("blur", invalidate);
  contents.on("did-start-loading", invalidate);
  contents.on("render-process-gone", invalidate);
  contents.on("destroyed", invalidate);
  window.on("blur", () => capture.release(contents));
  window.once("closed", () => capture.release(contents));
  let selection: string | null | undefined;
  return {
    invalidate,
    select(next: string | null) {
      // Refocusing the same Surface is not selection loss.
      if (selection !== next) invalidate();
      selection = next;
    },
  };
}
