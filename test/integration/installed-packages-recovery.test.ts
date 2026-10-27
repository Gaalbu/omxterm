import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  InstalledPackages,
  createNativeLeaseAdapter,
  type LeaseAdapter,
  type VersionLease,
} from "../../src/installed-packages/installed-packages.js";
import { packageArchive } from "../fixtures/extension-package-archive.js";

const runtime = { appVersion: "0.23.0-dev.1", apiVersion: "0.1.0" };
const manifest = {
  format: 1,
  id: "test.files",
  version: "1.0.0",
  name: "Fixture",
  engines: { omxterm: ">=0.23.0-0", api: "0.1.x" },
  backend: "index.mjs",
};
let build: string, root: string, archive: string;
let native: LeaseAdapter, store: InstalledPackages;
beforeAll(async () => {
  await mkdir(".scratch", { recursive: true });
  build = await mkdtemp(path.resolve(".scratch/package-recovery-build-"));
  await promisify(execFile)(
    process.execPath,
    [path.resolve("scripts/build-installed-packages.mjs"), build],
    { timeout: 90_000 },
  );
  native = createNativeLeaseAdapter(path.join(build, "extension-leases.node"));
}, 100_000);
afterAll(async () => {
  if (build) await rm(build, { recursive: true, force: true });
});
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "package-recovery-"));
  store = await openStore(native);
  archive = path.join(root, "fixture.omxext");
  await writeFile(
    archive,
    packageArchive([
      { name: "extension.json", data: JSON.stringify(manifest) },
      { name: "index.mjs", data: "// never executed" },
    ]),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function openStore(leases: LeaseAdapter) {
  return InstalledPackages.open({
    root: path.join(root, "store"),
    runtime,
    leases,
  });
}

it("never resets lost generation history after all package bytes were collected", async () => {
  await store.install(archive, { expectedGeneration: 0, enabled: true });
  await store.uninstall(manifest.id, 1);
  await store.collect();
  expect(await readdir(path.join(root, "store/versions"))).toEqual([]);
  await rm(path.join(root, "store/registry.json"));
  await expect(openStore(native)).rejects.toMatchObject({
    code: "invalid-store",
  });
  expect(await readFile(path.join(root, "store/initialized"), "utf8")).toBe(
    "installed-packages-v1\n",
  );
});

it.each(["writer", "stage", "both"])(
  "reports postpublication %s release failure as unknown and still retires other handles",
  async (kind) => {
    let armed = false;
    const adapter: LeaseAdapter = {
      async tryAcquire(file, exclusive) {
        const pin = await native.tryAcquire(file, exclusive);
        if (!pin) return null;
        return {
          async release() {
            await pin.release();
            if (
              armed &&
              (kind === "both" || path.basename(file).startsWith(kind))
            ) {
              if (kind !== "both") armed = false;
              throw new Error("controlled release failure");
            }
          },
        };
      },
    };
    const failing = await openStore(adapter);
    armed = true;
    await expect(
      failing.install(archive, { expectedGeneration: 0, enabled: true }),
    ).rejects.toMatchObject({ code: "outcome-unknown", cleanupFailed: true });
    expect((await store.snapshot())[0]?.generation).toBe(1);
    expect(await readdir(path.join(root, "store/staging"))).toEqual([]);
  },
);

it("preserves prepublication conflict and lost publication receipt through cleanup failure", async () => {
  let armed = false;
  const adapter: LeaseAdapter = {
    async tryAcquire(file, exclusive) {
      const pin = await native.tryAcquire(file, exclusive);
      if (!pin) return null;
      return {
        async release() {
          await pin.release();
          if (armed && file.endsWith("writer.lock")) {
            armed = false;
            throw new Error("release failure");
          }
        },
      };
    },
  };
  const failing = await openStore(adapter);
  armed = true;
  await expect(
    failing.install(archive, { expectedGeneration: 7, enabled: true }),
  ).rejects.toMatchObject({ code: "conflict", cleanupFailed: true });
  const registry = path.join(root, "store/registry.json");
  const before = await readFile(registry);
  let blockReplace = false;
  const blocker: LeaseAdapter = {
    async tryAcquire(file, exclusive) {
      const pin = await native.tryAcquire(file, exclusive);
      if (pin && blockReplace && file.endsWith("writer.lock")) {
        blockReplace = false;
        // Real publication succeeds, but its caller loses the writer-release
        // receipt. This is an unknown requester outcome, not a simulated rollback.
        return {
          async release() {
            await pin.release();
            throw new Error("receipt lost");
          },
        };
      }
      return pin;
    },
  };
  const losingReceipt = await openStore(blocker);
  blockReplace = true;
  await expect(
    losingReceipt.install(archive, { expectedGeneration: 0, enabled: true }),
  ).rejects.toMatchObject({ code: "outcome-unknown", cleanupFailed: true });
  expect(await readFile(registry)).not.toEqual(before);
});

it.skipIf(process.platform === "win32")(
  "preserves uncertainty when real staging removal fails after publication",
  async () => {
    await store.install(archive, { expectedGeneration: 0, enabled: true });
    let armed = false;
    const staging = path.join(root, "store/staging");
    const adapter: LeaseAdapter = {
      async tryAcquire(file, exclusive) {
        const pin = await native.tryAcquire(file, exclusive);
        if (!pin) return null;
        return {
          async release() {
            await pin.release();
            if (armed && file.endsWith("writer.lock")) {
              armed = false;
              await chmod(staging, 0o500);
            }
          },
        };
      },
    };
    const failing = await openStore(adapter);
    armed = true;
    try {
      await expect(
        failing.install(archive, { expectedGeneration: 1, enabled: true }),
      ).rejects.toMatchObject({ code: "outcome-unknown", cleanupFailed: true });
      expect((await store.snapshot())[0]?.generation).toBe(2);
    } finally {
      await chmod(staging, 0o700);
    }
    expect((await store.collect()).pending).toEqual([]);
  },
);

it("retires an acquired version pin if its writer-release receipt fails", async () => {
  const installed = await store.install(archive, {
    expectedGeneration: 0,
    enabled: true,
  });
  let armed = false;
  const adapter: LeaseAdapter = {
    async tryAcquire(file, exclusive) {
      const pin = await native.tryAcquire(file, exclusive);
      if (!pin) return null;
      return {
        async release() {
          await pin.release();
          if (armed && file.endsWith("writer.lock")) {
            armed = false;
            throw new Error("release receipt lost");
          }
        },
      };
    },
  };
  const failing = await openStore(adapter);
  armed = true;
  await expect(failing.openVersion(manifest.id)).rejects.toMatchObject({
    code: "invalid-store",
    cleanupFailed: true,
  });
  await store.uninstall(manifest.id, 1);
  expect((await store.collect()).removed).toContain(installed.digest);
});

it("bounds lock attempts under writer exclusion and continues past pinned entries", async () => {
  const pins: VersionLease[] = [];
  for (let i = 0; i < 40; i++) {
    const name = randomUUID();
    pins.push(
      (await native.tryAcquire(
        path.join(root, `store/locks/stage-${name}.lock`),
        false,
      ))!,
    );
    await mkdir(path.join(root, "store/staging", name));
  }
  let attempts = 0;
  const counting: LeaseAdapter = {
    async tryAcquire(file, exclusive) {
      if (path.basename(file).startsWith("stage-")) attempts++;
      return native.tryAcquire(file, exclusive);
    },
  };
  const collector = await openStore(counting);
  try {
    const first = await collector.collect();
    expect(first.pending).toHaveLength(32);
    expect(first.more).toBe(true);
    expect(attempts).toBe(32);
    attempts = 0;
    const second = await collector.collect();
    expect(second.pending).toHaveLength(8);
    expect(second.more).toBe(false);
    expect(attempts).toBe(8);
  } finally {
    await Promise.all(pins.map((pin) => pin.release()));
  }
});

it("bounds abandoned registry temp cleanup and tolerates normal stage disappearance", async () => {
  for (let i = 0; i < 40; i++)
    await writeFile(
      path.join(root, `store/registry-${randomUUID()}.tmp`),
      "incomplete",
    );
  expect((await store.collect()).removed).toHaveLength(32);
  expect((await store.collect()).removed).toHaveLength(8);
  const id = randomUUID();
  const stage = path.join(root, "store/staging", id);
  const held = (await native.tryAcquire(
    path.join(root, `store/locks/stage-${id}.lock`),
    false,
  ))!;
  await mkdir(stage);
  const abandoning: LeaseAdapter = {
    async tryAcquire(file, exclusive) {
      if (file.endsWith(`stage-${id}.lock`)) {
        await rm(stage, { recursive: true });
        await held.release();
      }
      return native.tryAcquire(file, exclusive);
    },
  };
  const collector = await openStore(abandoning);
  try {
    expect((await collector.collect()).pending).toEqual([]);
  } finally {
    await held.release();
  }
});

it.each(["_", "X"])(
  "rejects garbage names with separator %s without deletion",
  async (separator) => {
    const invalid = path.join(
      root,
      "store/garbage",
      `${"a".repeat(64)}${separator}${randomUUID()}`,
    );
    await mkdir(invalid);
    await writeFile(path.join(invalid, "keep"), "owned by nobody here");
    await expect(store.collect()).rejects.toMatchObject({
      code: "invalid-store",
    });
    expect(await readFile(path.join(invalid, "keep"), "utf8")).toBe(
      "owned by nobody here",
    );
  },
);

it.each([
  { extras: [{ name: "σ.txt" }, { name: "ς.txt" }] },
  { extras: [{ name: "straße.txt" }, { name: "STRASSE.txt" }] },
  { extras: [{ name: "empty/", crc: 1 }] },
  { extras: [{ name: "empty/", compressed: true }] },
])(
  "rejects portable aliases and malformed directory encodings %#",
  async ({ extras }) => {
    await writeFile(
      archive,
      packageArchive([
        { name: "extension.json", data: JSON.stringify(manifest) },
        { name: "index.mjs" },
        ...extras,
      ]),
    );
    await expect(
      store.install(archive, { expectedGeneration: 0, enabled: false }),
    ).rejects.toMatchObject({ code: "invalid-package" });
    expect(await store.snapshot()).toEqual([]);
  },
);
it("requires exact regular extension.json and rejects malformed archives", async () => {
  await writeFile(
    archive,
    packageArchive([
      { name: "Extension.json", data: JSON.stringify(manifest) },
      { name: "index.mjs" },
    ]),
  );
  await expect(
    store.install(archive, { expectedGeneration: 0, enabled: false }),
  ).rejects.toMatchObject({ code: "invalid-package" });
  await writeFile(archive, "not a zip");
  await expect(
    store.install(archive, { expectedGeneration: 0, enabled: false }),
  ).rejects.toMatchObject({ code: "invalid-package" });
});
