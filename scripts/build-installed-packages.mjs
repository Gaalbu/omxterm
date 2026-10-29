import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtensionLeases } from "./build-extension-leases.mjs";

// Internal checkpoint artifact; deliberately not loaded by application startup.
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(
  process.argv[2] ?? path.join(root, "dist/installed-packages"),
);
await buildExtensionLeases(output);
await build({
  absWorkingDir: root,
  entryPoints: ["src/installed-packages/installed-packages.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["yauzl", "semver"],
  outfile: path.join(output, "index.mjs"),
});
