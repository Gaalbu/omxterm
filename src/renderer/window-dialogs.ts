import { mountWindowPalette } from "./command-palette";
import type { CommandPaletteBridge } from "../shared/command-palette";
import type { TerminalClipboard } from "../terminal-surface/terminal-surface";
import type { TerminalTabs } from "./terminal-tabs";
import { overlaySubscriptions } from "./hosted-overlay-subscriptions";
import type { AboutBridge } from "../shared/about";
import { mountAboutDialog } from "./about/about-dialog";
import type { RendererLanguage } from "./renderer-language";

export function mountWindowOverlays(
  document: Document,
  options: {
    about?: AboutBridge;
    palette?: CommandPaletteBridge;
    clipboard?: TerminalClipboard;
  },
  tabs: TerminalTabs,
  language: RendererLanguage,
  canOpen: () => boolean,
  activity: { dialogs(active: boolean): void; overlay(): void },
) {
  const bridges = overlaySubscriptions(options, tabs.openOverlay);
  const dialogs = mountWindowDialogs(document, bridges, canOpen, {
    language,
    focusTerminal: tabs.focusSelected,
    onActivityChange: activity.dialogs,
  });
  const palette = mountWindowPalette(
    document,
    bridges,
    tabs,
    language,
    canOpen,
    activity.overlay,
  );
  return { dialogs, palette };
}

// Settings is retained application content, not a modal owner.
export function mountWindowDialogs(
  document: Document,
  bridges: { readonly about?: AboutBridge | undefined },
  canOpen: () => boolean,
  options: {
    readonly language?: RendererLanguage;
    readonly focusTerminal: () => void;
    readonly onActivityChange: (active: boolean) => void;
  },
) {
  const about = mountAboutDialog(document, bridges.about, canOpen, options);
  return { dispose: () => about?.dispose() };
}
