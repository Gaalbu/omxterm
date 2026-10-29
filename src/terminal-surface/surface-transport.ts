import type { PtyCallbacks, PtyTransport } from "restty";
import type { TerminalSize } from "../shared/terminal-contract";
import type { TerminalSessionAdapter } from "./terminal-session-adapter";

// Rendering survives a retained exit; native transport authority does not.
export function surfaceTransport(
  adapter: TerminalSessionAdapter,
  live: () => boolean,
  ready: () => boolean,
  resized: (
    size: TerminalSize,
    meta: Parameters<PtyTransport["resize"]>[2],
  ) => void,
) {
  let callbacks: PtyCallbacks | undefined;
  const writable = () => live() && ready();
  const transport: PtyTransport = {
    connect(options) {
      if (live()) {
        callbacks = options.callbacks;
        callbacks.onConnect?.();
      }
    },
    disconnect() {
      const previous = callbacks;
      callbacks = undefined;
      previous?.onDisconnect?.();
    },
    sendInput(data) {
      if (writable()) adapter.write(data);
      return writable();
    },
    resize(cols, rows, meta) {
      const size = { cols, rows };
      resized(size, meta);
      if (writable()) adapter.resize(size);
      return writable();
    },
    isConnected: () => callbacks !== undefined && live(),
    destroy() {},
  };
  return {
    transport,
    output: (data: string) => {
      if (live()) callbacks?.onData?.(data);
    },
  };
}
