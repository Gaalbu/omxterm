import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { packageArchive } from "./extension-package-archive.js";
import type { ExtensionRuntime } from "../../src/extension-runtime/runtime.js";
import type { InstalledPackages } from "../../src/installed-packages/installed-packages.js";

export async function marker(file: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    try {
      await access(file);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error("fixture-marker-timeout");
}

export async function runtimeCases(
  host: ExtensionRuntime,
  store: InstalledPackages,
  root: string,
): Promise<void> {
  async function install(id: string, source: string) {
    const archive = path.join(root, `${id}.omxext`);
    await writeFile(
      archive,
      packageArchive([
        {
          name: "extension.json",
          data: JSON.stringify({
            format: 1,
            id,
            version: "1.0.0",
            name: "Native runtime case",
            engines: { omxterm: ">=0.23.0-0 <0.24.0", api: "0.1.x" },
            backend: "backend.mjs",
          }),
        },
        { name: "backend.mjs", data: source },
      ]),
    );
    return store.install(archive, { expectedGeneration: 0, enabled: true });
  }
  const started = path.join(root, "cancel-started");
  const cancelled = path.join(root, "cancel-observed");
  await install(
    "test.cancel",
    `
import {writeFileSync} from 'node:fs';
export function activate() { return { invoke(value, signal) {
  if (value !== 'wait') return value;
  writeFileSync(${JSON.stringify(started)}, 'started');
  return new Promise(resolve => signal.addEventListener('abort', () => {
    writeFileSync(${JSON.stringify(cancelled)}, 'cancelled'); resolve('late');
  }, {once:true}));
}}; }`,
  );
  const backend = await host.activate("test.cancel");
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(backend.call("wait", pre.signal), { code: "cancelled" });
  await assert.rejects(access(started));
  const abort = new AbortController();
  const pending = assert.rejects(backend.call("wait", abort.signal), {
    code: "outcome-unknown",
  });
  await marker(started);
  abort.abort();
  await pending;
  await marker(cancelled);
  assert.equal(await backend.call("still-usable"), "still-usable");
  assert.equal((await backend.retire()).settled, true);
  console.log(
    JSON.stringify({ case: "cancel-before-and-after-dispatch", passed: true }),
  );

  const disconnected = path.join(root, "channel-deactivated");
  const release = path.join(root, "channel-release");
  const installation = await install(
    "test.channel",
    `
import {writeFileSync, existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
export function activate() { return {
 invoke() { process.disconnect(); return null; },
 async deactivate() {
   writeFileSync(${JSON.stringify(disconnected)}, 'deactivated');
   while (!existsSync(${JSON.stringify(release)})) await delay(10);
 }
}; }`,
  );
  // The child's own Node channel disconnect triggers actual production cleanup.
  // Hold deactivate with a live timer to prove its independent pin remains held.
  const channel = await host.activate("test.channel");
  await assert.rejects(channel.call(null), { code: "outcome-unknown" });
  await marker(disconnected);
  await store.uninstall("test.channel", installation.generation);
  assert.ok((await store.collect()).pending.includes(installation.digest!));
  const fresh = await host.activate("test.cancel");
  assert.notEqual(fresh.epoch, backend.epoch);
  assert.equal(await fresh.call("fresh-admission"), "fresh-admission");
  assert.equal((await fresh.retire()).settled, true);
  await writeFile(release, "release");
  const retirement = await channel.retire();
  assert.equal(retirement.settled, true);
  assert.equal(retirement.exitObserved, true);
  assert.equal(retirement.streamsClosed, true);
  assert.equal(retirement.killRequested, false);
  assert.equal(retirement.exitCode, 0);
  assert.equal(
    retirement.cooperative,
    false,
    "lost channel has no cooperation receipt",
  );
  assert.ok((await store.collect()).removed.includes(installation.digest!));
  console.log(
    JSON.stringify({ case: "actual-channel-death-held-pin", retirement }),
  );

  for (const kind of ["refusing", "looping"] as const) {
    const imported = path.join(root, `${kind}-import`);
    const installed = await install(
      `test.${kind}`,
      `
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(imported)}, 'imported');
${kind === "looping" ? "while (true) {}" : "await new Promise(() => {});"}
export function activate() { throw new Error('unreachable'); }`,
    );
    const activation = assert.rejects(host.activate(`test.${kind}`));
    await marker(imported);
    assert.equal(await readFile(imported, "utf8"), "imported");
    await store.uninstall(`test.${kind}`, installed.generation);
    assert.ok((await store.collect()).pending.includes(installed.digest!));
    const before = performance.now();
    const result = await host.retire(`test.${kind}`);
    await activation;
    assert.ok(result?.settled);
    assert.equal(result.exitObserved, true);
    assert.equal(result.streamsClosed, true);
    assert.equal(result.killRequested, true);
    assert.ok(
      performance.now() - before >= 2000,
      "two-second grace was shortened",
    );
    assert.ok((await store.collect()).removed.includes(installed.digest!));
    console.log(
      JSON.stringify({ case: `${kind}-esm-import`, retirement: result }),
    );
  }
}
