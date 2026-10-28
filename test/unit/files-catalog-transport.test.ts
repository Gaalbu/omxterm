import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { downloadExtension } from "../../src/main/extension-download";
import { OFFICIAL_CATALOG_URL } from "../../src/main/extension-catalog";
const require = createRequire(import.meta.url);
it.skipIf(process.platform === "win32")(
  "the controlled packaged catalog origin supplies real TLS and closes/restores its exact interception",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omxterm-catalog-tls-"));
    const helper = require("../fixtures/files-catalog-transport.cjs") as {
      start(
        options: Record<string, string>,
      ): Promise<{
        requests: string[];
        available(value: boolean): void;
        validArchive(value: boolean): void;
        close(): Promise<void>;
      }>;
    };
    let transport: Awaited<ReturnType<typeof helper.start>> | undefined;
    try {
      const archive = path.join(root, "files.omxext");
      const archiveUrl =
        "https://github.com/luizomf/omxterm/releases/download/ext-files-v0.1.0/files.omxext";
      const bytes = Buffer.from("fixture bytes");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const catalogFile = path.join(root, "catalog.json");
      const catalogCertificate = path.join(root, "cert.pem");
      const catalogKey = path.join(root, "key.pem");
      await writeFile(archive, bytes);
      await writeFile(
        catalogFile,
        JSON.stringify({
          entries: [{ archive: { url: archiveUrl, sha256: hash } }],
        }),
      );
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          catalogKey,
          "-out",
          catalogCertificate,
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { timeout: 10000, stdio: "pipe" },
      );
      transport = await helper.start({
        archive,
        archiveSha256: hash,
        catalogFile,
        catalogCertificate,
        catalogKey,
      });
      const signal = new AbortController().signal;
      await expect(
        downloadExtension(OFFICIAL_CATALOG_URL, signal, 262144),
      ).rejects.toThrow("download-failed");
      transport.available(true);
      expect(
        await downloadExtension(OFFICIAL_CATALOG_URL, signal, 262144),
      ).toEqual(await readFile(catalogFile));
      expect(await downloadExtension(archiveUrl, signal)).toEqual(
        Buffer.from("wrong bytes"),
      );
      transport.validArchive(true);
      expect(await downloadExtension(archiveUrl, signal)).toEqual(bytes);
      expect(transport.requests).toEqual([
        "/catalog",
        "/catalog",
        "/archive",
        "/archive",
      ]);
      await transport.close();
      await transport.close();
    } finally {
      await transport?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
