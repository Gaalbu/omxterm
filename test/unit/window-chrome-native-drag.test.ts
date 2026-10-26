import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { exerciseWindowsHandleDrag } from "../fixtures/window-chrome-native-drag";

const native = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (
        file: string,
        args: string[],
        options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => { pid: number }
    >(),
  dipToScreenPoint: vi.fn((point: { x: number; y: number }) => ({
    x: point.x * 2.5,
    y: point.y * 2.5,
  })),
}));
vi.mock("node:child_process", () => ({ execFile: native.execFile }));
vi.mock("electron", () => ({ screen: native }));
vi.mock("../fixtures/native-fixture-ownership", () => ({
  spawnFixtureProcess: (start: () => unknown) => start(),
}));

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

function windowDouble() {
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(1234n);
  return {
    focus: vi.fn(),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    getNativeWindowHandle: vi.fn(() => handle),
    getContentBounds: () => ({ x: 40, y: 40, width: 960, height: 640 }),
    getBounds: vi
      .fn()
      .mockReturnValueOnce({ x: 40, y: 40, width: 960, height: 640 })
      .mockReturnValue({ x: 59, y: 58, width: 961, height: 640 }),
  };
}

let receipt: string;
let failure: Error | null;
beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  vi.clearAllMocks();
  receipt = JSON.stringify(geometry());
  failure = null;
  native.execFile.mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(failure, receipt));
    return { pid: 123 };
  });
});
afterEach(() => vi.unstubAllGlobals());

it("uses physical evidence, not enclosing DIP size, with the original real drag", async () => {
  const window = windowDouble();
  const useCursor = vi.fn();
  await expect(
    exerciseWindowsHandleDrag(window as unknown as BrowserWindow, useCursor),
  ).resolves.toBe("verified");
  expect(useCursor).toHaveBeenCalledOnce();
  expect(window.focus).toHaveBeenCalledOnce();
  expect(native.execFile).toHaveBeenCalledOnce();
  const [file, args, options] = native.execFile.mock.calls[0]!;
  expect(file).toBe("powershell.exe");
  expect(options).toEqual({ timeout: 15_000, windowsHide: true });
  const script = Buffer.from(args[2]!, "base64").toString("utf16le");
  // Composition guards only; Win32 execution still requires native qualification.
  expect(script).toContain("Owned window is not foreground");
  expect(script).toContain("Owned window is not under pointer");
  const beforeRead = script.indexOf("$beforeGeometry = [Pointer]::Snapshot");
  const buttonDown = script.indexOf("[Pointer]::mouse_event(2");
  expect(beforeRead).toBeGreaterThan(
    script.indexOf("Owned window is not under pointer"),
  );
  expect(buttonDown).toBeGreaterThan(beforeRead);
  expect(script.indexOf("Owned window is not foreground")).toBeLessThan(
    buttonDown,
  );
  expect(script).toContain("SetCursorPos(1300 + $i * 5, 120 + $i * 5)");
  expect(script).toContain("finally {");
  expect(script).toContain("if ($down) { [Pointer]::mouse_event(4");
  expect(script).toContain("SetCursorPos($original.X, $original.Y)");
  expect(
    script.indexOf("$afterGeometry = [Pointer]::Snapshot"),
  ).toBeGreaterThan(script.indexOf("SetCursorPos($original.X, $original.Y)"));
});

it("wires the exact physical-size guard into the drag caller", async () => {
  const evidence = geometry();
  evidence.after.client.width += 1;
  receipt = JSON.stringify(evidence);
  await expect(
    exerciseWindowsHandleDrag(
      windowDouble() as unknown as BrowserWindow,
      vi.fn(),
    ),
  ).rejects.toThrow("physical client width");
});

it.each([
  "Owned window is not foreground",
  "Owned window is not under pointer",
  "GetWindowRect failed",
])("propagates native helper failure without retry: %s", async (message) => {
  failure = new Error(message);
  await expect(
    exerciseWindowsHandleDrag(
      windowDouble() as unknown as BrowserWindow,
      vi.fn(),
    ),
  ).rejects.toThrow(message);
  expect(native.execFile).toHaveBeenCalledOnce();
});

it.each(["isFullScreen", "isMaximized", "isMinimized"] as const)(
  "rejects an Electron %s transition even with unchanged native geometry",
  async (state) => {
    const window = windowDouble();
    window[state].mockReturnValueOnce(false).mockReturnValue(true);
    await expect(
      exerciseWindowsHandleDrag(window as unknown as BrowserWindow, vi.fn()),
    ).rejects.toThrow("restored window");
  },
);

it.each(["isFullScreen", "isMaximized", "isMinimized"] as const)(
  "rejects an initially nonrestored %s window before native input",
  async (state) => {
    const window = windowDouble();
    window[state].mockReturnValue(true);
    await expect(
      exerciseWindowsHandleDrag(window as unknown as BrowserWindow, vi.fn()),
    ).rejects.toThrow("restored window");
    expect(native.execFile).not.toHaveBeenCalled();
  },
);

it("rejects a changed BrowserWindow native handle", async () => {
  const window = windowDouble();
  window.getNativeWindowHandle
    .mockReturnValueOnce(window.getNativeWindowHandle())
    .mockReturnValue(Buffer.alloc(8));
  await expect(
    exerciseWindowsHandleDrag(window as unknown as BrowserWindow, vi.fn()),
  ).rejects.toThrow();
});

it("retains the independent DIP movement check", async () => {
  const window = windowDouble();
  window.getBounds
    .mockReset()
    .mockReturnValue({ x: 40, y: 40, width: 960, height: 640 });
  await expect(
    exerciseWindowsHandleDrag(window as unknown as BrowserWindow, vi.fn()),
  ).rejects.toThrow("moves the same window");
});

it("does not launch native input on other platforms", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  await expect(
    exerciseWindowsHandleDrag(
      windowDouble() as unknown as BrowserWindow,
      vi.fn(),
    ),
  ).resolves.toBe("not-exercised");
  expect(native.execFile).not.toHaveBeenCalled();
});
