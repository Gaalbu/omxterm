import { dialog, type BrowserWindow } from "electron";
import type { createExtensionManager } from "./extension-manager";

export async function installExtensionFromDialog(
  window: BrowserWindow,
  manager: ReturnType<typeof createExtensionManager>,
  stopping: () => boolean,
) {
  const owner = window.webContents;
  const cancelled = () => manager.cancel(owner);
  owner.once("destroyed", cancelled);
  try {
    const selected = await dialog.showOpenDialog(window, {
      title: "Install local extension",
      properties: ["openFile"],
      filters: [{ name: "OMXTerm extension", extensions: ["omxext"] }],
    });
    if (selected.canceled || owner.isDestroyed() || stopping()) return;
    const preview = await manager.prepare(owner, selected.filePaths[0]!);
    if (owner.isDestroyed() || stopping()) return;
    const consent = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Trust extension code?",
      message: `Install ${preview.manifest.name} ${preview.manifest.version}?`,
      detail: `This is trusted local code, not a sandbox. It can read/change files, run programs and use the network with your user permissions. Third-party authors are responsible for their extensions. Only install packages you trust. Installation is dormant until you invoke its action.\n\nPackage: ${preview.manifest.id}\nSHA-256: ${preview.digest}\nCurrent generation: ${preview.expectedGeneration}`,
      buttons: ["Cancel", "Trust and install"],
      defaultId: 0,
      cancelId: 0,
    });
    if (consent.response === 1 && !owner.isDestroyed() && !stopping())
      await manager.approve(owner, preview.token);
  } finally {
    cancelled();
    owner.removeListener("destroyed", cancelled);
  }
}
