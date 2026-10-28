import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { InstalledPackages } from "../../src/installed-packages/installed-packages";
import { packageArchive } from "../fixtures/extension-package-archive";
import {
  extensionsIpc,
  type ExtensionsResult,
} from "../../src/shared/extensions";
import type { IpcEvent } from "../../src/main/terminal-ipc-types";
import type { ExtensionViewHostOptions } from "../../src/main/extension-view-host";
type Handler = (
  event: IpcEvent,
  ...args: unknown[]
) => Promise<ExtensionsResult>;
type Host = {
  options: ExtensionViewHostOptions;
  open: ReturnType<typeof vi.fn>;
  retire: ReturnType<typeof vi.fn<() => Promise<{ status: "settled" }>>>;
};
import { startApplicationExtensions } from "../../src/main/application-extensions";

const adapters = vi.hoisted(() => ({
  root: "",
  selected: undefined as unknown,
  handlers: new Map<string, Handler>(),
  windows: new Map<unknown, unknown>(),
  picker: vi.fn(),
  consent:
    vi.fn<
      (
        _window: unknown,
        options: { detail?: string },
      ) => Promise<{ response: number }>
    >(),
  activate: vi.fn(),
  retire: vi.fn(),
  hosts: [] as Host[],
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "0.23.0-dev.5", getPath: () => adapters.root },
  BrowserWindow: {
    fromWebContents: (owner: unknown) => adapters.windows.get(owner),
    getFocusedWindow: () => adapters.selected,
  },
  dialog: { showOpenDialog: adapters.picker, showMessageBox: adapters.consent },
  ipcMain: {
    handle: (channel: string, handler: Handler) =>
      adapters.handlers.set(channel, handler),
    removeHandler: (channel: string) => adapters.handlers.delete(channel),
  },
}));
vi.mock(
  "../../src/installed-packages/installed-packages",
  async (original) => ({
    ...(await original<
      typeof import("../../src/installed-packages/installed-packages")
    >()),
    createNativeLeaseAdapter: () => ({
      tryAcquire: async () => ({ release: async () => {} }),
    }),
  }),
);
vi.mock("../../src/extension-runtime/electron-runtime", () => ({
  createExtensionRuntime: async () => ({
    activate: adapters.activate,
    retire: adapters.retire,
    dispose: async () => [],
  }),
}));
vi.mock("../../src/main/extension-view-ipc", () => ({
  startExtensionViewHost: (options: ExtensionViewHostOptions) => {
    const host = {
      options,
      open: vi.fn(async () => {}),
      retire: vi.fn(async () => {
        await options.resources.release();
        options.onState?.("settled");
        return { status: "settled" as const };
      }),
    };
    adapters.hosts.push(host);
    return host;
  },
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
let service: Awaited<ReturnType<typeof startApplicationExtensions>>;
let window: BrowserWindow;
let archive: string;
const manifest = {
  format: 1,
  id: "example.files",
  name: "Files",
  version: "1.0.0",
  engines: { omxterm: ">=0.23.0-0", api: "0.1.x" },
  backend: "backend.mjs",
  view: { entry: "index.html", action: "example.files.open", title: "Files" },
};
function bytes(version = "1.0.0") {
  return packageArchive([
    { name: "extension.json", data: JSON.stringify({ ...manifest, version }) },
    { name: "backend.mjs", data: "" },
    { name: "index.html", data: "<h1>Files</h1>" },
  ]);
}
function request(
  value: unknown,
  event: IpcEvent = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  },
) {
  return adapters.handlers.get(extensionsIpc)!(event, value);
}
beforeEach(async () => {
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
  Object.defineProperty(process, "arch", {
    value: "arm64",
    configurable: true,
  });
  adapters.root = await mkdtemp(path.join(os.tmpdir(), "omxterm-service-"));
  adapters.hosts.length = 0;
  adapters.handlers.clear();
  adapters.windows.clear();
  adapters.activate.mockReset();
  adapters.retire.mockReset().mockResolvedValue(null);
  adapters.picker.mockReset();
  adapters.consent.mockReset().mockResolvedValue({ response: 1 });
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    send: vi.fn(),
    isDestroyed: () => false,
  });
  window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    getContentSize: () => [800, 600],
  }) as unknown as BrowserWindow;
  adapters.windows.set(contents, window);
  adapters.selected = window;
  archive = path.join(adapters.root, "files.omxext");
  await writeFile(archive, bytes());
  adapters.picker.mockResolvedValue({ canceled: false, filePaths: [archive] });
  adapters.activate.mockImplementation(async () => {
    const packages = await InstalledPackages.open({
      root: path.join(adapters.root, "extensions"),
      runtime: { appVersion: "0.23.0-dev.5", apiVersion: "0.1.0" },
      leases: { tryAcquire: async () => ({ release: async () => {} }) },
    });
    const entry = (await packages.snapshot())[0]!;
    return { selection: entry, call: vi.fn(async () => ({ ok: true })) };
  });
  service = await startApplicationExtensions({
    applicationRoot: adapters.root,
    isTrustedSender: (event) => event.sender === contents,
    changed() {},
    keybind() {},
  });
  service.registerWindow(window, () => ({
    owner: window,
    signal: new AbortController().signal,
    terminalDirectory: "/captured",
  }));
});
afterEach(async () => {
  await service?.dispose();
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
  await rm(adapters.root, { recursive: true, force: true });
});
it("Settings installs captured bytes through explicit trust without activating code", async () => {
  adapters.consent.mockImplementationOnce(async () => {
    await writeFile(archive, bytes("2.0.0"));
    return { response: 1 };
  });
  const result = await request({ operation: "install" });
  expect(result).toMatchObject({
    ok: true,
    entries: [{ version: "1.0.0", local: "dormant", enabled: true }],
  });
  expect(adapters.activate).not.toHaveBeenCalled();
  expect(adapters.consent.mock.calls[0]![1].detail).toContain("network");
  expect(service.actions()).toMatchObject([
    { id: "example.files.open", accelerator: null },
  ]);
});
it("the terminal context contribution retains its source when selection changes before click", async () => {
  await request({ operation: "install" });
  let directory = "/original";
  service.registerWindow(window, () => ({
    owner: window,
    signal: new AbortController().signal,
    terminalDirectory: directory,
  }));
  const item = service.contextMenu(window)[0]!;
  directory = "/later-selection";
  item.click();
  await vi.waitFor(() => expect(adapters.hosts).toHaveLength(1));
  expect(
    await adapters.hosts[0]!.options.onRequest!(
      { operation: "terminal-directory" },
      new AbortController().signal,
    ),
  ).toEqual({ ok: true, directory: "/original" });
});

