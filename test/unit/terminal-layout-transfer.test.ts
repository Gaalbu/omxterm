import { afterEach, expect, it, vi } from "vitest";
import {
  createLayoutDirectoryResolver,
  createTerminalLayoutTransfer,
  type PreparedLayout,
} from "../../src/main/terminal-layout-transfer";
import type { SavedLayout } from "../../src/shared/terminal-layout";
const saved = (): SavedLayout => ({
  version: 1,
  platform: "linux",
  savedAt: "2026-10-29T00:00:00.000Z",
  omitted: 1,
  selected: 0,
  tabs: [
    {
      root: 0,
      nodes: [
        { direction: "row", children: [1, 2], weights: [0.25, 0.75] },
        { pane: 0 },
        { pane: 1 },
      ],
      focused: 1,
      panes: [
        { kind: "launch-local", path: "/known" },
        { kind: "reported-local", path: "/missing" },
      ],
    },
  ],
});
afterEach(() => vi.useRealTimers());
it("prepares literal cwd and fallback before core transfer without waiting for mounts", async () => {
  let plan!: PreparedLayout;
  const owner = {};
  const create = vi.fn(
    (value: PreparedLayout, _focus: () => boolean, accepted: () => void) => {
      plan = value;
      accepted();
      return new Promise<void>(() => {});
    },
  );
  const transfer = createTerminalLayoutTransfer({
    platform: "linux",
    home: "/home/test",
    alive: () => true,
    resolve: async (directory) => directory === "/known",
    create,
  });
  expect(
    await transfer.open(
      owner,
      saved(),
      () => false,
      async (commit) => commit(),
    ),
  ).toEqual({ ok: true, status: "accepted", fallbacks: 1 });
  expect([...plan.directories.values()]).toEqual(["/known", "/home/test"]);
  expect(plan.initial.tabs[0]!.nodes).toEqual(saved().tabs[0]!.nodes);
  expect(JSON.stringify(plan.initial)).not.toContain("/known");
  transfer.dispose();
  expect(create).toHaveBeenCalledOnce();
});
it("captures before await, refuses concurrent work and final local revocation", async () => {
  let release!: (value: boolean) => void;
  let alive = true;
  const create = vi.fn(async () => {});
  const transfer = createTerminalLayoutTransfer({
    platform: "linux",
    home: "/home/test",
    alive: () => alive,
    resolve: () =>
      new Promise<boolean>((done) => {
        release = done;
      }),
    create,
  });
  const input = saved();
  input.tabs[0]!.panes[1] = { kind: "home" };
  const pending = transfer.open(
    {},
    input,
    () => true,
    async (commit) => {
      alive = false;
      commit();
    },
  );
  input.tabs[0]!.panes[0] = { kind: "home" };
  expect(
    await transfer.open(
      {},
      saved(),
      () => true,
      async (commit) => commit(),
    ),
  ).toMatchObject({ error: "busy" });
  release(true);
  expect(await pending).toMatchObject({ error: "unavailable" });
  expect(create).not.toHaveBeenCalled();
});
it("rejects wrong platform/shape before I/O and reports unknown after transfer", async () => {
  const resolve = vi.fn(async () => true);
  const transfer = createTerminalLayoutTransfer({
    platform: "linux",
    home: "/home/test",
    alive: () => true,
    resolve,
    create: async () => {
      throw new Error("native failure");
    },
  });
  expect(
    await transfer.open(
      {},
      { ...saved(), platform: "win32" },
      () => true,
      async (commit) => commit(),
    ),
  ).toMatchObject({ error: "invalid-layout" });
  expect(resolve).not.toHaveBeenCalled();
  expect(
    await transfer.open(
      {},
      saved(),
      () => true,
      async (commit) => commit(),
    ),
  ).toMatchObject({ error: "outcome-unknown" });
});
it("keeps timed-out I/O slots until underlying settlement", async () => {
  vi.useFakeTimers();
  const releases: ((value: boolean) => void)[] = [];
  const inspect = vi.fn(
    () => new Promise<boolean>((resolve) => releases.push(resolve)),
  );
  const resolve = createLayoutDirectoryResolver(inspect, 10);
  const first = resolve("/a");
  const second = resolve("/b");
  await vi.advanceTimersByTimeAsync(10);
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  expect(await resolve("/c")).toBe(false);
  expect(inspect).toHaveBeenCalledTimes(2);
  releases[0]!(true);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const next = resolve("/d");
  await vi.advanceTimersByTimeAsync(10);
  expect(await next).toBe(false);
  expect(inspect).toHaveBeenCalledTimes(3);
  releases[1]!(true);
  releases[2]!(true);
});
