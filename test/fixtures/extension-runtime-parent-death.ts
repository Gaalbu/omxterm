import { app } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packageArchive } from "./extension-package-archive.js";
import type * as RuntimeModule from "../../src/extension-runtime/electron-runtime.js";
import type * as StoreModule from "../../src/installed-packages/installed-packages.js";

const [build, root, role] = process.argv.slice(-3) as [string, string, string];
app.commandLine.appendSwitch("no-sandbox");
app.setPath("userData", path.join(root, role + "-profile"));
app.setPath("sessionData", path.join(root, role + "-session"));
const owner = new AbortController();
let stop!: () => void;
let collect!: () => void;
const stopped = new Promise<void>((resolve) => {
  stop = resolve;
});
const collecting = new Promise<void>((resolve) => {
  collect = resolve;
});
const release = path.join(root, "release");
function requestStop() {
  stop();
  owner.abort();
}
process.on("message", (message) => {
  if (message === "stop") requestStop();
  if (message === "collect") collect();
});
process.on("disconnect", requestStop);
const deadline = setTimeout(requestStop, 60_000);
function report(value: object) {
  process.send?.(value);
  console.log(JSON.stringify(value));
}
void app
  .whenReady()
  .then(run)
  .catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });
async function run() {
  let host: RuntimeModule.ExtensionRuntime | undefined;
  let code = 0;
  try {
    const { createExtensionRuntime } = (await import(
      pathToFileURL(path.join(build, "index.mjs")).href
    )) as typeof RuntimeModule;
    const { InstalledPackages, createNativeLeaseAdapter } = (await import(
      pathToFileURL(path.join(build, "packages.mjs")).href
    )) as typeof StoreModule;
    const runtime = { appVersion: "0.23.0-dev.4", apiVersion: "0.1.0" };
    const addon = path.join(build, "extension-leases.node");
    const storeRoot = path.join(root, "store");
    const store = await InstalledPackages.open({
      root: storeRoot,
      runtime,
      leases: createNativeLeaseAdapter(addon),
    });
    host = await createExtensionRuntime({
      root: storeRoot,
      runtime,
      addon,
      bootstrap: path.join(build, "bootstrap.mjs"),
      environment: process.env,
      owner: owner.signal,
    });
    async function install(id: string, source: string) {
      const archive = path.join(root, id + ".omxext");
      await writeFile(
        archive,
        packageArchive([
          {
            name: "extension.json",
            data: JSON.stringify({
              format: 1,
              id,
              version: "1.0.0",
              name: "Parent death fixture",
              engines: { omxterm: ">=0.23.0-0 <0.24.0", api: "0.1.x" },
              backend: "backend.mjs",
            }),
          },
          { name: "backend.mjs", data: source },
        ]),
      );
      return store.install(archive, { expectedGeneration: 0, enabled: true });
    }
    if (role === "parent") {
      const installation = await install(
        "test.parent",
        `
import {writeFileSync, existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
export function activate() { return {
  invoke() { return {pid: process.pid}; },
  async deactivate() {
    writeFileSync(${JSON.stringify(path.join(root, "waiting"))}, 'waiting');
    const deadline = performance.now() + 30000;
    while (!existsSync(${JSON.stringify(release)}) && performance.now() < deadline) await delay(10);
    writeFileSync(${JSON.stringify(path.join(root, "released"))}, existsSync(${JSON.stringify(release)}) ? 'controlled' : 'timeout');
  }
}; }
`,
      );
      await writeFile(
        path.join(root, "installation.json"),
        JSON.stringify(installation),
      );
      const backend = await host.activate("test.parent");
      report({
        kind: "ready",
        diagnostic: await backend.call(null),
        installation,
        mainPid: process.pid,
      });
    } else {
      assert.equal(role, "manager");
      const installation = JSON.parse(
        await readFile(path.join(root, "installation.json"), "utf8"),
      ) as { generation: number; digest: string };
      assert.equal(
        await readFile(path.join(root, "waiting"), "utf8"),
        "waiting",
      );
      await store.uninstall("test.parent", installation.generation);
      const pending = await store.collect();
      assert.ok(pending.pending.includes(installation.digest));
      assert.ok(!pending.removed.includes(installation.digest));
      await assert.rejects(host.activate("test.parent"));
      await install(
        "test.unrelated",
        "export function activate() { return { invoke(value) { return value; } }; }",
      );
      const fresh = await host.activate("test.unrelated");
      assert.equal(await fresh.call("fresh-admission"), "fresh-admission");
      const retirement = await fresh.retire();
      assert.equal(retirement.settled, true);
      assert.equal(retirement.cooperative, true);
      const stillPending = await store.collect();
      assert.ok(stillPending.pending.includes(installation.digest));
      report({ kind: "managed", pending, stillPending, retirement });
      await Promise.race([collecting, stopped]);
      if (!owner.signal.aborted) {
        const collected = await store.collect();
        assert.ok(collected.removed.includes(installation.digest));
        report({ kind: "collected", collected });
      }
    }
    await stopped;
  } catch (error) {
    code = 1;
    console.error(error);
  } finally {
    await writeFile(release, "release");
    const settlement = (await host?.dispose()) ?? [];
    clearTimeout(deadline);
    report({ kind: "settled", role, settlement });
    if (settlement.every((item) => item.settled)) {
      await writeFile(
        path.join(root, role + "-settled.json"),
        JSON.stringify(settlement),
      );
      app.exit(code);
    } else {
      console.error("unsettled-owner-retained");
      process.exitCode = 1;
    }
  }
}
