import type {
  ExtensionsBridge,
  ExtensionsRequest,
  ExtensionsResult,
} from "../../shared/extensions";
import { createPageButton, setPageNotice } from "../application-page";

// Explicit snapshots, never polling. Unknown mutations require a deliberate
// Refresh; no button automatically repeats a possibly committed operation.
export function renderExtensions(
  document: Document,
  bridge: ExtensionsBridge,
  live: () => boolean,
) {
  const panel = document.createElement("section");
  panel.className = "settings-panel extensions-panel";
  const heading = document.createElement("h2");
  heading.textContent = "Local extensions · development preview";
  const explanation = document.createElement("p");
  explanation.textContent =
    "Install a separately downloaded .omxext package. Trusted extension code has your user permissions; it is not sandboxed. Installed packages stay dormant until invoked. This preview is Linux ARM64 only.";
  const controls = document.createElement("div");
  controls.className = "application-page-actions";
  const notice = document.createElement("div");
  notice.setAttribute("role", "status");
  const list = document.createElement("div");
  let busy = false;
  const buttons = new Set<HTMLButtonElement>();
  function button(
    label: string,
    request: ExtensionsRequest,
    parent: HTMLElement,
  ) {
    const element = createPageButton(document);
    element.textContent = label;
    element.addEventListener("click", () => {
      void run(request);
    });
    buttons.add(element);
    parent.append(element);
  }
  function render(result: ExtensionsResult) {
    if (!result.ok) {
      setPageNotice(notice, {
        text: `${result.error ?? "outcome-unknown"}. No automatic retry. Refresh to inspect current state.`,
        severity: "warning",
      });
      return;
    }
    setPageNotice(notice, {
      text:
        (result.pendingCleanup === undefined
          ? "Retained-byte cleanup has not been inspected. "
          : "") +
        (result.pendingCleanup
          ? "Pending Cleanup: a package is still pinned or cleanup has not settled. Other app instances: unknown."
          : "Registry snapshot refreshed. Local activity belongs to this app instance; activity in other instances is unknown."),
      severity: result.pendingCleanup ? "warning" : "info",
    });
    for (const element of buttons)
      if (list.contains(element)) buttons.delete(element);
    list.replaceChildren();
    for (const entry of result.entries ?? []) {
      const row = document.createElement("section");
      const title = document.createElement("h3");
      title.textContent = `${entry.name}${entry.version ? ` · ${entry.version}` : ""}`;
      const state = document.createElement("p");
      state.textContent = `${entry.id} · generation ${entry.generation} · ${entry.installed ? (entry.enabled ? "enabled" : "disabled") : "uninstalled"} · local ${entry.local} · other instances unknown`;
      row.append(title, state);
      if (entry.installed) {
        button(
          entry.enabled ? "Disable" : "Enable",
          {
            operation: entry.enabled ? "disable" : "enable",
            id: entry.id,
            generation: entry.generation,
          },
          row,
        );
        button(
          "Uninstall",
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
    if (!list.children.length)
      list.textContent = "No local extensions installed.";
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
  button("Install local .omxext…", { operation: "install" }, controls);
  button("Refresh", { operation: "snapshot" }, controls);
  panel.append(heading, explanation, controls, notice, list);
  void run({ operation: "snapshot" });
  return panel;
}
