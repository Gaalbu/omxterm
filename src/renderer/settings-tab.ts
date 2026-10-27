import type { SettingsBridge } from "../shared/settings";
import { createSettingsView } from "./settings/settings-dialog";
import type { retainDismissalGesture } from "./about/about-dialog";
import type { RendererLanguage } from "./renderer-language";

export interface SettingsTab {
  readonly kind: "settings";
  readonly container: HTMLElement;
  readonly view: ReturnType<typeof createSettingsView>;
  removed: boolean;
}

export function createSettingsTab(
  parent: HTMLElement,
  bridge: SettingsBridge,
  language: RendererLanguage,
  keyboard: ReturnType<typeof retainDismissalGesture>,
  close: (tab: SettingsTab) => void,
): SettingsTab {
  const container = parent.ownerDocument.createElement("div");
  container.className = "settings-tab";
  container.hidden = true;
  parent.append(container);
  const view = createSettingsView(parent.ownerDocument, bridge, {
    container,
    language,
    keyboard,
    onClose: () => close(tab),
  });
  view.setSelected(false);
  const tab: SettingsTab = {
    kind: "settings",
    container,
    view,
    removed: false,
  };
  return tab;
}
