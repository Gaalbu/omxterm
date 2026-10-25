import type { SettingsBridge, SettingsSnapshot } from "../../shared/settings";
import { describeSettingsResult } from "./settings-dialog";

// Raw JSON keeps its explicit Save. A dirty draft is never replaced by a
// graphical or external change; saving it from a stale revision is refused.
export function renderConfigFile(
  document: Document,
  bridge: SettingsBridge,
  snapshot: () => SettingsSnapshot | undefined,
  live: () => boolean,
  adopt: (next: SettingsSnapshot) => void,
  syncs: (() => void)[],
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
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Save";
  const revert = document.createElement("button");
  revert.type = "button";
  revert.textContent = "Reload File";
  const actions = document.createElement("div");
  actions.className = "settings-actions";
  actions.append(save, revert);
  let draftRevision: string | undefined;
  let dirty = false;
  let generation = 0;
  let pending = false;
  const busy = (value: boolean) => {
    pending = value;
    save.disabled = revert.disabled = value;
  };
  const fill = () => {
    const current = snapshot();
    if (!current) return;
    location.textContent = current.configurationPath;
    editor.placeholder = '{\n  "version": 1\n}';
    if (dirty) {
      if (draftRevision !== current.revision)
        message.textContent =
          "config.json changed since you started editing. Your draft is kept; saving it will be refused until you reload the file.";
      return;
    }
    editor.value = current.text ?? "";
    draftRevision = current.revision;
  };
  syncs.push(fill);
  editor.addEventListener("input", () => {
    generation += 1;
    dirty = true;
  });
  revert.addEventListener("click", () => {
    if (pending) return;
    const submitted = generation;
    busy(true);
    message.textContent = "Reloading…";
    void bridge.snapshot().then(
      (next) => {
        if (!live()) return;
        busy(false);
        if (generation === submitted) dirty = false;
        message.textContent = "";
        adopt(next);
      },
      () => {
        if (!live()) return;
        busy(false);
        message.textContent =
          "The file could not be reloaded. Your draft is kept.";
      },
    );
  });
  save.addEventListener("click", () => {
    const revision = draftRevision ?? snapshot()?.revision;
    if (!revision || pending) return;
    const submitted = generation;
    busy(true);
    message.textContent = "Saving…";
    void bridge.saveText(editor.value, revision).then(
      (result) => {
        if (!live()) return;
        busy(false);
        if (result.status === "saved") {
          dirty = generation !== submitted;
          draftRevision = result.snapshot.revision;
        }
        adopt(result.snapshot);
        message.textContent =
          describeSettingsResult(result).text +
          (result.status === "saved" && dirty
            ? " Newer edits are not saved."
            : "");
      },
      () => {
        if (!live()) return;
        busy(false);
        message.textContent = "Not saved: the request failed.";
      },
    );
  });
  panel.append(location, editor, actions, message);
  return panel;
}
