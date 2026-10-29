import type { SavedLayout } from "../../src/shared/terminal-layout.js";

/** Own Enter through release; the original page cannot own keys in a new window. */
export function bindReleasedOpen(
  document: Document,
  button: HTMLButtonElement,
  snapshot: () => SavedLayout | undefined,
  open: (value: SavedLayout) => void,
) {
  const window = document.defaultView!;
  const lifetime = new window.AbortController();
  const events = { signal: lifetime.signal };
  let captured: SavedLayout | undefined;
  let suppressClick = false;
  let timer: number | undefined;
  let clickTimer: number | undefined;
  const cancel = () => {
    captured = undefined;
    suppressClick = false;
    window.clearTimeout(timer);
    window.clearTimeout(clickTimer);
    timer = clickTimer = undefined;
  };
  const copy = (value: SavedLayout) =>
    JSON.parse(JSON.stringify(value)) as SavedLayout;
  button.addEventListener(
    "click",
    () => {
      if (suppressClick) return;
      const value = snapshot();
      if (value) open(copy(value));
    },
    events,
  );
  button.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || captured) return;
      const value = snapshot();
      if (!value) return;
      captured = copy(value);
      suppressClick = true;
      timer = window.setTimeout(cancel, 30_000);
    },
    events,
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if (event.key !== "Enter" || !suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      const value = captured;
      cancel();
      suppressClick = true;
      clickTimer = window.setTimeout(() => {
        suppressClick = false;
      }, 0);
      if (value && snapshot()) open(value);
    },
    { ...events, capture: true },
  );
  button.addEventListener("blur", cancel, events);
  window.addEventListener("blur", cancel, events);
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) cancel();
    },
    events,
  );
  return {
    cancel,
    dispose() {
      cancel();
      lifetime.abort();
    },
  };
}
