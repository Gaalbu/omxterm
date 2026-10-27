import { englishLanguage, type RendererLanguage } from "./renderer-language";
import type {
  HostedContentBridge,
  HostedContentDescriptor,
} from "../shared/extension-view";

export interface HostedTab {
  readonly kind: "hosted";
  readonly id: string;
  readonly title: string;
  readonly container: HTMLElement;
  readonly slot: HTMLElement;
  removed: boolean;
}

// One presentation owner per window. Revisions invalidate native work immediately;
// promise continuations may activate DOM only while their selection still owns it.
export function createHostedContentTabs(
  parent: HTMLElement,
  bridge: HostedContentBridge | undefined,
  callbacks: {
    open(tab: HostedTab): void;
    retired(id: string): void;
    close(tab: HostedTab): void;
  },
  language: RendererLanguage = englishLanguage,
) {
  const page = parent.ownerDocument.defaultView!;
  let selected: HostedTab | undefined;
  let selectionIdentity: object | undefined;
  let revision = 0;
  let generation = 0;
  let nativePossible = false;
  let blocked = false;
  let pendingOverlay = false;
  let disposed = false;
  let scheduled = false;
  let transitioning = false;
  let failed = false;
  let overlayGeneration = -1;
  let restoreSuppressed = false;
  const notice = parent.ownerDocument.createElement("div");
  notice.setAttribute("role", "status");
  notice.hidden = true;
  parent.before(notice);
  const fail = () => {
    failed = true;
    notice.textContent = language.t("hosted.failure");
    notice.hidden = false;
  };
  const removeLanguage = language.bind(() => {
    if (failed) notice.textContent = language.t("hosted.failure");
    for (const button of parent.querySelectorAll(
      ".hosted-content-tab > button",
    ))
      button.textContent = language.t("hosted.close");
  });
  const present = async (tab: HostedTab | undefined, focus = false) => {
    if (!bridge) return true;
    const bounds = tab?.slot.getBoundingClientRect();
    if (tab) nativePossible = true;
    const request = ++revision;
    try {
      const accepted = await bridge.present({
        id: tab?.id ?? null,
        revision: request,
        bounds: bounds
          ? {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            }
          : { x: 0, y: 0, width: 0, height: 0 },
        focus,
      });
      if (request === revision) {
        if (!accepted) fail();
        else if (!tab) nativePossible = false;
      }
      return accepted;
    } catch {
      if (request === revision) fail();
      return false;
    }
  };
  const show = (focus = false) => {
    if (
      !disposed &&
      !failed &&
      !transitioning &&
      !restoreSuppressed &&
      !blocked &&
      !pendingOverlay &&
      selected &&
      !selected.removed
    )
      void present(selected, focus);
  };
  const layout = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    page.requestAnimationFrame(() => {
      scheduled = false;
      show();
    });
  };
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(layout);
  page.addEventListener("resize", layout);
  const removeOpen = bridge?.onOpen((descriptor: HostedContentDescriptor) => {
    if (disposed) return;
    const container = parent.ownerDocument.createElement("section");
    container.className = "hosted-content-tab";
    container.hidden = true;
    const close = parent.ownerDocument.createElement("button");
    close.textContent = language.t("hosted.close");
    const slot = parent.ownerDocument.createElement("div");
    slot.className = "hosted-content-slot";
    const tab: HostedTab = {
      kind: "hosted",
      ...descriptor,
      container,
      slot,
      removed: false,
    };
    close.addEventListener("click", () => callbacks.close(tab));
    container.append(close, slot);
    parent.append(container);
    observer?.observe(slot);
    callbacks.open(tab);
  });
  const removeRetired = bridge?.onRetired(callbacks.retired);
  return {
    select(
      tab: HostedTab | undefined,
      activate: () => void,
      identity?: object,
    ) {
      if (selectionIdentity !== identity) generation += 1;
      selectionIdentity = identity;
      const current = generation;
      transitioning = true;
      if (!blocked) restoreSuppressed = false;
      selected = tab;
      const finish = () => {
        if (disposed || current !== generation) return;
        transitioning = false;
        activate();
        show(true);
      };
      if (nativePossible) {
        void present(undefined).then((ok) => {
          if (ok) finish();
        });
      } else finish();
    },
    focus: () => show(true),
    setBlocked(value: boolean) {
      const changed = blocked !== value;
      blocked = value;
      if (value && changed) overlayGeneration = generation;
      if (!value && changed && overlayGeneration !== generation)
        restoreSuppressed = true;
      if (value) pendingOverlay = false;
      if (!changed) return;
      if (value && nativePossible) void present(undefined);
      else show();
    },
    openOverlay(open: () => void) {
      if (disposed || pendingOverlay || transitioning) return;
      if (!nativePossible) {
        open();
        return;
      }
      pendingOverlay = true;
      const current = generation;
      void present(undefined).then((ok) => {
        if (disposed) return;
        if (current !== generation) {
          pendingOverlay = false;
          show();
          return;
        }
        if (!ok) return; // Fail closed, including focus/layout requests.
        open();
        pendingOverlay = false;
        show();
      });
    },
    forget(tab: HostedTab) {
      observer?.unobserve(tab.slot);
    },
    close(tab: HostedTab, remove: () => void) {
      void bridge?.close(tab.id).then(remove, fail);
    },
    dispose() {
      disposed = true;
      generation += 1;
      removeOpen?.();
      removeRetired?.();
      observer?.disconnect();
      page.removeEventListener("resize", layout);
      notice.remove();
      removeLanguage();
      if (nativePossible) void present(undefined);
    },
  };
}
