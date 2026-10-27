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
import type { BackendProcess, Retirement } from "./backend-process.js";
export type { BackendProcess, Retirement } from "./backend-process.js";
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
  let resolve!: (value: T | PromiseLike<T>) => void;
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
  private readonly ended = deferred<Retirement>();
  private readonly exit = deferred<void>();
  private readonly startSettled = deferred<void>();
  private phase:
    "starting" | "pinning" | "checking" | "importing" | "active" | "stopping" =
    "starting";
  private child?: BackendProcess;
  private guard?: OpenVersion;
  private guardRelease?: Promise<void>;
  private selection?: VersionSelection;
  private sequence = 0;
  private received = 0;
  private request = 0;
  private pending = new Map<number, Pending>();
  private admissions = new Map<Promise<void>, () => void>();
  private stopPromise?: Promise<Retirement>;
  private activationTimer: ReturnType<typeof setTimeout>;
  private startupFinished = false;
  private guardSettled = false;
  private spawned = false;
  private spawnFailed = false;
  private exitObserved = false;
  private streamsClosed = false;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private killRequested = false;
  private killAccepted: boolean | null = null;
  private deactivated = false;
  private cleanupFailed = false;
  constructor(
    readonly id: string,
    private readonly options: RuntimeOptions,
    private readonly finished: () => void,
  ) {
    void this.ready.promise.catch(() => {});
    this.activationTimer = setTimeout(
      () => this.fail("activation-failed"),
      10_000,
    );
    void this.start().finally(() => {
      this.startupFinished = true;
      this.startSettled.resolve();
      this.maybeFinish();
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
      this.child.onSpawn(() => {
        this.spawned = true;
      });
      this.child.onExit((code, signal) => {
        void this.exited(code, signal);
      });
      this.child.onDisconnect(() => {
        if (!this.exitObserved) this.fail("outcome-unknown");
      });
      this.child.onError(() => {
        if (!this.spawned) this.spawnFailed = true;
        this.fail("activation-failed");
      });
      this.child.onClose(() => {
        this.streamsClosed = true;
        if (this.spawnFailed) {
          this.exit.resolve(); // Settled non-spawn is distinct from observed exit.
          void this.releaseGuard().then(() => this.maybeFinish());
        } else this.maybeFinish();
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
      await this.admitImport();
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
  private async admitImport(): Promise<void> {
    this.phase = "checking";
    const valid = await this.guard!.revalidate();
    // Admission linearizes at this short writer-protected read. A later disable
    // cannot retroactively revoke already admitted ordinary trusted code.
    if (this.phase !== "checking" || this.options.owner.aborted || !valid) {
      this.fail("unavailable");
      await this.releaseGuard();
      return;
    }
    this.phase = "importing";
    this.send("admit");
    await this.releaseGuard();
    if (this.cleanupFailed) this.fail("outcome-unknown");
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
  reuse(): Promise<Backend> {
    if (this.phase === "stopping")
      return Promise.reject(new RuntimeError("unavailable"));
    if (this.phase !== "active") return this.ready.promise;
    return this.admit(() => this.ready.promise);
  }
  private call(value: Value, signal?: AbortSignal): Promise<Value> {
    if (!boundedValue(value))
      return Promise.reject(new RuntimeError("protocol"));
    // Capture before async admission: caller mutation cannot retarget an operation.
    const captured = JSON.parse(JSON.stringify(value)) as Value;
    return this.admit(() => this.dispatch(captured, signal), signal);
  }
  private admit<T>(
    operation: () => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.phase !== "active" || this.options.owner.aborted)
      return Promise.reject(new RuntimeError("unavailable"));
    if (signal?.aborted) return Promise.reject(new RuntimeError("cancelled"));
    if (this.pending.size + this.admissions.size >= PENDING_LIMIT)
      return Promise.reject(new RuntimeError("busy"));
    const result = deferred<T>();
    let cancelled = false;
    const cancel = (code: "unavailable" | "cancelled") => {
      cancelled = true;
      result.reject(new RuntimeError(code));
    };
    const abort = () => cancel("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => this.fail("outcome-unknown"), 10_000);
    const work = (async () => {
      const pin = await this.options.packages.openVersion(
        this.id,
        this.selection,
      );
      try {
        await pin.release();
      } catch {
        this.cleanupFailed = true;
        throw new RuntimeError("outcome-unknown");
      }
    })();
    this.admissions.set(work, () => cancel("unavailable"));
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.admissions.delete(work);
      this.maybeFinish();
    };
    void work.then(
      () => {
        done();
        if (cancelled) return;
        if (this.phase !== "active" || this.options.owner.aborted) {
          cancel("unavailable");
          return;
        }
        try {
          result.resolve(operation());
        } catch {
          result.reject(new RuntimeError("outcome-unknown"));
        }
      },
      () => {
        done();
        this.fail(this.cleanupFailed ? "outcome-unknown" : "unavailable");
        result.reject(
          new RuntimeError(
            this.cleanupFailed ? "outcome-unknown" : "unavailable",
          ),
        );
      },
    );
    return result.promise;
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
  private revoke(): void {
    this.phase = "stopping";
    clearTimeout(this.activationTimer);
    for (const cancel of this.admissions.values()) cancel();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new RuntimeError("outcome-unknown"));
    }
    this.pending.clear();
  }
  stop(): Promise<Retirement> {
    if (this.stopPromise) return this.stopPromise;
    this.revoke();
    this.ready.reject(new RuntimeError("unavailable"));
    try {
      if (this.child && !this.exitObserved && !this.spawnFailed)
        this.send("stop");
    } catch {
      /* Still join actual lifetime. */
    }
    this.stopPromise = this.retire();
    return this.stopPromise;
  }
  private async retire(): Promise<Retirement> {
    await within(this.startSettled.promise, 2000, () => undefined);
    if (!this.child) return this.result(); // Pending acquisition remains unknown.
    await within(this.exit.promise, 2000, () => undefined);
    if (!this.exitObserved && !this.spawnFailed) {
      this.killRequested = true;
      try {
        this.killAccepted = this.child.kill();
      } catch {
        this.killAccepted = false;
      }
      await within(this.exit.promise, 5000, () => undefined);
    }
    const result = await within(this.ended.promise, 2000, () => this.result());
    this.child.disconnect();
    return result;
  }
  private async exited(
    code: number | null,
    signal: string | null,
  ): Promise<void> {
    this.spawned = true;
    this.exitObserved = true;
    this.exitCode = code;
    this.exitSignal = signal;
    this.exit.resolve(); // Cancels any pending grace/escalation wait immediately.
    this.revoke();
    this.ready.reject(new RuntimeError("activation-failed"));
    await this.releaseGuard();
    this.maybeFinish();
  }
  private maybeFinish(): void {
    const processSettled = !this.child
      ? this.startupFinished
      : (this.exitObserved || this.spawnFailed) && this.streamsClosed;
    if (
      !processSettled ||
      (this.guard && !this.guardSettled) ||
      this.admissions.size
    )
      return;
    this.ended.resolve(this.result());
    if (!this.cleanupFailed) this.finished();
  }
  private result(): Retirement {
    const processSettled = !this.child
      ? this.startupFinished
      : (this.exitObserved || this.spawnFailed) && this.streamsClosed;
    return {
      settled:
        processSettled &&
        (this.guardSettled || !this.guard) &&
        this.admissions.size === 0 &&
        !this.cleanupFailed,
      processStarted: this.spawned,
      exitObserved: this.exitObserved,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      streamsClosed: this.streamsClosed,
      killRequested: this.killRequested,
      killAccepted: this.killAccepted,
      cooperative:
        this.exitObserved &&
        this.exitCode === 0 &&
        this.exitSignal === null &&
        this.deactivated &&
        !this.killRequested,
      cleanupFailed: this.cleanupFailed,
    };
  }
}
/** One application-owned authority. Construction never launches a backend. */
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
    if (existing) return existing.reuse();
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
