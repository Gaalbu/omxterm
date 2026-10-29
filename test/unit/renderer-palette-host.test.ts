// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { mountTerminalWindowPage } from "../../src/renderer/terminal-window-host";
import { createFakeSurface } from "../fixtures/terminal-tabs-harness";
import type { TerminalBridge } from "../../src/shared/terminal-bridge";

it("owns native query clipboard and excludes competing About/image/tab actions", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const tabStrip = document.createElement("nav");
  const tabsContainer = document.createElement("main");
  document.body.replaceChildren(tabStrip, tabsContainer);
  let open!: () => void;
  let about!: () => void;
  let image!: () => void;
  let clipboard!: Parameters<TerminalBridge["onClipboardAction"]>[0];
  let command!: Parameters<TerminalBridge["onTabCommand"]>[0];
  const surface = createFakeSurface();
  const createAdapter = vi.fn(() => ({
    sessionId: () => "s1",
    start: async () => {},
    write() {},
    resize() {},
    close() {},
  }));
  const loadImage = vi.fn(async () => null);
  const host = mountTerminalWindowPage(
    { tabStrip, tabsContainer },
    {
      createAdapter,
      mount: async () => surface,
      palette: {
        snapshot: async () => ({ token: "one", actions: [] }),
        invoke: async () => {},
        onOpen: (listener) => {
          open = listener;
          return () => {};
        },
        setDispatchGuard() {},
      },
      about: {
        info: async () => ({ name: "OMXTerm", version: "1", copyright: "MIT" }),
        openLink: async () => {},
        onOpen: (listener) => {
          about = listener;
          return () => {};
        },
      },
      loadLocalImage: loadImage,
      subscribeToLocalImageOpen: (listener) => {
        image = listener;
        return () => {};
      },
      subscribeToClipboardActions: (listener) => {
        clipboard = listener;
        return () => {};
      },
      subscribeToTabCommands: (listener) => {
        command = listener;
        return () => {};
      },
      clipboard: {
        readText: async () => "query",
        writeText: async () => {},
        confirmPaste: async () => true,
        requestContextMenu() {},
      },
    },
  );
  try {
    await host.ready;
    open();
    await Promise.resolve();
    expect(tabsContainer.inert).toBe(true);
    about();
    image();
    command({ action: "new" });
    expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(loadImage).not.toHaveBeenCalled();
    expect(createAdapter).toHaveBeenCalledOnce();
    clipboard("paste");
    await Promise.resolve();
    const query = document.querySelector<HTMLInputElement>("[role=combobox]")!;
    expect(query.value).toBe("query");
    expect(surface.paste).not.toHaveBeenCalled();
    clipboard("select-all");
    expect(query.selectionEnd).toBe(5);
    query.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(tabsContainer.inert).toBe(false);
    about();
    open();
    expect(document.querySelectorAll("dialog[open]")).toHaveLength(1);
    expect(document.querySelector(".command-palette")).toBeNull();
  } finally {
    host.dispose();
    document.body.replaceChildren();
  }
});
