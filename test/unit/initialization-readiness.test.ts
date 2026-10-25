import { afterEach, expect, it, vi } from "vitest";
import { initializationReadinessScene } from "../fixtures/initialization-readiness-headless";
import { startCancellationTab } from "../fixtures/initialization-cancellation-readiness";

vi.mock("esbuild", async (importOriginal) => {
  const actual = await importOriginal<typeof import("esbuild")>();
  return {
    ...actual,
    async build(options: import("esbuild").BuildOptions) {
      const { headlessInitializationSurface } =
        await import("../fixtures/initialization-readiness-headless");
      return actual.build(headlessInitializationSurface(options));
    },
  };
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it.for(["fonts", "runtime"] as const)(
  "creates B for %s only after A's actual host registration, not its started-session receipt",
  { timeout: 30_000 },
  async (boundary) => {
    const f = await initializationReadinessScene(boundary);
    cleanups.push(f.dispose);
    await vi.waitFor(() => expect(f.surfacePort.held).toBe(true));
    expect(f.starts).toBe(1);
    expect(f.selected).toEqual({ sessionId: "s1", tabSessionIds: ["s1"] });
    expect(f.surfacePort.adoptions).toBe(0);
    expect(f.listeners).toBe(0);
    let sent = 0;
    const createB = startCancellationTab(f.renderer, () => {
      sent++;
      f.send({ action: "new" });
    });
    // The old A-ready sequence sends immediately into a real preload with no
    // host listener. Holding mount return makes that interleaving deterministic.
    await Promise.resolve();
    expect(
      sent,
      "B command must remain pending before actual registration",
    ).toBe(0);
    f.release();
    await createB;
    await vi.waitFor(() => expect(f.surfacePort.mounts).toBe(2));
    expect(sent).toBe(1);
    expect(f.listeners).toBe(1);
    expect(f.starts).toBe(2);
  },
);

it("loses an early command despite an arrival observer and never replays it after registration", async () => {
  const f = await initializationReadinessScene();
  cleanups.push(f.dispose);
  await vi.waitFor(() => expect(f.surfacePort.held).toBe(true));
  let arrivals = 0;
  const remove = f.observeArrival(() => arrivals++);
  expect(f.listeners).toBe(1); // Independent observer only.
  f.send({ action: "new" });
  expect(arrivals).toBe(1);
  expect(
    await f.renderer.executeJavaScript(
      "globalThis.__omxtermInitializationHost.isReady()",
    ),
  ).toBe(false);
  expect(f.starts).toBe(1);
  expect(f.surfacePort.mounts).toBe(1);
  f.release();
  await vi.waitFor(() => expect(f.listeners).toBe(2));
  expect(f.surfacePort.adoptions).toBe(1);
  expect(f.surfacePort.mounts).toBe(1); // No queued replay from the preload.
  expect(f.starts).toBe(1);
  f.send({ action: "new" });
  await vi.waitFor(() => expect(f.surfacePort.mounts).toBe(2));
  expect(f.starts).toBe(2);
  remove();
}, 30_000);

it("rejects B creation when the window retires before actual host registration", async () => {
  const f = await initializationReadinessScene();
  cleanups.push(f.dispose);
  await vi.waitFor(() => expect(f.surfacePort.held).toBe(true));
  const createTab = vi.fn(() => f.send({ action: "new" }));
  const failed = expect(
    startCancellationTab(f.renderer, createTab),
  ).rejects.toThrow("unavailable");
  f.pagehide();
  await failed;
  f.release();
  expect(createTab).not.toHaveBeenCalled();
  expect(f.starts).toBe(1);
  expect(f.listeners).toBe(0);
}, 30_000);
