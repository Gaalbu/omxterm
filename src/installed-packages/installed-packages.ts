import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { valid } from "semver";
import {
  checkCompatibility,
  extractPackage,
  isRecord,
  PackageError,
  readBoundedFile,
  syncDirectory,
  validId,
  type PackageManifest,
  type PackageRuntime,
} from "./archive.js";
import type { LeaseAdapter, VersionLease } from "./native-leases.js";
import {
  parseRegistry,
  garbageIdentity,
  UUID,
  DIGEST,
  REGISTRY_BYTES,
  MAX_INSTALLATIONS,
  type Registry,
  type Installation,
} from "./registry.js";
export type { Installation } from "./registry.js";

export {
  PackageError,
  type PackageManifest,
  type PackageRuntime,
} from "./archive.js";
export {
  createNativeLeaseAdapter,
  type LeaseAdapter,
  type VersionLease,
} from "./native-leases.js";

export type VersionSelection = {
  id: string;
  generation: number;
  digest: string;
};
export type OpenVersion = VersionSelection & {
  directory: string;
  manifest: PackageManifest;
  revalidate(): Promise<boolean>;
  release(): Promise<void>;
};
export type CleanupResult = { removed: string[]; pending: string[] };
const MAX_SCAN = 10_000;

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
function nextGeneration(entry?: Installation): number {
  const next = (entry?.generation ?? 0) + 1;
  if (!Number.isSafeInteger(next)) throw new PackageError("invalid-store");
  return next;
}
async function directory(file: string): Promise<void> {
  const stat = await lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new PackageError("invalid-store");
}
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** Internal installation foundation. No extension execution or application IPC. */
export class InstalledPackages {
  private active = 0;
  private constructor(
    private readonly root: string,
    private readonly runtime: PackageRuntime,
    private readonly leases: LeaseAdapter,
  ) {}

  static async open(options: {
    root: string;
    runtime: PackageRuntime;
    leases: LeaseAdapter;
  }): Promise<InstalledPackages> {
    if (
      !path.isAbsolute(options.root) ||
      !valid(options.runtime.appVersion) ||
      !valid(options.runtime.apiVersion)
    )
      throw new PackageError("invalid-store");
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    // Canonical aliases share permanent sidecars. Never replace a live namespace.
    const root = await realpath(options.root);
    await directory(root);
    for (const name of ["locks", "versions", "staging", "garbage"]) {
      const target = path.join(root, name);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await directory(target);
    }
    const store = new InstalledPackages(
      root,
      { ...options.runtime },
      options.leases,
    );
    await store.writer(async () => {
      if (!(await exists(store.registryPath))) {
        if (
          (await readdir(path.join(root, "versions"))).length ||
          (await readdir(path.join(root, "staging"))).length
        )
          throw new PackageError("invalid-store");
        await store.publish({ format: 1, installations: [] });
      } else await store.readRegistry();
    });
    return store;
  }

