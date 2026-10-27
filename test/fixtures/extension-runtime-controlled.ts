import { vi } from "vitest";
import {
  ExtensionRuntime,
  type BackendProcess,
} from "../../src/extension-runtime/runtime.js";
import type {
  OpenVersion,
  VersionSelection,
} from "../../src/installed-packages/installed-packages.js";
import { decode, type Message } from "../../src/extension-runtime/protocol.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
// Only external process/store events are controlled; all state decisions are production APIs.
class Process implements BackendProcess {
  sent: Message[] = [];
  message!: (raw: unknown) => void;
  spawn!: () => void;
  error!: () => void;
  close!: () => void;
  exit!: (code: number | null, signal: string | null) => void;
  lost!: () => void;
  sequence = 0;
  kill = vi.fn(() => true);
  disconnect = vi.fn();
  send(raw: string) {
    this.sent.push(decode(raw));
  }
  onMessage(listener: typeof this.message) {
    this.message = listener;
  }
  onSpawn(listener: typeof this.spawn) {
    this.spawn = listener;
  }
  onError(listener: typeof this.error) {
    this.error = listener;
  }
  onClose(listener: typeof this.close) {
    this.close = listener;
  }
  onExit(listener: typeof this.exit) {
    this.exit = listener;
  }
  onDisconnect(listener: typeof this.lost) {
    this.lost = listener;
  }
  reply(kind: string, fields: Record<string, unknown> = {}) {
    this.message(
      JSON.stringify({
        epoch: this.sent[0]!.epoch,
        sequence: ++this.sequence,
        kind,
        ...fields,
      }),
    );
  }
  kinds() {
    return this.sent.map((message) => message.kind);
  }
}
export const selection: VersionSelection = {
  id: "test.backend",
  generation: 1,
  digest: "a".repeat(64),
};
export function pin(): OpenVersion {
  return {
    ...selection,
    directory: "/synthetic/backend",
    manifest: {
      format: 1,
      id: selection.id,
      version: "1.0.0",
      name: "Test",
      engines: { omxterm: "*", api: "*" },
      backend: "index.mjs",
    },
    revalidate: vi.fn(async () => true),
    release: vi.fn(async () => {}),
  };
}
export function fixture() {
  const owner = new AbortController();
  const guard = pin();
  const openVersion = vi.fn(
    async (_id: string, _expected?: VersionSelection) => guard,
  );
  const children: Process[] = [];
  const spawn = vi.fn(() => {
    const child = new Process();
    children.push(child);
    return child;
  });
  const runtime = new ExtensionRuntime({
    packages: { openVersion },
    bootstrap: {
      root: "/synthetic/store",
      addon: "/synthetic/lease.node",
      runtime: { appVersion: "1.0.0", apiVersion: "1.0.0" },
    },
    spawn,
    owner: owner.signal,
  });
  return { runtime, owner, guard, openVersion, spawn, children };
}
export const flush = () => vi.advanceTimersByTimeAsync(0);
export const observe = <T>(promise: Promise<T>) =>
  promise.catch((error: unknown) => error);
export async function active(f = fixture()) {
  const pending = f.runtime.activate(selection.id);
  await flush();
  const child = f.children[0]!;
  child.spawn();
  child.reply("pinned");
  await flush();
  child.reply("active");
  const backend = await pending;
  return { ...f, child, backend };
}
