import {
  SETTINGS_FIELDS,
  type SettingsBridge,
  type SettingsPath,
  type SettingsResult,
  type SettingsSnapshot,
} from "../../shared/settings";
import type { TerminalClipboardAction } from "../../shared/terminal-contract";
import type { TerminalClipboard } from "../../terminal-surface/terminal-surface";
import type { MessageKey } from "../../shared/i18n";
import { retainDismissalGesture } from "../about/about-dialog";
import {
  englishLanguage,
  type RendererLanguage,
  type Translate,
} from "../renderer-language";
import { renderConfigFile } from "./settings-config-file";
import { pages, renderControl, type SettingsViewHooks } from "./settings-pages";

const SAVED = {
  live: "settings.saved.live",
  "new-tabs": "settings.saved.newTabs",
  "new-windows": "settings.saved.newWindows",
  restart: "settings.saved.restart",
} as const satisfies Record<string, MessageKey>;

// Describes what a result actually did, never more: saved is not applied.
// Text from main (validator detail, notices) is shown as main reported it.
export function describeSettingsResult(
  result: SettingsResult,
  path?: SettingsPath,
  t: Translate = englishLanguage.t,
): { readonly text: string; readonly error: boolean } {
  if (result.status !== "saved") return { text: result.message, error: true };
  if (!result.application.applied)
    return {
      text: t("settings.notApplied", { notice: result.application.notice }),
      error: true,
    };
  return {
    text: t(
      path ? SAVED[SETTINGS_FIELDS[path].lifetime] : "settings.saved.live",
    ),
    error: false,
  };
}

type DialogOptions = {
  readonly focusTerminal: () => void;
  readonly onActivityChange: (active: boolean) => void;
  readonly language?: RendererLanguage;
};

// Save-on-change dialog and controls adapted from ruscher/omxterm PR #622 at
// b3c3a4ad6c1f2224bded65873ba0b09a07ec5d38 (MIT).
export function mountSettingsDialog(
  document: Document,
  bridge: SettingsBridge | undefined,
  canOpen: () => boolean,
  options: DialogOptions,
) {
  if (!bridge) return undefined;
  const dialog = createSettingsDialog(document, bridge, options);
  const removeOpen = bridge.onOpen(() => {
    if (canOpen()) void dialog.open();
  });
  return {
    isActive: dialog.isActive,
    editClipboard: dialog.editClipboard,
    dispose() {
      removeOpen();
      dialog.dispose();
    },
  };
}

export function createSettingsDialog(
  document: Document,
  bridge: SettingsBridge,
  options: DialogOptions,
) {
  const language = options.language ?? englishLanguage;
  let dialog: HTMLDialogElement | undefined;
  let disposed = false;
  // Relabels the open dialog in place, including after its own language change.
  let relabel: ((t: Translate) => void) | undefined;
  const unbindLabels = language.bind((t) => relabel?.(t));
  const keyboard = retainDismissalGesture(document);
  const close = (restoreFocus: boolean) => {
    const previous = dialog;
    if (!previous) return;
    dialog = undefined;
    relabel = undefined;
    if (restoreFocus) previous.close();
    previous.remove();
    options.onActivityChange(false);
    if (restoreFocus) options.focusTerminal();
  };

  const open = async () => {
    if (disposed) return;
    if (dialog) {
      (
        dialog.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        ) ?? dialog.querySelector<HTMLElement>(".settings-close")
      )?.focus();
      return;
    }
    const current = document.createElement("dialog");
    dialog = current;
    current.className = "settings-dialog";
    current.setAttribute("aria-labelledby", "settings-title");
    const live = () => dialog === current;
    const view = buildSettingsView(document, bridge, live, language);
    const done = document.createElement("button");
    done.type = "button";
    done.className = "settings-close";
    relabel = (t) => {
      view.relabel(t);
      done.textContent = t("common.close");
    };
    relabel(language.t);
    done.addEventListener("click", () => {
      if (live()) close(true);
    });
    current.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (live()) close(true);
    });
    current.addEventListener("keydown", (event) => {
      keyboard.track(event, done);
      event.stopPropagation();
    });
    current.append(view.element, done);
    document.body.append(current);
    options.onActivityChange(true);
    current.showModal();
    done.focus();
    await view.load();
  };

  return {
    isActive: () => dialog !== undefined,
    open,
    // App Copy/Paste/Select All edit the focused text field and never reach
    // the terminal while Settings owns input.
    editClipboard(
      action: TerminalClipboardAction,
      clipboard: Pick<TerminalClipboard, "readText" | "writeText"> | undefined,
    ) {
      const field = dialog?.contains(document.activeElement)
        ? document.activeElement
        : undefined;
      if (
        !(field instanceof HTMLInputElement) &&
        !(field instanceof HTMLTextAreaElement)
      )
        return;
      void editField(field, action, clipboard);
    },
    dispose() {
      disposed = true;
      unbindLabels();
      keyboard.dispose();
      close(false);
    },
  };
}

