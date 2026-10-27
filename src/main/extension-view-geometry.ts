import type { BrowserWindow, Rectangle } from "electron";
import type { HostedContentPresentation } from "../shared/extension-view";

function intersect(a: Rectangle, b: Rectangle): Rectangle {
  const x = Math.ceil(Math.max(a.x, b.x));
  const y = Math.ceil(Math.max(a.y, b.y));
  return {
    x,
    y,
    width: Math.max(0, Math.floor(Math.min(a.x + a.width, b.x + b.width)) - x),
    height: Math.max(
      0,
      Math.floor(Math.min(a.y + a.height, b.y + b.height)) - y,
    ),
  };
}

export function extensionViewBounds(
  owner: BrowserWindow,
  slot: Rectangle,
  css: HostedContentPresentation["bounds"],
): Rectangle | null {
  const zoom = owner.webContents.getZoomFactor();
  if (
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    zoom > 10 ||
    ![slot.x, slot.y, slot.width, slot.height].every(
      (v) => Number.isFinite(v) && v >= 0 && v <= 100_000,
    )
  )
    return null;
  const [width = 0, height = 0] = owner.getContentSize();
  const bounds = intersect(
    intersect(
      {
        x: css.x * zoom,
        y: css.y * zoom,
        width: css.width * zoom,
        height: css.height * zoom,
      },
      slot,
    ),
    { x: 0, y: 0, width, height },
  );
  return bounds.width && bounds.height ? bounds : null;
}
