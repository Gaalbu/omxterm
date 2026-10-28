import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
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

// Startup creates infrastructure, never activates installed code. Unsupported
// platforms retain Settings with an explicit preview-unavailable result.
export async function startApplicationExtensions(options: {
  applicationRoot: string;
  isTrustedSender(event: IpcEvent): boolean;
  changed(): void;
  keybind: NonNullable<
    Parameters<typeof startExtensionViewHost>[0]["onKeybind"]
  >;
}) {
  const windows = new Map<
    BrowserWindow,
    (sessionId?: string) => ExtensionTarget
  >();
  const lifetime = new AbortController();
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
        createViews({ pin, target, signal: epochSignal, call, retired }) {
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
              // Preserve a core-owned recovery strip even if the guest reports
              // full-window geometry. Renderer slot intersection excludes the
              // remainder of the actual title/tab chrome.
              return {
                x: 0,
                y: 34,
                width: width!,
                height: Math.max(0, height! - 34),
              };
            },
            onKeybind: options.keybind,
            onRequest(value, signal) {
              if (
                epochSignal.aborted ||
                target.signal.aborted ||
                signal.aborted
              )
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
        },
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
        error: supported
          ? "Extension store or runtime unavailable. Terminal sessions remain usable."
          : "Files development preview requires Linux ARM64.",
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
      if (!manager) return refresh();
      if (busy.has(window)) return { ok: false, error: "busy" };
      busy.add(window);
      try {
        const request = args[0];
        if (request.operation === "snapshot") await manager.collect();
        if (request.operation === "install")
          await installExtensionFromDialog(window, manager, () => stopping);
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
  function actions(target?: ExtensionTarget): CoreAction[] {
    if (stopping) return [];
    return installations.flatMap((entry) => {
      const view = entry.enabled && entry.digest && entry.manifest?.view;
      if (!view) return [];
      return [
        {
          id: view.action,
          label: view.title,
          accelerator: null,
          palette: true,
          extension: true,
          invoke() {
            const captured =
              target ?? capture(BrowserWindow.getFocusedWindow() ?? undefined);
            if (!captured || captured.signal.aborted || stopping) return;
            void manager!.open(entry.id, captured).catch(() => {
              const window = captured.owner as BrowserWindow;
              if (!window.isDestroyed() && !stopping)
                void dialog.showMessageBox(window, {
                  type: "error",
                  message: "Extension unavailable",
                  detail:
                    "Refresh Extensions in Settings to inspect the installed state. No operation was automatically retried.",
                });
            });
          },
        },
      ];
    });
  }
  return {
    actions,
    capture,
    contextMenu(window: BrowserWindow, sessionId?: string) {
      const target = capture(window, sessionId);
      return target
        ? actions(target).map((action) => ({
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
        // The native window getter is no longer usable after closed.
        manager?.cancel(contents);
      });
    },
    async dispose() {
      stopping = true;
      ipcMain.removeHandler(extensionsIpc);
      lifetime.abort();
      return (await manager?.dispose()) ?? true;
    },
  };
}
