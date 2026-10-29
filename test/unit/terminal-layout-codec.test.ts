import { describe, expect, it } from "vitest";
import { leaf, type PaneLayout } from "../../src/renderer/pane-layout";
import {
  serializePaneLayout,
  deserializePaneLayout,
} from "../../src/renderer/terminal-tabs-layout";
import {
  isCapturedLayout,
  isInitialLayout,
  isSavedLayout,
  type SavedLayout,
} from "../../src/shared/terminal-layout";
import {
  captureValue,
  decode,
  encode,
} from "../../src/extension-runtime/protocol";

function deep(): PaneLayout<number> {
  let tree = leaf(15);
  for (let pane = 14; pane >= 0; pane--)
    tree = {
      kind: "split",
      direction: pane % 2 ? "column" : "row",
      children: [leaf(pane), tree],
      weights: [0.3, 0.7],
    };
  return tree;
}

describe("flat saved-window layout", () => {
  it("roundtrips asymmetric n-ary and deepest sixteen-pane trees", () => {
    for (const tree of [
      deep(),
      {
        kind: "split",
        direction: "row",
        children: [leaf(0), leaf(1), leaf(2)],
        weights: [0.2, 0.3, 0.5],
      } as PaneLayout<number>,
    ]) {
      const flat = serializePaneLayout(tree, 0);
      expect(deserializePaneLayout(flat)).toEqual(tree);
      expect(flat.nodes.length).toBeLessThanOrEqual(31);
    }
  });

  it("survives actual own-view capture and backend request/result envelopes", () => {
    const flat = serializePaneLayout(deep(), 9);
    const saved: SavedLayout = {
      version: 1,
      platform: "linux",
      savedAt: "2026-07-01T00:00:00.000Z",
      selected: 0,
      omitted: 1,
      tabs: [flat, flat].map((tab) => ({
        ...tab,
        panes: tab.panes.map(() => ({
          kind: "reported-local",
          path: "/" + "a".repeat(4095),
        })),
      })),
    };
    expect(isSavedLayout(saved)).toBe(true);
    for (const platform of [["linux"], ["win32"], null, 1, { name: "linux" }])
      expect(isSavedLayout({ ...saved, platform })).toBe(false);
    // The actual own-view host passes captured arrays without prototypes.
    expect(isSavedLayout(captureValue(saved))).toBe(true);
    // Own-view bridge uses captureValue for both request and response. Backend
    // then envelopes that same value; do not substitute JSON.stringify alone.
    const view = captureValue({ operation: "save", layout: saved });
    for (const kind of ["call", "result"])
      expect(
        decode(
          encode({
            epoch: "00000000-0000-0000-0000-000000000001",
            sequence: 1,
            kind,
            request: 1,
            ...(kind === "result" ? { ok: true } : {}),
            value: view,
          }),
        ).value,
      ).toEqual(view);
    expect(captureValue(view)).toEqual(view);
    expect(
      isCapturedLayout({
        selected: 0,
        omitted: 1,
        tabs: [{ ...flat, panes: flat.panes.map((pane) => `s${pane + 1}`) }],
      }),
    ).toBe(true);
  });

  it("refuses cycles, reused/missing nodes or panes, invalid weights/focus, and duplicate restore tokens", () => {
    const flat = serializePaneLayout(deep(), 0);
    for (const mutate of [
      (tab: typeof flat) => {
        tab.nodes[0] = {
          direction: "row",
          children: [0, 1],
          weights: [0.5, 0.5],
        };
      },
      (tab: typeof flat) => {
        tab.nodes.push({ pane: 0 });
      },
      (tab: typeof flat) => {
        tab.nodes[1] = { pane: 15 };
      },
      (tab: typeof flat) => {
        tab.focused = 16;
      },
      (tab: typeof flat) => {
        tab.nodes[0] = { direction: "row", children: [1, 2], weights: [0, 1] };
      },
    ]) {
      const invalid = structuredClone(flat);
      mutate(invalid);
      expect(() => deserializePaneLayout(invalid)).toThrow(
        "Invalid terminal layout",
      );
    }
    const token = "00000000-0000-0000-0000-000000000001";
    expect(
      isInitialLayout({
        selected: 0,
        fallbacks: 0,
        tabs: [{ ...flat, panes: flat.panes.map(() => token) }],
      }),
    ).toBe(false);
  });
});
