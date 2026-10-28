import type {
  ExtensionsBridge,
  ExtensionsRequest,
  ExtensionsResult,
} from "../../shared/extensions";
import type { MessageKey } from "../../shared/i18n";
import { englishLanguage, type Translate } from "../renderer-language";
import { createPageButton, setPageNotice } from "../application-page";

// Explicit snapshots, never polling. Relabel retained nodes without repeating a
// request, losing a displayed generation or changing a pending operation.
export function renderExtensions(
  document: Document,
  bridge: ExtensionsBridge,
  live: () => boolean,
  labels: ((t: Translate) => void)[] = [],
) {
  let t = englishLanguage.t;
  const bindings = new Map<HTMLElement, () => void>();
  function bind(element: HTMLElement, text: () => string) {
    const apply = () => {
      element.textContent = text();
    };
    bindings.set(element, apply);
    apply();
  }
  const term = (value: string) => {
    const words = [
      "enabled",
      "disabled",
      "uninstalled",
      "dormant",
      "starting",
      "active",
      "stopping",
      "failed",
      "unknown",
      "busy",
      "invalid-package",
      "incompatible",
      "invalid-store",
      "conflict",
      "outcome-unknown",
      "runtime-unavailable",
      "unsupported",
      "unavailable",
    ] as const;
    return t(`extensions.${words.find((word) => word === value) ?? "unknown"}`);
  };
  const panel = document.createElement("section");
  panel.className = "settings-panel extensions-panel";
  const heading = document.createElement("h2");
  bind(heading, () => t("extensions.heading"));
  const explanation = document.createElement("p");
  bind(explanation, () => t("extensions.explanation"));
  const controls = document.createElement("div");
  controls.className = "application-page-actions";
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  const list = document.createElement("div");
  let busy = false;
  let last: ExtensionsResult | undefined;
  const buttons = new Set<HTMLButtonElement>();
  function button(
    label: MessageKey,
    request: ExtensionsRequest,
    parent: HTMLElement,
  ) {
    const element = createPageButton(document);
    bind(element, () => t(label));
    element.disabled = busy;
    element.addEventListener("click", () => {
      void run(request);
    });
    buttons.add(element);
    parent.append(element);
  }
  function renderNotice() {
    if (!last) return;
    setPageNotice(notice, {
      text: !last.ok
        ? t("extensions.error", {
            reason: term(last.error ?? "outcome-unknown"),
          })
        : (last.pendingCleanup === undefined
            ? t("extensions.cleanupUnchecked")
            : "") +
          t(
            last.pendingCleanup
              ? "extensions.cleanupPending"
              : "extensions.refreshed",
          ),
      severity: !last.ok || last.pendingCleanup ? "warning" : "info",
    });
  }
  function render(result: ExtensionsResult) {
    last = result;
    renderNotice();
    if (!result.ok) return;
    for (const element of bindings.keys())
      if (element === list || list.contains(element)) bindings.delete(element);
    for (const element of buttons)
      if (list.contains(element)) buttons.delete(element);
    list.replaceChildren();
    for (const entry of result.entries ?? []) {
      const row = document.createElement("section");
      const title = document.createElement("h3");
      title.textContent = `${entry.name}${entry.version ? ` · ${entry.version}` : ""}`;
      const state = document.createElement("p");
      bind(state, () =>
        t("extensions.state", {
          id: entry.id,
          generation: entry.generation,
          installed: term(
            entry.installed
              ? entry.enabled
                ? "enabled"
                : "disabled"
              : "uninstalled",
          ),
          local: term(entry.local),
        }),
      );
      row.append(title, state);
      if (entry.installed) {
        button(
          entry.enabled ? "extensions.disable" : "extensions.enable",
          {
            operation: entry.enabled ? "disable" : "enable",
            id: entry.id,
            generation: entry.generation,
          },
          row,
        );
        button(
          "extensions.uninstall",
          {
            operation: "uninstall",
            id: entry.id,
            generation: entry.generation,
          },
          row,
        );
      }
      list.append(row);
    }
    if (!list.children.length) bind(list, () => t("extensions.empty"));
  }
  async function run(request: ExtensionsRequest) {
    if (busy || !live()) return;
    busy = true;
    for (const element of buttons) element.disabled = true;
    try {
      const result = await bridge.request(request);
      if (live()) render(result);
    } catch {
      if (live()) render({ ok: false, error: "outcome-unknown" });
    } finally {
      busy = false;
      for (const element of buttons) element.disabled = false;
    }
  }
  labels.push((next) => {
    t = next;
    for (const apply of bindings.values()) apply();
    renderNotice();
  });
  button("extensions.install", { operation: "install" }, controls);
  button("extensions.refresh", { operation: "snapshot" }, controls);
  panel.append(heading, explanation, controls, notice, list);
  void run({ operation: "snapshot" });
  return panel;
}
