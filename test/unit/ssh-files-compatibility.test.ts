import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  checkCompatibility,
  parseManifest,
} from "../../src/installed-packages/archive";
import { packageCompatible } from "../../src/installed-packages/compatibility";
import {
  catalogCompatible,
  type CatalogRelease,
} from "../../src/main/extension-catalog";

it("admits unchanged Files only on the explicitly assigned SSH preview host across store and catalog", async () => {
  const manifest = parseManifest(
    JSON.parse(
      await readFile(
        new URL("../../extensions/files/extension.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const runtime = { appVersion: "0.24.0-dev.0", apiVersion: "0.1.0" };
  expect(() => checkCompatibility(manifest, runtime)).not.toThrow();
  const release = {
    ...manifest,
    targets: ["linux-arm64"],
  } as unknown as CatalogRelease;
  expect(catalogCompatible(release, runtime, "linux-arm64")).toBe(true);
  expect(catalogCompatible(release, runtime, "darwin-arm64")).toBe(false);
  for (const appVersion of ["0.24.0", "0.24.0-dev.1", "0.25.0-dev.0"])
    expect(packageCompatible(manifest, { ...runtime, appVersion })).toBe(false);
  expect(packageCompatible(manifest, { ...runtime, apiVersion: "0.2.0" })).toBe(
    false,
  );
  for (const changed of [
    { ...manifest, id: "other.files" },
    { ...manifest, version: "0.1.1" },
    { ...manifest, engines: { ...manifest.engines, omxterm: "<0.24.0" } },
  ])
    expect(() => checkCompatibility(changed, runtime)).toThrow("incompatible");
});
