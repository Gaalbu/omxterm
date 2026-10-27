import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  InstalledPackages,
  createNativeLeaseAdapter,
  type OpenVersion,
} from "../installed-packages/installed-packages.js";
import {
  boundedValue,
  decode,
  encode,
  exact,
  PENDING_LIMIT,
  type Bootstrap,
  type Message,
  type Value,
} from "./protocol.js";

// App-owned Node-mode bootstrap only; never wait for Electron browser readiness.
// Refuse missing Node mode/IPC before opening any installed package.
if (
  process.type ||
  !process.versions.electron ||
  process.env.ELECTRON_RUN_AS_NODE !== "1" ||
  typeof process.send !== "function"
)
  process.exit(78);
let epoch = "";
let received = 0;
let sequence = 0;
let phase:
  "waiting" | "pinning" | "pinned" | "activating" | "active" | "stopping" =
  "waiting";
let version: OpenVersion | undefined;
let activation: Promise<void> | undefined;
let backend:
  | {
      invoke(value: Value, signal: AbortSignal): Promise<Value> | Value;
      deactivate?(signal: AbortSignal): Promise<void> | void;
    }
  | undefined;
const owner = new AbortController();
const calls = new Map<
  number,
  { abort: AbortController; done: Promise<void> }
>();
let lastRequest = 0;
let stopping: Promise<void> | undefined;
// Deliberately retain the JS/native holder until OS process teardown, including
// after deactivate or channel loss. This is not a finalizer-based release policy.
process.on("exit", () => {
  void version;
});
const startupTimer = setTimeout(() => {
  void stop();
}, 10_000);
function send(
  kind: string,
  fields: Record<string, unknown> = {},
  complete?: () => void,
): void {
  if (!process.connected) throw new Error("channel-closed");
  process.send!(
    encode({ epoch, sequence: ++sequence, kind, ...fields }),
    (error: Error | null) => {
      if (complete) complete();
      else if (error) process.exit(1);
    },
  );
}
function stop(): Promise<void> {
  if (stopping) return stopping;
  phase = "stopping";
  clearTimeout(startupTimer);
  owner.abort();
  for (const call of calls.values()) call.abort.abort();
  stopping = (async () => {
    try {
      await activation;
      await Promise.allSettled([...calls.values()].map((call) => call.done));
      await backend?.deactivate?.(AbortSignal.timeout(2000));
      if (process.connected) {
        // Flush the cooperation receipt, but keep the pin until actual OS exit.
        send("deactivated", {}, () => process.exit(0));
        return;
      }
    } catch {
      process.exit(1);
    }
    process.exit(0);
  })();
  return stopping;
}
async function activate(): Promise<void> {
  try {
    if (!version || owner.signal.aborted || !(await version.revalidate()))
      throw new Error("unavailable");
    if (owner.signal.aborted || !process.connected) return;
    const entry = version.manifest.backend;
    if (!entry.endsWith(".mjs")) throw new Error("esm-required");
    const file = path.resolve(version.directory, entry);
    if (!file.startsWith(version.directory + path.sep))
      throw new Error("entry");
    const exports: unknown = await import(pathToFileURL(file).href);
    if (
      !exports ||
      typeof exports !== "object" ||
      !("activate" in exports) ||
      typeof exports.activate !== "function"
    )
      throw new Error("activation");
    if (owner.signal.aborted) return;
    const entryActivate = exports.activate as (context: {
      signal: AbortSignal;
    }) => unknown;
    const result: unknown = await entryActivate({ signal: owner.signal });
    if (
      !result ||
      typeof result !== "object" ||
      !("invoke" in result) ||
      typeof result.invoke !== "function" ||
      ("deactivate" in result && typeof result.deactivate !== "function")
    )
      throw new Error("activation");
    backend = result as NonNullable<typeof backend>;
    if (owner.signal.aborted) return;
    phase = "active";
    clearTimeout(startupTimer);
    send("active");
  } catch {
    try {
      send("failed");
    } catch {
      /* Lost authority. */
    }
    // Do not await stop from the activation promise which stop itself joins.
    setImmediate(() => {
      void stop();
    });
  }
}
async function invoke(
  request: number,
  value: Value,
  abort: AbortController,
): Promise<void> {
  try {
    if (
      !version ||
      !(await version.revalidate()) ||
      abort.signal.aborted ||
      owner.signal.aborted
    )
      throw new Error("unavailable");
    const result = await backend!.invoke(value, abort.signal);
    // send/encode captures the result once without invoking serialization hooks.
    if (!owner.signal.aborted)
      send("result", { request, ok: true, value: result });
  } catch {
    if (!owner.signal.aborted) {
      try {
        send("result", { request, ok: false, value: null });
      } catch {
        void stop();
      }
    }
  } finally {
    calls.delete(request);
  }
}
async function initialize(message: Message): Promise<void> {
  phase = "pinning";
  const config = message.bootstrap as Bootstrap | undefined;
  if (
    !config ||
    typeof config.root !== "string" ||
    typeof config.addon !== "string" ||
    !path.isAbsolute(config.root) ||
    !path.isAbsolute(config.addon) ||
    !config.runtime ||
    !config.selection ||
    typeof config.selection.id !== "string"
  )
    throw new Error("protocol");
  const store = await InstalledPackages.open({
    root: config.root,
    runtime: config.runtime,
    leases: createNativeLeaseAdapter(config.addon),
  });
  version = await store.openVersion(config.selection.id, config.selection);
  if (owner.signal.aborted) return;
  phase = "pinned";
  send("pinned");
}
async function message(raw: unknown): Promise<void> {
  const message = decode(raw);
  if (phase === "waiting") epoch = message.epoch;
  if (message.epoch !== epoch || message.sequence !== received + 1)
    throw new Error("protocol");
  received = message.sequence;
  if (message.kind === "stop" && exact(message, [])) {
    void stop();
    return;
  }
  if (phase === "stopping") return;
  if (
    message.kind === "initialize" &&
    phase === "waiting" &&
    exact(message, ["bootstrap"])
  ) {
    return initialize(message);
  }
  if (message.kind === "admit" && phase === "pinned" && exact(message, [])) {
    phase = "activating";
    activation = activate();
    return;
  }
  if (phase === "active") return activeMessage(message);
  throw new Error("protocol");
}
function activeMessage(message: Message): void {
  if (
    message.kind === "call" &&
    exact(message, ["request", "value"]) &&
    Number.isSafeInteger(message.request) &&
    (message.request as number) > lastRequest &&
    boundedValue(message.value) &&
    calls.size < PENDING_LIMIT
  ) {
    const request = message.request as number;
    lastRequest = request;
    const abort = new AbortController();
    const done = invoke(request, message.value, abort);
    calls.set(request, { abort, done });
    return;
  }
  if (
    message.kind === "cancel" &&
    exact(message, ["request"]) &&
    Number.isSafeInteger(message.request) &&
    (message.request as number) > 0 &&
    (message.request as number) <= lastRequest
  ) {
    calls.get(message.request as number)?.abort.abort();
    return;
  }
  throw new Error("protocol");
}
process.on("message", (raw: unknown) => {
  void message(raw).catch(() => {
    void stop();
  });
});
process.on("disconnect", () => {
  void stop();
});
