import { lstat, opendir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord, PackageError } from "./archive.js";
import { DIGEST, UUID, garbageIdentity, withCleanup } from "./registry.js";
import type { LeaseAdapter, VersionLease } from "./native-leases.js";

export type CleanupResult = {
  removed: string[];
  pending: string[];
  more: boolean;
};
type Item = {
  kind: "versions" | "staging" | "garbage" | "temporary";
  name: string;
  identity: string;
};
const SCAN_LIMIT = 10_000;
const BATCH = 32;

// Enumerate outside writer exclusion, with a cap while reading rather than
// after allocating an unbounded readdir result. No handles survive this call.
async function inventory(root: string): Promise<Item[]> {
  const result: Item[] = [];
  let examined = 0;
  for (const kind of ["versions", "staging", "garbage", "temporary"] as const) {
    const directory = await opendir(
      kind === "temporary" ? root : path.join(root, kind),
      { bufferSize: 32 },
    );
    for await (const entry of directory) {
      if (++examined > SCAN_LIMIT) throw new PackageError("invalid-store");
      const name = entry.name;
      if (kind === "temporary") {
        if (
          /^registry-[a-f0-9-]+\.tmp$/.test(name) &&
          UUID.test(name.slice(9, -4))
        )
          result.push({ kind, name, identity: name });
        continue;
      }
      const identity = kind === "garbage" ? garbageIdentity(name) : name;
      if (
        kind !== "garbage" &&
        !(kind === "versions" ? DIGEST : UUID).test(name)
      )
        throw new PackageError("invalid-store");
      result.push({ kind, name, identity });
    }
  }
  return result;
}
function missing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** Hidden implementation of InstalledPackages.collect; no separate public port. */
export async function collectPackages(
  root: string,
  leases: LeaseAdapter,
  writer: (
    operation: (referenced: Set<string | null>) => Promise<void>,
  ) => Promise<void>,
  offset: number,
): Promise<{ result: CleanupResult; nextOffset: number }> {
  const entries = await inventory(root);
  const start = offset < entries.length ? offset : 0;
  const selected = entries.slice(start, start + BATCH);
  const end = start + selected.length;
  const result: CleanupResult = {
    removed: [],
    pending: [],
    more: end < entries.length,
  };
  const detached: { file: string; identity: string; pin?: VersionLease }[] = [];
  const lock = (key: string) =>
    leases.tryAcquire(path.join(root, "locks", `${key}.lock`), true);
  return withCleanup(async () => {
    await writer(async (referenced) => {
      for (const item of selected) {
        if (item.kind === "versions" && referenced.has(item.identity)) continue;
        const source =
          item.kind === "temporary"
            ? path.join(root, item.name)
            : path.join(root, item.kind, item.name);
        // A writer owns every registry temporary file. Once this transaction is
        // admitted, selected old names cannot belong to an in-flight writer.
        if (item.kind === "temporary") {
          try {
            const stat = await lstat(source);
            if (!stat.isFile() || stat.isSymbolicLink())
              throw new PackageError("invalid-store");
            detached.push({ file: source, identity: item.identity });
          } catch (error) {
            if (!missing(error)) throw error;
          }
          continue;
        }
        const key = `${item.kind === "versions" ? "version" : item.kind === "staging" ? "stage" : "garbage"}-${item.name}`;
        const pin = await lock(key);
        if (!pin) {
          result.pending.push(item.identity);
          continue;
        }
        let retained = false;
        try {
          const stat = await lstat(source);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new PackageError("invalid-store");
          if (item.kind === "garbage") {
            detached.push({ file: source, identity: item.identity, pin });
            retained = true;
            continue;
          }
          const name = `${item.identity}-${randomUUID()}`;
          const target = path.join(root, "garbage", name);
          const garbagePin = await lock(`garbage-${name}`);
          if (!garbagePin) throw new PackageError("busy");
          try {
            await rename(source, target);
          } catch (error) {
            await garbagePin.release();
            throw error;
          }
          detached.push({
            file: target,
            identity: item.identity,
            pin: garbagePin,
          });
        } catch (error) {
          // A cooperating installer/collector can remove an inventoried stage
          // before this transaction acquires its now-free lease.
          if (missing(error)) continue;
          if (error instanceof PackageError) throw error;
          result.pending.push(item.identity);
        } finally {
          if (!retained) await pin.release();
        }
      }
    });
    for (const item of detached) {
      try {
        await rm(item.file, { recursive: true, force: true });
        result.removed.push(item.identity);
      } catch {
        result.pending.push(item.identity);
      }
    }
    return { result, nextOffset: result.more ? end : 0 };
  }, [
    async () => {
      // Retire every captured handle even if one release fails.
      const outcomes = await Promise.allSettled(
        detached.map((item) => item.pin?.release()),
      );
      if (outcomes.some((outcome) => outcome.status === "rejected"))
        throw new PackageError("invalid-store");
    },
  ]);
}
