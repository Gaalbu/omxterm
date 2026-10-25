import { createHeadlessTerminal } from "restty/headless";
import { expect, it } from "vitest";
import { localImageReferenceCells } from "../fixtures/restty-local-image-targets";

it("targets the only occupied continuation cell for an 89-cell reference on an 88-column grid", () => {
  const reference = `/tmp/${"x".repeat(74)} photo.png`;
  expect(reference).toHaveLength(89);
  expect(
    localImageReferenceCells({
      cols: 88,
      reference,
      prefixColumns: 0,
      rootCellDelta: 0,
    }),
  ).toEqual([2, 79, 80, 88]);
});

it.each([
  {
    label: "exactly cols cells",
    reference: "/tmp/xxxxx photo.png",
    expected: [2, 10, 11],
    end: 20,
  },
  {
    label: "cols + 1 cells",
    reference: "/tmp/xxxxxx photo.png",
    expected: [2, 11, 12, 20],
    end: 21,
  },
  {
    label: "cols + 2 cells",
    reference: "/tmp/xxxxxxx photo.png",
    expected: [2, 12, 13, 21],
    end: 22,
  },
  {
    label: "cols + 3 cells",
    reference: "/tmp/xxxxxxxx photo.png",
    expected: [2, 13, 14, 22],
    end: 23,
  },
  {
    label: "longer continuation retains column 2",
    reference: "/tmp/xxxxxxxxxxxxxxx photo.png",
    expected: [2, 20, 21, 22],
    end: 30,
  },
  {
    label: "Unicode prefix ending exactly at cols",
    reference: "/tmp/x photo.png",
    prefixColumns: 4,
    expected: [6, 10, 11],
    end: 20,
  },
  {
    label: "Unicode prefix with cols + 1 total cells",
    reference: "/tmp/xx photo.png",
    prefixColumns: 4,
    expected: [6, 11, 12, 20],
    end: 21,
  },
  {
    label: "Unicode prefix with cols + 2 total cells",
    reference: "/tmp/xxx photo.png",
    prefixColumns: 4,
    expected: [6, 12, 13, 21],
    end: 22,
  },
  {
    label: "Unicode prefix with cols + 3 total cells",
    reference: "/tmp/xxxx photo.png",
    prefixColumns: 4,
    expected: [6, 13, 14, 22],
    end: 23,
  },
  {
    label: "wide root adds a cell and wraps",
    reference: "/tmp/漢xxxx photo.png",
    rootCellDelta: 1,
    expected: [2, 11, 12, 20],
    end: 21,
  },
  {
    label: "combining root removes a code-unit cell",
    reference: "/tmp/e\u0301xxxxx photo.png",
    rootCellDelta: -1,
    expected: [2, 11, 12, 20],
    end: 21,
  },
  {
    label: "Unicode prefix with quoted reference and location suffix",
    cols: 26,
    reference: "'/tmp/x photo.png':12:3",
    prefixColumns: 4,
    expected: [6, 11, 12, 26],
    end: 27,
  },
  {
    label: "continuation target already covered by the filename",
    reference: "/tmp/xxxxxxxxxxxxxxx photo.png",
    cols: 19,
    expected: [2, 20, 21],
    end: 30,
  },
])(
  "keeps occupied reference targets and wrap coverage for $label",
  async ({
    reference,
    cols = 20,
    prefixColumns = 0,
    rootCellDelta = 0,
    expected,
    end,
  }) => {
    const cells = localImageReferenceCells({
      cols,
      reference,
      prefixColumns,
      rootCellDelta,
    });
    expect(cells).toEqual(expected);
    expect(cells.some((cell) => cell >= cols)).toBe(end > cols);

    const core = await createHeadlessTerminal({ cols, rows: 4 });
    try {
      core.write(`${prefixColumns ? "漢e\u0301 " : ""}${reference}`);
      const codepoints = core.snapshot()!.codepoints!;
      for (const cell of cells) {
        expect(cell).toBeGreaterThanOrEqual(prefixColumns);
        expect(cell).toBeLessThan(end);
        // The actual core must place reference text, not blank padding, here.
        expect(codepoints[cell]).toBeGreaterThan(0);
      }
      expect(codepoints[end]).toBe(0);
    } finally {
      core.dispose();
    }
  },
);
