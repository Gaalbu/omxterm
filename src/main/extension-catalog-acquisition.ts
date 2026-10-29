import type { BrowserWindow } from "electron";
import { PackageError } from "../installed-packages/archive";
import type { createExtensionCatalog } from "./extension-catalog";

/** Catalog loading has its own cancellation slot, not the installed-management
 * busy slot. A slow/offline catalog cannot block local-file installation. */
export function createCatalogAcquisition(
  catalog: ReturnType<typeof createExtensionCatalog>,
) {
  const loads = new Map<
    BrowserWindow,
    { token: string; abort: AbortController }
  >();
  return {
    cancel(window: BrowserWindow, token: string) {
      const load = loads.get(window);
      if (load?.token === token) load.abort.abort();
    },
    dispose() {
      for (const load of loads.values()) load.abort.abort();
    },
    async refresh(window: BrowserWindow, token: string) {
      if (loads.has(window) || loads.size >= 4) throw new PackageError("busy");
      const abort = new AbortController();
      const owner = window.webContents;
      const cancel = () => abort.abort();
      loads.set(window, { token, abort });
      owner.once("destroyed", cancel);
      owner.once("render-process-gone", cancel);
      owner.on("did-start-navigation", cancel);
      try {
        await catalog.refresh(abort.signal);
      } finally {
        loads.delete(window);
        owner.removeListener("destroyed", cancel);
        owner.removeListener("render-process-gone", cancel);
        owner.removeListener("did-start-navigation", cancel);
      }
    },
  };
}
