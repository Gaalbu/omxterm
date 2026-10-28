import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildFixture } from "../fixtures/window-chrome-build";
import { buildExtensionFixturePackages } from "../fixtures/extension-view-package-build";
import { createExtensionFixtureResources } from "../fixtures/extension-view-resources";

// No Electron, browser, PTY or backend execution. Windows mapped-addon cleanup
// remains owned by an outer process-exit observer; this POSIX check does not
// extend that contract or qualify native view composition.
it.skipIf(!["linux", "darwin"].includes(process.platform))(
  "builds the native fixture and retains a real installed A pin across B publication and collection",
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "omxterm-view-pin-"));
    let owner:
      Awaited<ReturnType<typeof createExtensionFixtureResources>> | undefined;
    try {
      await buildFixture(root);
      await buildExtensionFixturePackages(root);
      owner = await createExtensionFixtureResources(root);
      const bytes = await owner.resources.read(
        "index.html",
        4096,
        new AbortController().signal,
      );
      expect(Buffer.from(bytes).toString()).toContain("Captured A");
      await owner.replaceCurrent();
      await owner.resources.release();
      const result = await owner.assertRetired();
      expect(result).toMatchObject({
        admitted: true,
        first: { generation: 1 },
        replacement: { generation: 2 },
        released: 1,
        active: 0,
        postReleaseRead: "rejected",
        replacementDirectoryRetained: true,
      });
      expect(result.pending.pending).toEqual([result.first.digest]);
      expect(result.collected.removed).toEqual([result.first.digest]);
      expect(result.first.digest).not.toBe(result.replacement.digest);
      expect(
        result.reads.filter((read) => read.resource === "index.html"),
      ).toHaveLength(2);
    } finally {
      try {
        await owner?.resources.release();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
