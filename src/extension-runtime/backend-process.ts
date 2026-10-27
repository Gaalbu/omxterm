/** Actual process exit and stream closure are separate retirement facts. */
export type Retirement = {
  settled: boolean;
  processStarted: boolean;
  exitObserved: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  streamsClosed: boolean;
  killRequested: boolean;
  killAccepted: boolean | null;
  cooperative: boolean;
  cleanupFailed: boolean;
};
/** Sole direct-child owner/reaper. Controlled tests model these same events. */
export interface BackendProcess {
  send(message: string): void;
  disconnect(): void;
  kill(): boolean;
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  onSpawn(listener: () => void): void;
  onError(listener: () => void): void;
  onClose(listener: () => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
}
