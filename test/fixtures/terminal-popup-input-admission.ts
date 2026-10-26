import type { Event, Input } from "electron";

export const POPUP_INPUT_PROVISIONING_ENV =
  "OMXTERM_TEST_PROVISIONED_NATIVE_INPUT";
export const POPUP_INPUT_RECEIPT_PREFIX = "__OMXTERM_POPUP_INPUT__";
export const POPUP_INPUT_ADMISSION_MS = 5_000;

// An operator declaration is a safety prerequisite, NEVER an admission receipt.
// Xwayland/portal resources cannot be retired by the Electron fixture supervisor.
export function requireProvisionedPopupInput(value: string | undefined) {
  if (value !== "1")
    throw new Error(
      "Native popup input requires a provisioned input-capable desktop; set OMXTERM_TEST_PROVISIONED_NATIVE_INPUT=1 only after provisioning, not to bypass portal consent",
    );
}

export interface PopupInputWindow {
  readonly webContents: {
    isDestroyed(): boolean;
    on(
      event: "before-input-event",
      listener: (
        event: Pick<Event, "preventDefault">,
        input: NativeKey,
      ) => void,
    ): unknown;
    on(event: "destroyed", listener: () => void): unknown;
    removeListener(
      event: "before-input-event",
      listener: (
        event: Pick<Event, "preventDefault">,
        input: NativeKey,
      ) => void,
    ): unknown;
    removeListener(event: "destroyed", listener: () => void): unknown;
  };
  isDestroyed(): boolean;
  isFocused(): boolean;
  on(event: "closed", listener: () => void): unknown;
  removeListener(event: "closed", listener: () => void): unknown;
}
type NativeKey = Pick<
  Input,
  | "type"
  | "key"
  | "code"
  | "isAutoRepeat"
  | "alt"
  | "control"
  | "meta"
  | "shift"
>;
type Failure =
  | "retired"
  | "wrong-window"
  | "wrong-key"
  | "submission-failed"
  | "submission-timeout"
  | "receipt-timeout";

// Fixed F5 warmup + F6 proof. A cold EI fallback may lose the warmup, but only
// the actual owned-window F6 press can admit input. Preventing its down may omit
// its native up; retain suppression until owner retirement, not a guessed drain.
// This is not a menu-map timing proxy.
export function observePopupInput(
  window: PopupInputWindow,
  focused: () => PopupInputWindow | null,
) {
  let retired = false;
  let started = false;
  let admitted = false;
  let phase: "warmup" | "probe" | "receipt" = "warmup";
  let down = false;
  let failure: Error | undefined;
  let controller: AbortController | undefined;
  let resolveReceipt: (() => void) | undefined;
  let rejectReceipt: ((error: Error) => void) | undefined;
  const fail = (reason: Failure) => {
    failure ??= new Error(`Native popup input admission failed: ${reason}`);
    controller?.abort();
    rejectReceipt?.(failure);
    return failure;
  };
  const checkOwner = () => {
    if (retired || window.isDestroyed() || window.webContents.isDestroyed())
      throw fail("retired");
    if (focused() !== window || !window.isFocused()) throw fail("wrong-window");
  };
  const observe = (event: Pick<Event, "preventDefault">, input: NativeKey) => {
    if (retired) return;
    const calibration = ["F5", "F6"].some(
      (key) => input.key === key || input.code === key,
    );
    if ((started && !admitted) || calibration) event.preventDefault();
    if (!started || admitted || failure) return;
    if (
      phase === "warmup" ||
      (input.key === "F5" && input.code === "F5") ||
      input.type !== "keyDown"
    )
      return;
    if (focused() !== window || !window.isFocused()) {
      fail("wrong-window");
      return;
    }
    if (
      input.key !== "F6" ||
      input.code !== "F6" ||
      input.isAutoRepeat ||
      input.alt ||
      input.control ||
      input.meta ||
      input.shift
    ) {
      fail("wrong-key");
      return;
    }
    down = true;
    resolveReceipt?.();
  };
  const dispose = () => {
    if (retired) return;
    retired = true;
    admitted = false;
    fail("retired");
    window.webContents.removeListener("before-input-event", observe);
    window.webContents.removeListener("destroyed", dispose);
    window.removeListener("closed", dispose);
  };
  try {
    window.webContents.on("before-input-event", observe);
    window.webContents.on("destroyed", dispose);
    window.on("closed", dispose);
    if (window.isDestroyed() || window.webContents.isDestroyed()) dispose();
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    isAdmitted: () => admitted,
    dispose,
    async calibrate(
      submit: (key: "F5" | "F6", signal: AbortSignal) => Promise<void>,
    ) {
      if (started)
        throw new Error("Native popup input calibration already started");
      started = true;
      checkOwner();
      controller = new AbortController();
      let submitting = true;
      const receipt = new Promise<void>((resolve, reject) => {
        resolveReceipt = resolve;
        rejectReceipt = reject;
      });
      // The owned native command is joined before observing the receipt/error.
      // A receipt can reject while that command is still retiring.
      void receipt.catch(() => undefined);
      const timer = setTimeout(
        () => fail(submitting ? "submission-timeout" : "receipt-timeout"),
        POPUP_INPUT_ADMISSION_MS,
      );
      try {
        await submit("F5", controller.signal);
        if (failure) throw failure;
        checkOwner();
        phase = "probe";
        await submit("F6", controller.signal);
        if (failure) throw failure;
        submitting = false;
        phase = "receipt";
        await receipt;
        if (failure) throw failure;
        checkOwner();
        admitted = true;
        return {
          warmupSubmitted: true,
          probeSubmitted: true,
          ownedWindow: true,
          keyDown: down,
        };
      } catch {
        throw failure ?? fail("submission-failed");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
