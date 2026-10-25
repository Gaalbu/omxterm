import type { SettingsBridge, SettingsSnapshot } from "../../shared/settings";
import type { Translate } from "../renderer-language";
import { describeSettingsResult } from "./settings-dialog";
import type { SettingsViewHooks } from "./settings-pages";

// Raw JSON keeps its explicit Save. A dirty draft is never replaced by a
// graphical or external change; saving it from a stale revision is refused.
export function renderConfigFile(
  document: Document,
  bridge: SettingsBridge,
  snapshot: () => SettingsSnapshot | undefined,
  live: () => boolean,
  adopt: (next: SettingsSnapshot) => void,
  { syncs, relabels, language }: SettingsViewHooks,
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "settings-panel settings-config-file";
  const location = document.createElement("p");
  location.className = "settings-path";
  const editor = document.createElement("textarea");
  editor.spellcheck = false;
  editor.setAttribute("aria-label", "config.json");
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  // The message keeps how it was worded, so a language change rewords it.
  let messageText: (t: Translate) => string = () => "";
  const show = (text: (t: Translate) => string) => {
    messageText = text;
    message.textContent = text(language.t);
  };
  const save = document.createElement("button");
  save.type = "button";
  const revert = document.createElement("button");
  revert.type = "button";
  relabels.push((t) => {
    save.textContent = t("settings.file.save");
    revert.textContent = t("settings.file.reload");
    message.textContent = messageText(t);
  });
  const actions = document.createElement("div");
  actions.className = "settings-actions";
  actions.append(save, revert);
  let draftRevision: string | undefined;
  let dirty = false;
  const fill = () => {
    const current = snapshot();
    if (!current) return;
    location.textContent = current.configurationPath;
    editor.placeholder = '{\n  "version": 1\n}';
    if (dirty) {
      if (draftRevision !== current.revision)
        show((t) => t("settings.file.changed"));
      return;
    }
    editor.value = current.text ?? "";
    draftRevision = current.revision;
  };
  syncs.push(fill);
  editor.addEventListener("input", () => {
    dirty = true;
  });
  revert.addEventListener("click", () => {
    dirty = false;
    show(() => "");
    void bridge.snapshot().then((next) => {
      if (live()) adopt(next);
    });
  });
  save.addEventListener("click", () => {
    const revision = draftRevision ?? snapshot()?.revision;
    if (!revision) return;
    show((t) => t("settings.saving"));
    void bridge.saveText(editor.value, revision).then(
      (result) => {
        if (!live()) return;
        if (result.status === "saved") dirty = false;
        adopt(result.snapshot);
        show((t) => describeSettingsResult(result, undefined, t).text);
      },
      () => {
        if (live()) show((t) => t("settings.requestFailed"));
      },
    );
  });
  panel.append(location, editor, actions, message);
  return panel;
}
