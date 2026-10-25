// @vitest-environment jsdom
import { afterEach, expect, it, vi, type Mock } from "vitest";
import { mountTerminalWindowPage } from "../../src/renderer/terminal-window-host";
import type { TerminalTabCommand } from "../../src/shared/terminal-contract";
import type { TerminalSnippetsResponse } from "../../src/shared/terminal-snippets";
import type { LocalImageData } from "../../src/shared/local-image";
import type {
  TerminalSessionAdapter,
  TerminalSessionHandlers,
} from "../../src/terminal-surface/terminal-session-adapter";
import { createSemanticInputDelivery } from "../../src/terminal-surface/semantic-input-delivery";
import type { TerminalSurfaceOptions } from "../../src/terminal-surface/terminal-surface";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
async function fixture() {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const content = document.createElement("div"),
    root = document.createElement("aside"),
    tabsContainer = document.createElement("main"),
    tabStrip = document.createElement("nav");
  content.append(tabsContainer, root);
  document.body.append(tabStrip, content);
  vi.spyOn(content, "getBoundingClientRect").mockReturnValue({
    width: 1000,
  } as DOMRect);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  let toggle!: () => void, about!: () => void, image!: () => void;
  let clipboardAction!: (action: "copy" | "paste" | "select-all") => void;
  let tabCommand!: (command: TerminalTabCommand) => void;
  let tabBar!: () => void;
  const clipboard = {
    readText: vi.fn(async () => "pasted\nquery"),
    writeText: vi.fn(async () => {}),
    confirmPaste: vi.fn(async () => false),
    requestContextMenu: vi.fn(),
  };
  const surfaces: ReturnType<typeof surface>[] = [];
  function surface(adapter: TerminalSessionAdapter) {
    const input = document.createElement("textarea");
    tabsContainer.append(input);
    const delivery = createSemanticInputDelivery({
      isLive: () => true,
      isBracketedPasteEnabled: () => false,
      confirmPaste: clipboard.confirmPaste,
      write: adapter.write,
    });
    return {
      dispose: vi.fn(() => delivery.dispose()),
      focus: vi.fn(() => input.focus()),
      applyTheme: vi.fn(),
      applyConfiguration: vi.fn(),
      inject: vi.fn(
        async (text: string, options?: { readonly submit?: boolean }) => {
          await delivery.deliver(text, options);
        },
      ),
      zoom: vi.fn(),
      copy: vi.fn(async () => {}),
      paste: vi.fn(async () => {}),
      selectAll: vi.fn(),
      find: vi.fn(),
    };
  }
  const sessionHandlers: TerminalSessionHandlers[] = [];
  const surfaceOptions: TerminalSurfaceOptions[] = [];
  const failure = vi.fn();
  const transportWrites: Mock<(data: string) => void>[] = [];
  let nextSession = 0;
  const adapters = vi.fn(() => {
    const sessionId = `s${++nextSession}`;
    const write = vi.fn<(data: string) => void>();
    transportWrites.push(write);
    return {
      sessionId: () => sessionId,
      start: async (handlers: TerminalSessionHandlers) => {
        sessionHandlers.push(handlers);
      },
      write,
      resize: vi.fn(),
      close: vi.fn(),
    };
  });
  const load = vi
    .fn<() => Promise<TerminalSnippetsResponse>>()
    .mockResolvedValue({
      snippets: [{ name: "literal", body: " a  b\n$VALUE\n", execute: true }],
    });
  const loadImage = vi
    .fn<() => Promise<LocalImageData | null>>()
    .mockResolvedValue(null);
  const host = mountTerminalWindowPage(
    { tabsContainer, tabStrip },
    {
      page: window,
      createAdapter: adapters,
      mount: async (_container, adapter, options) => {
        const value = surface(adapter);
        surfaces.push(value);
        surfaceOptions.push(options);
        await adapter.start({ onOutput() {}, onExit: () => value.dispose() });
        return value;
      },
      onSurfaceFailure: failure,
      clipboard,
      snippets: {
        element: root,
        load,
        subscribeToToggle(listener) {
          toggle = listener;
          return vi.fn();
        },
      },
      subscribeToClipboardActions(listener) {
        clipboardAction = listener;
        return vi.fn();
      },
      subscribeToTabCommands(listener) {
        tabCommand = listener;
        return vi.fn();
      },
      subscribeToTabBarToggle(listener) {
        tabBar = listener;
        return vi.fn();
      },
      about: {
        info: async () => ({ name: "OMXTerm", version: "1", copyright: "MIT" }),
        openLink: async () => {},
        onOpen(listener) {
          about = listener;
          return vi.fn();
        },
      },
      loadLocalImage: loadImage,
      subscribeToLocalImageOpen(listener) {
        image = listener;
        return vi.fn();
      },
    },
  );
  cleanups.push(host.dispose);
  await host.ready;
  return {
    root,
    host,
    toggle,
    about,
    image,
    load,
    loadImage,
    clipboard,
    clipboardAction,
    tabCommand,
    tabBar,
    surfaces,
    adapters,
    sessionHandlers,
    transportWrites,
    surfaceOptions,
    failure,
  };
}

