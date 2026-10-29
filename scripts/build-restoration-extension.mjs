import { buildExtension } from "./build-files-extension.mjs";
if (process.argv.length > 4)
  throw new Error(
    "Usage: build-restoration-extension.mjs [OUTPUT [SOURCE_COMMIT]]",
  );
await buildExtension("restoration", process.argv[2], process.argv[3]);
console.log(
  "Built separate Saved Layout archive, checksum and unqualified build receipt.",
);