  private get registryPath(): string {
    return path.join(this.root, "registry.json");
  }
  private lock(key: string, exclusive: boolean): Promise<VersionLease | null> {
    return this.leases.tryAcquire(
      path.join(this.root, "locks", `${key}.lock`),
      exclusive,
    );
  }
  private async checkRoot(): Promise<void> {
    for (const name of ["", "locks", "versions", "staging", "garbage"])
      await directory(path.join(this.root, name));
  }
  private async bounded<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= 32) throw new PackageError("busy");
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
    }
  }
  private async writer<T>(operation: () => Promise<T>): Promise<T> {
    await this.checkRoot();
    const lease = await this.lock("writer", true);
    if (!lease) throw new PackageError("busy");
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }
  private async readRegistry(): Promise<Registry> {
    try {
      return parseRegistry(
        JSON.parse(
          (await readBoundedFile(this.registryPath, REGISTRY_BYTES)).toString(
            "utf8",
          ),
        ),
      );
    } catch {
      throw new PackageError("invalid-store");
    }
  }
  private async publish(registry: Registry): Promise<void> {
    const bytes = JSON.stringify(registry);
    if (
      Buffer.byteLength(bytes) > REGISTRY_BYTES ||
      registry.installations.length > MAX_INSTALLATIONS
    )
      throw new PackageError("invalid-store");
    const temporary = path.join(this.root, `registry-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, this.registryPath);
      // POSIX directory fsync makes the publication name durable on supported
      // local filesystems. Windows replacement is atomic but power loss is not
      // qualified; do not claim FlushFileBuffers on a file flushes its directory.
      if (process.platform !== "win32") {
        const parent = await open(this.root, "r");
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      }
    } catch {
      // A replace/flush failure or lost response is not permission to replay.
      throw new PackageError("outcome-unknown");
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  private entry(
    registry: Registry,
    id: string,
    expected: number,
  ): Installation | undefined {
    if (!validId(id) || !Number.isSafeInteger(expected) || expected < 0)
      throw new PackageError("conflict");
    const current = registry.installations.find((entry) => entry.id === id);
    if ((current?.generation ?? 0) !== expected)
      throw new PackageError("conflict");
    return current;
  }

  snapshot(): Promise<Installation[]> {
    return this.bounded(() =>
      this.writer(async () => (await this.readRegistry()).installations),
    );
  }

  install(
    archive: string,
    options: { expectedGeneration: number; enabled: boolean },
  ): Promise<Installation> {
    return this.bounded(async () => {
      if (typeof options.enabled !== "boolean")
        throw new PackageError("invalid-package");
      await this.checkRoot();
      const stageId = randomUUID();
      const stage = path.join(this.root, "staging", stageId);
      const pin = await this.lock(`stage-${stageId}`, false);
      if (!pin) throw new PackageError("busy");
      try {
        await mkdir(stage, { mode: 0o700 });
        const { manifest, digest } = await extractPackage(
          archive,
          stage,
          this.runtime,
        );
        const marker = JSON.stringify({ digest, manifest });
        const metadata = await open(
          path.join(stage, ".omxterm-install.json"),
          "wx",
          0o600,
        );
        try {
          await metadata.writeFile(marker);
          await metadata.sync();
        } finally {
          await metadata.close();
        }
        await syncDirectory(stage);
        return await this.writer(async () => {
          const registry = await this.readRegistry();
          const old = this.entry(
            registry,
            manifest.id,
            options.expectedGeneration,
          );
          const version = path.join(this.root, "versions", digest);
          if (await exists(version)) {
            await directory(version);
            const existing = await readBoundedFile(
              path.join(version, ".omxterm-install.json"),
              128 * 1024,
            );
            if (existing.toString("utf8") !== marker)
              throw new PackageError("invalid-store");
          } else {
            // All managed publishers/collectors use writer exclusion. This is
            // not a generic no-replace filesystem primitive for arbitrary paths.
            await rename(stage, version);
            await syncDirectory(path.join(this.root, "versions"));
            await syncDirectory(path.join(this.root, "staging"));
          }
          const installed: Installation = {
            id: manifest.id,
            generation: nextGeneration(old),
            digest,
            enabled: options.enabled,
            manifest,
          };
          registry.installations = registry.installations.filter(
            (entry) => entry.id !== manifest.id,
          );
          registry.installations.push(installed);
          await this.publish(registry);
          return installed;
        });
      } finally {
        try {
          await rm(stage, { recursive: true, force: true });
        } finally {
          await pin.release();
        }
      }
    });
  }

  setEnabled(
    id: string,
    expectedGeneration: number,
    enabled: boolean,
  ): Promise<Installation> {
    return this.change(id, expectedGeneration, enabled);
  }
  uninstall(id: string, expectedGeneration: number): Promise<Installation> {
    // Tombstone publication and physical cleanup are deliberately separate.
    return this.change(id, expectedGeneration, null);
  }
  private change(
    id: string,
    expectedGeneration: number,
    enabled: boolean | null,
  ): Promise<Installation> {
    return this.bounded(() =>
      this.writer(async () => {
        const registry = await this.readRegistry();
        const old = this.entry(registry, id, expectedGeneration);
        if (!old?.digest || (enabled !== null && typeof enabled !== "boolean"))
          throw new PackageError("unavailable");
        const entry: Installation =
          enabled === null
            ? {
                id,
                generation: nextGeneration(old),
                digest: null,
                enabled: false,
                manifest: null,
              }
            : { ...old, generation: nextGeneration(old), enabled };
        registry.installations = registry.installations.map((current) =>
          current.id === id ? entry : current,
        );
        await this.publish(registry);
        return entry;
      }),
    );
  }

  openVersion(id: string, expected?: VersionSelection): Promise<OpenVersion> {
    return this.bounded(() =>
      this.writer(async () => {
        const entry = (await this.readRegistry()).installations.find(
          (entry) => entry.id === id,
        );
        if (
          !entry?.enabled ||
          !entry.digest ||
          !entry.manifest ||
          (expected &&
            (expected.id !== id ||
              expected.generation !== entry.generation ||
              expected.digest !== entry.digest))
        )
          throw new PackageError("unavailable");
        checkCompatibility(entry.manifest, this.runtime);
        const pin = await this.lock(`version-${entry.digest}`, false);
        if (!pin) throw new PackageError("busy");
        let released = false;
        try {
          const version = path.join(this.root, "versions", entry.digest);
          await directory(version);
          const marker = JSON.parse(
            (
              await readBoundedFile(
                path.join(version, ".omxterm-install.json"),
                128 * 1024,
              )
            ).toString("utf8"),
          ) as unknown;
          if (
            !isRecord(marker) ||
            marker.digest !== entry.digest ||
            JSON.stringify(marker.manifest) !== JSON.stringify(entry.manifest)
          )
            throw new PackageError("invalid-store");
          return {
            id,
            generation: entry.generation,
            digest: entry.digest,
            directory: version,
            manifest: entry.manifest,
            release: async () => {
              released = true;
              await pin.release();
            },
            revalidate: () =>
              this.bounded(() =>
                this.writer(async () => {
                  if (released) return false;
                  const current = (
                    await this.readRegistry()
                  ).installations.find((item) => item.id === id);
                  return (
                    current?.enabled === true &&
                    current.generation === entry.generation &&
                    current.digest === entry.digest
                  );
                }),
              ),
          };
        } catch (error) {
          await pin.release();
          throw error;
        }
      }),
    );
  }

  collect(): Promise<CleanupResult> {
    return this.bounded(async () => {
      const result: CleanupResult = { removed: [], pending: [] };
      const detached: { path: string; identity: string; pin: VersionLease }[] =
        [];
      try {
        await this.writer(async () => {
          const registry = await this.readRegistry();
          const referenced = new Set(
            registry.installations.map((entry) => entry.digest),
          );
          for (const kind of ["versions", "staging"] as const) {
            const entries = await readdir(path.join(this.root, kind));
            if (entries.length > MAX_SCAN)
              throw new PackageError("invalid-store");
            for (const identity of entries) {
              if (!(kind === "versions" ? DIGEST : UUID).test(identity))
                throw new PackageError("invalid-store");
              if (kind === "versions" && referenced.has(identity)) continue;
              if (detached.length >= 32) {
                result.pending.push(identity);
                continue;
              }
              const pin = await this.lock(
                `${kind === "versions" ? "version" : "stage"}-${identity}`,
                true,
              );
              if (!pin) {
                result.pending.push(identity);
                continue;
              }
              try {
                const source = path.join(this.root, kind, identity);
                await directory(source);
                const name = `${identity}-${randomUUID()}`;
                const target = path.join(this.root, "garbage", name);
                const garbagePin = await this.lock(`garbage-${name}`, true);
                if (!garbagePin) throw new PackageError("busy");
                try {
                  await rename(source, target);
                  detached.push({ path: target, identity, pin: garbagePin });
                } catch {
                  await garbagePin.release();
                  result.pending.push(identity);
                }
              } finally {
                await pin.release();
              }
            }
          }
          // Garbage is never selectable. A dedicated use lease protects deletion
          // outside the writer interval against concurrent cleanup passes.
          const garbage = await readdir(path.join(this.root, "garbage"));
          if (garbage.length > MAX_SCAN)
            throw new PackageError("invalid-store");
          for (const name of garbage) {
            if (detached.some((item) => path.basename(item.path) === name))
              continue;
            const identity = garbageIdentity(name);
            if (detached.length >= 32) {
              result.pending.push(identity);
              continue;
            }
            const source = path.join(this.root, "garbage", name);
            const garbagePin = await this.lock(`garbage-${name}`, true);
            if (!garbagePin) {
              result.pending.push(identity);
              continue;
            }
            try {
              await directory(source);
              detached.push({ path: source, identity, pin: garbagePin });
            } catch {
              await garbagePin.release();
              result.pending.push(identity);
            }
          }
          // Incomplete registry temp files are non-authoritative and writer-owned.
          for (const name of await readdir(this.root)) {
            if (
              name.startsWith("registry-") &&
              name.endsWith(".tmp") &&
              UUID.test(name.slice(9, -4))
            )
              await rm(path.join(this.root, name), { force: true });
          }
        });
        for (const item of detached) {
          try {
            await rm(item.path, { recursive: true, force: true });
            result.removed.push(item.identity);
          } catch {
            result.pending.push(item.identity);
          }
        }
        return result;
      } finally {
        await Promise.all(detached.map((item) => item.pin.release()));
      }
    });
  }
}
