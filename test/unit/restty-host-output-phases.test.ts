import type { BrowserWindow } from "electron";
import { writeSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalTerminalSession } from "../../src/main/local-terminal-session";
import { terminalIpc } from "../../src/shared/terminal-ipc";
import type {
  IpcListener,
  IpcMainPort,
} from "../../src/main/terminal-ipc-types";
import { createOutputStressHarness } from "../fixtures/restty-host-output-stress";
import { outputCheckpointProducer } from "../fixtures/restty-output-checkpoint";
import { prepareOutputRefit } from "../fixtures/restty-output-refit";

vi.mock("node:fs", { spy: true });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("records each actual source/ACK/copy checkpoint without replacing the output oracle", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  vi.mocked(writeSync).mockImplementation((_fd, value) => {
    lines.push(String(value));
    return 0;
  });
  const harness = createOutputStressHarness({ sessionIndex: 0 });
  let acknowledge!: IpcListener;
  const port = harness.ipcPort({
    on(_channel, listener) {
      acknowledge = listener;
    },
  } as IpcMainPort);
  port.on(terminalIpc.outputAck, () => {});
  let sourceBytes = 0,
    transcript = "";
  let input!: (data: Buffer) => void;
  runInNewContext(outputCheckpointProducer(16), {
    process: {
      stdin: {
        isTTY: false,
        on(_event: string, listener: typeof input) {
          input = listener;
        },
        resume() {},
      },
      stdout: {
        write(text: string, done?: () => void) {
          sourceBytes += Buffer.byteLength(text);
          transcript += text;
          harness.observeOutput(0, text);
          acknowledge({} as never, { sessionId: "s1", end: sourceBytes });
          done?.();
          return true;
        },
      },
      exit(code: number) {
        harness.observeExit(0, { exitCode: code, signal: 0 });
      },
    },
  });
  const sizes = [{ cols: 80, rows: 24 }];
  const window = {
    getBounds: () => ({ width: 900, height: 600, x: 0, y: 0 }),
    setBounds() {
      sizes.push({ cols: 82, rows: 24 });
    },
    webContents: {
      async executeJavaScript(script: string) {
        if (script.includes("scrollbackLines")) return 10000;
        if (script.includes("usedJSHeapSize")) return 123;
        return undefined; // Adapt the existing renderer stall, not its ordering.
      },
      send(_channel: string, action: string) {
        if (action === "copy") harness.observeClipboard(transcript);
      },
    },
  };
  const terminal = {
    write(text: string) {
      input(Buffer.from(text));
    },
    outputFlowMetrics: () => ({
      pendingBytes: 0,
      pauseCount: 1,
      resumeCount: 1,
      maxPendingBytes: 65536,
      largestNativeReadBytes: 65536,
    }),
  };
  const exercise = harness.exercise({
    window: window as unknown as BrowserWindow,
    terminals: [terminal as unknown as LocalTerminalSession],
    resizes: [sizes],
    launchKinds: ["explicit-command"],
    existingSession: true,
    async waitFor(predicate, label) {
      if (!(await predicate())) throw new Error(`Not ready: ${label}`);
    },
  });
  void exercise.catch(() => {});
  await vi.advanceTimersByTimeAsync(500);
  const result = await exercise;
  expect(result.destination.checkpoints).toHaveLength(16);
  expect(result.destination.records).toBe(65536);
  const records = lines.map(
    (line) =>
      JSON.parse(line.slice("__OMXTERM_RESTTY_HOST_PHASE__".length)) as {
        phase: string;
        status: string;
        checkpoint?: number;
      },
  );
  expect(
    records
      .filter((r) => r.phase.startsWith("checkpoint-"))
      .map((r) => [r.phase, r.status, r.checkpoint]),
  ).toEqual(
    Array.from({ length: 16 }, (_, checkpoint) => [
      ["checkpoint-source", "begin", checkpoint],
      ["checkpoint-source", "complete", checkpoint],
      ["checkpoint-ack", "begin", checkpoint],
      ["checkpoint-ack", "complete", checkpoint],
      ["checkpoint-copy", "begin", checkpoint],
      ["checkpoint-copy", "complete", checkpoint],
    ]).flat(),
  );
  expect(records.at(-1)).toMatchObject({
    phase: "output-producer-exit",
    status: "complete",
  });
  expect(lines.every((line) => line.length < 256)).toBe(true);
});

it("records calibration, exact-prefix acknowledgement and actual native-grid refit in order", async () => {
  const lines: string[] = [];
  vi.mocked(writeSync).mockImplementation((_fd, value) => {
    lines.push(String(value));
    return 0;
  });
  const sizes = [{ cols: 80, rows: 24 }];
  let maxWidth = "";
  const surface = {
    getBoundingClientRect: () => ({ width: 800 }),
    style: {
      get maxWidth() {
        return maxWidth;
      },
      set maxWidth(value: string) {
        maxWidth = value;
        sizes.push({ cols: value ? 60 : 80, rows: 24 });
      },
    },
  };
  const window = {
    webContents: {
      async executeJavaScript(script: string) {
        return runInNewContext(script, {
          document: { querySelector: () => surface },
        }) as unknown;
      },
    },
  };
  let sourceBytes = 53;
  const refit = await prepareOutputRefit({
    window: window as unknown as BrowserWindow,
    sizes,
    readProgress: () => ({
      sourceBytes,
      cumulativeAck: sourceBytes,
      pendingBytes: 0,
    }),
    async waitFor(predicate, label) {
      if (!(await predicate())) throw new Error(`Not ready: ${label}`);
    },
  });
  sourceBytes += refit.prefixUnits;
  const acknowledgement = await refit.refit();
  await refit.restore();
  expect(acknowledgement).toMatchObject({
    baselineBytes: 53,
    sourceBytes,
    cumulativeAck: sourceBytes,
    pendingBytes: 0,
  });
  expect(sizes.at(-1)).toEqual({ cols: 80, rows: 24 });
  const records = lines
    .filter((line) => line.startsWith("__OMXTERM_RESTTY_HOST_PHASE__"))
    .map(
      (line) =>
        JSON.parse(line.slice("__OMXTERM_RESTTY_HOST_PHASE__".length)) as {
          phase: string;
          status: string;
        },
    );
  expect(records.map((r) => [r.phase, r.status])).toEqual([
    ["refit-layout", "begin"],
    ["refit-layout", "complete"],
    ["refit-calibration", "begin"],
    ["refit-calibration", "complete"],
    ["refit-restoration", "begin"],
    ["refit-restoration", "complete"],
    ["refit-baseline-ack", "begin"],
    ["refit-baseline-ack", "complete"],
    ["refit-prefix-ack", "begin"],
    ["refit-prefix-ack", "complete"],
    ["refit-native-grid", "begin"],
    ["refit-native-grid", "complete"],
  ]);
});
