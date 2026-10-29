import { createHash } from "node:crypto";
import type { CatalogRelease } from "../../src/main/extension-catalog";
export function catalogBytes(
  manifest: Pick<CatalogRelease, "id" | "name" | "version" | "engines">,
  bytes: Buffer,
): Buffer {
  const tag = `ext-files-v${manifest.version}`;
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          engines: manifest.engines,
          description: "Files preview",
          targets: ["linux-arm64"],
          archive: {
            url: `https://github.com/luizomf/omxterm/releases/download/${tag}/files.omxext`,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          sourceCommit: "a".repeat(40),
          releaseUrl: `https://github.com/luizomf/omxterm/releases/tag/${tag}`,
        },
      ],
    }),
  );
}
