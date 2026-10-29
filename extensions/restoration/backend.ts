import type { ExtensionState } from "../../src/extension-runtime/state.js";
import { captureValue } from "../../src/extension-runtime/protocol.js";
import {
  exactLayoutKeys,
  isSavedLayout,
} from "../../src/shared/terminal-layout.js";
import { isRevision, stateDocument } from "./document.js";

/** State belongs to the declared extension ID, never an author-selected path. */
export function activate({
  signal,
  state,
}: {
  signal: AbortSignal;
  state?: ExtensionState;
}) {
  let running = false;
  return {
    async invoke(input: unknown, requestSignal: AbortSignal) {
      if (!state || signal.aborted || requestSignal.aborted)
        return { ok: false, error: "unavailable" };
      if (running) return { ok: false, error: "busy" };
      running = true;
      let dispatched = false;
      try {
        // Snapshot before awaiting: no getters/toJSON, mutation or unbounded data.
        const value = captureValue(input);
        if (
          exactLayoutKeys(value, ["operation"]) &&
          value.operation === "read"
        ) {
          const current = await state.read();
          return stateDocument(current.revision, current.value);
        }
        if (
          !exactLayoutKeys(value, ["operation", "expectedRevision", "value"]) ||
          value.operation !== "replace" ||
          !isRevision(value.expectedRevision) ||
          (value.value !== null && !isSavedLayout(value.value))
        )
          return { ok: false, error: "invalid-request" };
        if (signal.aborted || requestSignal.aborted)
          return { ok: false, error: "unavailable" };
        dispatched = true;
        const saved = await state.replace(
          value.expectedRevision,
          captureValue(value.value),
        );
        return stateDocument(saved.revision, saved.value);
      } catch (error) {
        const code =
          error !== null && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
        // The adapter's fixed prepublication categories preserve their meaning.
        // Unexpected errors after dispatch cannot establish that no write occurred.
        return {
          ok: false,
          error:
            typeof code === "string" &&
            [
              "busy",
              "conflict",
              "invalid-state",
              "invalid-value",
              "outcome-unknown",
            ].includes(code)
              ? code
              : dispatched
                ? "outcome-unknown"
                : "unavailable",
        };
      } finally {
        running = false;
      }
    },
  };
}
