import { createHash, randomUUID } from "node:crypto";
import {
  CatalogError,
  catalogAction,
  type CatalogRelease,
} from "./extension-catalog";
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

// Distinguish known preapproval revocation from validation/cleanup failure.
export class PackageTrustRevokedError extends PackageError {
  constructor() {
    super("unavailable");
  }
}

export type PackageTrustPreview = {
  token: string;
  digest: string;
  manifest: PackageManifest;
  expectedGeneration: number;
  catalogAction?: "install" | "update" | "reinstall" | "replace";
};
type Candidate = {
  token: string;
  bytes?: Buffer;
  preview?: PackageTrustPreview;
};

function verifyCatalogBytes(
  release: CatalogRelease | undefined,
  bytes: Buffer,
) {
  if (
    release &&
    (bytes.length !== release.archive.bytes ||
      createHash("sha256").update(bytes).digest("hex") !==
        release.archive.sha256)
  )
    throw new CatalogError("catalog-mismatch");
}
function verifyCatalogManifest(
  release: CatalogRelease | undefined,
  manifest: PackageManifest,
) {
  if (
    release &&
    (manifest.id !== release.id ||
      manifest.version !== release.version ||
      manifest.engines.omxterm !== release.engines.omxterm ||
      manifest.engines.api !== release.engines.api)
  )
    throw new CatalogError("catalog-mismatch");
}

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
      source: string | Buffer,
      expected?: CatalogRelease,
    ): Promise<PackageTrustPreview> {
      const release = expected ? structuredClone(expected) : undefined;
      if (disposed) throw new PackageError("unavailable");
      if (preparing >= 4 || (!candidates.has(owner) && candidates.size >= 4))
        throw new PackageError("busy");
      // Supersession revokes the previous approval before touching the source.
      const candidate: Candidate = { token: randomUUID() };
      candidates.set(owner, candidate);
      preparing++;
      let temporary: string | undefined;
      try {
        if (
          typeof source === "string" &&
          path.extname(source).toLowerCase() !== ".omxext"
        )
          throw new PackageError("invalid-package");
        if (
          Buffer.isBuffer(source) &&
          source.length > PACKAGE_LIMITS.archiveBytes
        )
          throw new PackageError("invalid-package");
        const bytes =
          typeof source === "string"
            ? await readBoundedFile(source, PACKAGE_LIMITS.archiveBytes)
            : Buffer.from(source);
        verifyCatalogBytes(release, bytes);
        temporary = await mkdtemp(
          path.join(options.temporaryDirectory, "omxterm-trust-"),
        );
        const validated = await extractPackage(
          bytes,
          temporary,
          options.runtime,
        );
        verifyCatalogManifest(release, validated.manifest);
        const installed = (await options.packages.snapshot()).find(
          (entry) => entry.id === validated.manifest.id,
        );
        if (!current(owner, candidate)) throw new PackageTrustRevokedError();
        candidate.bytes = bytes;
        candidate.preview = {
          token: candidate.token,
          ...validated,
          expectedGeneration: installed?.generation ?? 0,
          ...(release
            ? {
                catalogAction: catalogAction(
                  release,
                  installed
                    ? {
                        version: installed.manifest?.version ?? null,
                        digest: installed.digest,
                      }
                    : undefined,
                ),
              }
            : {}),
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