it("routes native action subscriptions to panel text, retains passive focus, and preserves exact selected injection", async () => {
  const f = await fixture();
  f.tabCommand({ action: "new" });
  await vi.waitFor(() => expect(f.surfaces).toHaveLength(2));
  f.toggle();
  const input = f.root.querySelector("input")!;
  expect(document.activeElement).toBe(input);
  window.dispatchEvent(new Event("focus"));
  f.tabBar();
  expect(document.activeElement).toBe(input);
  input.value = "query";
  input.select();
  f.clipboardAction("copy");
  expect(f.clipboard.writeText).toHaveBeenCalledWith("query");
  f.clipboardAction("paste");
  await vi.waitFor(() => expect(input.value).toBe("pasted query"));
  f.clipboardAction("select-all");
  expect(input.selectionEnd).toBe(input.value.length);
  for (const surface of f.surfaces) {
    expect(surface.copy).not.toHaveBeenCalled();
    expect(surface.paste).not.toHaveBeenCalled();
    expect(surface.selectAll).not.toHaveBeenCalled();
    expect(surface.inject).not.toHaveBeenCalled();
  }
  input.value = "";
  input.dispatchEvent(new Event("input"));
  await vi.waitFor(() =>
    expect(f.root.querySelector("li button")).not.toBeNull(),
  );
  f.root.querySelector<HTMLButtonElement>("li button")!.click();
  expect(f.surfaces[1]!.inject).toHaveBeenCalledExactlyOnceWith(
    " a  b\n$VALUE\n",
    { submit: true },
  );
  expect(f.surfaces[0]!.inject).not.toHaveBeenCalled();
  expect(f.adapters).toHaveBeenCalledTimes(2);
  f.clipboardAction("paste");
  expect(f.surfaces[1]!.paste).toHaveBeenCalledOnce();
});

