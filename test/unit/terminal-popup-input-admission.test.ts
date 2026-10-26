import { EventEmitter } from "node:events";
import type { Input } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import {
  observePopupInput,
  POPUP_INPUT_ADMISSION_MS,
  requireProvisionedPopupInput,
} from "../fixtures/terminal-popup-input-admission";
import { exerciseTerminalPopup } from "../fixtures/terminal-popup-native-exercise";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
function key(type: "keyDown" | "keyUp", overrides: Partial<Input> = {}): Input {
  return {
    type,
    key: "F6",
    code: "F6",
    isAutoRepeat: false,
    isComposing: false,
    location: 0,
    modifiers: [],
    alt: false,
    control: false,
    meta: false,
    shift: false,
    ...overrides,
  };
}
function target() {
  let focused = true;
  let destroyed = false;
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
  });
  const window = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => destroyed,
    isFocused: () => focused,
  });
  return {
    window,
    focus: (value: boolean) => {
      focused = value;
    },
    destroy() {
      destroyed = true;
      window.emit("closed");
    },
    event(input: Input) {
      const event = { preventDefault: vi.fn() };
      webContents.emit("before-input-event", event, input);
      return event;
    },
  };
}
function fixture() {
  const t = target();
  const input = observePopupInput(t.window, () =>
    t.window.isFocused() ? t.window : null,
  );
  disposers.push(input.dispose);
  return { ...t, input };
}

const native = vi.hoisted(() => ({ focused: undefined as unknown }));
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => native.focused },
  clipboard: { writeText() {} },
  nativeImage: {},
  screen: {},
}));

it("requires explicit provisioning without treating that declaration or event arrival as admission", async () => {
  expect(() => requireProvisionedPopupInput(undefined)).toThrow(
    "provisioned input-capable desktop",
  );
  expect(() => requireProvisionedPopupInput("true")).toThrow(
    "provisioned input-capable desktop",
  );
  requireProvisionedPopupInput("1");
  const t = fixture();
  expect(t.input.isAdmitted()).toBe(false);
  t.event(key("keyDown"));
  t.event(key("keyUp"));
  expect(t.input.isAdmitted()).toBe(false);
  t.input.dispose();
  const submit = vi.fn(async () => {});
  await expect(t.input.calibrate(submit)).rejects.toThrow("retired");
  expect(submit).not.toHaveBeenCalled();
});

it("admits only the owned native F6 press after F5 warmup and F6 proof, even when warmup and prevented-key release are absent", async () => {
  const t = fixture();
  const submit = vi.fn(async (value: "F5" | "F6") => {
    expect(t.input.isAdmitted()).toBe(false);
    if (value === "F6") {
      expect(t.event(key("keyDown")).preventDefault).toHaveBeenCalledOnce();
    }
  });
  await expect(t.input.calibrate(submit)).resolves.toEqual({
    warmupSubmitted: true,
    probeSubmitted: true,
    ownedWindow: true,
    keyDown: true,
  });
  expect(submit.mock.calls.map(([value]) => value)).toEqual(["F5", "F6"]);
  expect(t.input.isAdmitted()).toBe(true);
  expect(
    t.event(key("keyUp", { key: "F5", code: "F5" })).preventDefault,
  ).toHaveBeenCalledOnce();
  expect(t.event(key("keyUp")).preventDefault).toHaveBeenCalledOnce();
  expect(
    t.event(key("keyDown", { key: "Home", code: "Home" })).preventDefault,
  ).not.toHaveBeenCalled();
  await expect(t.input.calibrate(submit)).rejects.toThrow("already started");
  expect(submit).toHaveBeenCalledTimes(2);
  t.destroy();
  expect(t.input.isAdmitted()).toBe(false);
  expect(t.window.webContents.listenerCount("before-input-event")).toBe(0);
});

