import os from "node:os";
import { discoverAliases } from "./discovery.js";

export function activate(
  { signal }: { signal: AbortSignal },
  discover = discoverAliases,
) {
  let running = 0;
  return {
    async invoke(value: unknown, requestSignal: AbortSignal) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).join() !== "operation" ||
        (value as { operation: unknown }).operation !== "aliases"
      )
        return { ok: false, error: "invalid-request" };
      if (signal.aborted || requestSignal.aborted)
        return { ok: false, error: "unavailable" };
      if (running >= 8) return { ok: false, error: "busy" };
      running++;
      try {
        return {
          ok: true,
          ...(await discover(
            os.homedir(),
            AbortSignal.any([signal, requestSignal]),
          )),
        };
      } catch {
        return { ok: false, error: "unavailable" };
      } finally {
        running--;
      }
    },
  };
}
