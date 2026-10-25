import { expect, it } from "vitest";
import {
  localImageClippingReady,
  planLocalImageClipping,
} from "../fixtures/restty-local-image-clipping";
import { snapshotLocalImageCoreCells } from "../fixtures/restty-local-image-core-probe";
import { measureLocalImageRoot } from "../fixtures/restty-local-image-root";
import { realFrameFixture } from "../fixtures/restty-link-core-probe";

type Frame = Awaited<ReturnType<typeof realFrameFixture>>;
const cells = (fixture: Frame) =>
  snapshotLocalImageCoreCells(fixture.wasm, fixture.handle);
const asciiPath = (length: number) =>
  `/tmp/${"x".repeat(length - 17)}/a photo.png`;

async function endpoint(
  fixture: Frame,
  reference: string,
  cols: number,
  rows = 8,
) {
  return measureLocalImageRoot({
    rootPrefix: reference,
    size: { cols, rows },
    deliverOutput: (data) => fixture.write(data),
    readCells: async () => cells(fixture),
    async waitFor(predicate) {
      expect(await predicate()).toBe(true);
    },
  });
}

function printClipped(fixture: Frame, output: string) {
  fixture.write(output);
  fixture.runtime.scroll.scrollViewportByLines(-1000);
  fixture.produce();
}

it("keeps the complete 114-cell path visible before a concealed continuation on 110 columns", async () => {
  const reference = asciiPath(114);
  const fixture = await realFrameFixture(110, 8);
  try {
    fixture.write(reference);
    fixture.produce();
    expect(fixture.runtime.getVisibleLinkAtClientPoint(2, 0)?.url).toBe(
      reference,
    );
    const plan = planLocalImageClipping(reference, 114, { cols: 110, rows: 8 });
    expect(plan).toMatchObject({
      prefixRows: 2,
      paddingCells: 106,
      leadRows: 6,
      clickRow: 6,
      clickCol: 2,
    });
    printClipped(fixture, plan.output);
    // Selection trims final spaces; actual core cells must prove they are literal.
    expect(fixture.wasm.getSelectionText(fixture.handle, 6, 0, 7, 109)).toBe(
      reference,
    );
    expect(Array.from(fixture.frame().codepoints!).slice(774, 880)).toEqual(
      Array(106).fill(32),
    );
    expect(localImageClippingReady(cells(fixture), reference, plan)).toBe(true);
    fixture.produce();
    expect(
      fixture.runtime.getVisibleLinkAtClientPoint(plan.clickCol, plan.clickRow),
    ).toBeNull();
    fixture.runtime.scroll.scrollViewportByLines(1);
    fixture.produce();
    expect(fixture.wasm.getSelectionText(fixture.handle, 7, 0, 7, 109)).toBe(
      "continuation.png",
    );
    expect(localImageClippingReady(cells(fixture), reference, plan, 1)).toBe(
      true,
    );
  } finally {
    fixture.dispose();
  }
});

