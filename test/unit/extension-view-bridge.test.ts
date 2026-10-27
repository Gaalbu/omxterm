import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createHostedContentBridge } from "../../src/preload/extension-view-bridge";
import {
  extensionViewIpc,
  isHostedContentDescriptor,
  isHostedContentPresentation,
} from "../../src/shared/extension-view";

const presentation = {
  id: null,
  revision: 1,
  bounds: { x: 0, y: 40, width: 800, height: 500 },
  focus: false,
};
describe("hosted application-tab contract", () => {
  it("rejects extra fields, unsafe numbers, unbounded titles and arbitrary identities", () => {
    expect(isHostedContentDescriptor({ id: "host-1", title: "Files" })).toBe(
      true,
    );
    for (const descriptor of [
      { id: "../path", title: "Files" },
      { id: "a", title: "x".repeat(161) },
      { id: "a", title: "a\n" },
      { id: "a", title: "A", url: "file:///private" },
    ])
      expect(isHostedContentDescriptor(descriptor)).toBe(false);
    expect(isHostedContentPresentation(presentation)).toBe(true);
    for (const revision of [
      0,
      -1,
      Infinity,
      NaN,
      Number.MAX_SAFE_INTEGER + 1,
      1.5,
    ])
      expect(isHostedContentPresentation({ ...presentation, revision })).toBe(
        false,
      );
    for (const width of [-1, Infinity, NaN, 100_001, "1"])
      expect(
        isHostedContentPresentation({
          ...presentation,
          bounds: { ...presentation.bounds, width },
        }),
      ).toBe(false);
    expect(isHostedContentPresentation({ ...presentation, pageZoom: 2 })).toBe(
      false,
    );
    expect(
      isHostedContentPresentation({
        ...presentation,
        bounds: { ...presentation.bounds, extra: 1 },
      }),
    ).toBe(false);
  });

  it("validates incoming events and acknowledgments, with removable listeners", async () => {
    const handlers = new Map<
      string,
      (event: Electron.IpcRendererEvent, value: unknown) => void
    >();
    const transport = {
      invoke: vi.fn(
        async (_channel: string, ..._args: unknown[]): Promise<unknown> => true,
      ),
      on: vi.fn(
        (
          channel: string,
          handler: (event: Electron.IpcRendererEvent, value: unknown) => void,
        ) => handlers.set(channel, handler),
      ),
      removeListener: vi.fn((channel: string, _handler: unknown) =>
        handlers.delete(channel),
      ),
    };
    const bridge = createHostedContentBridge(transport);
    const opened = vi.fn();
    const retired = vi.fn();
    const offOpen = bridge.onOpen(opened);
    const offRetired = bridge.onRetired(retired);
    const event = {} as Electron.IpcRendererEvent;
    handlers.get(extensionViewIpc.open)!(event, {
      id: "a",
      title: "A",
      path: "/private",
    });
    handlers.get(extensionViewIpc.retired)!(event, "../x");
    expect(opened).not.toHaveBeenCalled();
    expect(retired).not.toHaveBeenCalled();
    handlers.get(extensionViewIpc.open)!(event, { id: "a", title: "A" });
    handlers.get(extensionViewIpc.retired)!(event, "a");
    expect(opened).toHaveBeenCalledWith({ id: "a", title: "A" });
    expect(retired).toHaveBeenCalledWith("a");
    expect(await bridge.present(presentation)).toBe(true);
    expect(transport.invoke).toHaveBeenCalledWith(
      extensionViewIpc.present,
      presentation,
    );
    transport.invoke.mockResolvedValue("true");
    await expect(bridge.present(presentation)).rejects.toThrow("result");
    await expect(
      bridge.present({ ...presentation, revision: 0 }),
    ).rejects.toThrow("Invalid");
    await expect(bridge.close("../x")).rejects.toThrow("Invalid");
    transport.invoke.mockResolvedValue(undefined);
    await bridge.close("a");
    offOpen();
    offRetired();
    expect(handlers.size).toBe(0);
  });

  it("executes the actual child preload with visibility-only bounded host transport", async () => {
    const source = await readFile(
      new URL("../../src/preload/extension-view.cjs", import.meta.url),
      "utf8",
    );
    const expose =
      vi.fn<
        (
          _name: string,
          bridge: { onVisibility(listener: unknown): () => void },
        ) => void
      >();
    const on =
      vi.fn<
        (
          _channel: string,
          handler: (event: object, value: unknown) => void,
        ) => void
      >();
    const execute = (mainFrame: boolean) => {
      runInNewContext(source, {
        process: { isMainFrame: mainFrame },
        require: (name: string) => {
          expect(name).toBe("electron");
          return {
            contextBridge: { exposeInMainWorld: expose },
            ipcRenderer: { on },
          };
        },
      });
    };
    execute(false);
    expect(expose).not.toHaveBeenCalled();
    execute(true);
    expect(expose).toHaveBeenCalledTimes(1);
    const [name, bridge] = expose.mock.calls[0]!;
    expect(name).toBe("omxHostedContent");
    expect(Object.keys(bridge)).toEqual(["onVisibility"]);
    const listener = vi.fn();
    const dispose = bridge.onVisibility(listener);
    expect(listener).toHaveBeenLastCalledWith(false);
    const [channel, handler] = on.mock.calls[0]!;
    expect(channel).toBe(extensionViewIpc.visibility);
    handler({}, { visible: true });
    expect(listener).toHaveBeenCalledTimes(1);
    handler({}, true);
    expect(listener).toHaveBeenLastCalledWith(true);
    dispose();
    handler({}, false);
    expect(listener).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 32; i++) bridge.onVisibility(() => {});
    expect(() => bridge.onVisibility(() => {})).toThrow("Invalid");
    expect(() => bridge.onVisibility(null)).toThrow("Invalid");
  });
});
