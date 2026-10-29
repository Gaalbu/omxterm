import { buildExtension } from "./build-files-extension.mjs";
if (process.argv.length > 4)
  throw new Error("Usage: build-ssh-extension.mjs [OUTPUT [SOURCE_COMMIT]]");
await buildExtension("ssh", process.argv[2], process.argv[3]);
console.log(
  "Built separate SSH Connect archive, checksum and unqualified build receipt.",
);
