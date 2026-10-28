import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

// Called by the Node test worker before Electron launch. Node-API 8 addon and
// the production ESM store artifact belong to the supervised fixture root.
export async function buildExtensionFixturePackages(root: string) {
  await execute(
    process.execPath,
    [
      path.join(projectRoot, "scripts/build-installed-packages.mjs"),
      path.join(root, "installed-packages"),
    ],
    { cwd: projectRoot, timeout: 90_000 },
  );
}
