import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fromBufferPromise } from "yauzl";

// Consumes existing immutable artifacts; does not rebuild, publish or relabel
// their source/qualification. Source metadata is the same input as the builder.
export async function createFilesCatalog(archive, output) {
  const bytes = await readFile(archive);
  const receipt = JSON.parse(await readFile(archive + ".json", "utf8"));
  const metadata = JSON.parse(
    await readFile(
      new URL("../extensions/files/extension.json", import.meta.url),
      "utf8",
    ),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    receipt.format !== 1 ||
    receipt.archive?.name !== path.basename(archive) ||
    receipt.archive?.bytes !== bytes.length ||
    receipt.archive?.sha256 !== sha256 ||
    !/^[a-f0-9]{40}$/.test(receipt.source?.commit ?? "") ||
    JSON.stringify(receipt.manifest) !== JSON.stringify(metadata)
  )
    throw new Error("Archive receipt/metadata mismatch");
  if (
    (await readFile(archive + ".sha256", "utf8")) !==
    `${sha256}  ${path.basename(archive)}\n`
  )
    throw new Error("Archive checksum mismatch");
  const zip = await fromBufferPromise(bytes, { lazyEntries: true });
  let manifest;
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== "extension.json") continue;
      if (manifest || entry.uncompressedSize > 65536)
        throw new Error("Invalid archive manifest");
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      let length = 0;
      for await (const chunk of stream) {
        length += chunk.length;
        if (length > 65536) throw new Error("Oversized manifest");
        chunks.push(chunk);
      }
      manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
  } finally {
    zip.close();
  }
  if (JSON.stringify(manifest) !== JSON.stringify(metadata))
    throw new Error("Archive manifest mismatch");
  const tag = `ext-files-v${metadata.version}`;
  const releaseUrl = `https://github.com/luizomf/omxterm/releases/tag/${tag}`;
  const catalog = {
    schemaVersion: 1,
    entries: [
      {
        id: metadata.id,
        name: metadata.name,
        description:
          "Project-maintained local file manager preview: browse, create, rename, move, trash and delete files.",
        version: metadata.version,
        engines: metadata.engines,
        targets: ["linux-arm64"],
        archive: {
          url: `https://github.com/luizomf/omxterm/releases/download/${tag}/${receipt.archive.name}`,
          sha256,
          bytes: bytes.length,
        },
        sourceCommit: receipt.source.commit,
        releaseUrl,
      },
    ],
  };
  await writeFile(output, JSON.stringify(catalog, null, 2) + "\n", {
    flag: "wx",
  });
  return catalog;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 4)
    throw new Error("Usage: create-files-catalog.mjs ARCHIVE OUTPUT");
  await createFilesCatalog(process.argv[2], process.argv[3]);
  console.log(
    "Created catalog candidate; assets must be published and verified before promotion.",
  );
}
