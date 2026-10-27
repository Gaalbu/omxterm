// One owned process, no descendants. Parent joins actual exit/stream closure.
import path from "node:path";
import { pathToFileURL } from "node:url";
const [bundle, root, mode, archive] = process.argv.slice(2);
const { InstalledPackages, createNativeLeaseAdapter } = await import(
  pathToFileURL(bundle).href
);
const native = createNativeLeaseAdapter(
  path.join(path.dirname(bundle), "extension-leases.node"),
);
let armed = false;
process.on("message", () => {});
const leases = {
  async tryAcquire(file, exclusive) {
    const lease = await native.tryAcquire(file, exclusive);
    if (!lease || !armed || !file.endsWith("writer.lock")) return lease;
    if (mode === "before-publication") {
      process.send("boundary");
      await new Promise(() => {});
    }
    if (mode === "after-publication") {
      return {
        release: async () => {
          process.send("boundary");
          await new Promise(() => {});
        },
      };
    }
    return lease;
  },
};
const store = await InstalledPackages.open({
  root,
  runtime: { appVersion: "0.23.0-dev.1", apiVersion: "0.1.0" },
  leases,
});
armed = true;
if (mode === "pin") {
  const use = await store.openVersion("test.files");
  process.send({ kind: "pinned", digest: use.digest });
  process.on("message", async (message) => {
    if (message === "release") {
      await use.release();
      process.disconnect();
    }
  });
} else {
  await store.install(archive, { expectedGeneration: 1, enabled: true });
  throw new Error("fixture failed to hold publication boundary");
}
