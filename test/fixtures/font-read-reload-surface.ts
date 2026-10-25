import { mountResttyTerminalSurface as mountReal } from "../../src/terminal-surface/restty-terminal-surface";

import { readReloadEvidence } from "./font-read-reload-evidence";

export const mountResttyTerminalSurface: typeof mountReal = async (
  container,
  adapter,
  options,
) => {
  const record: (typeof readReloadEvidence.mounts)[number] = {
    family: options?.appearance?.systemFont?.family,
    lineHeight: options?.appearance?.lineHeight,
    status: "pending",
    cancelled: false,
  };
  readReloadEvidence.mounts.push(record);
  options?.abortSignal?.addEventListener(
    "abort",
    () => {
      record.cancelled = true;
    },
    { once: true },
  );
  try {
    const surface = await mountReal(container, adapter, {
      ...options,
      ...(options?.acquireFontInputs
        ? {
            acquireFontInputs: async (...args) => {
              const lease = await options.acquireFontInputs!(...args);
              record.fontName = lease.fonts[0]?.name;
              return lease;
            },
          }
        : {}),
    });
    record.status = "mounted";
    return surface;
  } catch (error) {
    record.status = "failed";
    throw error;
  }
};
