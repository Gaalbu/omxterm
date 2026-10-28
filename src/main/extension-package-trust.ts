import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  extractPackage,
  PackageError,
  PACKAGE_LIMITS,
  readBoundedFile,
  type PackageManifest,
  type PackageRuntime,
} from "../installed-packages/archive.js";
import type { InstalledPackages } from "../installed-packages/installed-packages.js";

export type PackageTrustPreview = {
  token: string;
  digest: string;
  manifest: PackageManifest;
  expectedGeneration: number;
};
type Candidate = {
  token: string;
  bytes?: Buffer;
  preview?: PackageTrustPreview;
};

/** Main-owned, one-shot consent. Owner identities are infrastructure objects,
 * never renderer-supplied window IDs. No module imports or runtime activation. */
export function createExtensionPackageTrust(options: {
  packages: Pick<InstalledPackages, "snapshot" | "install">;
  runtime: PackageRuntime;
  temporaryDirectory: string;
}) {
  const candidates = new Map<object, Candidate>();
  let preparing = 0;
  let disposed = false;
  const current = (owner: object, candidate: Candidate) =>
    !disposed && candidates.get(owner) === candidate;
  return {
    async prepare(
      owner: object,
      filename: string,
    ): Promise<PackageTrustPreview> {
      if (disposed) throw new PackageError("unavailable");
      if (preparing >= 4 || (!candidates.has(owner) && candidates.size >= 4))
        throw new PackageError("busy");
      // Supersession revokes the previous approval before touching the source.
      const candidate: Candidate = { token: randomUUID() };
      candidates.set(owner, candidate);
      preparing++;
      let temporary: string | undefined;
      try {
        if (path.extname(filename).toLowerCase() !== ".omxext")
          throw new PackageError("invalid-package");
        const bytes = await readBoundedFile(
          filename,
          PACKAGE_LIMITS.archiveBytes,
        );
        temporary = await mkdtemp(
          path.join(options.temporaryDirectory, "omxterm-trust-"),
        );
        const validated = await extractPackage(
          bytes,
          temporary,
          options.runtime,
        );
        const installed = (await options.packages.snapshot()).find(
          (entry) => entry.id === validated.manifest.id,
        );
        if (!current(owner, candidate)) throw new PackageError("unavailable");
        candidate.bytes = bytes;
        candidate.preview = {
          token: candidate.token,
          ...validated,
          expectedGeneration: installed?.generation ?? 0,
        };
        // IPC/UI metadata cannot mutate the retained consent record.
        return structuredClone(candidate.preview);
      } catch (error) {
        if (current(owner, candidate)) candidates.delete(owner);
        throw error;
      } finally {
        preparing--;
        if (temporary) {
          try {
            await rm(temporary, { recursive: true, force: true });
          } catch {
            if (current(owner, candidate)) candidates.delete(owner);
            throw new PackageError("unavailable");
          }
        }
      }
    },
    async approve(owner: object, token: string) {
      const candidate = candidates.get(owner);
      if (
        disposed ||
        !candidate?.bytes ||
        !candidate.preview ||
        candidate.token !== token
      )
        throw new PackageError("unavailable");
      // Consume before dispatch: publication errors/transport loss are never
      // permission to repeat an effectful installation with the same consent.
      candidates.delete(owner);
      return options.packages.install(candidate.bytes, {
        expectedGeneration: candidate.preview.expectedGeneration,
        enabled: true,
      });
    },
    cancel(owner: object): void {
      candidates.delete(owner);
    },
    dispose(): void {
      disposed = true;
      candidates.clear();
    },
  };
}
