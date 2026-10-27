import {
  isPaletteIdentity,
  paletteActionChannels,
  paletteIpc,
} from "../shared/command-palette";
import { corePaletteActions, type CoreActionCatalog } from "./action-catalog";
import type { IpcEvent, TrustedWebContents } from "./terminal-ipc-types";

// A palette is a one-shot capability for one catalog and selected owner. It
// carries no caller-chosen window, filesystem path or executable command.
export function startCommandPalette(options: {
  ipcMain: {
    handle(
      channel: string,
      handler: (event: IpcEvent, ...args: unknown[]) => unknown,
    ): void;
    removeHandler(channel: string): void;
  };
  isTrustedSender(event: IpcEvent): boolean;
  selectedContents(): TrustedWebContents | undefined;
  catalog(): CoreActionCatalog;
}) {
  const leases = new WeakMap<
    TrustedWebContents,
    { token: string; catalog: CoreActionCatalog }
  >();
  let sequence = 0;
  let disposed = false;
  let delivery: { sender: TrustedWebContents; token: string } | undefined;
  const trusted = (event: IpcEvent) =>
    !disposed &&
    !event.sender.isDestroyed() &&
    event.senderFrame === event.sender.mainFrame &&
    options.isTrustedSender(event) &&
    options.selectedContents() === event.sender;
  options.ipcMain.handle(paletteIpc.snapshot, (event, ...args) => {
    if (!trusted(event)) throw new Error("Rejected palette owner");
    if (args.length) throw new TypeError("Invalid palette request");
    const catalog = options.catalog();
    const token = String(++sequence);
    leases.set(event.sender, { token, catalog });
    return {
      token,
      actions: corePaletteActions(catalog).map(
        ({ id, label, accelerator }) => ({ id, label, accelerator }),
      ),
    };
  });
  options.ipcMain.handle(paletteIpc.invoke, (event, ...args) => {
    if (!trusted(event)) throw new Error("Rejected palette owner");
    const [token, id] = args;
    if (
      args.length !== 2 ||
      !isPaletteIdentity(token) ||
      !isPaletteIdentity(id)
    )
      throw new TypeError("Invalid palette invocation");
    const lease = leases.get(event.sender);
    // Consume even a stale or invalid selection; no replay after owner recovery.
    leases.delete(event.sender);
    const catalog = options.catalog();
    if (
      !lease ||
      lease.token !== token ||
      lease.catalog !== catalog ||
      !Object.hasOwn(catalog, id)
    )
      return;
    const action = catalog[id as keyof CoreActionCatalog];
    if (!action.palette) return;
    delivery = { sender: event.sender, token };
    try {
      action.invoke();
    } finally {
      delivery = undefined;
    }
  });
  return {
    show() {
      const sender = options.selectedContents();
      if (sender && trusted({ sender, senderFrame: sender.mainFrame }))
        sender.send(paletteIpc.open, undefined);
    },
    invalidate(sender: TrustedWebContents) {
      leases.delete(sender);
    },
    send(sender: TrustedWebContents, channel: string, payload?: unknown) {
      if (sender.isDestroyed()) return;
      if (delivery?.sender === sender && paletteActionChannels.has(channel))
        sender.send(paletteIpc.dispatch, {
          token: delivery.token,
          channel,
          payload,
        });
      else sender.send(channel, payload);
    },
    dispose() {
      disposed = true;
      delivery = undefined;
      options.ipcMain.removeHandler(paletteIpc.snapshot);
      options.ipcMain.removeHandler(paletteIpc.invoke);
    },
  };
}
