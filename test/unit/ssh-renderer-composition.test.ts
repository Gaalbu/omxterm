// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { harness } from "../fixtures/restty-surface-harness";
import { createTerminalTabs } from "../../src/renderer/terminal-tabs";
import { createElectronTerminalAdapter } from "../../src/renderer/electron-terminal-adapter";
import { mountResttyTerminalSurface } from "../../src/terminal-surface/restty-terminal-surface";
import type { TerminalBridge } from "../../src/shared/terminal-bridge";

it("replays early SSH output/exit through the real Adapter, pane policy and retained Surface until Close", async () => {
  harness.instances.length = 0;
  harness.setInitError(undefined);
  const outputs = new Set<Parameters<TerminalBridge["onOutput"]>[0]>();
  const exits = new Set<Parameters<TerminalBridge["onExit"]>[0]>();
  const input = vi.fn(),
    resize = vi.fn(),
    close = vi.fn(),
    releaseSurface = vi.fn();
  const releaseFonts = vi.fn();
  const bridge = {
    retainSurface: vi.fn(async () => "font-snapshot"),
    releaseSurface,
    start: vi.fn(async (_surface?: string, _cwd?: string, token?: string) => {
      if (!token) return "local";
      for (const emit of outputs) emit("ssh", "early retained output", 21);
      for (const emit of exits)
        emit("ssh", { exitCode: 255, signal: 0, retained: true });
      return "ssh";
    }),
    input,
    resize,
    close,
    acknowledgeOutput: vi.fn(),
    sshPane: vi.fn(),
    onOutput(listener: Parameters<TerminalBridge["onOutput"]>[0]) {
      outputs.add(listener);
      return () => outputs.delete(listener);
    },
    onExit(listener: Parameters<TerminalBridge["onExit"]>[0]) {
      exits.add(listener);
      return () => exits.delete(listener);
    },
  } as unknown as TerminalBridge;
  const strip = document.createElement("nav"),
    container = document.createElement("main");
  document.body.append(strip, container);
  const tabs = createTerminalTabs(
    { strip, container },
    {
      createAdapter: (cwd, token) =>
        createElectronTerminalAdapter(bridge, "configuration", cwd, token),
      mount: mountResttyTerminalSurface,
      surfaceOptions: {
        acquireFontInputs: async () => ({ fonts: [], release: releaseFonts }),
      },
    },
  );
  try {
    await tabs.ready;
    tabs.handleCommand({
      action: "open-ssh",
      token: "token",
      sourceView: "old-view",
      title: "SSH · alias",
    });
    await vi.waitFor(() =>
      expect(container.querySelector(".terminal-exit-notice")).not.toBeNull(),
    );
    const restty = harness.instances[1]!;
    expect(restty.sendInput).toHaveBeenCalledWith(
      "early retained output",
      "pty",
    );
    expect(restty.destroy).not.toHaveBeenCalled();
    expect(releaseFonts).not.toHaveBeenCalled();
    expect(releaseSurface).not.toHaveBeenCalled();
    expect(restty.options.services.ptyTransport.sendInput("after exit")).toBe(
      false,
    );
    expect(input).not.toHaveBeenCalled();
    expect(bridge.acknowledgeOutput).toHaveBeenCalledWith("ssh", 21);
    const notice = container.querySelector<HTMLElement>(
      ".terminal-exit-notice",
    )!;
    expect(notice.textContent).toContain("255");
    notice.querySelector("button")!.click();
    expect(restty.destroy).toHaveBeenCalledOnce();
    expect(releaseFonts).toHaveBeenCalledOnce();
    expect(releaseSurface).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledExactlyOnceWith("ssh", undefined);
    expect(notice.isConnected).toBe(false);
  } finally {
    tabs.dispose();
    strip.remove();
    container.remove();
  }
});

it("cancels an unused SSH token when its real Adapter closes during start and closes a late accepted session", async () => {
  let finish!: (id: string) => void;
  const start = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const sshPane = vi.fn(),
    close = vi.fn();
  const bridge = {
    start,
    sshPane,
    close,
    onOutput: () => () => {},
    onExit: () => () => {},
  } as unknown as TerminalBridge;
  const adapter = createElectronTerminalAdapter(
    bridge,
    undefined,
    undefined,
    "pending-token",
  );
  const started = adapter.start({ onOutput: vi.fn(), onExit: vi.fn() });
  adapter.close();
  expect(sshPane).toHaveBeenCalledExactlyOnceWith("pending-token", null);
  finish("late");
  await started;
  expect(close).toHaveBeenCalledExactlyOnceWith("late", undefined);
  adapter.close();
  expect(close).toHaveBeenCalledOnce();
});
