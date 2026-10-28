import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Translator } from "../shared/i18n";
import { terminalIpc } from "../shared/terminal-ipc";
import type { createWindowActionSender } from "./window-action-delivery";
import {
  InstalledPackages,
  createNativeLeaseAdapter,
  PackageError,
} from "../installed-packages/installed-packages";
import { createExtensionRuntime } from "../extension-runtime/electron-runtime";
import {
  createExtensionManager,
  type ExtensionTarget,
} from "./extension-manager";
import { createExtensionPackageTrust } from "./extension-package-trust";
import { installExtensionFromDialog } from "./extension-install-dialog";
import { extensionResourceOwner } from "./extension-view-reader";
import { startExtensionViewHost } from "./extension-view-ipc";
import {
  extensionsIpc,
  isExtensionsRequest,
  type ExtensionsResult,
} from "../shared/extensions";
import type { IpcEvent } from "./terminal-ipc-types";
import type { CoreAction } from "./action-catalog";

function managementEntry(
  entry: Awaited<
    ReturnType<ReturnType<typeof createExtensionManager>["snapshot"]>
  >[number],
) {
  return {
    id: entry.id,
    generation: entry.generation,
    name: entry.manifest?.name ?? entry.id,
    version: entry.manifest?.version ?? null,
    installed: entry.digest !== null,
    enabled: entry.enabled,
    local: entry.local,
  };
}

function applicationViews(
  options: Parameters<typeof startApplicationExtensions>[0],
  {
    pin,
    target,
    signal: epochSignal,
    call,
    retired,
  }: Parameters<Parameters<typeof createExtensionManager>[0]["createViews"]>[0],
) {
  const window = target.owner as BrowserWindow;
  const view = pin.manifest.view!;
  const host = startExtensionViewHost({
    ipcMain,
    owner: window,
    preloadPath: path.join(
      options.applicationRoot,
      "preload",
      "extension-view.cjs",
    ),
    resources: extensionResourceOwner(pin),
    contentSlot: () => {
      const [width, height] = window.getContentSize();
      // Preserve a core-owned recovery strip; renderer geometry may only narrow it.
      return { x: 0, y: 34, width: width!, height: Math.max(0, height! - 34) };
    },
    onKeybind: options.keybind,
    onRequest(value, signal) {
      if (epochSignal.aborted || target.signal.aborted || signal.aborted)
        return Promise.reject(new PackageError("unavailable"));
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value.operation === "terminal-directory"
      )
        return Promise.resolve(
          target.terminalDirectory
            ? { ok: true, directory: target.terminalDirectory }
            : {
                ok: false,
                error:
                  "No local terminal directory was reported at invocation. Use Home or enter a path.",
              },
        );
      return call(value, signal);
    },
    onState(state) {
      if (state === "settled") retired();
    },
  });
  return {
    open: async () => {
      await host.open({ entryResource: view.entry, title: view.title });
    },
    retire: host.retire,
  };
}