it.each(["About", "image"])(
  "retains loading panel inert under %s and preserves overlay focus/cancellation",
  async (kind) => {
    const f = await fixture();
    let complete!: (value: TerminalSnippetsResponse) => void;
    f.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    let cancelImage!: (value: null) => void;
    f.loadImage.mockImplementation(
      () =>
        new Promise((resolve) => {
          cancelImage = resolve;
        }),
    );
    f.toggle();
    await vi.waitFor(() => expect(complete).toBeDefined());
    const focusCalls = f.surfaces[0]!.focus.mock.calls.length;
    if (kind === "About") f.about();
    else f.image();
    expect(f.root.inert).toBe(true);
    expect(f.root.hidden).toBe(false);
    complete({ snippets: [{ name: "fresh", body: "fresh", execute: false }] });
    await vi.waitFor(() =>
      expect(f.root.querySelector("li button")).not.toBeNull(),
    );
    f.root.querySelector<HTMLButtonElement>("li button")!.click();
    f.root.querySelector<HTMLButtonElement>("header button")!.click();
    f.toggle();
    f.clipboardAction("paste");
    window.dispatchEvent(new Event("focus"));
    expect(f.root.hidden).toBe(false);
    expect(f.surfaces[0]!.inject).not.toHaveBeenCalled();
    expect(f.surfaces[0]!.paste).not.toHaveBeenCalled();
    expect(f.surfaces[0]!.focus).toHaveBeenCalledTimes(focusCalls);
    if (kind === "About")
      document.querySelector<HTMLButtonElement>(".about-close")!.click();
    else cancelImage(null);
    await vi.waitFor(() => expect(f.root.inert).toBe(false));
    expect(f.surfaces[0]!.focus).toHaveBeenCalledTimes(focusCalls + 1);
    expect(f.load).toHaveBeenCalledOnce();
  },
);

it.each(["signal", "rendering"] as const)(
  "disables an open preview when %s failure retains its tab",
  async (kind) => {
    const f = await fixture();
    f.toggle();
    await vi.waitFor(() =>
      expect(f.root.querySelector(".snippet-preview-open")).not.toBeNull(),
    );
    f.root.querySelector<HTMLButtonElement>(".snippet-preview-open")!.click();
    const insert = document.querySelector<HTMLButtonElement>(
      ".snippet-preview-insert",
    )!;
    const run = document.querySelector<HTMLButtonElement>(
      ".snippet-preview-run",
    )!;
    if (kind === "signal") {
      f.sessionHandlers[0]!.onExit({ exitCode: 0, signal: 9 });
      expect(f.surfaces[0]!.dispose).toHaveBeenCalledOnce();
    } else {
      f.surfaceOptions[0]!.onFatalError!("Synthetic rendering failure");
      expect(f.failure).toHaveBeenCalledExactlyOnceWith(
        "Synthetic rendering failure",
      );
    }
    expect(document.querySelectorAll("main.terminal-surface")).toHaveLength(1);
    expect(insert.disabled).toBe(true);
    expect(run.disabled).toBe(true);
    expect(
      document.querySelector(".snippet-preview-closed")!.textContent,
    ).toContain("Nothing will be sent");
    // Acceptance rechecks the target even if a stale event bypasses disabled UI.
    insert.disabled = false;
    insert.click();
    expect(document.querySelector(".snippet-preview")).not.toBeNull();
    expect(f.surfaces[0]!.inject).not.toHaveBeenCalled();
    document
      .querySelector(".snippet-preview")!
      .dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(document.querySelector(".snippet-preview")).toBeNull();
    expect(document.activeElement).toBe(
      f.root.querySelector(".snippet-preview-open"),
    );
    expect(f.clipboard.confirmPaste).not.toHaveBeenCalled();
  },
);

it.each(["signal", "rendering", "startup"] as const)(
  "refuses both row delivery and preview capture after retained %s failure",
  async (kind) => {
    const f = await fixture();
    f.toggle();
    await vi.waitFor(() =>
      expect(f.root.querySelector(".snippet-preview-open")).not.toBeNull(),
    );
    if (kind === "rendering")
      f.surfaceOptions[0]!.onFatalError!("Synthetic rendering failure");
    else
      f.sessionHandlers[0]!.onExit({
        exitCode: 1,
        signal: kind === "signal" ? 9 : 0,
        ...(kind === "startup" ? { startupFailed: true } : {}),
      });
    expect(document.querySelectorAll("main.terminal-surface")).toHaveLength(1);
    f.root.querySelector<HTMLButtonElement>(".snippet-preview-open")!.click();
    f.root.querySelector<HTMLButtonElement>(".snippet-activate")!.click();
    expect(document.querySelector(".snippet-preview")).toBeNull();
    expect(f.surfaces[0]!.inject).not.toHaveBeenCalled();
  },
);

