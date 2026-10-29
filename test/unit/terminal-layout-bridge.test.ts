import { describe, expect, it, vi } from "vitest";
import { createTerminalLayoutBridge } from "../../src/preload/terminal-layout-bridge";
import {
  layoutIpc,
  type InitialLayout,
} from "../../src/shared/terminal-layout";
import { isTerminalSessionStart } from "../../src/shared/terminal-panes";
const token = "00000000-0000-0000-0000-000000000001";
const plan: InitialLayout = {
  selected: 0,
  fallbacks: 0,
  tabs: [{ root: 0, nodes: [{ pane: 0 }], panes: [token], focused: 0 }],
};
function fixture() {
  let listener!: (event: unknown, value: unknown) => void;
  const ipc = {
    invoke: vi.fn(async (): Promise<unknown> => plan),
    send: vi.fn(),
    on: vi.fn((_channel: string, callback: typeof listener) => {
      listener = callback;
    }),
    removeListener: vi.fn(),
  };
  return {
    ipc,
    bridge: createTerminalLayoutBridge(ipc),
    emit: (id: unknown) => listener({}, id),
  };
}

describe("layout preload bridge", () => {
  it("validates one-shot initial responses and exact cancellation tokens", async () => {
    const f = fixture();
    expect(await f.bridge.initial()).toEqual(plan);
    expect(f.ipc.invoke).toHaveBeenCalledWith(layoutIpc.initial);
    f.ipc.invoke.mockResolvedValueOnce(null);
    expect(await f.bridge.initial()).toBeNull();
    f.ipc.invoke.mockResolvedValueOnce({ ...plan, tabs: [] });
    await expect(f.bridge.initial()).rejects.toThrow("Invalid initial");
    expect(() => f.bridge.cancel("-".repeat(36))).toThrow();
    f.bridge.cancel(token);
    expect(f.ipc.send).toHaveBeenCalledExactlyOnceWith(layoutIpc.cancel, token);
  });
  it("correlates capture replies, refuses invalid IDs and replies null for unavailable captures", () => {
    const f = fixture();
    const captured = {
      selected: 0,
      omitted: 1,
      tabs: [{ ...plan.tabs[0]!, panes: [null] }],
    };
    const capture = vi.fn(() => captured);
    const remove = f.bridge.onCapture(capture);
    f.emit("not-a-token");
    expect(capture).not.toHaveBeenCalled();
    f.emit(token);
    expect(f.ipc.send).toHaveBeenLastCalledWith(layoutIpc.captured, {
      id: token,
      layout: captured,
    });
    capture.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    f.emit(token);
    expect(f.ipc.send).toHaveBeenLastCalledWith(layoutIpc.captured, {
      id: token,
      layout: null,
    });
    remove();
    expect(f.ipc.removeListener).toHaveBeenCalledWith(
      layoutIpc.capture,
      expect.any(Function),
    );
  });
  it("validates restored session intent separately from SSH or directory inheritance", () => {
    const valid = (value: unknown) =>
      isTerminalSessionStart(value, (id) => id === "surface");
    expect(valid({ restoreToken: token, surfaceId: "surface" })).toBe(true);
    for (const extra of [
      { launchToken: token },
      { workingDirectoryOf: "s1" },
      { cwd: "/synthetic" },
    ])
      expect(valid({ restoreToken: token, ...extra })).toBe(false);
    expect(valid({ restoreToken: "-".repeat(36) })).toBe(false);
  });
});
