import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtensionLeases } from "./build-extension-leases.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const outdir = path.resolve(
  process.argv[2] ?? path.join(root, "dist/extension-runtime"),
);
await buildExtensionLeases(outdir);
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
