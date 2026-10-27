import type { AboutBridge } from "../shared/about";
import type { CommandPaletteBridge } from "../shared/command-palette";
import type { HostedContentBridge } from "../shared/extension-view";

export function overlaySubscriptions<
  T extends { about?: AboutBridge; palette?: CommandPaletteBridge },
>(options: T, open: (callback: () => void) => void): T {
  return {
    ...options,
    ...(options.about ? { about: hideBeforeOpen(options.about, open)! } : {}),
    ...(options.palette
      ? { palette: hideBeforeOpen(options.palette, open)! }
      : {}),
  };
}

export function hostedTabOptions(
  bridge: HostedContentBridge | undefined,
  deactivate: () => void,
) {
  return {
    ...(bridge ? { hostedContent: bridge } : {}),
    onGraphicalSelected: deactivate,
    onSettingsSelected: deactivate,
  };
}

// Wrap only inbound host overlay opens. Existing overlay lifetimes still own
// their activity callbacks; the tab presentation owner supplies the hide barrier.
export function hideBeforeOpen<
  T extends { onOpen(listener: () => void): () => void },
>(
  bridge: T | undefined,
  openOverlay: (open: () => void) => void,
): T | undefined {
  return bridge
    ? {
        ...bridge,
        onOpen: (listener: () => void) =>
          bridge.onOpen(() => openOverlay(listener)),
      }
    : undefined;
}
