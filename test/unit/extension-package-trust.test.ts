import { createHash } from "node:crypto";
import type { CatalogRelease } from "../../src/main/extension-catalog";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstalledPackages } from "../../src/installed-packages/installed-packages.js";
import { createExtensionPackageTrust } from "../../src/main/extension-package-trust.js";
import { packageArchive } from "../fixtures/extension-package-archive.js";

const runtime = { appVersion: "0.23.0-dev.5", apiVersion: "0.1.0" };
const manifest = {
  format: 1,
  id: "example.files",
  version: "1.0.0",
  name: "Files",
  engines: { omxterm: ">=0.23.0-0 <0.24.0", api: "0.1.x" },
  backend: "backend.mjs",
};
function archive(version = "1.0.0") {
  return packageArchive([
    { name: "extension.json", data: JSON.stringify({ ...manifest, version }) },
    {
      name: "backend.mjs",
      data: "throw new Error('must not import during installation');",
    },
  ]);
}
let root: string;
let packages: InstalledPackages;
let filename: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "omxterm-trust-test-"));
  filename = path.join(root, "files.omxext");
  // Controlled lease adapter: these headless tests qualify the production
  // consent/store composition, not kernel exclusion or native-addon behavior.
  packages = await InstalledPackages.open({
    root: path.join(root, "store"),
    runtime,
    leases: { tryAcquire: async () => ({ release: async () => {} }) },
  });
  await writeFile(filename, archive());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function service() {
  return createExtensionPackageTrust({
    packages,
    runtime,
    temporaryDirectory: root,
  });
}

describe("captured package consent", () => {
  function release(bytes: Buffer): CatalogRelease {
    return {
      id: manifest.id,
      name: manifest.name,
      description: "Files",
      version: manifest.version,
      engines: { ...manifest.engines },
      targets: ["linux-arm64"],
      archive: {
        url: "https://github.com/luizomf/omxterm/releases/download/ext-files-v1.0.0/files.omxext",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      sourceCommit: "a".repeat(40),
      releaseUrl:
        "https://github.com/luizomf/omxterm/releases/tag/ext-files-v1.0.0",
    };
  }
  it("binds catalog size/hash and exact manifest fields before issuing consent", async () => {
    const trust = service();
    const bytes = archive();
    const expected = release(bytes);
    const mismatches = [
      {
        ...expected,
        archive: { ...expected.archive, bytes: bytes.length + 1 },
      },
      { ...expected, archive: { ...expected.archive, sha256: "b".repeat(64) } },
      { ...expected, id: "other.files" },
      { ...expected, version: "2.0.0" },
      { ...expected, engines: { ...expected.engines, api: ">=0.1.0 <0.2.0" } },
      {
        ...expected,
        engines: { ...expected.engines, omxterm: ">=0.23.0-dev.5 <0.24.0" },
      },
    ];
    for (const selected of mismatches)
      await expect(trust.prepare({}, bytes, selected)).rejects.toThrow(
        "catalog-mismatch",
      );
    expect(await packages.snapshot()).toEqual([]);
    const owner = {};
    const preparing = trust.prepare(owner, bytes, expected);
    expected.id = "changed.identity";
    const preview = await preparing;
    expect(preview.catalogAction).toBe("install");
    const installed = await trust.approve(owner, preview.token);
    expect(installed.digest).toBe(release(bytes).archive.sha256);
    const reinstall = await trust.prepare(owner, bytes, release(bytes));
    expect(reinstall.catalogAction).toBe("reinstall");
    trust.cancel(owner);
  });
  it("installs approved A bytes after the chooser path becomes B; does not import", async () => {
    const trust = service();
    const owner = {};
    const preview = await trust.prepare(owner, filename);
    await writeFile(filename, archive("2.0.0"));
    preview.expectedGeneration = 99;
    preview.manifest.version = "99.0.0";
    const installed = await trust.approve(owner, preview.token);
    expect(installed.digest).toBe(preview.digest);
    expect(installed.manifest?.version).toBe("1.0.0");
    expect(installed.generation).toBe(1);
    expect(installed.enabled).toBe(true);
    const pin = await packages.openVersion(manifest.id);
    expect(
      await readFile(path.join(pin.directory, "backend.mjs"), "utf8"),
    ).toContain("must not import");
    await pin.release();
    await expect(trust.approve(owner, preview.token)).rejects.toThrow(
      "unavailable",
    );
  });

  it("rejects another owner and superseded/cancelled consent without changing the store", async () => {
    const trust = service();
    const owner = {};
    const first = await trust.prepare(owner, filename);
    await expect(trust.approve({}, first.token)).rejects.toThrow("unavailable");
    const second = await trust.prepare(owner, filename);
    await expect(trust.approve(owner, first.token)).rejects.toThrow(
      "unavailable",
    );
    trust.cancel(owner);
    await expect(trust.approve(owner, second.token)).rejects.toThrow(
      "unavailable",
    );
    expect(await packages.snapshot()).toEqual([]);
  });

  it("uses observed generation and consumes approval on a conflict", async () => {
    const trust = service();
    const owner = {};
    const preview = await trust.prepare(owner, filename);
    await packages.install(archive("2.0.0"), {
      expectedGeneration: 0,
      enabled: false,
    });
    await expect(trust.approve(owner, preview.token)).rejects.toThrow(
      "conflict",
    );
    await expect(trust.approve(owner, preview.token)).rejects.toThrow(
      "unavailable",
    );
    expect((await packages.snapshot())[0]?.manifest?.version).toBe("2.0.0");
  });

  it("does not publish malformed or incompatible packages", async () => {
    const trust = service();
    for (const bytes of [
      Buffer.from("not a zip"),
      packageArchive([
        {
          name: "extension.json",
          data: JSON.stringify({
            ...manifest,
            engines: { omxterm: "99.x", api: "0.1.x" },
          }),
        },
        { name: "backend.mjs", data: "" },
      ]),
    ]) {
      await writeFile(filename, bytes);
      await expect(trust.prepare({}, filename)).rejects.toThrow();
    }
    expect(await packages.snapshot()).toEqual([]);
  });

  it("revokes a held preparation on owner loss without late approval", async () => {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshot = vi
      .spyOn(packages, "snapshot")
      .mockImplementationOnce(async () => {
        entered();
        await gate;
        return [];
      });
    const trust = service();
    const owner = {};
    const pending = trust.prepare(owner, filename);
    await reached;
    trust.cancel(owner);
    release();
    await expect(pending).rejects.toThrow("unavailable");
    snapshot.mockRestore();
    expect(await packages.snapshot()).toEqual([]);
  });

  it("captures mutable install buffers and options before asynchronous store admission", async () => {
    const bytes = archive();
    const options = { expectedGeneration: 0, enabled: true };
    const pending = packages.install(bytes, options);
    bytes.fill(0);
    options.expectedGeneration = 99;
    options.enabled = false;
    const installed = await pending;
    expect(installed.enabled).toBe(true);
    expect(installed.manifest?.version).toBe("1.0.0");
  });
});
