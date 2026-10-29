import type { TerminalClipboardAction } from "../shared/terminal-contract";
import type { TerminalClipboard } from "../terminal-surface/terminal-surface";

export function editPaletteQuery(
  action: TerminalClipboardAction,
  field: () => HTMLInputElement | undefined,
  clipboard: TerminalClipboard | undefined,
): boolean {
  const query = field();
  if (!query) return false;
  if (action === "select-all") query.select();
  else if (action === "copy") {
    const text = query.value.slice(
      query.selectionStart ?? 0,
      query.selectionEnd ?? 0,
    );
    if (text) void clipboard?.writeText(text).catch(() => {});
  } else {
    const value = query.value;
    const start = query.selectionStart;
    const end = query.selectionEnd;
    void clipboard
      ?.readText()
      .then((text) => {
        if (
          field() !== query ||
          query.value !== value ||
          query.selectionStart !== start ||
          query.selectionEnd !== end
        )
          return;
        query.setRangeText(
          text.replace(/[\r\n]+/g, " "),
          start ?? 0,
          end ?? 0,
          "end",
        );
        query.dispatchEvent(
          new query.ownerDocument.defaultView!.Event("input", {
            bubbles: true,
          }),
        );
      })
      .catch(() => {});
  }
  return true;
}
