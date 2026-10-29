import {
  isSavedLayout,
  type SavedLayout,
} from "../../src/shared/terminal-layout.js";
import { errorCode, isStateDocument, type StateDocument } from "./document.js";
import { bindReleasedOpen } from "./open-gesture.js";
import { createRestorationPage } from "./ui.js";

export interface RestorationBridge {
  request(value: unknown): Promise<unknown>;
  onVisibility(listener: (visible: boolean) => void): () => void;
}
export function mountRestorationPage(
  document: Document,
  bridge: RestorationBridge,
) {
  const ui = createRestorationPage(document);
  const lifetime = new document.defaultView!.AbortController();
  let displayed: StateDocument | undefined;
  let pending = false;
  let visible = false;
  let disposed = false;
  let available = false;
  let refreshRequired = true;
  let generation = 0;
  const controls = () => {
    const blocked = pending || !visible || refreshRequired || !displayed;
    ui.buttons.open.disabled =
      blocked || !available || displayed?.status !== "saved";
    ui.buttons.save.disabled = blocked || !available;
    ui.buttons.forget.disabled = blocked || displayed?.status === "empty";
    ui.buttons.refresh.disabled = pending || !visible;
  };
  const openSnapshot = () =>
    !pending &&
    visible &&
    !disposed &&
    !refreshRequired &&
    available &&
    displayed?.status === "saved"
      ? (displayed.value ?? undefined)
      : undefined;
  const gesture = bindReleasedOpen(
    document,
    ui.buttons.open,
    openSnapshot,
    (value) => {
      void run(() => open(value));
    },
  );
  const adopt = (state: StateDocument) => {
    gesture.cancel();
    displayed = JSON.parse(JSON.stringify(state)) as StateDocument;
    refreshRequired = false;
    ui.render(displayed);
  };
  async function run(work: () => Promise<void>, requireVisible = true) {
    if (pending || disposed || (requireVisible && !visible)) return;
    pending = true;
    controls();
    try {
      await work();
    } catch {
      if (!disposed) {
        refreshRequired = true;
        ui.message(
          "The result is unavailable. Choose Refresh before another deliberate action; nothing will be retried automatically.",
          "warning",
        );
      }
    } finally {
      pending = false;
      if (!disposed) controls();
    }
  }
  async function refresh() {
    gesture.cancel();
    ui.message("Reading saved state…");
    let reply: unknown;
    try {
      reply = await bridge.request({ operation: "read" });
    } catch {
      reply = undefined;
    }
    if (disposed) return;
    if (isStateDocument(reply)) {
      adopt(reply);
      ui.message(
        reply.status === "invalid"
          ? "Saved data was preserved. Replace or Forget is available only because its current revision is readable."
          : "Saved state refreshed. Save and Open are always explicit actions.",
        reply.status === "invalid" ? "warning" : "info",
      );
    } else {
      refreshRequired = true;
      displayed = undefined;
      ui.render();
      ui.message(
        errorCode(reply) === "invalid-state"
          ? "State cannot be read safely. Nothing was repaired or overwritten. Unreadable, oversized or malformed state requires external correction with the app closed, then Refresh."
          : "Saved state is unavailable or busy. Choose Refresh to read again; no automatic retry.",
        "error",
      );
    }
  }
  async function replace(expectedRevision: string, value: SavedLayout | null) {
    let reply: unknown;
    try {
      reply = await bridge.request({
        operation: "replace",
        expectedRevision,
        value,
      });
    } catch {
      reply = { error: "outcome-unknown" };
    }
    if (disposed) return;
    if (
      isStateDocument(reply) &&
      reply.revision !== expectedRevision &&
      reply.status === (value === null ? "empty" : "saved")
    ) {
      adopt(reply);
      ui.message(
        value === null
          ? "Active saved layout forgotten. Interrupted-write temporary files may remain; see the cleanup guidance below."
          : "Window layout saved. This replaces the displayed snapshot, not your live terminals.",
        "success",
      );
      return;
    }
    const code = isStateDocument(reply) ? "outcome-unknown" : errorCode(reply);
    if (code === "conflict") {
      refreshRequired = true;
      ui.message(
        "Another window or process changed the saved layout. Its newer data was preserved. Choose Refresh before a new deliberate Replace or Forget.",
        "warning",
      );
    } else if (code === "outcome-unknown" || code === "unavailable") {
      refreshRequired = true;
      ui.message(
        "The write outcome is unknown; it may already have committed. Choose Refresh to read actual state. Do not replay the request; no automatic retry.",
        "warning",
      );
    } else {
      refreshRequired = code === "invalid-state";
      ui.message(
        "Saved state was not replaced. It may be busy or unreadable. Refresh before trying again; unreadable state needs external correction, not a blind overwrite.",
        "error",
      );
    }
  }
  async function save() {
    if (!displayed || refreshRequired || !available) return;
    gesture.cancel();
    const expectedRevision = displayed.revision;
    const intent = generation;
    ui.message("Capturing this window's current terminal arrangement…");
    let captured: unknown;
    try {
      captured = await bridge.request({
        operation: "terminal.captureLayout.v1",
      });
    } catch {
      captured = undefined;
    }
    if (disposed) return;
    if (!visible || generation !== intent) {
      ui.message(
        "Save cancelled before writing because the source page was hidden. Saved state was not changed.",
        "info",
      );
      return;
    }
    if (!isSavedLayout(captured)) {
      ui.message(
        "Capture failed or there are no eligible terminal tabs. Saved state was not changed. Keep the layout within 16 tabs, 16 panes per tab and 32 panes total.",
        "error",
      );
      return;
    }
    await replace(expectedRevision, captured);
  }
  async function forget() {
    if (!displayed || refreshRequired || displayed.status === "empty") return;
    gesture.cancel();
    ui.message("Forgetting the active saved layout…");
    await replace(displayed.revision, null);
  }
  async function open(layout: SavedLayout) {
    ui.message("Opening this saved snapshot in a new window…");
    let reply: unknown;
    try {
      reply = await bridge.request({
        operation: "terminal.openLayout.v1",
        layout,
      });
    } catch {
      reply = { error: "outcome-unknown" };
    }
    if (disposed) return;
    if (
      reply &&
      typeof reply === "object" &&
      "ok" in reply &&
      reply.ok === true &&
      "status" in reply &&
      reply.status === "accepted"
    ) {
      ui.message(
        "New window accepted. Its core status reports shell initialization and folder fallbacks; acceptance does not mean every shell started. Existing work stays open.",
        "success",
      );
    } else if (
      reply &&
      typeof reply === "object" &&
      "ok" in reply &&
      reply.ok === false &&
      ["busy", "invalid-layout", "unavailable"].includes(errorCode(reply))
    ) {
      ui.message(
        "Open was refused. The host may be busy, the source window unavailable, or the snapshot incompatible with this platform. Existing work was not changed.",
        "error",
      );
    } else {
      refreshRequired = true;
      ui.message(
        "A new window may already have opened. Check your windows, then Refresh before another deliberate Open. This request will not be replayed automatically.",
        "warning",
      );
    }
  }
  for (const [name, action] of [
    ["save", save],
    ["forget", forget],
    ["refresh", refresh],
  ] as const)
    ui.buttons[name].addEventListener(
      "click",
      () => {
        void run(action);
      },
      { signal: lifetime.signal },
    );
  const unsubscribe = bridge.onVisibility((next) => {
    if (visible === next) return;
    visible = next;
    if (!next) {
      generation++;
      gesture.cancel();
    }
    controls();
    if (next && !disposed)
      (ui.buttons.open.disabled ? ui.buttons.refresh : ui.buttons.open).focus();
  });
  controls();
  const ready = run(async () => {
    let capabilities: unknown;
    try {
      capabilities = await bridge.request({ operation: "host.capabilities" });
    } catch {
      capabilities = undefined;
    }
    if (disposed) return;
    const declared: unknown[] =
      capabilities &&
      typeof capabilities === "object" &&
      "capabilities" in capabilities &&
      Array.isArray(capabilities.capabilities)
        ? capabilities.capabilities
        : [];
    available = ["terminal.captureLayout.v1", "terminal.openLayout.v1"].every(
      (name) => declared.includes(name),
    );
    await refresh();
    if (!disposed && !available)
      ui.message(
        "This host does not provide both layout capabilities. Use a compatible Linux ARM64 preview host. Read and Forget do not require a host filesystem bridge.",
        "warning",
      );
  }, false);
  return {
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      unsubscribe();
      gesture.dispose();
      lifetime.abort();
      ui.page.remove();
    },
  };
}
