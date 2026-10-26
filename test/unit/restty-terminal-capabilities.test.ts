import { createInputHandler } from "restty/internal";
import { describe, expect, it } from "vitest";

function createHarness() {
  const replies: string[] = [];
  const handler = createInputHandler({
    sendReply: (data) => replies.push(data),
    getCursorPosition: () => ({ row: 7, col: 11 }),
    getWindowMetrics: () => ({
      widthPx: 800,
      heightPx: 480,
      cellWidthPx: 10,
      cellHeightPx: 20,
      cols: 80,
      rows: 24,
    }),
    positionToCell: () => ({ row: 2, col: 4 }),
    getWheelCellMetrics: () => ({
      cellWidth: 10,
      cellHeight: 20,
      cols: 80,
      rows: 24,
    }),
  });
  return { handler, replies };
}

function feedAtEveryBoundary(sequence: string, expectedReply: string): void {
  for (let split = 0; split <= sequence.length; split += 1) {
    const { handler, replies } = createHarness();
    expect(handler.filterOutput(sequence.slice(0, split))).toBe("");
    expect(handler.filterOutput(sequence.slice(split))).toBe("");
    expect(replies, `split ${split}`).toEqual([expectedReply]);
  }
}

describe("Restty terminal capability and mouse ownership", () => {
  it("answers DA1 and DA2 deterministically once across every split", () => {
    feedAtEveryBoundary("\u001b[c", "\u001b[?1;2c");
    feedAtEveryBoundary("\u001b[>c", "\u001b[>0;0;0c");
  });

  it("answers cell-size reports once across every split", () => {
    feedAtEveryBoundary("\u001b[16t", "\u001b[6;20;10t");
  });

  it("passes CPR to core without fabricating a reply for one-argument callers", () => {
    const sequence = "A中B\u001b[6nZ";
    for (let split = 0; split <= sequence.length; split++) {
      const { handler, replies } = createHarness();
      const output =
        handler.filterOutput(sequence.slice(0, split)) +
        handler.filterOutput(sequence.slice(split));
      expect(output).toBe(sequence);
      expect(replies).toEqual([]);
    }
  });

  it("commits only a completed, accepted CPR prefix through its synchronous consumer", () => {
    const { handler, replies } = createHarness();
    // Local private-runtime extension, not a public Surface API.
    const filter = handler.filterOutput as (
      output: string,
      onCoreOutput: (prefix: string) => void,
    ) => string;
    const prefixes: string[] = [];
    const commit = (prefix: string) => prefixes.push(prefix);
    expect(filter("A中\u001b[6", commit)).toBe("A中");
    expect(prefixes).toEqual([]);
    expect(filter("\u0018n\u001b[6\u001an", commit)).toBe("nn");
    expect(prefixes).toEqual([]);
    expect(filter("\u001b[" + "1".repeat(10_000_001), commit)).toBe("");
    expect(filter("6nB\u001b[6nZ", commit)).toBe("Z");
    expect(prefixes).toEqual(["B\u001b[6n"]);
    expect(replies).toEqual([]);
  });

  it("leaves alternate-screen controls to Ghostty while owning mouse modes and reports", () => {
    const { handler, replies } = createHarness();
    expect(handler.filterOutput("\u001b[?1049hALT\u001b[?1049l")).toBe(
      "\u001b[?1049hALT\u001b[?1049l",
    );
    expect(handler.filterOutput("\u001b[?1000h\u001b[?1006h")).toBe("");

    expect(
      handler.sendMouseEvent("down", {
        button: 0,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
      } as PointerEvent),
    ).toBe(true);
    expect(
      handler.sendMouseEvent("up", {
        button: 0,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
      } as PointerEvent),
    ).toBe(true);
    expect(replies).toEqual(["\u001b[<0;5;3M", "\u001b[<0;5;3m"]);
  });
});
