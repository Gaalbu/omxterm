import {
  createLocalTerminalSession,
  type LocalTerminalSessionOptions,
  type SpawnPty,
} from "./local-terminal-session";
import type { TerminalApplication } from "./terminal-application";

interface NativeQuit {
  on(
    event: "before-quit",
    listener: (event: { preventDefault(): void }) => void,
  ): void;
  on(event: "window-all-closed", listener: () => void): void;
  quit(): void;
}

function boundedExtensionCleanup(
  dispose: () => Promise<unknown>,
  unknown?: () => void,
) {
  return new Promise<void>((resolve) => {
    let completed = false;
    const finish = (settled: boolean) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (!settled) unknown?.();
      resolve();
    };
    const timer = setTimeout(() => finish(false), 15_000);
    void Promise.resolve()
      .then(dispose)
      .then(
        (result) => finish(result !== false),
        () => finish(false),
      );
  });
}

export function registerTerminalShutdown(
  native: NativeQuit,
  options: {
    readonly application: () =>
      Pick<TerminalApplication, "isQuitting" | "requestQuit"> | undefined;
    readonly disposeSessions: () => void;
    // Extensions receive bounded cleanup time, never a veto over normal Quit.
    readonly disposeExtensions?: () => Promise<unknown>;
    readonly onExtensionCleanupUnknown?: () => void;
  },
) {
  const pendingExits = new Set<Promise<void>>();
  let draining = false;
  let stopped = false;

  // TerminalApplication owns last-window quit; Electron's default must not
  // bypass the same native completion barrier used by explicit Quit.
  native.on("window-all-closed", () => {});
  native.on("before-quit", (event) => {
    const application = options.application();
    if (!application || stopped) return;
    event.preventDefault();
    if (!application.isQuitting()) {
      void application.requestQuit();
      return;
    }
    if (draining) return;
    // Set the latch before disposal: close can synchronously reenter Quit or
    // report exit. A native close error propagates and cannot become success.
    draining = true;
    options.disposeSessions();
    if (options.disposeExtensions)
      pendingExits.add(
        boundedExtensionCleanup(
          options.disposeExtensions,
          options.onExtensionCleanupUnknown,
        ),
      );
    void Promise.all([...pendingExits]).then(() => {
      stopped = true;
      native.quit();
    });
  });

  return {
    createSession(
      spawn: SpawnPty,
      sessionOptions: LocalTerminalSessionOptions,
    ) {
      if (draining) throw new Error("Terminal application is shutting down");
      let complete!: () => void;
      const exited = new Promise<void>((resolve) => {
        complete = resolve;
      });
      // Register before native subscription/forwarding can synchronously close
      // the last window. Controller disposal never removes this ownership.
      pendingExits.add(exited);
      const finish = () => {
        pendingExits.delete(exited);
        complete();
      };
      try {
        return createLocalTerminalSession(spawn, {
          ...sessionOptions,
          onExit(exit, launchKind) {
            finish();
            sessionOptions.onExit(exit, launchKind);
          },
        });
      } catch (error) {
        finish();
        throw error;
      }
    },
  };
}
