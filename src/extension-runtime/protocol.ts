import { types } from "node:util";
import type {
  PackageRuntime,
  VersionSelection,
} from "../installed-packages/installed-packages.js";

export type Value =
  null | boolean | number | string | Value[] | { [key: string]: Value };
export const MESSAGE_BYTES = 1024 * 1024;
export const PENDING_LIMIT = 32;
export type Bootstrap = {
  root: string;
  addon: string;
  runtime: PackageRuntime;
  selection: VersionSelection;
};
export type Message = {
  epoch: string;
  sequence: number;
  kind: string;
  [key: string]: unknown;
};
export class RuntimeError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "busy"
      | "cancelled"
      | "protocol"
      | "activation-failed"
      | "outcome-unknown",
  ) {
    super(code);
    this.name = "RuntimeError";
  }
}
/** Capture data once under a conservative serialized budget, without user hooks. */
export function captureValue(value: unknown): Value {
  return capture(value, false);
}
function capture(value: unknown, envelope: boolean): Value {
  // Reserve envelope space separately; payload depth starts at its own root.
  let budget = envelope ? MESSAGE_BYTES : MESSAGE_BYTES - 1024;
  function visit(item: unknown, depth: number): Value {
    budget -= 8;
    if (budget < 0 || depth > 16) throw new RuntimeError("protocol");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      budget -= 32;
      if (!Number.isFinite(item) || budget < 0)
        throw new RuntimeError("protocol");
      return item;
    }
    if (typeof item === "string") {
      budget -= item.length * 6 + 2;
      if (budget < 0) throw new RuntimeError("protocol");
      return item;
    }
    if (typeof item !== "object" || types.isProxy(item))
      throw new RuntimeError("protocol");
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      prototype !== null &&
      prototype !== (array ? Array.prototype : Object.prototype)
    )
      throw new RuntimeError("protocol");
    const keys = Reflect.ownKeys(item);
    if (keys.length > (array ? 257 : 256)) throw new RuntimeError("protocol");
    if (array) return captureArray(item, depth, keys.length);
    const captured = Object.create(null) as Record<string, Value>;
    for (const key of keys) {
      if (typeof key !== "string") throw new RuntimeError("protocol");
      visit(key, depth + 1);
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable)
        throw new RuntimeError("protocol");
      captured[key] = captureProperty(descriptor.value, key, depth);
    }
    return captured;
  }
  function captureProperty(item: unknown, key: string, depth: number): Value {
    if (!envelope || depth !== 0 || key !== "value")
      return visit(item, depth + 1);
    budget -= MESSAGE_BYTES - 1024;
    if (budget < 0) throw new RuntimeError("protocol");
    return captureValue(item);
  }
  function captureArray(
    item: unknown[],
    depth: number,
    members: number,
  ): Value[] {
    const length = Object.getOwnPropertyDescriptor(item, "length")!
      .value as number;
    if (length > 256 || members !== length + 1)
      throw new RuntimeError("protocol");
    const captured: Value[] = [];
    Object.setPrototypeOf(captured, null); // JSON arrays must not inherit toJSON.
    for (let i = 0; i < length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
      if (!descriptor || !("value" in descriptor))
        throw new RuntimeError("protocol");
      captured[i] = visit(descriptor.value, depth + 1);
    }
    return captured;
  }
  try {
    return visit(value, 0);
  } catch {
    throw new RuntimeError("protocol");
  }
}
export function boundedValue(value: unknown): value is Value {
  try {
    captureValue(value);
    return true;
  } catch {
    return false;
  }
}
export function decode(raw: unknown): Message {
  if (
    typeof raw !== "string" ||
    raw.length > MESSAGE_BYTES ||
    Buffer.byteLength(raw) > MESSAGE_BYTES
  )
    throw new RuntimeError("protocol");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RuntimeError("protocol");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RuntimeError("protocol");
  const message = value as Message;
  if (
    typeof message.epoch !== "string" ||
    message.epoch.length !== 36 ||
    !Number.isSafeInteger(message.sequence) ||
    message.sequence < 1 ||
    typeof message.kind !== "string"
  )
    throw new RuntimeError("protocol");
  return message;
}
export function encode(message: Message): string {
  const result = JSON.stringify(capture(message, true));
  if (Buffer.byteLength(result) > MESSAGE_BYTES)
    throw new RuntimeError("protocol");
  return result;
}
export function exact(message: Message, keys: string[]): boolean {
  const allowed = new Set(["epoch", "sequence", "kind", ...keys]);
  return (
    Object.keys(message).length === allowed.size &&
    Object.keys(message).every((key) => allowed.has(key))
  );
}
