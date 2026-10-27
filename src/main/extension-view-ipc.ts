import { isAbsolute } from "node:path";
import { terminalIpc } from "../shared/terminal-ipc";
import type {
  TerminalClipboardAction,
  TerminalContextMenuTarget,
} from "../shared/terminal-contract";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
  extensionViewIpc,
  isHostedContentId,
  isHostedContentPresentation,
} from "../shared/extension-view";
import {
  createExtensionViewHost,
  type ExtensionViewHostOptions,
} from "./extension-view-host";

type Host = ReturnType<typeof createExtensionViewHost>;
type Route = { contents: WebContents; host: Host; issued: Set<string> };
const routers = new WeakMap<IpcMain, Map<WebContents, Route>>();
const presentationRevisions = new WeakMap<WebContents, number>();

export function sendExtensionAwareClipboard(
  ipcMain: IpcMain,
  owner: WebContents,
  action: TerminalClipboardAction,
  target?: TerminalContextMenuTarget,
): void {
  if (
    !target &&
    routers
      .get(ipcMain)
      ?.get(owner)
      ?.host.clipboard(action === "select-all" ? "selectAll" : action)
  )
    return;
  owner.send(terminalIpc.clipboardAction, target ? { action, target } : action);
}

// Multiple actual windows share one pair of handlers; callers cannot choose a
// window or host. The trusted owner is registered by main, never by a child.
export function startExtensionViewHost(
  options: ExtensionViewHostOptions & { ipcMain: IpcMain },
) {
  const contents = options.owner.webContents;
  if (
    !isAbsolute(options.preloadPath) ||
    options.owner.isDestroyed() ||
    contents.isDestroyed()
  )
    throw new Error("Invalid hosted owner setup");
  let routes = routers.get(options.ipcMain);
  if (routes?.has(contents)) throw new Error("Hosted owner already registered");
  if (!routes) {
    routes = new Map();
    const registry = routes;
    const routeFor = (event: IpcMainInvokeEvent) => {
      const route = registry.get(event.sender);
      if (
        !route ||
        event.sender.isDestroyed() ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Rejected hosted owner");
      return route;
    };
    options.ipcMain.handle(
      extensionViewIpc.present,
      (event, ...args: unknown[]) => {
        const route = routeFor(event);
        if (args.length !== 1 || !isHostedContentPresentation(args[0]))
          throw new TypeError("Invalid hosted presentation");
        const presentation = args[0];
        if (
          presentation.id !== null &&
          (!route.issued.has(presentation.id) ||
            !route.host.owns(presentation.id))
        )
          throw new Error("Unknown hosted content");
        if (
          presentation.revision <=
          (presentationRevisions.get(event.sender) ?? 0)
        )
          return false;
        presentationRevisions.set(event.sender, presentation.revision);
        return route.host.present(presentation);
      },
    );
    options.ipcMain.handle(
      extensionViewIpc.close,
      async (event, ...args: unknown[]) => {
        const route = routeFor(event);
        if (args.length !== 1 || !isHostedContentId(args[0]))
          throw new TypeError("Invalid hosted close");
        const id = args[0];
        if (!route.issued.has(id) || !route.host.owns(id))
          throw new Error("Unknown hosted content");
        await route.host.close(id);
      },
    );
    routers.set(options.ipcMain, routes);
  }
  const registry = routes;
  const issued = new Set<string>();
  const host = createExtensionViewHost({
    ...options,
    onRetired(id) {
      if (issued.delete(id) && !contents.isDestroyed())
        contents.send(extensionViewIpc.retired, id);
      options.onRetired?.(id);
    },
    onState(state, outcome) {
      if (state === "retiring") {
        registry.delete(contents);
        if (!registry.size) {
          options.ipcMain.removeHandler(extensionViewIpc.present);
          options.ipcMain.removeHandler(extensionViewIpc.close);
          routers.delete(options.ipcMain);
        }
      }
      options.onState?.(state, outcome);
    },
  });
  registry.set(contents, { contents, host, issued });
  return {
    async open(input: { entryResource: string; title: string }) {
      const descriptor = await host.open(input);
      if (!host.owns(descriptor.id) || contents.isDestroyed())
        throw new Error("Hosted owner retired");
      issued.add(descriptor.id);
      try {
        contents.send(extensionViewIpc.open, descriptor);
      } catch {
        await host.retire();
        throw new Error("Hosted notification failed");
      }
      return descriptor;
    },
    clipboard: host.clipboard,
    retire: host.retire,
  };
}