it.each(["exit", "close-session"] as const)(
  "never retargets an open preview after ordinary %s and a replacement tab",
  async (kind) => {
    const f = await fixture();
    f.tabCommand({ action: "new" });
    await vi.waitFor(() => expect(f.surfaces).toHaveLength(2));
    f.toggle();
    await vi.waitFor(() =>
      expect(f.root.querySelector(".snippet-preview-open")).not.toBeNull(),
    );
    const opener = f.root.querySelector<HTMLButtonElement>(
      ".snippet-preview-open",
    )!;
    opener.click();
    const stale = document.querySelector<HTMLButtonElement>(
      ".snippet-preview-run",
    )!;
    if (kind === "exit")
      f.sessionHandlers[1]!.onExit({ exitCode: 0, signal: 0 });
    else f.tabCommand({ action: "close-session", sessionId: "s2" });
    expect(stale.disabled).toBe(true);
    expect(document.querySelectorAll("main.terminal-surface")).toHaveLength(1);
    document
      .querySelector<HTMLButtonElement>(".snippet-preview-cancel")!
      .click();
    expect(document.activeElement).toBe(opener);
    f.tabCommand({ action: "new" });
    await vi.waitFor(() => expect(f.surfaces[2]?.focus).toHaveBeenCalled());
    stale.disabled = false;
    stale.click();
    for (const surface of f.surfaces)
      expect(surface.inject).not.toHaveBeenCalled();
    opener.click();
    document
      .querySelector<HTMLButtonElement>(".snippet-preview-insert")!
      .click();
    expect(f.surfaces[2]!.inject).toHaveBeenCalledExactlyOnceWith(
      " a  b\n$VALUE\n",
      { submit: false },
    );
    expect(f.surfaces[0]!.inject).not.toHaveBeenCalled();
    expect(f.surfaces[1]!.inject).not.toHaveBeenCalled();
  },
);

it("disposes a pending preview and ignores late failure and stale acceptance without refocusing", async () => {
  const f = await fixture();
  f.toggle();
  await vi.waitFor(() =>
    expect(f.root.querySelector(".snippet-preview-open")).not.toBeNull(),
  );
  f.root.querySelector<HTMLButtonElement>(".snippet-preview-open")!.click();
  const stale = document.querySelector<HTMLButtonElement>(
    ".snippet-preview-run",
  )!;
  f.surfaces[0]!.focus.mockClear();
  f.host.dispose();
  f.sessionHandlers[0]!.onExit({ exitCode: 0, signal: 9 });
  stale.click();
  expect(document.querySelector(".snippet-preview")).toBeNull();
  expect(f.surfaces[0]!.inject).not.toHaveBeenCalled();
  expect(f.surfaces[0]!.focus).not.toHaveBeenCalled();
  expect(f.surfaces[0]!.dispose).toHaveBeenCalled();
});

it.each([
  [true, "insert", false],
  [false, "run", true],
] as const)(
  "delivers exact bytes with final %s/%s intent through Protected Paste",
  async (execute, choice, submit) => {
    const f = await fixture();
    f.load.mockResolvedValue({
      snippets: [{ name: "literal", body: " a  b\n$VALUE\n", execute }],
    });
    f.clipboard.confirmPaste.mockResolvedValue(true);
    f.toggle();
    await vi.waitFor(() =>
      expect(f.root.querySelector(".snippet-preview-open")).not.toBeNull(),
    );
    f.root.querySelector<HTMLButtonElement>(".snippet-preview-open")!.click();
    expect(document.querySelector(".snippet-preview pre")!.textContent).toBe(
      " a  b\n$VALUE\n",
    );
    f.surfaces[0]!.focus.mockClear();
    document
      .querySelector<HTMLButtonElement>(`.snippet-preview-${choice}`)!
      .click();
    expect(document.querySelector(".snippet-preview")).toBeNull();
    expect(f.surfaces[0]!.focus).toHaveBeenCalledOnce();
    await f.surfaces[0]!.inject.mock.results[0]!.value;
    expect(f.clipboard.confirmPaste).toHaveBeenCalledExactlyOnceWith(
      " a  b\n$VALUE\n",
    );
    expect(f.transportWrites[0]!.mock.calls).toEqual(
      submit ? [[" a  b\n$VALUE\n"], ["\r"]] : [[" a  b\n$VALUE\n"]],
    );
    expect(f.surfaces[0]!.focus).toHaveBeenCalledOnce();
  },
);

