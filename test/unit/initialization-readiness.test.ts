import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
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
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: vi.fn(actual.mkdtemp),
    readFile: vi.fn(actual.readFile),
  };
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it.for(["fonts", "runtime"] as const)(
  "creates B for %s after actual host registration while A's Surface return is still held",
  { timeout: 30_000 },
  async (boundary) => {
    const f = await initializationReadinessScene(boundary);
    cleanups.push(f.dispose);
    await vi.waitFor(() => expect(f.surfacePort.held).toBe(true));
    expect(f.starts).toBe(1);
    expect(f.selected).toEqual({ sessionId: "s1", tabSessionIds: ["s1"] });
    expect(f.surfacePort.adoptions).toBe(0);
    expect(f.listeners).toBe(1);
    let sent = 0;
    const createB = startCancellationTab(f.renderer, () => {
      sent++;
      f.send({ action: "new" });
    });
    await createB;
    expect(f.surfacePort.adoptions).toBe(0);
    expect(f.surfacePort.held).toBe(true);
    await vi.waitFor(() => expect(f.surfacePort.mounts).toBe(2));
    expect(sent).toBe(1);
    expect(f.listeners).toBe(1);
    expect(f.starts).toBe(2);
  },
);

it("loses an early command despite an arrival observer and never replays it after held registration", async () => {
  const f = await initializationReadinessScene("runtime", true);
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
  f.releaseRegistration();
  await vi.waitFor(() => expect(f.listeners).toBe(2));
  expect(f.surfacePort.adoptions).toBe(0);
  expect(f.surfacePort.mounts).toBe(1); // No queued replay from the preload.
  expect(f.starts).toBe(1);
  f.send({ action: "new" });
  await vi.waitFor(() => expect(f.surfacePort.mounts).toBe(2));
  expect(f.starts).toBe(2);
  remove();
}, 30_000);

it("rejects B creation when the window retires before held actual host registration", async () => {
  const f = await initializationReadinessScene("runtime", true);
  cleanups.push(f.dispose);
  await vi.waitFor(() => expect(f.surfacePort.held).toBe(true));
  const createTab = vi.fn(() => f.send({ action: "new" }));
  const failed = expect(
    startCancellationTab(f.renderer, createTab),
  ).rejects.toThrow("unavailable");
  f.pagehide();
  await failed;
  f.releaseRegistration();
  f.release();
  expect(createTab).not.toHaveBeenCalled();
  expect(f.starts).toBe(1);
  expect(f.listeners).toBe(0);
}, 30_000);

it("removes its owned root before rejecting a failure to load the scene HTML", async () => {
  const failure = new Error("Injected scene HTML read failure");
  let root: string | undefined;
  vi.mocked(readFile).mockImplementationOnce(async () => {
    root = await (vi.mocked(mkdtemp).mock.results.at(-1)!
      .value as Promise<string>);
    // The real recipe has already built the owned fixture at this point.
    await access(path.join(root, "renderer/index.js"));
    throw failure;
  });
  try {
    await expect(initializationReadinessScene()).rejects.toBe(failure);
    expect(root).toBeDefined();
    await expect(access(root!)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    // Also settle the exact root when this regression is run against old code.
    if (root) await rm(root, { recursive: true, force: true });
  }
}, 30_000);
