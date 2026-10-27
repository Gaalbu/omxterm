import { randomUUID } from "node:crypto";
import type {
  InstalledPackages,
  OpenVersion,
  VersionSelection,
} from "../installed-packages/installed-packages.js";
import {
  boundedValue,
  decode,
  encode,
  exact,
  PENDING_LIMIT,
  RuntimeError,
  type Bootstrap,
  type Message,
  type Value,
} from "./protocol.js";

export type Retirement = {
  settled: boolean;
  processStarted: boolean;
  exitObserved: boolean;
  exitCode: number | null;
  killRequested: boolean;
  killAccepted: boolean | null;
  cooperative: boolean;
  cleanupFailed: boolean;
};
/** The sole controlled-process seam; production is Electron utilityProcess. */
export interface BackendProcess {
  send(message: string): void;
  close(): void;
  kill(): boolean;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: () => void): void;
  onExit(listener: (code: number) => void): void;
}
export type RuntimeOptions = {
  packages: Pick<InstalledPackages, "openVersion">;
  bootstrap: Omit<Bootstrap, "selection">;
  spawn(): BackendProcess;
  owner: AbortSignal;
};
export type Backend = {
  readonly epoch: string;
  readonly selection: VersionSelection;
  call(value: Value, signal?: AbortSignal): Promise<Value>;
  retire(): Promise<Retirement>;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function within<T>(
  promise: Promise<T>,
  milliseconds: number,
  fallback: () => T,
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), milliseconds);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
type Pending = {
  resolve(value: Value): void;
  reject(reason: unknown): void;
  cleanup(): void;
  cancelled: boolean;
};

class Activation {
  readonly epoch = randomUUID();
  readonly ready = deferred<Backend>();
  readonly ended = deferred<Retirement>();
  private phase:
    "starting" | "pinning" | "checking" | "importing" | "active" | "stopping" =
    "starting";
  private child?: BackendProcess;
  private guard?: OpenVersion;
  private guardRelease?: Promise<void>;
  private sequence = 0;
  private received = 0;
  private request = 0;
  private pending = new Map<number, Pending>();
  private admissions = new Set<Promise<unknown>>();
  private stopPromise?: Promise<Retirement>;
  private activationTimer: ReturnType<typeof setTimeout>;
  private exitCode: number | null = null;
  private exitObserved = false;
  private killRequested = false;
  private killAccepted: boolean | null = null;
  private deactivated = false;
  private cleanupFailed = false;
  private selection?: VersionSelection;
  private startSettled = deferred<void>();
  private startupFinished = false;
  private guardSettled = false;

