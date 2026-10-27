import { app } from "electron";
import assert from "node:assert/strict";
import { writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeCases } from "./extension-runtime-cases.js";
import { packageArchive } from "./extension-package-archive.js";
import type * as RuntimeModule from "../../src/extension-runtime/electron-runtime.js";
import type * as StoreModule from "../../src/installed-packages/installed-packages.js";

const [build, root] = process.argv.slice(-2) as [string, string];
if (process.platform === "linux") app.commandLine.appendSwitch("no-sandbox");
app.setPath("userData", path.join(root, "profile"));
app.setPath("sessionData", path.join(root, "session"));
// Electron waits for the ESM entrypoint before emitting ready: never await ready
// at module top level. Register the actual fixture then finish module evaluation.
void app
  .whenReady()
  .then(run)
  .catch((error: unknown) => {
    console.error("fixture-setup-failed", error);
    app.exit(1);
  });
async function run(): Promise<void> {
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
  const marker = path.join(root, "imported");
  const operations = path.join(root, "operations");
  const archive = path.join(root, "runtime.omxext");
  await writeFile(
    archive,
    packageArchive([
      {
        name: "extension.json",
        data: JSON.stringify({
          format: 1,
          id: "test.runtime",
          version: "1.0.0",
          name: "Runtime fixture",
          engines: { omxterm: ">=0.23.0-0 <0.24.0", api: "0.1.x" },
          backend: "backend.mjs",
        }),
      },
      {
        name: "backend.mjs",
        data: `
import {writeFileSync, appendFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'imported');
export function activate({signal}) {
  return {
    invoke(value) {
      if (value === 'arm-loop') {
        process.on('SIGTERM', () => {});
        setTimeout(() => { while (true) {} }, 50);
        return 'armed';
      }
      appendFileSync(${JSON.stringify(operations)}, 'once\\n');
      return {value, debug:process.execArgv, nodeMode:process.env.ELECTRON_RUN_AS_NODE, internal:Object.keys(process.env).filter(k=>/^(OMXTERM_|NODE_OPTIONS)/i.test(k)), aborted:signal.aborted};
    },
    deactivate() {}
  };
}
`,
      },
    ]),
  );
  const installation = await store.install(archive, {
    expectedGeneration: 0,
    enabled: true,
  });
  const owner = new AbortController();
  const host = await createExtensionRuntime({
    root: storeRoot,
    runtime,
    addon,
    bootstrap: path.join(build, "bootstrap.mjs"),
    environment: {
      ...process.env,
      OMXTERM_RUNTIME_FIXTURE_SECRET: "must-not-inherit",
      NODE_OPTIONS: "--inspect=0",
    },
    owner: owner.signal,
  });
  const abortOwner = () => owner.abort();
  process.on("message", abortOwner);
  process.on("disconnect", abortOwner);
  const deadline = setTimeout(abortOwner, 45_000);
  let code = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  try {
    await assert.rejects(access(marker));
    const backend = await host.activate("test.runtime");
    assert.equal(await readFile(marker, "utf8"), "imported");
    assert.deepEqual(await backend.call({ operation: "once" }), {
      value: { operation: "once" },
      debug: [],
      nodeMode: "1",
      internal: [],
      aborted: false,
    });
    assert.equal(await readFile(operations, "utf8"), "once\n");
    const cooperative = await backend.retire();
    assert.equal(cooperative.settled, true);
    assert.equal(cooperative.streamsClosed, true);
    assert.equal(cooperative.exitObserved, true);
    assert.equal(cooperative.cooperative, true);
    assert.equal(cooperative.killRequested, false);
    console.log(
      JSON.stringify({
        case: "lazy-real-import-request-cooperative-exit",
        result: cooperative,
      }),
    );

    const looping = await host.activate("test.runtime");
    assert.notEqual(looping.epoch, backend.epoch);
    assert.equal(await looping.call("arm-loop"), "armed");
    await delay(150);
    await store.uninstall("test.runtime", installation.generation);
    const pinned = await store.collect();
    assert.ok(pinned.pending.includes(installation.digest!));
    assert.equal(pinned.removed.length, 0);
    let last = performance.now();
    let maximumGap = 0;
    ticker = setInterval(() => {
      const now = performance.now();
      maximumGap = Math.max(maximumGap, now - last);
      last = now;
    }, 20);
    const started = performance.now();
    const retirement = await looping.retire();
    const elapsed = performance.now() - started;
    await delay(60); // Let an overdue main timer report a synchronous kill stall.
    clearInterval(ticker);
    ticker = undefined;
    const collected = await store.collect();
    console.log(
      JSON.stringify({
        case: "noncooperative-loop-retirement",
        runtime: process.versions,
        platform: process.platform,
        arch: process.arch,
        elapsed,
        maximumGap,
        retirement,
        pinnedBeforeExit: pinned.pending.includes(installation.digest!),
        collectedAfterExit: collected.removed.includes(installation.digest!),
      }),
    );
    assert.ok(elapsed >= 2000, "two-second grace was shortened");
    assert.equal(retirement.settled, true);
    assert.equal(retirement.streamsClosed, true);
    assert.equal(retirement.exitObserved, true);
    assert.equal(retirement.killRequested, true);
    assert.equal(retirement.cooperative, false);
    assert.equal(collected.removed.includes(installation.digest!), true);
    assert.ok(
      maximumGap < 250,
      "main responsiveness exceeded 250ms during builtin retirement",
    );
    await runtimeCases(host, store, root);
    const finalBackend = await host.activate("test.runtime").catch(() => null);
    assert.equal(
      finalBackend,
      null,
      "uninstalled backend must not be admitted",
    );
    const owned = await host.activate("test.cancel");
    assert.equal(await owned.call("before-owner-abort"), "before-owner-abort");
    owner.abort();
    await assert.rejects(host.activate("test.cancel"), { code: "unavailable" });
    const ownedRetirement = await owned.retire();
    assert.equal(ownedRetirement.settled, true);
    assert.equal(ownedRetirement.cooperative, true);
    assert.equal(ownedRetirement.streamsClosed, true);
    console.log(
      JSON.stringify({
        case: "owner-abort-active-backend",
        retirement: ownedRetirement,
      }),
    );
  } catch (error) {
    code = 1;
    console.error(
      error instanceof Error
        ? error.name + ": " + error.message
        : "fixture failed",
    );
  } finally {
    if (ticker) clearInterval(ticker);
    const settlement = await host.dispose();
    console.log(
      JSON.stringify({ case: "fixture-owner-settlement", settlement }),
    );
    clearTimeout(deadline);
    process.removeListener("message", abortOwner);
    process.removeListener("disconnect", abortOwner);
    if (settlement.every((result) => result.settled)) {
      await writeFile(
        path.join(root, "settled.json"),
        JSON.stringify(settlement),
      );
      app.exit(code);
    } else {
      console.error("fixture-unsettled-retained");
      // Do not exit the owner and orphan an unobserved backend.
      process.exitCode = 1;
    }
  }
}
