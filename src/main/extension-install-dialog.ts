import { dialog, type BrowserWindow } from "electron";
import type { createExtensionManager } from "./extension-manager";
import { translatorFor, type Translator } from "../shared/i18n";

export async function installExtensionFromDialog(
  window: BrowserWindow,
  manager: ReturnType<typeof createExtensionManager>,
  stopping: () => boolean,
  translator: () => Translator = () => translatorFor("en-US"),
  captured?: Buffer,
) {
  const owner = window.webContents;
  const cancelled = () => manager.cancel(owner);
  owner.once("destroyed", cancelled);
  try {
    const selected = captured
      ? undefined
      : await dialog.showOpenDialog(window, {
          title: translator().t("extensions.chooserTitle"),
          properties: ["openFile"],
          filters: [
            {
              name: translator().t("extensions.chooserType"),
              extensions: ["omxext"],
            },
          ],
        });
    if (selected?.canceled || owner.isDestroyed() || stopping()) return false;
    const preview = await manager.prepare(
      owner,
      captured ?? selected!.filePaths[0]!,
    );
    if (owner.isDestroyed() || stopping()) return false;
    const consent = await dialog.showMessageBox(window, {
      type: "warning",
      title: translator().t("extensions.trustTitle"),
      message: translator().t("extensions.trustMessage", {
        name: preview.manifest.name,
        version: preview.manifest.version,
      }),
      detail: translator().t("extensions.trustDetail", {
        id: preview.manifest.id,
        digest: preview.digest,
        generation: preview.expectedGeneration,
      }),
      buttons: [
        translator().t("common.cancel"),
        translator().t("extensions.trustInstall"),
      ],
      defaultId: 0,
      cancelId: 0,
    });
    if (consent.response !== 1 || owner.isDestroyed() || stopping())
      return false;
    await manager.approve(owner, preview.token);
    return true;
  } finally {
    cancelled();
    owner.removeListener("destroyed", cancelled);
  }
}