it("cancelled consent does not install or activate", async () => {
  adapters.consent.mockResolvedValueOnce({ response: 0 });
  expect(await request({ operation: "install" })).toMatchObject({
    ok: true,
    entries: [],
  });
  expect(service.actions()).toEqual([]);
  expect(adapters.activate).not.toHaveBeenCalled();
});
it("authenticates main frame and rejects caller paths and malformed generations", async () => {
  await expect(
    request(
      { operation: "snapshot" },
      { sender: window.webContents, senderFrame: {} },
    ),
  ).rejects.toThrow("owner");
  await expect(
    request({ operation: "install", path: archive }),
  ).rejects.toThrow("Invalid");
  await expect(
    request({ operation: "disable", id: manifest.id, generation: -1 }),
  ).rejects.toThrow("Invalid");
  expect(adapters.picker).not.toHaveBeenCalled();
});
it("actions capture separate contexts; disable revokes both views and callbacks", async () => {
  await request({ operation: "install" });
  const first = service.actions()[0]!;
  first.invoke();
  await vi.waitFor(() => expect(adapters.hosts).toHaveLength(1));
  const captured = service.capture(window)!;
  captured.terminalDirectory = "/second";
  service.actions(captured)[0]!.invoke();
  await vi.waitFor(() => expect(adapters.hosts).toHaveLength(2));
  expect(
    await adapters.hosts[0]!.options.onRequest!(
      { operation: "terminal-directory" },
      new AbortController().signal,
    ),
  ).toEqual({ ok: true, directory: "/captured" });
  expect(
    await adapters.hosts[1]!.options.onRequest!(
      { operation: "terminal-directory" },
      new AbortController().signal,
    ),
  ).toEqual({ ok: true, directory: "/second" });
  expect(
    await request({ operation: "disable", id: manifest.id, generation: 1 }),
  ).toMatchObject({
    ok: true,
    entries: [{ enabled: false, generation: 2, local: "dormant" }],
  });
  expect(service.actions()).toEqual([]);
  expect(
    adapters.hosts.every((host) => host.retire.mock.calls.length === 1),
  ).toBe(true);
  await expect(
    adapters.hosts[0]!.options.onRequest!(
      { operation: "terminal-directory" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("unavailable");
});
