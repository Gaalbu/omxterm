import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { exerciseAuxiliaryPanel } from "../fixtures/auxiliary-panel-exercise";

vi.mock("electron", () => ({
  Menu: {
    getApplicationMenu: () => null,
    buildFromTemplate: () => ({ items: [] }),
    setApplicationMenu: () => undefined,
  },
}));

it("waits for the first session and grid after its canvas appears", async () => {
  vi.useFakeTimers();
  const reachedNextTab = new Error("reached next tab");
  const newTab = vi.fn(() => {
    throw reachedNextTab;
  });
  const evaluate = vi.fn(async () => true);
  const sizes: Array<Array<{ cols: number; rows: number }>> = [];
  const contents = Object.assign(new EventEmitter(), {
    executeJavaScript: evaluate,
  });
  // No native work: stop at the next action after the actual readiness predicate.
  const pending = exerciseAuxiliaryPanel({
    window: {
      webContents: contents,
      setContentSize() {},
      focus() {},
    },
    application: { newTabInSelectedWindow: newTab },
    sizes,
  } as unknown as Parameters<typeof exerciseAuxiliaryPanel>[0]).catch(
    (error: unknown) => error,
  );
  try {
    await vi.advanceTimersByTimeAsync(25);
    expect(evaluate).toHaveBeenCalledWith(
      "document.querySelectorAll('canvas').length === 1",
    );
    expect(newTab).not.toHaveBeenCalled();
    sizes[0] = [];
    await vi.advanceTimersByTimeAsync(25);
    expect(newTab).not.toHaveBeenCalled();
    sizes[0].push({ cols: 80, rows: 24 });
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toBe(reachedNextTab);
    expect(newTab).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
