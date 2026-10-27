import { startTerminalWindow } from "../../src/renderer/start-terminal-window";
import { createOverlayActionConsumption } from "./overlay-action-consumption";
import { observeHostTabCommands } from "./host-tab-command-readiness";

const consumption = createOverlayActionConsumption(crypto.randomUUID());
Object.defineProperty(window, "__overlayConsumptionFixture", {
  value: () => consumption.snapshot(),
});
const bridge = window.omxterm;
// Observe completion of the real bridge; do not replace the hosted tab adapter.
let hiddenAcknowledged = true;
let latestRevision = 0;
let hideRevision = 0;
const overlayReceipts: Array<{
  modal: string;
  hiddenAcknowledged: boolean;
  hideRevision: number;
}> = [];
Object.defineProperty(window, "__extensionOverlayReceipts", {
  value: overlayReceipts,
});
if (bridge.terminal.hostedContent) {
  const seen = new WeakSet<Element>();
  const overlays = new MutationObserver(() => {
    for (const modal of document.querySelectorAll(
      ".command-palette, .about-dialog[open]",
    )) {
      if (seen.has(modal)) continue;
      seen.add(modal);
      overlayReceipts.push({
        modal: modal.className,
        hiddenAcknowledged,
        hideRevision,
      });
    }
  });
  overlays.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  window.addEventListener("pagehide", () => overlays.disconnect(), {
    once: true,
  });
}
const hostedContent = bridge.terminal.hostedContent && {
  ...bridge.terminal.hostedContent,
  async present(
    input: Parameters<typeof bridge.terminal.hostedContent.present>[0],
  ) {
    // Invalidate synchronously on show; publish hide only after actual main ACK.
    latestRevision = input.revision;
    if (input.id !== null) hiddenAcknowledged = false;
    const accepted = await bridge.terminal.hostedContent!.present(input);
    if (accepted && input.id === null && input.revision === latestRevision) {
      hiddenAcknowledged = true;
      hideRevision = input.revision;
    }
    return accepted;
  },
};
const host = observeHostTabCommands(bridge.terminal.onTabCommand);
Object.defineProperty(window, "__windowChromeHostReady", { value: host.wait });
window.addEventListener("pagehide", host.dispose, { once: true });
startTerminalWindow({
  ...bridge,
  terminal: {
    ...bridge.terminal,
    ...(hostedContent ? { hostedContent } : {}),
    onTabCommand: host.subscribe,
    onClipboardAction: consumption.clipboard(bridge.terminal.onClipboardAction),
    onSnippetsToggle: consumption.toggle(bridge.terminal.onSnippetsToggle),
  },
});
