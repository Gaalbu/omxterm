// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  mountRestorationPage,
  type RestorationBridge,
} from "../../extensions/restoration/page";
import { stateDocument } from "../../extensions/restoration/document";
import { savedLayout } from "../fixtures/restoration-layout";
const revision = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.useRealTimers();
});
type Request = {
  operation: string;
  expectedRevision?: string;
  value?: unknown;
  layout?: unknown;
};
async function setup(
  initial: unknown = stateDocument(revision(1), savedLayout()),
) {
  let visibility!: (visible: boolean) => void;
  let current = initial;
  let intercept: ((value: Request) => Promise<unknown> | undefined) | undefined;
  const captured = savedLayout();
  captured.savedAt = "2026-07-02T10:00:00.000Z";
  const request = vi.fn<RestorationBridge["request"]>(async (input) => {
    const value = input as Request;
    const result = intercept?.(value);
    if (result) return result;
    if (value.operation === "host.capabilities")
      return {
        capabilities: ["terminal.captureLayout.v1", "terminal.openLayout.v1"],
      };
    if (value.operation === "read") return current;
    if (value.operation === "terminal.captureLayout.v1") return captured;
    if (value.operation === "replace")
      return stateDocument(revision(2), value.value);
    return { ok: true, status: "accepted", fallbacks: 1 };
  });
  const page = mountRestorationPage(document, {
    request,
    onVisibility(listener) {
      visibility = listener;
      listener(true);
      return vi.fn();
    },
  });
  dispose = page.dispose;
  await page.ready;
  const button = (name: string) =>
    document.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;
  const calls = (operation: string) =>
    request.mock.calls
      .map(([value]) => value as Request)
      .filter((value) => value.operation === operation);
  return {
    request,
    captured,
    page,
    button,
    calls,
    visibility,
    read(value: unknown) {
      current = value;
    },
    intercept(handler: NonNullable<typeof intercept>) {
      intercept = handler;
    },
  };
}
function key(button: HTMLElement, type: "keydown" | "keyup", repeat = false) {
  button.dispatchEvent(
    new KeyboardEvent(type, {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      repeat,
    }),
  );
}
it("loads only metadata, never auto-restores, and does not require state.v1 in host capabilities", async () => {
  const f = await setup();
  expect(
    f.request.mock.calls.map(([value]) => (value as Request).operation),
  ).toEqual(["host.capabilities", "read"]);
  expect(f.button("open").disabled).toBe(false);
  expect(document.body.textContent).toContain("1 terminal tabs · 3 panes");
  expect(document.body.textContent).toContain(
    "1 reported, 1 launch-only, 1 Home",
  );
  expect(document.body.textContent).toContain("1 graphical tabs omitted");
  expect(document.body.textContent).not.toContain("/synthetic/reported");
  expect(document.body.textContent).toContain("retained");
  expect(document.body.textContent).toContain("state-*.tmp");
});
it("captures live source state, then replaces only against the displayed revision", async () => {
  const f = await setup();
  f.button("save").click();
  f.button("save").click();
  expect(f.calls("terminal.captureLayout.v1")).toHaveLength(1);
  await vi.waitFor(() => expect(f.calls("replace")).toHaveLength(1));
  expect(f.calls("replace")[0]).toEqual({
    operation: "replace",
    expectedRevision: revision(1),
    value: f.captured,
  });
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Window layout saved"),
  );
  f.button("forget").click();
  await vi.waitFor(() => expect(f.calls("replace")).toHaveLength(2));
  expect(f.calls("replace")[1]).toEqual({
    operation: "replace",
    expectedRevision: revision(2),
    value: null,
  });
});
it("requires explicit Refresh after a conflict and preserves the observed revision until then", async () => {
  const f = await setup();
  f.intercept((value) =>
    value.operation === "replace"
      ? Promise.resolve({ ok: false, error: "conflict" })
      : undefined,
  );
  f.button("save").click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Its newer data was preserved"),
  );
  expect(f.button("save").disabled).toBe(true);
  expect(f.button("forget").disabled).toBe(true);
  f.button("save").click();
  expect(f.calls("replace")).toHaveLength(1);
  f.read(stateDocument(revision(3), savedLayout()));
  f.button("refresh").click();
  await vi.waitFor(() => expect(f.button("save").disabled).toBe(false));
  f.button("save").click();
  await vi.waitFor(() => expect(f.calls("replace")).toHaveLength(2));
  expect(f.calls("replace")[1]!.expectedRevision).toBe(revision(3));
});
it("reports a lost write receipt as unknown and never automatically resubmits", async () => {
  const f = await setup();
  f.intercept((value) =>
    value.operation === "replace"
      ? Promise.reject(new Error("transport"))
      : undefined,
  );
  f.button("forget").click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("may already have committed"),
  );
  expect(f.calls("replace")).toHaveLength(1);
  expect(f.button("forget").disabled).toBe(true);
  expect(f.calls("read")).toHaveLength(1);
});
it("permits explicit recovery of invalid schema but never blindly overwrites unreadable state", async () => {
  const f = await setup(stateDocument(revision(1), { unrelated: true }));
  expect(f.button("open").disabled).toBe(true);
  expect(f.button("save").textContent).toBe("Replace saved layout");
  expect(f.button("save").disabled).toBe(false);
  expect(f.button("forget").disabled).toBe(false);
  f.read({ ok: false, error: "invalid-state" });
  f.button("refresh").click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("external correction"),
  );
  expect(f.button("save").disabled).toBe(true);
  expect(f.button("forget").disabled).toBe(true);
});
it.each(["hide", "dispose"])(
  "does not write a captured layout after source %s",
  async (reason) => {
    const f = await setup();
    let finish!: (value: unknown) => void;
    f.intercept((value) =>
      value.operation === "terminal.captureLayout.v1"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : undefined,
    );
    f.button("save").click();
    expect(f.button("refresh").disabled).toBe(true);
    if (reason === "hide") f.visibility(false);
    else f.page.dispose();
    finish(f.captured);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.calls("replace")).toHaveLength(0);
  },
);
it("opens exactly the loaded snapshot after Enter release, never on keydown or repeat", async () => {
  const loaded = savedLayout();
  const f = await setup(stateDocument(revision(1), loaded));
  const open = f.button("open");
  key(open, "keydown");
  key(open, "keydown", true);
  expect(f.calls("terminal.openLayout.v1")).toHaveLength(0);
  loaded.savedAt = "2026-07-03T00:00:00.000Z";
  key(open, "keyup");
  open.click();
  expect(f.calls("terminal.openLayout.v1")).toEqual([
    { operation: "terminal.openLayout.v1", layout: savedLayout() },
  ]);
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("New window accepted"),
  );
  expect(f.calls("terminal.captureLayout.v1")).toHaveLength(0);
});
it.each(["blur", "button-blur", "hide", "lost-release", "refresh"])(
  "cancels held Open on %s",
  async (reason) => {
    const f = await setup();
    vi.useFakeTimers();
    const open = f.button("open");
    key(open, "keydown");
    if (reason === "blur") window.dispatchEvent(new Event("blur"));
    if (reason === "button-blur") open.dispatchEvent(new Event("blur"));
    if (reason === "hide") f.visibility(false);
    if (reason === "lost-release") vi.advanceTimersByTime(30_000);
    if (reason === "refresh") f.button("refresh").click();
    key(open, "keyup");
    expect(f.calls("terminal.openLayout.v1")).toHaveLength(0);
  },
);
it("dispatches pointer Open immediately and treats malformed/lost acceptance as unknown", async () => {
  const f = await setup();
  f.intercept((value) =>
    value.operation === "terminal.openLayout.v1"
      ? Promise.resolve({})
      : undefined,
  );
  f.button("open").click();
  expect(f.calls("terminal.openLayout.v1")).toHaveLength(1);
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("may already have opened"),
  );
  expect(f.button("open").disabled).toBe(true);
});
