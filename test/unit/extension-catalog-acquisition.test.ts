import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { it, expect, vi } from "vitest";
import { createCatalogAcquisition } from "../../src/main/extension-catalog-acquisition";
import { createExtensionCatalog } from "../../src/main/extension-catalog";
it.each([
  "destroyed",
  "render-process-gone",
  "did-start-navigation",
  "cancel",
  "dispose",
])(
  "revokes catalog acquisition on %s and removes owner listeners",
  async (event) => {
    const contents = new EventEmitter();
    const window = { webContents: contents } as unknown as BrowserWindow;
    const catalog = createExtensionCatalog(
      { appVersion: "0.23.0-dev.9", apiVersion: "0.1.0" },
      "linux-arm64",
    );
    let signal!: AbortSignal;
    let finish!: () => void;
    vi.spyOn(catalog, "refresh").mockImplementation(async (owner) => {
      signal = owner;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const acquisitions = createCatalogAcquisition(catalog);
    const pending = acquisitions.refresh(window, "owned");
    acquisitions.cancel(window, "wrong-token");
    expect(signal.aborted).toBe(false);
    await expect(acquisitions.refresh(window, "other")).rejects.toThrow("busy");
    if (event === "cancel") acquisitions.cancel(window, "owned");
    else if (event === "dispose") acquisitions.dispose();
    else contents.emit(event);
    expect(signal.aborted).toBe(true);
    finish();
    await pending;
    expect(contents.eventNames()).toEqual([]);
  },
);
