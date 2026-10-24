// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTabsHarness } from "../fixtures/terminal-tabs-harness";

afterEach(() => vi.restoreAllMocks());

async function splitHarness(size = { cols: 120, rows: 40 }) {
  const harness = createTabsHarness();
  await harness.tabs.ready;
  harness.sessionAdapters[0]!.resize(size);
  return harness;
}

async function split(
  harness: Awaited<ReturnType<typeof splitHarness>>,
  direction: "right" | "down",
) {
  const count = harness.surfaces.length;
  harness.tabs.handleCommand({ action: "split", direction });
  await vi.waitFor(() => expect(harness.surfaces).toHaveLength(count + 1));
  // The new pane's Surface reports its grid like a real one would.
  harness.sessionAdapters.at(-1)!.resize({ cols: 120, rows: 40 });
}

const tab = (harness: ReturnType<typeof createTabsHarness>) =>
  harness.container.querySelector<HTMLElement>(".terminal-tab")!;

describe("Terminal Panes", () => {
  it("splits the focused pane into a sibling started from its session", async () => {
    const harness = await splitHarness();
    await split(harness, "right");

    expect(harness.createAdapter).toHaveBeenLastCalledWith("s1");
    expect(harness.container.children).toHaveLength(1);
    expect(tab(harness).hasAttribute("data-split")).toBe(true);
    const row = tab(harness).querySelector(".terminal-pane-split")!;
    expect(row.getAttribute("data-direction")).toBe("row");
    expect(row.querySelector('[role="separator"]')).not.toBeNull();
    expect(harness.notifySelection).toHaveBeenLastCalledWith("s2", [
      "s1",
      "s2",
    ]);
    expect(tab(harness).querySelectorAll(".pane-focused")).toHaveLength(1);
    expect(harness.surfaces[1]!.focus).toHaveBeenCalled();
    expect(harness.adapters[0]!.close).not.toHaveBeenCalled();
  });

  it.each([
    [{ cols: 40, rows: 40 }, "right"],
    [{ cols: 120, rows: 10 }, "down"],
  ] as const)(
    "refuses a split below the 20 x 5 reference with no session (%o %s)",
    async (size, direction) => {
      const harness = await splitHarness(size);
      harness.tabs.handleCommand({ action: "split", direction });
      await Promise.resolve();
      expect(harness.createAdapter).toHaveBeenCalledOnce();
      expect(tab(harness).hasAttribute("data-split")).toBe(false);
    },
  );

  it("refuses to split a pane whose grid is not known yet", async () => {
    const harness = createTabsHarness();
    await harness.tabs.ready;
    harness.tabs.handleCommand({ action: "split", direction: "right" });
    expect(harness.createAdapter).toHaveBeenCalledOnce();
  });

  it("routes every terminal-directed action to the focused pane only", async () => {
    const harness = await splitHarness();
    await split(harness, "down");
    harness.tabs.handleCommand({ action: "focus-pane", target: "previous" });
    expect(harness.notifySelection).toHaveBeenLastCalledWith("s1", [
      "s1",
      "s2",
    ]);

    harness.tabs.clipboardAction("paste");
    harness.tabs.find();
    harness.tabs.injectText("'/tmp/a b'");
    harness.tabs.injectSnippet("printf hi", { submit: true });
    const [first, second] = harness.surfaces;
    expect(first!.paste).toHaveBeenCalledOnce();
    expect(first!.find).toHaveBeenCalledOnce();
    expect(first!.inject).toHaveBeenCalledTimes(2);
    expect(second!.paste).not.toHaveBeenCalled();
    expect(second!.inject).not.toHaveBeenCalled();

    harness.tabs.zoom("in");
    for (const surface of harness.surfaces)
      expect(surface.zoom).toHaveBeenCalledWith("in");
  });

  it("follows the focused pane's title in the tab strip", async () => {
    const harness = await splitHarness();
    harness.tabs.handleCommand({ action: "new" });
    await vi.waitFor(() => expect(harness.surfaces).toHaveLength(2));
    harness.tabs.handleCommand({ action: "previous" });
    await split(harness, "right");
    harness.tabs.setSessionTitle("s1", "editor");
    harness.tabs.setSessionTitle("s3", "build");
    expect(harness.strip.querySelector("button")!.textContent).toBe("build");
    harness.tabs.handleCommand({ action: "focus-pane", target: "next" });
    expect(harness.strip.querySelector("button")!.textContent).toBe("editor");
  });

  it("removes an exited pane, focuses its sibling and keeps the tab", async () => {
    const harness = await splitHarness();
    await split(harness, "right");
    harness.adapters[1]!.handlers!.onExit({ exitCode: 0, signal: 0 });

    expect(harness.container.children).toHaveLength(1);
    expect(tab(harness).hasAttribute("data-split")).toBe(false);
    expect(harness.notifySelection).toHaveBeenLastCalledWith("s1", ["s1"]);
    expect(harness.surfaces[0]!.dispose).not.toHaveBeenCalled();
  });

  it("never takes focus from panel controls when a focused pane exits", async () => {
    let allowPassive = true;
    const harness = createTabsHarness({
      tabsOptions: { canAutoFocus: () => allowPassive },
    });
    await harness.tabs.ready;
    harness.sessionAdapters[0]!.resize({ cols: 120, rows: 40 });
    harness.tabs.handleCommand({ action: "split", direction: "right" });
    await vi.waitFor(() => expect(harness.surfaces).toHaveLength(2));
    harness.surfaces[0]!.focus.mockClear();
    allowPassive = false;
    harness.adapters[1]!.handlers!.onExit({ exitCode: 0, signal: 0 });
    expect(harness.notifySelection).toHaveBeenLastCalledWith("s1", ["s1"]);
    expect(harness.surfaces[0]!.focus).not.toHaveBeenCalled();
  });

  it("keeps an unexpectedly signalled pane until main orders its removal", async () => {
    const harness = await splitHarness();
    await split(harness, "right");
    harness.adapters[1]!.handlers!.onExit({ exitCode: 0, signal: 9 });
    expect(tab(harness).hasAttribute("data-split")).toBe(true);

    harness.tabs.handleCommand({ action: "close-session", sessionId: "s2" });
    expect(tab(harness).hasAttribute("data-split")).toBe(false);
    expect(harness.surfaces[1]!.dispose).toHaveBeenCalledOnce();
    expect(harness.surfaces[0]!.dispose).not.toHaveBeenCalled();
  });

  it("closes the pane captured before confirmation, not a later focus", async () => {
    const harness = await splitHarness();
    await split(harness, "right");
    harness.tabs.handleCommand({ action: "prepare-close-pane" });
    harness.tabs.handleCommand({ action: "focus-pane", target: "previous" });
    harness.tabs.handleCommand({
      action: "resolve-close-pane",
      confirmed: true,
    });
    expect(harness.surfaces[1]!.dispose).toHaveBeenCalledOnce();
    expect(harness.surfaces[0]!.dispose).not.toHaveBeenCalled();

    harness.tabs.handleCommand({ action: "prepare-close-pane" });
    harness.tabs.handleCommand({
      action: "resolve-close-pane",
      confirmed: false,
    });
    expect(harness.surfaces[0]!.dispose).not.toHaveBeenCalled();
  });

  it("closes the last pane through the last-tab path", async () => {
    const notifyEmpty = vi.fn();
    const harness = createTabsHarness({ tabsOptions: { notifyEmpty } });
    await harness.tabs.ready;
    harness.tabs.handleCommand({ action: "close-pane" });
    expect(harness.surfaces[0]!.dispose).toHaveBeenCalledOnce();
    expect(harness.container.children).toHaveLength(0);
    expect(notifyEmpty).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("closes every pane of a closed tab", async () => {
    const harness = await splitHarness();
    await split(harness, "right");
    await split(harness, "down");
    harness.tabs.handleCommand({ action: "close" });
    for (const surface of harness.surfaces)
      expect(surface.dispose).toHaveBeenCalledOnce();
    expect(harness.container.children).toHaveLength(0);
  });

  it("hides a background tab's pane containers with the tab", async () => {
    const harness = await splitHarness();
    await split(harness, "right");
    harness.tabs.handleCommand({ action: "new" });
    await vi.waitFor(() => expect(harness.surfaces).toHaveLength(3));
    const [first] = [...harness.container.children] as HTMLElement[];
    expect(first!.hidden).toBe(true);
    for (const pane of first!.querySelectorAll<HTMLElement>("main"))
      expect(pane.hidden).toBe(true);
    harness.tabs.handleCommand({ action: "previous" });
    for (const pane of first!.querySelectorAll<HTMLElement>("main"))
      expect(pane.hidden).toBe(false);
  });

  it("equalizes the focused pane's split", async () => {
    const harness = await splitHarness();
    await split(harness, "right");
    await split(harness, "right");
    const shares = () =>
      [
        ...tab(harness).querySelectorAll<HTMLElement>(
          ".terminal-pane-split > main",
        ),
      ].map((element) => Number(element.style.flexGrow));
    expect(shares()).toEqual([0.5, 0.25, 0.25]);
    harness.tabs.handleCommand({ action: "equalize-panes" });
    for (const share of shares()) expect(share).toBeCloseTo(1 / 3);
  });
});
