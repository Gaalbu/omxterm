import { describe, expect, it } from "vitest";
import { assertWindowsDragGeometry } from "../fixtures/window-chrome-drag-geometry";

function geometry() {
  const before = {
    hwnd: "1234",
    monitor: "5678",
    dpi: 240,
    showCmd: 1,
    flags: 0,
    outer: { x: 100, y: 100, width: 2400, height: 1600 },
    client: { width: 2370, height: 1580 },
  };
  return {
    before,
    after: {
      ...structuredClone(before),
      outer: { ...before.outer, x: 149, y: 145 },
    },
  };
}

it("accepts exact physical sizes when position changes enclosing DIP width", () => {
  const evidence = geometry();
  const enclosingWidth = ({ x, width }: { x: number; width: number }) =>
    Math.ceil((x + width) / 2.5) - Math.floor(x / 2.5);
  expect(enclosingWidth(evidence.before.outer)).toBe(960);
  expect(enclosingWidth(evidence.after.outer)).toBe(961);
  expect(() =>
    assertWindowsDragGeometry(JSON.stringify(evidence), 1234n),
  ).not.toThrow();
});

it.each(
  (["outer", "client"] as const).flatMap((kind) =>
    (["width", "height"] as const).flatMap((axis) =>
      [-1, 1].map((delta) => ({ kind, axis, delta })),
    ),
  ),
)(
  "rejects a physical pixel change: $kind.$axis $delta",
  ({ kind, axis, delta }) => {
    const evidence = geometry();
    evidence.after[kind][axis] += delta;
    expect(() =>
      assertWindowsDragGeometry(JSON.stringify(evidence), 1234n),
    ).toThrow(`physical ${kind === "outer" ? "window" : "client"} ${axis}`);
  },
);

it.each(["x", "y"] as const)("rejects no physical movement on %s", (axis) => {
  const evidence = geometry();
  evidence.after.outer[axis] = evidence.before.outer[axis];
  expect(() =>
    assertWindowsDragGeometry(JSON.stringify(evidence), 1234n),
  ).toThrow("move the physical window");
});

for (const phase of ["before", "after"] as const) {
  describe(phase, () => {
    it.each([0, -1, 0.5, NaN, "240", null])("rejects invalid DPI %j", (dpi) => {
      const evidence = geometry();
      Object.assign(evidence[phase], { dpi });
      expect(() =>
        assertWindowsDragGeometry(JSON.stringify(evidence), 1234n),
      ).toThrow();
    });

    it.each([0, 2, 3, 9, null, "1"])(
      "rejects nonrestored placement %j",
      (showCmd) => {
        const evidence = geometry();
        Object.assign(evidence[phase], { showCmd });
        expect(() =>
          assertWindowsDragGeometry(JSON.stringify(evidence), 1234n),
        ).toThrow("restored placement");
      },
    );

    it.each([-1, 8, 0.5, NaN])(
      "rejects invalid placement flags %j",
      (flags) => {
        const evidence = geometry();
        evidence[phase].flags = flags;
        expect(() =>
          assertWindowsDragGeometry(JSON.stringify(evidence), 1234n),
        ).toThrow();
      },
    );

    it.each(["", "0", null, 5678])("rejects invalid monitor %j", (monitor) => {
      const evidence = geometry();
      Object.assign(evidence[phase], { monitor });
      expect(() =>
        assertWindowsDragGeometry(JSON.stringify(evidence), 1234n),
      ).toThrow("valid monitor");
    });

    it("rejects a different HWND", () => {
      const evidence = geometry();
      evidence[phase].hwnd = "4321";
      expect(() =>
        assertWindowsDragGeometry(JSON.stringify(evidence), 1234n),
      ).toThrow("owned HWND");
    });
  });
}

it.each([{ dpi: 192 }, { monitor: "8765" }, { flags: 1 }])(
  "rejects a native context transition %j",
  (change) => {
    const evidence = geometry();
    Object.assign(evidence.after, change);
    expect(() =>
      assertWindowsDragGeometry(JSON.stringify(evidence), 1234n),
    ).toThrow();
  },
);

it.each(["", "not-json", "null", "[]", "{}", '{"before":{}}'])(
  "fails closed on missing or malformed evidence %j",
  (receipt) => {
    expect(() => assertWindowsDragGeometry(receipt, 1234n)).toThrow();
  },
);

it.each(["outer", "client"] as const)(
  "rejects invalid %s dimensions",
  (kind) => {
    for (const dimension of ["width", "height"] as const) {
      for (const value of [0, -1, 0.5, NaN, undefined]) {
        const evidence = geometry();
        Object.assign(evidence.before[kind], { [dimension]: value });
        Object.assign(evidence.after[kind], { [dimension]: value });
        expect(() =>
          assertWindowsDragGeometry(JSON.stringify(evidence), 1234n),
        ).toThrow();
      }
    }
  },
);
