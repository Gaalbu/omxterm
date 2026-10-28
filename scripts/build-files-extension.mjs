import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Maintainer build only. Users select the resulting precompiled archive; they
// never run npm, Python, an installation hook or a source compiler to install it.
const root = path.resolve(import.meta.dirname, "..");
const output = path.resolve(
  process.argv[2] ?? path.join(root, "dist/extensions/files-0.1.0.omxext"),
);
const stage = await mkdtemp(path.join(os.tmpdir(), "omxterm-files-build-"));
try {
  await build({
    absWorkingDir: root,
    entryPoints: ["extensions/files/backend.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(stage, "backend.mjs"),
  });
  await build({
    absWorkingDir: root,
    entryPoints: ["extensions/files/view.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: path.join(stage, "view.js"),
  });
  for (const name of ["index.html", "files.css"])
    await cp(path.join(root, "extensions/files", name), path.join(stage, name));
  await cp(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
  await writeFile(
    path.join(stage, "extension.json"),
    JSON.stringify({
      format: 1,
      id: "omxterm.files",
      version: "0.1.0",
      name: "Files — Linux ARM64 preview",
      engines: { omxterm: ">=0.23.0-dev.5 <0.24.0", api: "0.1.x" },
      backend: "backend.mjs",
      view: {
        entry: "index.html",
        action: "omxterm.files.open",
        title: "Files",
      },
    }),
  );
  await mkdir(path.dirname(output), { recursive: true });
  execFileSync(
    "python3",
    [
      "-c",
      `import pathlib,sys,zipfile
source=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'x', compression=zipfile.ZIP_DEFLATED) as archive:
 for name in ['extension.json','backend.mjs','index.html','files.css','view.js','LICENSE']:
  entry=zipfile.ZipInfo(name, (2026,1,1,0,0,0))
  entry.external_attr=0o100600 << 16
  entry.compress_type=zipfile.ZIP_DEFLATED
  archive.writestr(entry, (source/name).read_bytes())
`,
      stage,
      output,
    ],
    { stdio: "pipe", timeout: 30_000 },
  );
  console.log("Built separately installable Files preview archive.");
} finally {
  await rm(stage, { recursive: true, force: true });
}