  constructor(
    readonly id: string,
    private readonly options: RuntimeOptions,
    private readonly finished: () => void,
  ) {
    // Observe rejection immediately even if the caller delays attaching a handler.
    void this.ready.promise.catch(() => {});
    this.activationTimer = setTimeout(() => {
      this.fail("activation-failed");
    }, 10_000);
    void this.start().finally(() => {
      this.startupFinished = true;
      this.startSettled.resolve();
      if (!this.child) {
        this.ended.resolve(this.result());
        if (!this.cleanupFailed) this.finished();
      }
    });
  }
  private async start(): Promise<void> {
    try {
      this.guard = await this.options.packages.openVersion(this.id);
      this.selection = {
        id: this.guard.id,
        generation: this.guard.generation,
        digest: this.guard.digest,
      };
      if (this.phase === "stopping") {
        await this.releaseGuard();
        return;
      }
      this.child = this.options.spawn();
      this.child.onExit((code) => {
        void this.exited(code);
      });
      this.child.onClose(() => {
        if (!this.exitObserved) this.fail("outcome-unknown");
      });
      this.child.onMessage((raw) => {
        void this.message(raw).catch(() => this.fail("protocol"));
      });
      this.phase = "pinning";
      this.send("initialize", {
        bootstrap: { ...this.options.bootstrap, selection: this.selection },
      });
    } catch {
      this.fail("activation-failed");
      if (!this.child) await this.releaseGuard();
    }
  }
  private send(kind: string, fields: Record<string, unknown> = {}): void {
    if (!this.child || !Number.isSafeInteger(++this.sequence))
      throw new RuntimeError("protocol");
    this.child.send(
      encode({ epoch: this.epoch, sequence: this.sequence, kind, ...fields }),
    );
  }
  private async releaseGuard(): Promise<void> {
    this.guardRelease ??= (async () => {
      try {
        await this.guard?.release();
      } catch {
        this.cleanupFailed = true;
      }
      this.guardSettled = true;
    })();
    await this.guardRelease;
  }
  private async message(raw: unknown): Promise<void> {
    const message = decode(raw);
    if (message.epoch !== this.epoch || message.sequence !== this.received + 1)
      throw new RuntimeError("protocol");
    this.received = message.sequence;
    if (this.phase === "stopping") {
      if (message.kind === "deactivated" && exact(message, []))
        this.deactivated = true;
      return;
    }
    if (
      message.kind === "pinned" &&
      this.phase === "pinning" &&
      exact(message, [])
    ) {
      this.phase = "checking";
      const valid = await this.guard!.revalidate();
      // This short store check linearizes admission. A later disable cannot undo
      // already admitted trusted code; subsequent calls must revalidate again.
      if (this.phase !== "checking" || this.options.owner.aborted || !valid) {
        this.fail("unavailable");
        await this.releaseGuard();
        return;
      }
      this.phase = "importing";
      this.send("admit");
      await this.releaseGuard();
      if (this.cleanupFailed) this.fail("outcome-unknown");
      return;
    }
    if (
      message.kind === "active" &&
      this.phase === "importing" &&
      exact(message, [])
    ) {
      await this.releaseGuard();
      if (this.phase !== "importing" || this.cleanupFailed) {
        this.fail("outcome-unknown");
        return;
      }
      this.phase = "active";
      clearTimeout(this.activationTimer);
      this.ready.resolve({
        epoch: this.epoch,
        selection: { ...this.selection! },
        call: (value, signal) => this.call(value, signal),
        retire: () => this.stop(),
      });
      return;
    }
    if (message.kind === "failed" && exact(message, [])) {
      this.fail("activation-failed");
      return;
    }
    if (
      message.kind === "result" &&
      this.phase === "active" &&
      exact(message, ["request", "ok", "value"])
    ) {
      this.response(message);
      return;
    }
    throw new RuntimeError("protocol");
  }
  private response(message: Message): void {
    if (
      !Number.isSafeInteger(message.request) ||
      typeof message.ok !== "boolean" ||
      !boundedValue(message.value)
    )
      throw new RuntimeError("protocol");
    const pending = this.pending.get(message.request as number);
    if (!pending) throw new RuntimeError("protocol");
    this.pending.delete(message.request as number);
    pending.cleanup();
    if (!pending.cancelled) {
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new RuntimeError("outcome-unknown"));
    }
  }
  private call(value: Value, signal?: AbortSignal): Promise<Value> {
    if (!boundedValue(value))
      return Promise.reject(new RuntimeError("protocol"));
    if (this.phase !== "active" || this.options.owner.aborted)
      return Promise.reject(new RuntimeError("unavailable"));
    if (signal?.aborted) return Promise.reject(new RuntimeError("cancelled"));
    if (this.pending.size + this.admissions.size >= PENDING_LIMIT)
      return Promise.reject(new RuntimeError("busy"));
    const admission = (async () => {
      const pin = await this.options.packages.openVersion(
        this.id,
        this.selection,
      );
      await pin.release();
    })();
    this.admissions.add(admission);
    return admission.then(
      () => {
        this.admissions.delete(admission);
        if (this.phase !== "active" || this.options.owner.aborted)
          throw new RuntimeError("unavailable");
        if (signal?.aborted) throw new RuntimeError("cancelled");
        return this.dispatch(value, signal);
      },
      () => {
        this.admissions.delete(admission);
        this.fail("unavailable");
        throw new RuntimeError("unavailable");
      },
    );
  }
  private dispatch(value: Value, signal?: AbortSignal): Promise<Value> {
    const request = ++this.request;
    if (!Number.isSafeInteger(request))
      return Promise.reject(new RuntimeError("protocol"));
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(request);
        if (!pending || pending.cancelled) return;
        pending.cancelled = true;
        reject(new RuntimeError("outcome-unknown"));
        try {
          this.send("cancel", { request });
        } catch {
          this.fail("outcome-unknown");
        }
      };
      const timer = setTimeout(() => this.fail("outcome-unknown"), 10_000);
      this.pending.set(request, {
        resolve,
        reject,
        cancelled: false,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
        },
      });
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        this.send("call", { request, value });
      } catch {
        this.fail("outcome-unknown");
      }
    });
  }
  private fail(code: ConstructorParameters<typeof RuntimeError>[0]): void {
    this.ready.reject(new RuntimeError(code));
    void this.stop();
  }
  stop(): Promise<Retirement> {
    if (this.stopPromise) return this.stopPromise;
    this.phase = "stopping";
    clearTimeout(this.activationTimer);
    this.ready.reject(new RuntimeError("unavailable"));
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new RuntimeError("outcome-unknown"));
    }
    this.pending.clear();
    try {
      if (this.child && !this.exitObserved) this.send("stop");
    } catch {
      /* Joining actual exit is still required. */
    }
    this.stopPromise = this.retire();
    return this.stopPromise;
  }
  private async retire(): Promise<Retirement> {
    await within(this.startSettled.promise, 2000, () => undefined);
    if (!this.child) {
      // An unfinished store acquisition is not settled cancellation.
      if (!this.guard) return this.result();
      await this.releaseGuard();
      this.finished();
      return this.result();
    }
    const cooperative = await within(this.ended.promise, 2000, () => null);
    if (cooperative) return cooperative;
    if (!this.exitObserved) {
      this.killRequested = true;
      try {
        this.killAccepted = this.child.kill();
      } catch {
        this.killAccepted = false;
      }
    }
    const result = await within(this.ended.promise, 5000, () => this.result());
    this.child.close();
    return result;
  }
  private async exited(code: number): Promise<void> {
    this.exitObserved = true;
    this.exitCode = code;
    this.phase = "stopping";
    clearTimeout(this.activationTimer);
    this.ready.reject(new RuntimeError("activation-failed"));
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new RuntimeError("outcome-unknown"));
    }
    this.pending.clear();
    this.child?.close();
    await this.releaseGuard();
    await Promise.allSettled(this.admissions);
    this.ended.resolve(this.result());
    if (!this.cleanupFailed) this.finished();
  }
  private result(): Retirement {
    return {
      settled:
        (this.exitObserved || (this.startupFinished && !this.child)) &&
        (this.guardSettled || !this.guard) &&
        this.admissions.size === 0 &&
        !this.cleanupFailed,
      processStarted: !!this.child,
      exitObserved: this.exitObserved,
      exitCode: this.exitCode,
      killRequested: this.killRequested,
      killAccepted: this.killAccepted,
      cooperative: this.exitObserved && this.deactivated && !this.killRequested,
      cleanupFailed: this.cleanupFailed,
    };
  }
}

