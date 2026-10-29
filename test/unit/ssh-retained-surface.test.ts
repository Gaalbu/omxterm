// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { harness } from "../fixtures/restty-surface-harness";
import type { TerminalSessionHandlers } from "../../src/terminal-surface/terminal-session-adapter";
import { mountResttyTerminalSurface } from "../../src/terminal-surface/restty-terminal-surface";
import { DEFAULT_TERMINAL_THEME } from "../../src/shared/terminal-theme";

beforeEach(() => {
  harness.instances.length = 0;
  harness.setInitError(undefined);
});
it.each([true, false])(
  "retains readable SSH output with dead transport (early exit: %s)",
  async (early) => {
    let handlers!: TerminalSessionHandlers;
    const exit = (next: TerminalSessionHandlers) => {
      next.onOutput("retained SSH result");
      next.onExit({ exitCode: 255, signal: 0, retained: true });
    };
    const adapter = {
      start: vi.fn(async (next: TerminalSessionHandlers) => {
        handlers = next;
        if (early) exit(next);
      }),
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
    };
    const release = vi.fn();
    const copy = vi.fn();
    const onBell = vi.fn();
    const surface = await mountResttyTerminalSurface(
      document.createElement("main"),
      adapter,
      {
        acquireFontInputs: async () => ({ fonts: [], release }),
        clipboard: {
          writeText: copy,
          readText: async () => "paste",
          confirmPaste: async () => true,
          requestContextMenu() {},
        },
        onBell,
      },
    );
    if (!early) exit(handlers);
    const restty = harness.instances[0]!;
    const transport = restty.options.services.ptyTransport;
    const previousResizes = adapter.resize.mock.calls.length;
    expect(restty.sendInput).toHaveBeenCalledWith("retained SSH result", "pty");
    expect(restty.destroy).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    restty.pane.runtime.interaction.getSelectionText.mockReturnValue(
      "retained SSH result",
    );
    await surface.copy();
    surface.find();
    surface.zoom("in");
    surface.applyTheme(DEFAULT_TERMINAL_THEME);
    expect(copy).toHaveBeenCalledWith("retained SSH result");
    expect(restty.openSearch).toHaveBeenCalled();
    expect(restty.updateSize).toHaveBeenCalled();
    expect(transport.sendInput("reply")).toBe(false);
    transport.resize(80, 24);
    await surface.inject("injection");
    restty.emit({ type: "bell" });
    expect(onBell).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
    expect(adapter.resize).toHaveBeenCalledTimes(previousResizes);
    surface.dispose();
    surface.dispose();
    expect(adapter.close).toHaveBeenCalledOnce();
    expect(restty.destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  },
);
