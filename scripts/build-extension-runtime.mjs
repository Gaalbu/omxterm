import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtensionLeases } from "./build-extension-leases.mjs";
import { buildFilesMove } from "./build-files-move.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildExtensionRuntime(outputDirectory) {
  const outdir = path.resolve(outputDirectory);
  await buildExtensionLeases(outdir);
  await buildFilesMove(outdir);
  await build({
    absWorkingDir: root,
    entryPoints: {
      index: "src/extension-runtime/electron-runtime.ts",
      bootstrap: "src/extension-runtime/bootstrap.ts",
      packages: "src/installed-packages/installed-packages.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["electron", "yauzl", "semver"],
    outExtension: { ".js": ".mjs" },
    outdir,
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildExtensionRuntime(
    process.argv[2] ?? path.join(root, "dist/extension-runtime"),
  );
}