async function editField(
  field: HTMLInputElement | HTMLTextAreaElement,
  action: TerminalClipboardAction,
  clipboard: Pick<TerminalClipboard, "readText" | "writeText"> | undefined,
) {
  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (action === "select-all") {
    field.select();
    return;
  }
  if (action === "copy") {
    const text =
      start === null || end === null
        ? field.value
        : field.value.slice(start, end);
    if (text) await clipboard?.writeText(text).catch(() => undefined);
    return;
  }
  const text = await clipboard?.readText().catch(() => "");
  if (!text || field.ownerDocument.activeElement !== field) return;
  if (start === null || end === null) field.value = text;
  else field.setRangeText(text, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function buildSettingsView(
  document: Document,
  bridge: SettingsBridge,
  live: () => boolean,
  language: RendererLanguage,
) {
  let snapshot: SettingsSnapshot | undefined;
  const syncs: (() => void)[] = [];
  const relabels: ((t: Translate) => void)[] = [];
  const hooks: SettingsViewHooks = { syncs, relabels, language };
  const element = document.createElement("div");
  element.className = "settings-body";
  const title = document.createElement("h2");
  title.id = "settings-title";
  relabels.push((t) => {
    title.textContent = t("settings.title");
  });
  const status = document.createElement("p");
  status.className = "settings-status";
  status.setAttribute("role", "status");
  const problem = document.createElement("p");
  problem.className = "settings-problem";
  problem.setAttribute("role", "alert");
  problem.hidden = true;
  const tabs = document.createElement("div");
  tabs.className = "settings-tabs";
  tabs.setAttribute("role", "tablist");
  const panels = document.createElement("div");
  panels.className = "settings-panels";

  // The status keeps how it was worded, so a language change rewords it.
  let statusText: (t: Translate) => string = () => "";
  const report = (text: (t: Translate) => string, error: boolean) => {
    statusText = text;
    status.textContent = text(language.t);
    status.classList.toggle("error", error);
  };
  relabels.push((t) => {
    status.textContent = statusText(t);
    problem.textContent = snapshot?.problem
      ? t("settings.problem", { problem: snapshot.problem })
      : "";
  });
  const adopt = (next: SettingsSnapshot) => {
    snapshot = next;
    problem.textContent = next.problem
      ? language.t("settings.problem", { problem: next.problem })
      : "";
    problem.hidden = next.problem === undefined;
    for (const sync of syncs) sync();
  };
  let queue = Promise.resolve();
  const change = (path: SettingsPath, value: unknown) => {
    report((t) => t("settings.saving"), false);
    queue = queue
      .then(() => bridge.change({ path, value }))
      .then(
        (result) => {
          if (!live()) return;
          adopt(result.snapshot);
          report(
            (t) => describeSettingsResult(result, path, t).text,
            describeSettingsResult(result, path).error,
          );
        },
        () => {
          if (!live()) return;
          report((t) => t("settings.requestFailed"), true);
          for (const sync of syncs) sync();
        },
      );
  };
  const value = (path: SettingsPath) => snapshot?.values[path];

  const tabButtons: HTMLButtonElement[] = [];
  const select = (index: number) => {
    tabButtons.forEach((button, position) => {
      const selected = position === index;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      panels.children[position]!.toggleAttribute("hidden", !selected);
    });
  };
  const addPage = (id: string, label: MessageKey, panel: HTMLElement) => {
    const index = tabButtons.length;
    const button = document.createElement("button");
    button.type = "button";
    button.id = `settings-tab-${id}`;
    relabels.push((t) => {
      button.textContent = t(label);
    });
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `settings-panel-${id}`);
    button.addEventListener("click", () => select(index));
    button.addEventListener("keydown", (event) => {
      const step =
        event.key === "ArrowDown" || event.key === "ArrowRight"
          ? 1
          : event.key === "ArrowUp" || event.key === "ArrowLeft"
            ? -1
            : 0;
      if (!step) return;
      event.preventDefault();
      const next = (index + step + tabButtons.length) % tabButtons.length;
      select(next);
      tabButtons[next]!.focus();
    });
    panel.id = `settings-panel-${id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    tabButtons.push(button);
    tabs.append(button);
    panels.append(panel);
  };

  // Pages depend on the main-reported platform, so they are built with the
  // first snapshot; until then the dialog shows a loading status.
  const build = (platform: string) => {
    for (const page of pages(platform)) {
      const panel = document.createElement("div");
      panel.className = "settings-panel";
      for (const control of page.controls)
        panel.append(renderControl(document, control, value, change, hooks));
      addPage(page.id, page.label, panel);
    }
    addPage(
      "config-file",
      "settings.page.configFile",
      renderConfigFile(document, bridge, () => snapshot, live, adopt, hooks),
    );
    select(0);
    for (const apply of relabels) apply(language.t);
  };
  element.append(title, problem, tabs, panels, status);
  report((t) => t("settings.loading"), false);

  return {
    element,
    async load() {
      try {
        const loaded = await bridge.snapshot();
        if (!live()) return;
        build(loaded.platform);
        adopt(loaded);
        report(() => "", false);
        tabButtons[0]?.focus();
      } catch {
        if (live()) report((t) => t("settings.loadFailed"), true);
      }
    },
    relabel(t: Translate) {
      for (const apply of relabels) apply(t);
    },
  };
}