it("does not admit xdotool success without a real receipt or retry the missing proof", async () => {
  vi.useFakeTimers();
  const t = fixture();
  t.event(key("keyDown"));
  const submit = vi.fn(async (value: "F5" | "F6") => {
    if (value === "F5") t.event(key("keyDown"));
  });
  const run = t.input.calibrate(submit);
  const rejected = expect(run).rejects.toThrow("receipt-timeout");
  await vi.advanceTimersByTimeAsync(0);
  expect(submit).toHaveBeenCalledTimes(2);
  expect(t.input.isAdmitted()).toBe(false);
  await vi.advanceTimersByTimeAsync(POPUP_INPUT_ADMISSION_MS);
  await rejected;
  expect(submit).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  // Late calibration remains suppressed until the native owner retires.
  expect(t.event(key("keyDown")).preventDefault).toHaveBeenCalledOnce();
  expect(t.input.isAdmitted()).toBe(false);
});

it("does not accept another window's input or a target event while another window owns focus", async () => {
  vi.useFakeTimers();
  const t = fixture();
  const peer = target();
  const run = t.input.calibrate(async (value) => {
    if (value === "F6") {
      peer.event(key("keyDown"));
      peer.event(key("keyUp"));
    }
  });
  const rejected = expect(run).rejects.toThrow("receipt-timeout");
  await vi.advanceTimersByTimeAsync(POPUP_INPUT_ADMISSION_MS);
  await rejected;
  expect(t.input.isAdmitted()).toBe(false);
  const other = fixture();
  await expect(
    other.input.calibrate(async (value) => {
      if (value === "F6") {
        other.focus(false);
        other.event(key("keyDown"));
      }
    }),
  ).rejects.toThrow("wrong-window");
  expect(other.input.isAdmitted()).toBe(false);
});

it("refuses injection before submission when focused-window identity is not its live owner", async () => {
  const t = target();
  const peer = target();
  const input = observePopupInput(t.window, () => peer.window);
  disposers.push(input.dispose);
  const submit = vi.fn(async () => {});
  await expect(input.calibrate(submit)).rejects.toThrow("wrong-window");
  expect(submit).not.toHaveBeenCalled();
  expect(input.isAdmitted()).toBe(false);
});

it.each([
  { key: "F7", code: "F7" },
  { key: "F6", code: "Unidentified" },
  { isAutoRepeat: true },
  { control: true },
])(
  "rejects wrong key identity/modifiers rather than recording input payload (%j)",
  async (overrides) => {
    const t = fixture();
    await expect(
      t.input.calibrate(async (value) => {
        if (value === "F6")
          expect(
            t.event(key("keyDown", overrides)).preventDefault,
          ).toHaveBeenCalledOnce();
      }),
    ).rejects.toThrow("wrong-key");
    expect(t.input.isAdmitted()).toBe(false);
  },
);

it("does not mistake a native release for the required proof press", async () => {
  vi.useFakeTimers();
  const t = fixture();
  const run = t.input.calibrate(async (value) => {
    if (value === "F6") t.event(key("keyUp"));
  });
  const rejected = expect(run).rejects.toThrow("receipt-timeout");
  await vi.advanceTimersByTimeAsync(POPUP_INPUT_ADMISSION_MS);
  await rejected;
  expect(t.input.isAdmitted()).toBe(false);
});

it.each(["F5", "F6"] as const)(
  "distinguishes failed %s submission from receipt and omits native error detail",
  async (failed) => {
    const t = fixture();
    const submit = vi.fn(async (value: "F5" | "F6") => {
      if (value === failed) throw new Error("synthetic-private-native-detail");
    });
    await expect(t.input.calibrate(submit)).rejects.toThrow(
      /^Native popup input admission failed: submission-failed$/u,
    );
    expect(submit).toHaveBeenCalledTimes(failed === "F5" ? 1 : 2);
    expect(t.input.isAdmitted()).toBe(false);
  },
);