/** Application-owned authority. Construction never launches a backend. */
export class ExtensionRuntime {
  private readonly activations = new Map<string, Activation>();
  private disposed = false;
  private readonly onAbort = () => {
    void this.dispose();
  };
  constructor(private readonly options: RuntimeOptions) {
    options.owner.addEventListener("abort", this.onAbort, { once: true });
    if (options.owner.aborted) this.disposed = true;
  }
  activate(id: string): Promise<Backend> {
    if (this.disposed || this.options.owner.aborted)
      return Promise.reject(new RuntimeError("unavailable"));
    const existing = this.activations.get(id);
    if (existing) return existing.ready.promise;
    if (this.activations.size >= 32)
      return Promise.reject(new RuntimeError("busy"));
    const activation = new Activation(id, this.options, () => {
      if (this.activations.get(id) === activation) this.activations.delete(id);
    });
    this.activations.set(id, activation);
    return activation.ready.promise;
  }
  retire(id: string): Promise<Retirement | null> {
    return this.activations.get(id)?.stop() ?? Promise.resolve(null);
  }
  async dispose(): Promise<Retirement[]> {
    this.disposed = true;
    this.options.owner.removeEventListener("abort", this.onAbort);
    return Promise.all(
      [...this.activations.values()].map((activation) => activation.stop()),
    );
  }
}
