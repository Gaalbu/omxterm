import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import {
  exactLayoutKeys,
  isCapturedLayout,
  isSavedLayout,
  layoutIpc,
  type SavedLayout,
  type LayoutDirectory,
} from "../shared/terminal-layout";
import type {
  IpcEvent,
  IpcMainPort,
  TerminalIpcController,
} from "./terminal-ipc-types";
import type { PreparedLayout } from "./terminal-layout-transfer";

/** Window-lifetime capture correlation and single-use pane allocations. */
export function registerTerminalLayoutIpc(options: {
  ipc: IpcMainPort;
  trusted(event: IpcEvent): boolean;
  platform: "linux" | "darwin" | "win32";
  quitting(): boolean;
}) {
  type Capture = {
    id: string;
    resolve(value: SavedLayout): void;
    reject(): void;
    dispose(): void;
  };
  type Owner = {
    window: BrowserWindow;
    controller: TerminalIpcController;
    plan?: PreparedLayout;
    initialRead: boolean;
    tokens: Map<string, string>;
    capture?: Capture;
  };
  const owners = new Map<object, Owner>();
  const ownerFor = (event: IpcEvent) =>
    options.trusted(event) && !options.quitting()
      ? owners.get(event.sender)
      : undefined;
  const remove = (owner: Owner) => {
    owner.capture?.reject();
    owner.capture?.dispose();
    owner.tokens.clear();
    owners.delete(owner.window.webContents);
  };
  options.ipc.handle(layoutIpc.initial, (event, value) => {
    const owner = ownerFor(event);
    if (!owner || value !== undefined || owner.initialRead)
      throw new Error("Unavailable initial layout");
    owner.initialRead = true;
    const plan = owner.plan;
    delete owner.plan;
    return plan?.initial ?? null;
  });
  const cancelListener = (event: IpcEvent, token?: unknown) => {
    const owner = ownerFor(event);
    if (owner && typeof token === "string") owner.tokens.delete(token);
  };
  const capturedListener = (event: IpcEvent, value?: unknown) => {
    const owner = ownerFor(event);
    if (
      !owner ||
      !exactLayoutKeys(value, ["id", "layout"]) ||
      value.id !== owner.capture?.id
    )
      return;
    const capture = owner.capture;
    if (!capture) return;
    delete owner.capture;
    capture.dispose();
    if (!isCapturedLayout(value.layout)) {
      capture.reject();
      return;
    }
    try {
      const layout: SavedLayout = {
        ...value.layout,
        version: 1,
        platform: options.platform,
        savedAt: new Date().toISOString(),
        tabs: value.layout.tabs.map((tab) => ({
          ...tab,
          panes: tab.panes.map((id): LayoutDirectory =>
            id === null
              ? { kind: "home" }
              : owner.controller.layoutDirectory!(id),
          ),
        })),
      };
      if (!isSavedLayout(layout)) throw new Error("Invalid layout");
      capture.resolve(layout);
    } catch {
      capture.reject();
    }
  };
  options.ipc.on(layoutIpc.cancel, cancelListener);
  options.ipc.on(layoutIpc.captured, capturedListener);
  return {
    constructing: () =>
      [...owners.values()].some(
        (owner) => owner.tokens.size > 0 || owner.plan !== undefined,
      ),
    register(
      window: BrowserWindow,
      controller: TerminalIpcController,
      plan?: PreparedLayout,
    ) {
      const owner: Owner = {
        window,
        controller,
        initialRead: false,
        tokens: new Map(plan?.directories),
        ...(plan ? { plan } : {}),
      };
      owners.set(window.webContents, owner);
      window.once("closed", () => remove(owner));
      window.webContents.once("destroyed", () => remove(owner));
      window.webContents.once("render-process-gone", () => remove(owner));
      // A reload must not replay a consumed plan or revive unused allocations.
      window.webContents.on(
        "did-start-navigation",
        (_event, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace && owner.initialRead) remove(owner);
        },
      );
    },
    capture(window: BrowserWindow, signal: AbortSignal): Promise<SavedLayout> {
      const owner = owners.get(window.webContents);
      if (!owner || owner.capture || signal.aborted || options.quitting())
        return Promise.reject(new Error("Layout unavailable or busy"));
      return new Promise((resolve, reject) => {
        const fail = () => {
          owner.capture?.dispose();
          delete owner.capture;
          reject(new Error("Layout capture unavailable"));
        };
        const timer = setTimeout(fail, 5000);
        signal.addEventListener("abort", fail, { once: true });
        const id = randomUUID();
        owner.capture = {
          id,
          resolve,
          reject: fail,
          dispose() {
            clearTimeout(timer);
            signal.removeEventListener("abort", fail);
          },
        };
        try {
          window.webContents.send(layoutIpc.capture, id);
        } catch {
          fail();
        }
      });
    },
    consume(window: BrowserWindow, token: string): string {
      const owner = owners.get(window.webContents);
      const directory = owner?.tokens.get(token);
      if (!owner || directory === undefined || options.quitting())
        throw new Error("Unavailable restored pane");
      owner.tokens.delete(token);
      return directory;
    },
    dispose() {
      for (const owner of owners.values()) remove(owner);
      options.ipc.removeHandler(layoutIpc.initial);
      options.ipc.removeListener(layoutIpc.cancel, cancelListener);
      options.ipc.removeListener(layoutIpc.captured, capturedListener);
    },
  };
}