// Startup creates infrastructure, never activates installed code. Unsupported
// platforms retain Settings with an explicit preview-unavailable result.
export async function startApplicationExtensions(options: {
  applicationRoot: string;
  isTrustedSender(event: IpcEvent): boolean;
  changed(): void;
  translator(): Translator;
  sendAction: ReturnType<typeof createWindowActionSender>["sendAction"];
  keybind: NonNullable<
    Parameters<typeof startExtensionViewHost>[0]["onKeybind"]
  >;
}) {
  const windows = new Map<
    BrowserWindow,
    (sessionId?: string) => ExtensionTarget
  >();
  const lifetime = new AbortController();
  const pending = new Map<
    BrowserWindow,
    { token: string; invoke(): Promise<void> }
  >();
  let manager: ReturnType<typeof createExtensionManager> | undefined;
  let installations: Awaited<
    ReturnType<NonNullable<typeof manager>["snapshot"]>
  > = [];
  let stopping = false;
  const supported = process.platform === "linux" && process.arch === "arm64";
  if (supported)
    try {
      const runtime = { appVersion: app.getVersion(), apiVersion: "0.1.0" };
      const root = path.join(app.getPath("userData"), "extensions");
      const addon = path.join(
        options.applicationRoot,
        "extension-runtime",
        "extension-leases.node",
      );
      const packages = await InstalledPackages.open({
        root,
        runtime,
        leases: createNativeLeaseAdapter(addon),
      });
      const backend = await createExtensionRuntime({
        root,
        runtime,
        addon,
        bootstrap: path.join(
          options.applicationRoot,
          "extension-runtime",
          "bootstrap.mjs",
        ),
        environment: process.env,
        owner: lifetime.signal,
      });
      manager = createExtensionManager({
        packages,
        runtime: backend,
        trust: createExtensionPackageTrust({
          packages,
          runtime,
          temporaryDirectory: app.getPath("temp"),
        }),
        createViews: (input) => applicationViews(options, input),
      });
      installations = await manager.snapshot();
    } catch {
      await manager?.dispose();
      manager = undefined;
      // A broken extension store/runtime must not prevent terminal startup.
    }
  async function refresh(): Promise<ExtensionsResult> {
    if (!manager)
      return {
        ok: false,
        error: supported ? "runtime-unavailable" : "unsupported",
      };
    installations = await manager.snapshot();
    options.changed();
    return {
      ok: true,
      pendingCleanup: manager.pendingCleanup(),
      entries: installations.map(managementEntry),
    };
  }
  const busy = new Set<BrowserWindow>();
  ipcMain.handle(
    extensionsIpc,
    async (event, ...args: unknown[]): Promise<ExtensionsResult> => {
      if (
        stopping ||
        !options.isTrustedSender(event) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Rejected extension management owner");
      const window = BrowserWindow.fromWebContents(event.sender);
      if (
        !window ||
        !windows.has(window) ||
        args.length !== 1 ||
        !isExtensionsRequest(args[0])
      )
        throw new TypeError("Invalid extension management request");
      if (args[0].operation === "open") {
        const issued = pending.get(window);
        if (!issued || issued.token !== args[0].token)
          return { ok: false, error: "unavailable" };
        pending.delete(window);
        if (
          !args[0].accepted ||
          BrowserWindow.getFocusedWindow() !== window ||
          stopping
        )
          return { ok: false, error: "unavailable" };
        await issued.invoke();
        return { ok: true };
      }
      if (!manager) return refresh();
      if (busy.has(window)) return { ok: false, error: "busy" };
      busy.add(window);
      try {
        const request = args[0];
        if (request.operation === "snapshot") await manager.collect();
        if (request.operation === "install")
          await installExtensionFromDialog(
            window,
            manager,
            () => stopping,
            options.translator,
          );
        else if (request.operation === "uninstall")
          await manager.uninstall(request.id, request.generation);
        else if (
          request.operation === "enable" ||
          request.operation === "disable"
        )
          await manager.setEnabled(
            request.id,
            request.generation,
            request.operation === "enable",
          );
        return await refresh();
      } catch (error) {
        // Do not turn an uncertain publication into a retry or a success snapshot.
        return {
          ok: false,
          error: error instanceof PackageError ? error.code : "outcome-unknown",
        };
      } finally {
        busy.delete(window);
      }
    },
  );
  const capture = (window: BrowserWindow | undefined, sessionId?: string) =>
    window ? windows.get(window)?.(sessionId) : undefined;
  function actions(
    target?: ExtensionTarget,
    claim?: () => boolean,
  ): CoreAction[] {
    if (stopping) return [];
    return installations.flatMap((entry) => {
      const view = entry.enabled && entry.digest && entry.manifest?.view;
      if (!view) return [];
      const open = manager!.action({
        id: entry.id,
        generation: entry.generation,
        digest: entry.digest!,
      });
      return [
        {
          id: view.action,
          label: view.title,
          accelerator: null,
          palette: true,
          extension: true,
          invoke() {
            if (claim && !claim()) return;
            const captured =
              target ?? capture(BrowserWindow.getFocusedWindow() ?? undefined);
            if (!captured || captured.signal.aborted || stopping) return;
            const window = captured.owner as BrowserWindow;
            const token = randomUUID();
            pending.set(window, {
              token,
              invoke: async () => {
                try {
                  await open(captured);
                } catch {
                  if (!window.isDestroyed() && !stopping)
                    void dialog.showMessageBox(window, {
                      type: "error",
                      message: options.translator().t("extensions.unavailable"),
                      detail: options
                        .translator()
                        .t("extensions.unavailableDetail"),
                    });
                }
              },
            });
            options.sendAction(window.webContents, terminalIpc.tabCommand, {
              action: "open-extension",
              token,
            });
          },
        },
      ];
    });
  }
  return {
    actions,
    capture,
    contextMenu(
      window: BrowserWindow,
      sessionId: string | undefined,
      claim: () => boolean,
    ) {
      const target = capture(window, sessionId);
      return target
        ? actions(
            target,
            () => BrowserWindow.getFocusedWindow() === window && claim(),
          ).map((action) => ({
            label: action.label,
            click: action.invoke,
          }))
        : [];
    },
    registerWindow(
      window: BrowserWindow,
      target: (sessionId?: string) => ExtensionTarget,
    ) {
      const contents = window.webContents;
      windows.set(window, target);
      window.once("closed", () => {
        windows.delete(window);
        pending.delete(window);
        // The native window getter is no longer usable after closed.
        manager?.cancel(contents);
      });
    },
    async dispose() {
      stopping = true;
      pending.clear();
      ipcMain.removeHandler(extensionsIpc);
      lifetime.abort();
      return (await manager?.dispose()) ?? true;
    },
  };
}
