import { app, type BrowserWindow } from "electron";
import { EventEmitter } from "node:events";
import { writeSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeResttyHostWindow } from "../fixtures/restty-host-window";

vi.mock("node:fs", { spy: true });
vi.mock("electron", () => ({
  app: { isActive: vi.fn(), focus: vi.fn() },
  BrowserWindow: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const originalFocusPredicate =
  "document.activeElement?.closest('.restty-terminal-surface') !== null";

function fixture({
  platform = "darwin",
  appActive = false,
  activate = true,
  restoreTerminal = true,
  ready = true,
} = {}) {
  vi.stubGlobal("process", { ...process, platform });
  const events: string[] = [];
  vi.mocked(app.isActive).mockImplementation(() => {
    events.push("app-is-active");
    return appActive;
  });
  vi.mocked(app.focus).mockImplementation(() => {
    events.push("app-focus");
    appActive = true;
  });
  let nativeFocused = false;
  let terminalFocused = false;
  let sessionReady = ready;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const nativeEvents = new EventEmitter();
  const window = {
    once: nativeEvents.once.bind(nativeEvents),
    removeListener: nativeEvents.removeListener.bind(nativeEvents),
    loadFile: vi.fn(async () => {
      events.push("load");
    }),
    showInactive: vi.fn(() => {
      events.push("show-inactive");
    }),
    focus: vi.fn(() => {
      events.push("native-focus");
      nativeFocused = activate && (platform !== "darwin" || appActive);
      // Model the production page-focus owner, not a fixture DOM focus call.
      terminalFocused = nativeFocused && restoreTerminal;
      if (nativeFocused) nativeEvents.emit("focus");
    }),
    isFocused: vi.fn(() => nativeFocused),
    webContents: {
      executeJavaScript: vi.fn(async (script: string) => {
        events.push("observe-dom-focus");
        expect(script).toBe(originalFocusPredicate);
        return terminalFocused;
      }),
    },
  };
  const initialize = () =>
    initializeResttyHostWindow(
      window as unknown as BrowserWindow,
      "/fixture",
      () => sessionReady,
      async (predicate, label) => {
        events.push(label);
        if (label === "default Restty session" && !sessionReady) await gate;
        if (!(await predicate())) throw new Error(`Not ready: ${label}`);
      },
    );
  return {
    window,
    nativeEvents,
    events,
    initialize,
    finishSession() {
      sessionReady = true;
      release();
    },
  };
}

it.each([
  ["darwin", false, true],
  ["darwin", true, false],
  ["linux", false, false],
  ["win32", false, false],
] as const)(
  "%s (app active: %s) activates only as needed after readiness and preserves focus oracles",
  async (platform, appActive, shouldActivate) => {
    const f = fixture({ platform, appActive, ready: false });
    const initialization = f.initialize();
    await vi.waitFor(() =>
      expect(f.events).toContain("default Restty session"),
    );
    expect(app.isActive).not.toHaveBeenCalled();
    expect(app.focus).not.toHaveBeenCalled();
    expect(f.window.focus).not.toHaveBeenCalled();
    expect(f.window.webContents.executeJavaScript).not.toHaveBeenCalled();
    f.finishSession();
    await initialization;
    expect(f.window.loadFile).toHaveBeenCalledExactlyOnceWith(
      path.join("/fixture", "renderer", "index.html"),
    );
    expect(f.events).toEqual([
      "load",
      "show-inactive",
      "default Restty session",
      ...(platform === "darwin" ? ["app-is-active"] : []),
      ...(shouldActivate ? ["app-focus"] : []),
      "native-focus",
      "native host window activation",
      "initial terminal focus",
      "observe-dom-focus",
    ]);
    expect(app.isActive).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
    if (shouldActivate) {
      expect(app.focus).toHaveBeenCalledExactlyOnceWith({ steal: true });
    } else {
      expect(app.focus).not.toHaveBeenCalled();
    }
    expect(f.window.focus).toHaveBeenCalledOnce();
    expect(f.window.isFocused).toHaveReturnedWith(true);
    expect(
      f.window.webContents.executeJavaScript,
    ).toHaveBeenCalledExactlyOnceWith(originalFocusPredicate, true);
  },
);

it("reports missing native activation before attempting the DOM focus assertion", async () => {
  const f = fixture({ activate: false });
  await expect(f.initialize()).rejects.toThrow(
    "Not ready: native host window activation",
  );
  expect(app.focus).toHaveBeenCalledExactlyOnceWith({ steal: true });
  expect(f.window.webContents.executeJavaScript).not.toHaveBeenCalled();
  expect(f.nativeEvents.listenerCount("focus")).toBe(0);
});

it("still rejects missing terminal DOM focus after successful native activation", async () => {
  const f = fixture({ restoreTerminal: false });
  await expect(f.initialize()).rejects.toThrow(
    "Not ready: initial terminal focus",
  );
  expect(f.window.isFocused).toHaveReturnedWith(true);
  expect(
    f.window.webContents.executeJavaScript,
  ).toHaveBeenCalledExactlyOnceWith(originalFocusPredicate, true);
});

it("emits actual host phase boundaries and the observed focus event without adding a renderer probe", async () => {
  const lines: string[] = [];
  vi.mocked(writeSync).mockImplementation((_fd, value) => {
    lines.push(String(value));
    return 0;
  });
  const f = fixture({ platform: "linux" });
  await f.initialize();
  const phases = lines.map((line) => {
    const receipt = JSON.parse(
      line.slice("__OMXTERM_RESTTY_HOST_PHASE__".length),
    ) as { phase: string; status: string; at: number; monotonicMs: number };
    expect(Number.isFinite(receipt.at)).toBe(true);
    expect(Number.isFinite(receipt.monotonicMs)).toBe(true);
    return [receipt.phase, receipt.status];
  });
  expect(phases).toEqual([
    ["window-load", "begin"],
    ["window-load", "complete"],
    ["first-session", "begin"],
    ["first-session", "complete"],
    ["native-focus-request", "begin"],
    ["native-focus-event", "complete"],
    ["native-focus-request", "complete"],
    ["native-focus", "begin"],
    ["native-focus", "complete"],
    ["dom-focus", "begin"],
    ["dom-focus-query", "begin"],
    ["dom-focus-query", "complete"],
    ["dom-focus", "complete"],
  ]);
  expect(f.window.focus).toHaveBeenCalledOnce();
  expect(
    f.window.webContents.executeJavaScript,
  ).toHaveBeenCalledExactlyOnceWith(originalFocusPredicate, true);
  expect(f.nativeEvents.listenerCount("focus")).toBe(0);
});

it("distinguishes a false existing DOM query response from a stalled renderer query", async () => {
  const lines: string[] = [];
  vi.mocked(writeSync).mockImplementation((_fd, value) => {
    lines.push(String(value));
    return 0;
  });
  const f = fixture({ restoreTerminal: false });
  await expect(f.initialize()).rejects.toThrow(
    "Not ready: initial terminal focus",
  );
  const records = lines.map(
    (line) =>
      JSON.parse(line.slice("__OMXTERM_RESTTY_HOST_PHASE__".length)) as {
        phase: string;
        status: string;
      },
  );
  expect(records).toContainEqual(
    expect.objectContaining({ phase: "dom-focus-query", status: "complete" }),
  );
  expect(records).not.toContainEqual(
    expect.objectContaining({ phase: "dom-focus", status: "complete" }),
  );
  expect(f.window.webContents.executeJavaScript).toHaveBeenCalledOnce();
  expect(f.nativeEvents.listenerCount("focus")).toBe(0);
});

it("keeps the original operation and failure authoritative when the diagnostic sink throws", async () => {
  vi.mocked(writeSync).mockImplementation(() => {
    throw new Error("sink unavailable");
  });
  const healthy = fixture({ platform: "linux" });
  await expect(healthy.initialize()).resolves.toBeUndefined();
  const blocked = fixture({ platform: "linux", activate: false });
  await expect(blocked.initialize()).rejects.toThrow(
    "Not ready: native host window activation",
  );
  expect(healthy.window.focus).toHaveBeenCalledOnce();
  expect(blocked.window.focus).toHaveBeenCalledOnce();
  expect(app.focus).not.toHaveBeenCalled();
});

it("does not activate a window when renderer loading fails", async () => {
  const f = fixture();
  f.window.loadFile.mockRejectedValueOnce(new Error("load failed"));
  await expect(f.initialize()).rejects.toThrow("load failed");
  expect(f.window.showInactive).not.toHaveBeenCalled();
  expect(app.isActive).not.toHaveBeenCalled();
  expect(app.focus).not.toHaveBeenCalled();
  expect(f.window.focus).not.toHaveBeenCalled();
});
