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
/** Conservative serialized upper bound: no unbounded stringify before admission. */
export function boundedValue(value: unknown): value is Value {
  let budget = MESSAGE_BYTES - 1024;
  function visit(item: unknown, depth: number): boolean {
    budget -= 8;
    if (budget < 0 || depth > 16) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") {
      budget -= 32;
      return Number.isFinite(item) && budget >= 0;
    }
    if (typeof item === "string") {
      budget -= item.length * 6 + 2;
      return budget >= 0;
    }
    if (typeof item !== "object") return false;
    if (Array.isArray(item))
      return (
        item.length <= 256 && item.every((entry) => visit(entry, depth + 1))
      );
    if (
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    const entries = Object.entries(item);
    return (
      entries.length <= 256 &&
      entries.every(
        ([key, entry]) => visit(key, depth + 1) && visit(entry, depth + 1),
      )
    );
  }
  return visit(value, 0);
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
  if (!boundedValue(message)) throw new RuntimeError("protocol");
  const result = JSON.stringify(message);
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