it.each(["decline", "target-exit"] as const)(
  "does not deliver or refocus after Protected Paste %s",
  async (kind) => {
    const f = await fixture();
    let confirm!: (approved: boolean) => void;
    f.clipboard.confirmPaste.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve;
        }),
    );
    f.toggle();
    await vi.waitFor(() =>
      expect(f.root.querySelector(".snippet-preview-open")).not.toBeNull(),
    );
    f.root.querySelector<HTMLButtonElement>(".snippet-preview-open")!.click();
    f.surfaces[0]!.focus.mockClear();
    document.querySelector<HTMLButtonElement>(".snippet-preview-run")!.click();
    expect(document.querySelector(".snippet-preview")).toBeNull();
    expect(f.surfaces[0]!.focus).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(confirm).toBeDefined());
    if (kind === "target-exit") {
      f.sessionHandlers[0]!.onExit({ exitCode: 0, signal: 9 });
      f.tabCommand({ action: "new" });
      await vi.waitFor(() => expect(f.surfaces[1]?.focus).toHaveBeenCalled());
    }
    for (const surface of f.surfaces) surface.focus.mockClear();
    confirm(kind === "target-exit");
    await f.surfaces[0]!.inject.mock.results[0]!.value;
    for (const write of f.transportWrites) expect(write).not.toHaveBeenCalled();
    for (const surface of f.surfaces)
      expect(surface.focus).not.toHaveBeenCalled();
  },
);

it("keeps a snippet preview exclusive and delivers its final choice to the captured tab", async () => {
  const f = await fixture();
  f.tabCommand({ action: "new" });
  await vi.waitFor(() => expect(f.surfaces).toHaveLength(2));
  f.toggle();
  await vi.waitFor(() =>
    expect(f.root.querySelector(".snippet-intent")?.textContent).toBe(
      "Run · adds Enter",
    ),
  );
  f.root.querySelector<HTMLButtonElement>(".snippet-preview-open")!.click();
  expect(document.querySelectorAll(".snippet-preview")).toHaveLength(1);
  expect(document.querySelector(".snippet-preview pre")!.textContent).toBe(
    " a  b\n$VALUE\n",
  );

  f.about();
  f.image();
  f.tabCommand({ action: "previous" });
  f.root.querySelector<HTMLButtonElement>(".snippet-activate")!.click();
  expect(document.querySelector(".about-dialog")).toBeNull();
  expect(document.querySelectorAll(".snippet-preview")).toHaveLength(1);
  expect(f.loadImage).not.toHaveBeenCalled();
  for (const surface of f.surfaces)
    expect(surface.inject).not.toHaveBeenCalled();

  document.querySelector<HTMLButtonElement>(".snippet-preview-insert")!.click();
  expect(document.querySelector(".snippet-preview")).toBeNull();
  expect(f.surfaces[1]!.inject).toHaveBeenCalledExactlyOnceWith(
    " a  b\n$VALUE\n",
    { submit: false },
  );
  expect(f.surfaces[0]!.inject).not.toHaveBeenCalled();
  expect(f.surfaces[1]!.focus).toHaveBeenCalled();

  f.about();
  expect(document.querySelector(".about-dialog")).not.toBeNull();
  f.root.querySelector<HTMLButtonElement>(".snippet-preview-open")!.click();
  expect(document.querySelector(".snippet-preview")).toBeNull();
});
