import type { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { submitPopupCalibrationKey } from "../fixtures/terminal-popup-native-exercise";

const port = vi.hoisted(() => ({
  calls: [] as unknown[][],
  child: undefined as EventEmitter | undefined,
  resolve: undefined as (() => void) | undefined,
  reject: undefined as ((error: Error) => void) | undefined,
}));
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
          port.calls.push(args);
          const child = (port.child = new EventEmitter());
          const operation = new Promise<{ stdout: string; stderr: string }>(
            (resolve, reject) => {
              port.resolve = () => resolve({ stdout: "", stderr: "" });
              port.reject = reject;
            },
          );
          return Object.assign(operation, { child });
        },
      },
    ),
  };
});
afterEach(() => {
  port.calls.length = 0;
  vi.useRealTimers();
});

it("submits a literal bounded calibration command and joins actual close after command success", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let settled = false;
  const run = submitPopupCalibrationKey("F5", controller.signal).then(() => {
    settled = true;
  });
  expect(port.calls).toEqual([
    [
      "/usr/bin/xdotool",
      ["key", "--clearmodifiers", "F5"],
      { timeout: 5_000, maxBuffer: 1024, signal: controller.signal },
    ],
  ]);
  port.resolve!();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  expect(port.child!.listenerCount("close")).toBe(1);
  port.child!.emit("close", 0, null);
  await run;
  expect(settled).toBe(true);
  expect(port.child!.listenerCount("close")).toBe(0);
});

it("does not mistake abort/error notification for actual native-command settlement", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let settled = false;
  const failure = new Error("synthetic aborted command");
  const run = submitPopupCalibrationKey("F6", controller.signal).finally(() => {
    settled = true;
  });
  const rejected = expect(run).rejects.toBe(failure);
  expect(port.calls[0]![1]).toEqual(["key", "--clearmodifiers", "F6"]);
  controller.abort();
  port.reject!(failure);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  port.child!.emit("close", null, "SIGTERM");
  await rejected;
  expect(settled).toBe(true);
  expect(port.child!.listenerCount("close")).toBe(0);
});
