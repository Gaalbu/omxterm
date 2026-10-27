import {
  isRecord,
  PackageError,
  parseManifest,
  validId,
  type PackageManifest,
} from "./archive.js";

export type Installation = {
  id: string;
  generation: number;
  digest: string | null;
  enabled: boolean;
  manifest: PackageManifest | null;
};
export type Registry = { format: 1; installations: Installation[] };
export const REGISTRY_BYTES = 2 * 1024 * 1024;
export const MAX_INSTALLATIONS = 1000;
export const DIGEST = /^[a-f0-9]{64}$/;
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function garbageIdentity(name: string): string {
  const split = name.length - 37;
  const identity = name.slice(0, split);
  if (
    name[split] !== "-" ||
    (!DIGEST.test(identity) && !UUID.test(identity)) ||
    !UUID.test(name.slice(split + 1))
  )
    throw new PackageError("invalid-store");
  return identity;
}

export type Publication = { attempted: boolean };

// All cleanup steps run. Their failures never replace a primary failure or turn
// a possibly committed mutation into an apparently prepublication rejection.
export async function withCleanup<T>(
  operation: () => Promise<T>,
  cleanup: (() => Promise<unknown>)[],
  publication?: Publication,
): Promise<T> {
  let value: T | undefined;
  let failure: unknown;
  let failed = false;
  try {
    value = await operation();
  } catch (error) {
    failure = error;
    failed = true;
  }
  let cleanupFailed = false;
  for (const close of cleanup) {
    try {
      await close();
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    const error = publication?.attempted
      ? new PackageError("outcome-unknown")
      : failure instanceof PackageError
        ? failure
        : new PackageError("invalid-store");
    error.cleanupFailed = true;
    throw error;
  }
  if (failed) throw failure;
  return value as T;
}

export function parseRegistry(value: unknown): Registry {
  if (
    !isRecord(value) ||
    value.format !== 1 ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.installations) ||
    value.installations.length > MAX_INSTALLATIONS
  )
    throw new PackageError("invalid-store");
  const ids = new Set<string>();
  for (const entry of value.installations) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join() !==
        "digest,enabled,generation,id,manifest" ||
      !validId(entry.id) ||
      ids.has(entry.id) ||
      !Number.isSafeInteger(entry.generation) ||
      (entry.generation as number) < 1 ||
      typeof entry.enabled !== "boolean"
    )
      throw new PackageError("invalid-store");
    ids.add(entry.id);
    if (entry.digest === null) {
      if (entry.enabled || entry.manifest !== null)
        throw new PackageError("invalid-store");
    } else {
      if (typeof entry.digest !== "string" || !DIGEST.test(entry.digest))
        throw new PackageError("invalid-store");
      const manifest = parseManifest(entry.manifest);
      if (manifest.id !== entry.id) throw new PackageError("invalid-store");
    }
  }
  return value as Registry;
}
