import {
  exactLayoutKeys,
  isLayoutToken,
  isSavedLayout,
  type SavedLayout,
} from "../../src/shared/terminal-layout.js";

export type StateDocument = {
  ok: true;
  revision: string;
  status: "saved" | "empty" | "invalid";
  value: SavedLayout | null;
};
export function isRevision(value: unknown): value is string {
  return value === "absent" || isLayoutToken(value);
}
export function stateDocument(revision: string, value: unknown): StateDocument {
  if (!isRevision(revision)) throw new Error("invalid-state");
  return {
    ok: true,
    revision,
    status:
      value === null ? "empty" : isSavedLayout(value) ? "saved" : "invalid",
    value: isSavedLayout(value) ? value : null,
  };
}
export function isStateDocument(value: unknown): value is StateDocument {
  return (
    exactLayoutKeys(value, ["ok", "revision", "status", "value"]) &&
    value.ok === true &&
    isRevision(value.revision) &&
    (value.status === "saved"
      ? isSavedLayout(value.value)
      : (value.status === "empty" || value.status === "invalid") &&
        value.value === null)
  );
}
export function errorCode(value: unknown): string {
  return value !== null &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : "unavailable";
}
