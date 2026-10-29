import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  isRecord,
  readBoundedFile,
  syncDirectory,
  validId,
} from "../installed-packages/archive.js";
import type { LeaseAdapter } from "../installed-packages/native-leases.js";
import { UUID } from "../installed-packages/registry.js";
import { captureValue, type Value } from "./protocol.js";

export const STATE_BYTES = 256 * 1024;
export const ABSENT_REVISION = "absent";
export type StateSnapshot = { revision: string; value: Value };
export type ExtensionState = {
  read(): Promise<StateSnapshot>;
  replace(expectedRevision: string, value: Value): Promise<StateSnapshot>;
};
export class StateError extends Error {
  constructor(
    readonly code:
      | "invalid-state"
      | "invalid-value"
      | "busy"
      | "conflict"
      | "outcome-unknown",
  ) {
    super(code);
    this.name = "StateError";
  }
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
async function directory(file: string): Promise<void> {
  if (!(await fs.lstat(file)).isDirectory())
    throw new StateError("invalid-state");
}
async function ensureDirectory(file: string): Promise<void> {
  try {
    await fs.mkdir(file, { mode: 0o700 });
    await syncDirectory(path.dirname(file));
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await directory(file);
}

/**
 * One document, outside immutable packages. Construction performs no I/O.
 * The profile and its ancestors are app-owned; this is not a same-user sandbox.
 * No registry lease, retry, repair, migration or orphan-temp sweep is involved.
 */
export function createExtensionState(options: {
  packageRoot: string;
  id: string;
  leases: LeaseAdapter;
}): ExtensionState {
  if (!path.isAbsolute(options.packageRoot) || !validId(options.id))
    throw new StateError("invalid-state");
  const profile = path.dirname(options.packageRoot);
  const root = path.join(profile, "extension-state");
  const scoped = path.join(root, options.id);
  const file = path.join(scoped, "state.json");
  const lock = path.join(scoped, "state.lock");
  let active = false;

  async function readCurrent(): Promise<StateSnapshot> {
    let bytes: Buffer;
    try {
      bytes = await readBoundedFile(file, STATE_BYTES);
    } catch (error) {
      if (hasCode(error, "ENOENT"))
        return { revision: ABSENT_REVISION, value: null };
      throw error;
    }
    const document: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !isRecord(document) ||
      Object.keys(document).sort().join() !== "format,revision,value" ||
      document.format !== 1 ||
      typeof document.revision !== "string" ||
      !UUID.test(document.revision)
    )
      throw new StateError("invalid-state");
    return {
      revision: document.revision,
      value: captureValue(document.value),
    };
  }

  async function transaction(
    operation: (publication: { attempted: boolean }) => Promise<StateSnapshot>,
  ): Promise<StateSnapshot> {
    if (active) throw new StateError("busy");
    active = true;
    const publication = { attempted: false };
    try {
      await directory(profile);
      await ensureDirectory(root);
      await ensureDirectory(scoped);
      // Native adapter creates a private regular lock without following its final
      // symlink. It keeps the same file identity across transactions/processes.
      const lease = await options.leases.tryAcquire(lock, true);
      if (!lease) throw new StateError("busy");
      try {
        await directory(root);
        await directory(scoped);
        return await operation(publication);
      } finally {
        await lease.release();
      }
    } catch (error) {
      if (publication.attempted) throw new StateError("outcome-unknown");
      if (error instanceof StateError) throw error;
      throw new StateError("invalid-state");
    } finally {
      active = false;
    }
  }

  return {
    read: () => transaction(() => readCurrent()),
    async replace(expectedRevision, value) {
      // Capture before awaiting any I/O; never run extension serialization hooks.
      let snapshot: StateSnapshot;
      let bytes: string;
      try {
        if (
          expectedRevision !== ABSENT_REVISION &&
          (typeof expectedRevision !== "string" || !UUID.test(expectedRevision))
        )
          throw new StateError("invalid-value");
        snapshot = { revision: randomUUID(), value: captureValue(value) };
        bytes = JSON.stringify({ format: 1, ...snapshot });
        if (Buffer.byteLength(bytes) > STATE_BYTES)
          throw new StateError("invalid-value");
      } catch {
        throw new StateError("invalid-value");
      }
      return transaction(async (publication) => {
        const current = await readCurrent();
        if (current.revision !== expectedRevision)
          throw new StateError("conflict");
        const temporary = path.join(scoped, `state-${randomUUID()}.tmp`);
        const handle = await fs.open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Null is a revisioned tombstone, not deletion of revision history.
        // Once rename is attempted, any failure (including lease release) requires
        // Refresh, never automatic resubmission. Interrupted temps are retained.
        publication.attempted = true;
        await fs.rename(temporary, file);
        await syncDirectory(scoped);
        return snapshot;
      });
    },
  };
}
