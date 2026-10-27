import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { OpenVersion } from "../installed-packages/installed-packages";
import {
  extensionResourceLimits,
  isExtensionResource,
  type CapturedResourceOwner,
} from "./extension-view-resources";

// Structural private consumer of InstalledPackages.openVersion's captured pin.
// Keep the complete pin in this closure. Admission/revalidate belongs to the
// caller, before epoch creation; existing reads never consult the registry.
export function extensionResourceOwner(
  pin: Pick<OpenVersion, "directory" | "release">,
): CapturedResourceOwner {
  let root: Promise<string> | undefined;
  let released = false;
  let release: Promise<void> | undefined;
  const reads = new Set<Promise<Uint8Array>>();
  const read = async (
    resource: string,
    maximum: number,
    signal: AbortSignal,
  ) => {
    if (
      released ||
      signal.aborted ||
      !isExtensionResource(resource) ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > extensionResourceLimits.bytes
    )
      throw new Error("Resource unavailable");
    const directory = await (root ??= realpath(pin.directory));
    const resolved = await realpath(path.join(directory, resource));
    if (!resolved.startsWith(`${directory}${path.sep}`) || signal.aborted)
      throw new Error("Resource unavailable");
    // The package store promises immutable validated directories while pinned.
    // This containment check is not a sandbox against trusted code mutating them.
    const file = await open(resolved, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maximum || signal.aborted)
        throw new Error("Resource unavailable");
      const bytes = new Uint8Array(maximum);
      let length = 0;
      while (length < bytes.length) {
        if (signal.aborted) throw new Error("Resource cancelled");
        const result = await file.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      // Detect growth beyond the admitted bound without allocating that growth.
      const extra = new Uint8Array(1);
      if ((await file.read(extra, 0, 1, length)).bytesRead || signal.aborted)
        throw new Error("Resource unavailable");
      return bytes.subarray(0, length);
    } finally {
      await file.close();
    }
  };
  return {
    read(resource, maximum, signal) {
      const pending = read(resource, maximum, signal);
      reads.add(pending);
      void pending.then(
        () => reads.delete(pending),
        () => reads.delete(pending),
      );
      return pending;
    },
    release() {
      if (!release) {
        released = true;
        release = Promise.allSettled([...reads]).then(() => pin.release());
      }
      return release;
    },
  };
}
