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

// App-owned code only. No extension bytes are imported before both pin/admission.
let channel: Electron.MessagePortMain | undefined;
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
function send(kind: string, fields: Record<string, unknown> = {}): void {
  channel?.postMessage(
    encode({ epoch, sequence: ++sequence, kind, ...fields }),
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
      send("deactivated");
    } catch {
      /* No cooperation receipt when cleanup failed. */
    }
    // The independent pin is released by actual process exit, never here.
    process.exit(0);
  })();
  return stopping;
}
async function activate(): Promise<void> {
  try {
    if (!version || owner.signal.aborted || !(await version.revalidate()))
      throw new Error("unavailable");
    if (owner.signal.aborted) return;
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
    if (!boundedValue(result)) throw new Error("result");
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
process.parentPort.once("message", (event) => {
  if (
    event.data !== "omxterm-extension-connect-v1" ||
    event.ports.length !== 1
  ) {
    void stop();
    return;
  }
  channel = event.ports[0]!;
  channel.on("message", (event) => {
    void message(event.data).catch(() => {
      void stop();
    });
  });
  channel.on("close", () => {
    void stop();
  });
  channel.start();
});
