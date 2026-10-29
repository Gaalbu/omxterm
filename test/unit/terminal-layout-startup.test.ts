// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InitialLayout } from "../../src/shared/terminal-layout";
import { createTerminalLayoutBridge } from "../../src/preload/terminal-layout-bridge";
import { registerTerminalIpcRouter } from "../../src/main/terminal-ipc-controller";
import {
  clipboardOptions,
  createIpcHarness,
} from "../fixtures/terminal-ipc-harness";
const host = vi.hoisted(() =>
  vi.fn(() => ({ ready: Promise.resolve(), dispose: vi.fn() })),
);
vi.mock("../../src/renderer/terminal-window-host", () => ({
  mountTerminalWindowPage: host,
}));
vi.mock("../../src/terminal-surface/restty-terminal-surface", () => ({
  mountResttyTerminalSurface: vi.fn(),
}));
import { startTerminalWindow } from "../../src/renderer/start-terminal-window";
const token = "00000000-0000-0000-0000-000000000001";
const plan: InitialLayout = {
  selected: 0,
  fallbacks: 0,
  tabs: [{ root: 0, nodes: [{ pane: 0 }], panes: [token], focused: 0 }],
};
beforeEach(() => {
  host.mockClear();
  document.body.innerHTML =
    '<nav id="tab-strip"></nav><div id="terminal-tabs"></div><div id="user-file-errors"></div><div id="snippets-sidebar"></div><div id="terminal-surface-failure"></div>';
});
afterEach(() => document.body.replaceChildren());
it.each([false, true])(
  "composes ordinary router/preload startup without a plan and preserves genuine provider failure (%s)",
  async (failed) => {
    const ipc = createIpcHarness();
    const router = registerTerminalIpcRouter(ipc.ipcMain);
    const contents = { mainFrame: {}, isDestroyed: () => false, send: vi.fn() };
    const event = { sender: contents, senderFrame: contents.mainFrame };
    router.registerController({
      ...clipboardOptions(),
      webContents: contents,
      createSession: vi.fn(),
      onSessionExit: vi.fn(),
      onSessionStartError: vi.fn(),
      ...(failed
        ? {
            initialLayout: () => {
              throw new Error("Lost plan");
            },
          }
        : {}),
    });
    const layout = createTerminalLayoutBridge({
      invoke: async (channel) => {
        const handler = ipc.handlers.get(channel);
        if (!handler) throw new Error("Missing handler");
        return handler(event);
      },
      send: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    });
    const terminal = {
      configuration: async () => ({ userFileErrors: [] }),
      layout,
      notifyTabsEmpty: vi.fn(),
    };
    startTerminalWindow({ terminal } as unknown as Window["omxterm"]);
    if (failed) {
      await vi.waitFor(() =>
        expect(terminal.notifyTabsEmpty).toHaveBeenCalledWith(
          "rendering-failure",
        ),
      );
      expect(host).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(host).toHaveBeenCalledOnce());
      const calls = host.mock.calls as unknown as [
        unknown,
        { initialLayout?: unknown },
      ][];
      expect(calls[0]?.[1].initialLayout).toBeUndefined();
      expect(terminal.notifyTabsEmpty).not.toHaveBeenCalled();
    }
    router.dispose();
  },
);
function fixture() {
  let resolve!: (plan: InitialLayout | null) => void;
  const initial = vi.fn(
    () =>
      new Promise<InitialLayout | null>((done) => {
        resolve = done;
      }),
  );
  const terminal = {
    configuration: async () => ({ userFileErrors: [] }),
    layout: { initial, cancel: vi.fn() },
    notifyTabsEmpty: vi.fn(),
  };
  startTerminalWindow({ terminal } as unknown as Window["omxterm"]);
  return { terminal, resolve: (value: InitialLayout | null) => resolve(value) };
}
it("obtains the initial plan before constructing any tab host, never a dummy shell", async () => {
  const f = fixture();
  await vi.waitFor(() =>
    expect(f.terminal.layout.initial).toHaveBeenCalledOnce(),
  );
  expect(host).not.toHaveBeenCalled();
  f.resolve(plan);
  await vi.waitFor(() => expect(host).toHaveBeenCalledOnce());
  expect(host).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ initialLayout: plan }),
  );
});
it("cancels a late initial plan after window retirement without mounting", async () => {
  const f = fixture();
  await vi.waitFor(() =>
    expect(f.terminal.layout.initial).toHaveBeenCalledOnce(),
  );
  window.dispatchEvent(new Event("pagehide"));
  f.resolve(plan);
  await vi.waitFor(() =>
    expect(f.terminal.layout.cancel).toHaveBeenCalledExactlyOnceWith(token),
  );
  expect(host).not.toHaveBeenCalled();
  expect(f.terminal.notifyTabsEmpty).not.toHaveBeenCalled();
});
