import type { BrowserWindow } from "electron";
import type { Translator } from "../shared/i18n";
import type { ExtensionsRequest } from "../shared/extensions";
import type { createExtensionManager } from "./extension-manager";
import { PackageError } from "../installed-packages/installed-packages";
import {
  downloadExtension,
  ExtensionDownloadError,
} from "./extension-download";
import { installExtensionFromDialog } from "./extension-install-dialog";
import { PackageTrustRevokedError } from "./extension-package-trust";

/** Owns request-scoped network/consent lifetimes independently of the renderer. */
export function createExtensionLinkInstaller(
  stopping: () => boolean,
  translator: () => Translator,
) {
  const pending = new Map<BrowserWindow, { token: string; cancel(): void }>();
  return {
    cancel(window: BrowserWindow, token: string) {
      const current = pending.get(window);
      if (current?.token === token) current.cancel();
    },
    dispose() {
      for (const current of pending.values()) current.cancel();
    },
    async install(
      window: BrowserWindow,
      manager: ReturnType<typeof createExtensionManager>,
      request: Extract<ExtensionsRequest, { operation: "install-link" }>,
    ) {
      if (pending.size >= 4 || pending.has(window))
        throw new PackageError("busy");
      const owner = window.webContents;
      const abort = new AbortController();
      const cancel = () => {
        abort.abort();
        manager.cancel(owner);
      };
      pending.set(window, { token: request.token, cancel });
      owner.once("destroyed", cancel);
      owner.once("render-process-gone", cancel);
      owner.on("did-start-navigation", cancel);
      try {
        const bytes = await downloadExtension(request.url, abort.signal);
        const installed = await installExtensionFromDialog(
          window,
          manager,
          () => stopping() || abort.signal.aborted,
          translator,
          bytes,
        );
        if (!installed) throw new ExtensionDownloadError("cancelled");
      } catch (error) {
        if (abort.signal.aborted && error instanceof PackageTrustRevokedError)
          throw new ExtensionDownloadError("cancelled");
        throw error;
      } finally {
        pending.delete(window);
        owner.removeListener("destroyed", cancel);
        owner.removeListener("render-process-gone", cancel);
        owner.removeListener("did-start-navigation", cancel);
        manager.cancel(owner);
      }
    },
  };
}
