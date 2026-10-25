// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mountTerminalWindowPage } from "../../src/renderer/terminal-window-host";
import type { TerminalTabCommand } from "../../src/shared/terminal-contract";
import type { LocalImageData } from "../../src/shared/local-image";
import { createFakeSurface } from "../fixtures/terminal-tabs-harness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}

afterEach(() => vi.restoreAllMocks());

it.each(["about", "choosing", "loading", "showing"] as const)(
  "keeps pane navigation/layout inert under %s but delivers captured closure",
  async (state) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    for (const method of ["showModal", "close"]) {
      if (!(method in HTMLDialogElement.prototype))
        Object.defineProperty(HTMLDialogElement.prototype, method, {
          configurable: true,
          value() {},
        });
    }
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(
      function (this: HTMLDialogElement) {
        this.open = true;
      },
    );
    vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.open = false;
    });
    const decoded = deferred<void>();
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value: vi.fn(() => decoded.promise),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pane-test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const loaded = deferred<LocalImageData | null>();
    const tabStrip = document.createElement("nav");
    const tabsContainer = document.createElement("div");
    document.body.replaceChildren(tabStrip, tabsContainer);
    let command!: (command: TerminalTabCommand) => void;
    let openAbout!: () => void;
    let openImage!: () => void;
    let next = 0;
    const surfaces: ReturnType<typeof createFakeSurface>[] = [];
    const notifyTabSelection = vi.fn();
    const host = mountTerminalWindowPage(
      { tabStrip, tabsContainer },
      {
        page: window,
        createAdapter: () => {
          const id = `s${++next}`;
          return {
            sessionId: () => id,
            start: async () => {},
            write: vi.fn(),
            resize: vi.fn(),
            close: vi.fn(),
          };
        },
        mount: async (container, adapter) => {
          vi.spyOn(
            container.closest<HTMLElement>(".terminal-tab")!,
            "getBoundingClientRect",
          ).mockReturnValue({ width: 1200, height: 800 } as DOMRect);
          await adapter.start({ onOutput: vi.fn(), onExit: vi.fn() });
          adapter.resize({ cols: 120, rows: 40 });
          const field = document.createElement("textarea");
          container.append(field);
          const surface = createFakeSurface();
          surface.focus.mockImplementation(() => field.focus());
          surfaces.push(surface);
          return surface;
        },
        notifyTabSelection,
        subscribeToTabCommands: (listener) => {
          command = listener;
          return () => {};
        },
        about: {
          info: async () => ({
            name: "OMXTerm",
            version: "1",
            copyright: "MIT",
          }),
          openLink: async () => {},
          onOpen: (listener) => {
            openAbout = listener;
            return () => {};
          },
        },
        loadLocalImage: () => loaded.promise,
        subscribeToLocalImageOpen: (listener) => {
          openImage = listener;
          return () => {};
        },
      },
    );
    try {
      await host.ready;
      command({ action: "split", direction: "right" });
      await vi.waitFor(() => expect(surfaces).toHaveLength(2));
      command({ action: "split", direction: "right" });
      await vi.waitFor(() => expect(surfaces).toHaveLength(3));
      command({ action: "prepare-close-pane" });
      const captured = surfaces[2]!;
      if (state === "about") openAbout();
      else {
        openImage();
        if (state !== "choosing") {
          loaded.resolve({
            name: "fixture.png",
            mime: "image/png",
            width: 1,
            height: 1,
            data: new Uint8Array([1]),
          });
          await vi.waitFor(() =>
            expect(document.querySelector("img")?.hasAttribute("src")).toBe(
              true,
            ),
          );
          if (state === "showing") {
            decoded.resolve();
            await vi.waitFor(() =>
              expect(
                document.querySelector<HTMLDialogElement>(
                  ".local-image-preview",
                )!.open,
              ).toBe(true),
            );
          }
        }
      }
      const active = document.activeElement;
      const layout = tabsContainer.innerHTML;
      const selection = notifyTabSelection.mock.calls.at(-1);
      for (const surface of surfaces) surface.focus.mockClear();
      command({ action: "split", direction: "right" });
      command({ action: "split", direction: "down" });
      command({ action: "focus-pane", target: "previous" });
      command({ action: "equalize-panes" });
      expect(surfaces).toHaveLength(3);
      expect(tabsContainer.innerHTML).toBe(layout);
      expect(notifyTabSelection.mock.calls.at(-1)).toEqual(selection);
      expect(document.activeElement).toBe(active);
      for (const surface of surfaces)
        expect(surface.focus).not.toHaveBeenCalled();
      command({ action: "resolve-close-pane", confirmed: true });
      expect(captured.dispose).toHaveBeenCalledOnce();
      expect(surfaces[0]!.dispose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(
        active?.isConnected ? active : document.body,
      );
      for (const surface of surfaces)
        expect(surface.focus).not.toHaveBeenCalled();
      command({ action: "close-session", sessionId: "s1" });
      expect(surfaces[0]!.dispose).toHaveBeenCalledOnce();
    } finally {
      host.dispose();
      loaded.resolve(null);
      decoded.resolve();
    }
  },
);