for (const cols of [88, 110, 112]) {
  for (const length of [
    55,
    cols - 1,
    cols,
    cols + 1,
    114,
    125,
    2 * cols,
    3 * cols + 1,
    7 * cols - 1,
  ]) {
    it(`proves standalone activation, clipped refusal and real concealed suffix at ${length}/${cols} cells`, async () => {
      const fixture = await realFrameFixture(cols, 8);
      const reference = asciiPath(length);
      try {
        expect(await endpoint(fixture, reference, cols)).toBe(length);
        fixture.write(`\u001b[3J\u001b[2J\u001b[H${reference}`);
        fixture.produce();
        expect(fixture.runtime.getVisibleLinkAtClientPoint(2, 0)?.url).toBe(
          reference,
        );
        const plan = planLocalImageClipping(reference, length, {
          cols,
          rows: 8,
        });
        if (length === 55)
          expect(plan).toMatchObject({
            prefixRows: 1,
            leadRows: 7,
            clickRow: 7,
          });
        if (length === cols)
          expect(plan).toMatchObject({
            prefixRows: 2,
            paddingCells: cols,
            leadRows: 6,
          });
        if (length === cols + 1)
          expect(plan).toMatchObject({ prefixRows: 2, paddingCells: cols - 1 });
        if (length === 2 * cols)
          expect(plan).toMatchObject({
            prefixRows: 3,
            paddingCells: cols,
            leadRows: 5,
          });
        if (length === 7 * cols - 1)
          expect(plan).toMatchObject({
            prefixRows: 7,
            paddingCells: 1,
            leadRows: 1,
          });
        printClipped(fixture, plan.output);
        expect(localImageClippingReady(cells(fixture), reference, plan)).toBe(
          true,
        );
        fixture.produce();
        expect(
          fixture.runtime.getVisibleLinkAtClientPoint(
            plan.clickCol,
            plan.clickRow,
          ),
        ).toBeNull();
        fixture.runtime.scroll.scrollViewportByLines(1);
        fixture.produce();
        expect(
          localImageClippingReady(cells(fixture), reference, plan, 1),
        ).toBe(true);
        expect(
          fixture.wasm.getSelectionText(fixture.handle, 7, 0, 7, cols - 1),
        ).toBe("continuation.png");
      } finally {
        fixture.dispose();
      }
    });
  }
}

for (const [reference, expectedEndpoint, baseEndpoint] of [
  [`C:\\tmp\\${"x".repeat(95)}\\a photo.png`, 114, 114],
  ["/tmp/漢e\u0301/a photo.png", 20, 20],
  ["/漢e\u0301/a photo.png", 16, 16],
  // Base 88 has no spacer here; wide 110 must add one before the wide glyph.
  [`/tmp/${"x".repeat(104)}漢e\u0301/a photo.png`, 125, 124],
  // Conversely, the base grid's wide-wrap spacer disappears on the wide grid.
  [`/tmp/${"x".repeat(82)}漢e\u0301/a photo.png`, 102, 103],
] as const) {
  it(`measures full Windows/Unicode spelling on the active grid (${expectedEndpoint}/${baseEndpoint})`, async () => {
    const fixture = await realFrameFixture(88, 8);
    try {
      expect(await endpoint(fixture, reference, 88)).toBe(baseEndpoint);
      fixture.wasm.resize(fixture.handle, 110, 8);
      const measured = await endpoint(fixture, reference, 110);
      expect(measured).toBe(expectedEndpoint);
      fixture.write(`\u001b[3J\u001b[2J\u001b[H${reference}`);
      fixture.produce();
      expect(fixture.runtime.getVisibleLinkAtClientPoint(2, 0)?.url).toBe(
        reference,
      );
      const plan = planLocalImageClipping(reference, measured, {
        cols: 110,
        rows: 8,
      });
      printClipped(fixture, plan.output);
      expect(localImageClippingReady(cells(fixture), reference, plan)).toBe(
        true,
      );
      fixture.produce();
      expect(
        fixture.runtime.getVisibleLinkAtClientPoint(
          plan.clickCol,
          plan.clickRow,
        ),
      ).toBeNull();
      if (baseEndpoint !== measured) {
        const stalePlan = planLocalImageClipping(reference, baseEndpoint, {
          cols: 110,
          rows: 8,
        });
        printClipped(fixture, stalePlan.output);
        expect(
          localImageClippingReady(cells(fixture), reference, stalePlan),
        ).toBe(false);
        printClipped(fixture, plan.output);
      }
      fixture.runtime.scroll.scrollViewportByLines(1);
      fixture.produce();
      expect(localImageClippingReady(cells(fixture), reference, plan, 1)).toBe(
        true,
      );
    } finally {
      fixture.dispose();
    }
  });
}

