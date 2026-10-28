// Development-preview management only. No paths, executable text or caller-owned
// window identity cross this bridge.
export const extensionsIpc = "omxterm:extensions";

// The installer and hosted resource reader admit the same portable URL paths.
export function isExtensionResource(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    value
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && !part.endsWith("."),
      )
  );
}
export type ExtensionEntry = {
  id: string;
  generation: number;
  name: string;
  version: string | null;
  installed: boolean;
  enabled: boolean;
  local: string;
};
export type ExtensionsResult = {
  ok: boolean;
  error?: string;
  entries?: ExtensionEntry[];
  pendingCleanup?: boolean | undefined;
};
export type ExtensionsRequest =
  | { operation: "snapshot" | "install" }
  | { operation: "open"; token: string; accepted: boolean }
  | {
      operation: "enable" | "disable" | "uninstall";
      id: string;
      generation: number;
    };
export type ExtensionsBridge = {
  request(request: ExtensionsRequest): Promise<ExtensionsResult>;
};
export function isExtensionsRequest(
  value: unknown,
): value is ExtensionsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.operation === "open")
    return (
      Object.keys(item).length === 3 &&
      typeof item.token === "string" &&
      /^[0-9a-f-]{36}$/.test(item.token) &&
      typeof item.accepted === "boolean"
    );
  if (item.operation === "snapshot" || item.operation === "install")
    return Object.keys(item).length === 1;
  return (
    ["enable", "disable", "uninstall"].includes(String(item.operation)) &&
    Object.keys(item).length === 3 &&
    typeof item.id === "string" &&
    item.id.length <= 128 &&
    /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(item.id) &&
    typeof item.generation === "number" &&
    Number.isSafeInteger(item.generation) &&
    item.generation > 0
  );
}
