// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mountTerminalWindowPage } from "../../src/renderer/terminal-window-host";
import type {
  HostedContentDescriptor,
  HostedContentPresentation,
} from "../../src/shared/extension-view";
import { createFakeSurface } from "../fixtures/terminal-tabs-harness";
import { deferred } from "../fixtures/settings-dialog-dom";

const owners: { dispose(): void }[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.dispose());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(["about", "palette", "image"] as const)(
  "hides native content before the actual inbound %s overlay and prevents legacy paste",
  async (kind) => {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false;
      },
    });
    const tabStrip = document.createElement("nav");
    const tabsContainer = document.createElement("div");
    document.body.append(tabStrip, tabsContainer);
    let openView!: (descriptor: HostedContentDescriptor) => void;
    const opens: Record<string, () => void> = {};
    let paste!: (action: "paste") => void;
    const surface = createFakeSurface();
    const present = vi.fn(
      async (_presentation: HostedContentPresentation) => true,
    );
    const info = vi.fn(async () => ({
      name: "test",
      version: "1",
      copyright: "test",
    }));
    const snapshot = vi.fn(async () => ({ token: "test", actions: [] }));
    const load = vi.fn(async () => null);
    const host = mountTerminalWindowPage(
      { tabStrip, tabsContainer },
      {
        page: window,
        createAdapter: () => ({
          sessionId: () => "s1",
          start: async () => {},
          write: vi.fn(),
          resize: vi.fn(),
          close: vi.fn(),
        }),
        mount: async () => surface,
        hostedContent: {
          onOpen(listener) {
            openView = listener;
            return () => {};
          },
          onRetired: () => () => {},
          onFailure: () => () => {},
          present,
          close: async () => {},
        },
        about: {
          info,
          openLink: async () => {},
          onOpen(listener) {
            opens.about = listener;
            return () => {};
          },
        },
        palette: {
          snapshot,
          invoke: async () => {},
          setDispatchGuard: () => {},
          onOpen(listener) {
            opens.palette = listener;
            return () => {};
          },
        },
        loadLocalImage: load,
        subscribeToLocalImageOpen(listener) {
          opens.image = listener;
          return () => {};
        },
        subscribeToClipboardActions(listener) {
          paste = listener;
          return () => {};
        },
      },
    );
    owners.push(host);
    await host.ready;
    expect(present).not.toHaveBeenCalled();
    openView({ id: "view-a", title: "Main title" });
    await Promise.resolve();
    const hide = deferred<boolean>();
    present.mockImplementationOnce(() => hide.promise);
    opens[kind]!();
    paste("paste");
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(info).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(surface.paste).not.toHaveBeenCalled();
    expect(present.mock.lastCall?.[0].id).toBeNull();
    hide.resolve(true);
    await vi.waitFor(() =>
      expect(
        kind === "about" ? info : kind === "palette" ? snapshot : load,
      ).toHaveBeenCalledOnce(),
    );
    if (kind !== "image") {
      expect(document.querySelector("dialog[open]")).not.toBeNull();
      document
        .querySelector("dialog[open]")!
        .dispatchEvent(new Event("cancel", { cancelable: true }));
    }
  },
);