it("rejects empty, hidden, hard-broken, wrong-grid and padding-click geometry despite null recognition", async () => {
  const fixture = await realFrameFixture(110, 8);
  const reference = asciiPath(114);
  const plan = planLocalImageClipping(reference, 114, { cols: 110, rows: 8 });
  try {
    fixture.produce();
    expect(
      fixture.runtime.getVisibleLinkAtClientPoint(plan.clickCol, plan.clickRow),
    ).toBeNull();
    expect(localImageClippingReady(cells(fixture), reference, plan)).toBe(
      false,
    );
    printClipped(fixture, plan.output);
    expect(localImageClippingReady(cells(fixture), reference, plan)).toBe(true);
    expect(
      localImageClippingReady(cells(fixture), reference, {
        ...plan,
        clickRow: 7,
        clickCol: 109,
      }),
    ).toBe(false);
    expect(
      localImageClippingReady(cells(fixture), reference, {
        ...plan,
        cols: 112,
      }),
    ).toBe(false);
    fixture.runtime.scroll.scrollViewportByLines(1);
    fixture.produce();
    expect(localImageClippingReady(cells(fixture), reference, plan)).toBe(
      false,
    );
    printClipped(
      fixture,
      plan.output.replace(
        reference,
        reference.slice(0, 110) + "\r\n" + reference.slice(110),
      ),
    );
    expect(localImageClippingReady(cells(fixture), reference, plan)).toBe(
      false,
    );
    printClipped(
      fixture,
      plan.output.replace(" ".repeat(106), "\u001b[8;110H "),
    );
    expect(localImageClippingReady(cells(fixture), reference, plan)).toBe(
      false,
    );
    printClipped(fixture, plan.output);
    fixture.runtime.scroll.scrollViewportByLines(7);
    fixture.produce();
    expect(
      fixture.runtime.getVisibleLinkAtClientPoint(plan.clickCol, plan.clickRow),
    ).toBeNull();
    expect(localImageClippingReady(cells(fixture), reference, plan)).toBe(
      false,
    );
  } finally {
    fixture.dispose();
  }
});

it("detects an absent or misplaced continuation rather than accepting a vacuous clipped refusal", async () => {
  const fixture = await realFrameFixture(110, 8);
  const reference = asciiPath(114);
  const plan = planLocalImageClipping(reference, 114, { cols: 110, rows: 8 });
  try {
    for (const output of [
      plan.output.replace("continuation.png", ""),
      plan.output.replace("continuation.png", " continuation.png"),
    ]) {
      printClipped(fixture, output);
      // Visible setup alone cannot prove what was printed below the edge.
      fixture.runtime.scroll.scrollViewportByLines(1);
      fixture.produce();
      expect(localImageClippingReady(cells(fixture), reference, plan, 1)).toBe(
        false,
      );
    }
  } finally {
    fixture.dispose();
  }
});

it("rejects invalid grids and endpoints with explicit geometry", () => {
  for (const [cols, rows, value] of [
    [0, 8, 114],
    [15, 8, 114],
    [110.5, 8, 114],
    [110, 0, 114],
    [110, 1, 114],
    [110, 8.5, 114],
    [NaN, 8, 114],
    [110, Infinity, 114],
    [110, 8, -1],
    [110, 8, 2],
    [110, 8, 114.5],
    [110, 8, NaN],
  ] as const) {
    expect(() =>
      planLocalImageClipping("/tmp/a photo.png", value, { cols, rows }),
    ).toThrow(/invalid.*clipping.*geometry/i);
  }
});

it("rejects a prefix that leaves no preceding hard row instead of hiding it", async () => {
  const reference = asciiPath(770);
  const fixture = await realFrameFixture(110, 8);
  try {
    await expect(endpoint(fixture, reference, 110)).rejects.toThrow(
      /capacity.*770.*110.*8/i,
    );
    expect(() =>
      planLocalImageClipping(reference, 770, { cols: 110, rows: 8 }),
    ).toThrow(/capacity.*770.*110.*8/i);
  } finally {
    fixture.dispose();
  }
});
