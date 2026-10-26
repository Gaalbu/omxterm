import type { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { submitPopupCalibrationKey } from "../fixtures/terminal-popup-native-exercise";

interface Command {
  readonly args: unknown[];
  readonly child: EventEmitter;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}
const port = vi.hoisted(() => ({ commands: [] as Command[] }));
vi.mock("electron", () => ({
  BrowserWindow: {},
  clipboard: {},
  nativeImage: {},
  screen: {},
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(
      () => {
        throw new Error("Only promisified execution is expected");
      },
      {
        [promisify.custom]: (...args: unknown[]) => {
          const child = new EventEmitter();
          let resolve!: () => void;
          let reject!: (error: Error) => void;
          const operation = new Promise<{ stdout: string; stderr: string }>(
            (done, fail) => {
              resolve = () => done({ stdout: "", stderr: "" });
              reject = fail;
            },
          );
          port.commands.push({ args, child, resolve, reject });
          return Object.assign(operation, { child });
        },
      },
    ),
  };
});
afterEach(() => {
  port.commands.length = 0;
  vi.useRealTimers();
});

it.each([
  ["F5", "71"],
  ["F6", "72"],
] as const)(
  "submits numeric modifier-free %s, then releases only its key after actual command/stream close",
  async (key, code) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let settled = false;
    const run = submitPopupCalibrationKey(key, controller.signal).then(() => {
      settled = true;
    });
    const submission = port.commands[0]!;
    expect(submission.args).toEqual([
      "/usr/bin/xdotool",
      ["key", code],
      { timeout: 5_000, maxBuffer: 1024, signal: controller.signal },
    ]);
    submission.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(port.commands).toHaveLength(1);
    expect(submission.child.listenerCount("close")).toBe(1);
    submission.child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(submission.child.listenerCount("close")).toBe(0);
    expect(port.commands).toHaveLength(2);
    const cleanup = port.commands[1]!;
    expect(cleanup.args).toEqual([
      "/usr/bin/xdotool",
      ["keyup", code],
      { timeout: 5_000, maxBuffer: 1024 },
    ]);
    cleanup.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    cleanup.child.emit("close", 0, null);
    await run;
    expect(settled).toBe(true);
    expect(cleanup.child.listenerCount("close")).toBe(0);
    expect(port.commands).toHaveLength(2);
  },
);

it.each(["success", "error", "abort"] as const)(
  "joins both command outcomes as well as stream closure when close arrives first (%s)",
  async (outcome) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const failure = new Error("synthetic command failure");
    let settled = false;
    const result = submitPopupCalibrationKey("F6", controller.signal)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    const submission = port.commands[0]!;
    submission.child.emit("exit", outcome === "success" ? 0 : 1, null);
    submission.child.emit("close", outcome === "success" ? 0 : 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(port.commands).toHaveLength(1);
    expect(settled).toBe(false);
    if (outcome === "abort") controller.abort();
    if (outcome === "success") submission.resolve();
    else submission.reject(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(port.commands).toHaveLength(2);
    const cleanup = port.commands[1]!;
    expect(cleanup.args).toEqual([
      "/usr/bin/xdotool",
      ["keyup", "72"],
      { timeout: 5_000, maxBuffer: 1024 },
    ]);
    cleanup.child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    cleanup.resolve();
    expect(await result).toBe(outcome === "success" ? undefined : failure);
    expect(settled).toBe(true);
    expect(port.commands).toHaveLength(2);
    expect(submission.child.listenerCount("close")).toBe(0);
    expect(cleanup.child.listenerCount("close")).toBe(0);
  },
);

it("does not inject or release any key for an already-aborted signal", async () => {
  const controller = new AbortController();
  const reason = new Error("synthetic pre-abort");
  controller.abort(reason);
  const result = submitPopupCalibrationKey("F5", controller.signal).catch(
    (error: unknown) => error,
  );
  expect(port.commands).toHaveLength(0);
  expect(await result).toBe(reason);
});

it.each([false, true])(
  "reports cleanup failure after joining its streams, preserving an earlier submission error (%s)",
  async (submissionFailed) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const primary = new Error("synthetic command failure");
    const release = new Error("synthetic keyup timeout");
    let settled = false;
    const result = submitPopupCalibrationKey("F5", controller.signal).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    const submission = port.commands[0]!;
    if (submissionFailed) submission.reject(primary);
    else submission.resolve();
    submission.child.emit("exit", submissionFailed ? 1 : 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(port.commands).toHaveLength(1);
    expect(settled).toBe(false);
    submission.child.emit("close", submissionFailed ? 1 : 0, null);
    await vi.advanceTimersByTimeAsync(0);
    const cleanup = port.commands[1]!;
    expect(cleanup.args).toEqual([
      "/usr/bin/xdotool",
      ["keyup", "71"],
      { timeout: 5_000, maxBuffer: 1024 },
    ]);
    cleanup.reject(release);
    cleanup.child.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    cleanup.child.emit("close", null, "SIGTERM");
    const error = await result;
    if (submissionFailed) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([primary, release]);
      expect((error as AggregateError).cause).toBe(primary);
    } else {
      expect(error).toBe(release);
    }
    expect(settled).toBe(true);
    expect(port.commands).toHaveLength(2);
    expect(submission.child.listenerCount("close")).toBe(0);
    expect(cleanup.child.listenerCount("close")).toBe(0);
  },
);

it("does not mistake abort/error notification for actual native-command settlement", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let settled = false;
  const failure = new Error("synthetic aborted command");
  const run = submitPopupCalibrationKey("F6", controller.signal).finally(() => {
    settled = true;
  });
  const rejected = expect(run).rejects.toBe(failure);
  const submission = port.commands[0]!;
  expect(submission.args[1]).toEqual(["key", "72"]);
  controller.abort();
  submission.reject(failure);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  submission.child.emit("close", null, "SIGTERM");
  await vi.advanceTimersByTimeAsync(0);
  const cleanup = port.commands[1]!;
  expect(cleanup.args).toEqual([
    "/usr/bin/xdotool",
    ["keyup", "72"],
    { timeout: 5_000, maxBuffer: 1024 },
  ]);
  expect(settled).toBe(false);
  cleanup.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  cleanup.child.emit("close", 0, null);
  await rejected;
  expect(cleanup.child.listenerCount("close")).toBe(0);
  expect(port.commands).toHaveLength(2);
  expect(settled).toBe(true);
  expect(submission.child.listenerCount("close")).toBe(0);
});