it("joins an aborted command before returning its bounded submission failure", async () => {
  vi.useFakeTimers();
  const t = fixture();
  let aborted = false;
  let close!: () => void;
  let settled = false;
  const run = t.input.calibrate(
    (_value, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            close = () => reject(new Error("closed"));
          },
          { once: true },
        );
      }),
  );
  const observed = run.finally(() => {
    settled = true;
  });
  const rejected = expect(observed).rejects.toThrow("submission-timeout");
  await vi.advanceTimersByTimeAsync(POPUP_INPUT_ADMISSION_MS);
  expect(aborted).toBe(true);
  expect(settled).toBe(false);
  close();
  await rejected;
  expect(t.input.isAdmitted()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["closed", "destroyed"] as const)(
  "retires on native %s and clears every owned listener/timer",
  async (event) => {
    vi.useFakeTimers();
    const t = fixture();
    const run = t.input.calibrate(async () => {});
    const rejected = expect(run).rejects.toThrow("retired");
    await vi.advanceTimersByTimeAsync(0);
    if (event === "closed") t.window.emit(event);
    else t.window.webContents.emit(event);
    await rejected;
    expect(t.input.isAdmitted()).toBe(false);
    expect(t.window.listenerCount("closed")).toBe(0);
    expect(t.window.webContents.listenerCount("destroyed")).toBe(0);
    expect(t.window.webContents.listenerCount("before-input-event")).toBe(0);
    expect(t.event(key("keyDown")).preventDefault).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    t.input.dispose();
  },
);

it("removes partial observation when native listener setup fails", () => {
  const t = target();
  const on = t.window.webContents.on.bind(t.window.webContents);
  vi.spyOn(t.window.webContents, "on").mockImplementation((name, listener) => {
    if (name === "destroyed")
      throw new Error("synthetic listener setup failure");
    return on(name, listener);
  });
  expect(() => observePopupInput(t.window, () => t.window)).toThrow(
    "synthetic listener setup failure",
  );
  expect(t.window.webContents.listenerCount("before-input-event")).toBe(0);
  expect(t.window.webContents.listenerCount("destroyed")).toBe(0);
  expect(t.window.listenerCount("closed")).toBe(0);
});

it("does not open the native popup when input submission has no admitted receipt", async () => {
  vi.useFakeTimers();
  let popupAttempts = 0;
  const t = fixture();
  const window = Object.assign(t.window, {
    id: 1,
    focus() {
      native.focused = window;
    },
  });
  Object.assign(window.webContents, {
    async executeJavaScript(script: string) {
      if (script.includes("contextmenu")) {
        popupAttempts += 1;
        throw new Error("Popup reached without native input admission");
      }
      if (script.includes(".length")) return 2;
      return undefined;
    },
  });
  const submit = vi.fn(async () => {});
  const admitNativeInput = vi.fn(async () => {
    await t.input.calibrate(submit);
  });
  const options = {
    window,
    windows: [window],
    application: { splitSelectedPane() {} },
    children: [0, 1].map(() => ({
      terminal: { hasForegroundChildProcess: () => true },
      observation: { ready: () => true, input: () => "" },
    })),
    popups: [],
    configuration: () => ({ keybinds: {} }),
    capture: false,
    admitNativeInput,
  } as unknown as Parameters<typeof exerciseTerminalPopup>[0];

  const failure = exerciseTerminalPopup(options).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(0);
  const beforeDeadline = {
    submissions: submit.mock.calls.length,
    admitted: t.input.isAdmitted(),
    popupAttempts,
  };
  await vi.advanceTimersByTimeAsync(POPUP_INPUT_ADMISSION_MS);
  const reason = await failure;
  expect(reason).toBeInstanceOf(Error);
  expect(reason instanceof Error ? reason.message : undefined).toContain(
    "receipt-timeout",
  );
  expect(beforeDeadline).toEqual({
    submissions: 2,
    admitted: false,
    popupAttempts: 0,
  });
  expect(admitNativeInput).toHaveBeenCalledOnce();
  expect(popupAttempts).toBe(0);
});
