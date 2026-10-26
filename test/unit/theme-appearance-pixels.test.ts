import type { BrowserWindow } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertTopPaint,
  hasThemeTopPaint,
} from "../fixtures/theme-appearance-exercise";

const accent = [239, 205, 171, 255];
const red = [0, 0, 255, 255];

function bitmap(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let x = 0; x < width; x += 1) {
    pixels.set(accent, x * 4);
    pixels.set(red, ((height - 1) * width + x) * 4);
  }
  return pixels;
}

function capture(width: number, height: number, pixels: Buffer) {
  const rect = { x: 487, y: 419, width: 1, height: 3 };
  const getSize = vi.fn((scaleFactor?: number) =>
    scaleFactor === 1 ? { width, height } : { width: 1, height: 3 },
  );
  const toBitmap = vi.fn(() => pixels);
  const capturePage = vi.fn(async (_rect: typeof rect) => ({
    getSize,
    toBitmap,
  }));
  const executeJavaScript = vi.fn(async () => rect);
  const window = {
    webContents: { capturePage, executeJavaScript },
  } as unknown as BrowserWindow;
  return { window, rect, getSize, toBitmap, capturePage };
}

afterEach(() => vi.useRealTimers());

it.each([
  [1, 3],
  [3, 8],
  [2, 2],
])(
  "samples exact top/bottom paint from the returned %ix%i image, not the DIP request",
  async (width, height) => {
    vi.useFakeTimers();
    const f = capture(width, height, bitmap(width, height));
    const operation = assertTopPaint(f.window, ".pane-focused");
    await Promise.all([
      expect(operation).resolves.toBeUndefined(),
      vi.runAllTimersAsync(),
    ]);
    expect(f.capturePage).toHaveBeenCalledExactlyOnceWith(f.rect);
    expect(f.toBitmap).toHaveBeenCalledExactlyOnceWith({ scaleFactor: 1 });
    expect(f.getSize).toHaveBeenCalledExactlyOnceWith(1);
  },
);

it("accepts the 3x8/96-byte capture with blended intermediate rows but exact opaque endpoints", () => {
  const pixels = bitmap(3, 8);
  for (let x = 0; x < 3; x += 1) pixels.set([120, 103, 213, 255], (3 + x) * 4);
  expect(pixels.length).toBe(96);
  expect(hasThemeTopPaint({ width: 3, height: 8 }, pixels)).toBe(true);
});

it.each([
  ["black below before PTY paint", "bottom", [0, 0, 0, 255]],
  ["missing accent", "top", [0, 0, 0, 255]],
  ["red at both endpoints", "top", red],
  ["accent at both endpoints", "bottom", accent],
] as const)("rejects %s", (_label, row, color) => {
  const pixels = bitmap(3, 8);
  const offset = row === "top" ? 4 : 88;
  pixels.set(color, offset);
  expect(hasThemeTopPaint({ width: 3, height: 8 }, pixels)).toBe(false);
});

it.each([
  ["accent blue", 4],
  ["accent green", 5],
  ["accent red", 6],
  ["accent alpha", 7],
  ["cell blue", 88],
  ["cell green", 89],
  ["cell red", 90],
  ["cell alpha", 91],
] as const)(
  "rejects a one-byte difference in %s without tolerance",
  (_label, offset) => {
    const pixels = bitmap(3, 8);
    pixels[offset] = pixels[offset] === 255 ? 254 : pixels[offset]! + 1;
    expect(hasThemeTopPaint({ width: 3, height: 8 }, pixels)).toBe(false);
  },
);

it.each([
  [0, 8],
  [-1, 8],
  [1.5, 8],
  [NaN, 8],
  [Infinity, 8],
  [3, 0],
  [3, 1],
  [3, -1],
  [3, 8.5],
  [3, NaN],
  [3, Infinity],
  [Number.MAX_SAFE_INTEGER + 1, 8],
  [3, Number.MAX_SAFE_INTEGER + 1],
  [Number.MAX_SAFE_INTEGER, 8],
])(
  "rejects malformed or indistinguishable dimensions %s x %s",
  (width, height) => {
    expect(hasThemeTopPaint({ width, height }, bitmap(3, 8))).toBe(false);
  },
);

it.each([0, 12, 92, 95, 97, 100])(
  "rejects an incomplete or mismatched %i-byte buffer",
  (length) => {
    const pixels = Buffer.alloc(length);
    bitmap(3, 8).copy(pixels);
    expect(hasThemeTopPaint({ width: 3, height: 8 }, pixels)).toBe(false);
  },
);

it.each(["top", "bottom"] as const)(
  "keeps the caller's exact %s-color failure and original wait budget",
  async (row) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pixels = bitmap(3, 8);
    pixels.set([0, 0, 0, 255], row === "top" ? 4 : 88);
    const f = capture(3, 8, pixels);
    const operation = assertTopPaint(f.window, ".pane-focused");
    await Promise.all([
      expect(operation).rejects.toThrow(
        "Timed out waiting for Chromium pixels show the 1px accent above opaque first-row cell paint",
      ),
      vi.runAllTimersAsync(),
    ]);
    expect(Date.now()).toBe(25_000);
    expect(f.getSize).toHaveBeenCalledWith(1);
    expect(f.toBitmap).toHaveBeenCalledWith({ scaleFactor: 1 });
    expect(f.capturePage.mock.calls.every(([rect]) => rect === f.rect)).toBe(
      true,
    );
  },
);
