import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildFixture } from "../fixtures/font-read-reload-build";
import {
  open,
  holdFontRead,
  fontReadHandles,
  releaseFontReads,
} from "../fixtures/font-read-reload-io";

it("holds the native fixture's real positional read and closes its actual handle", async () => {
  const filename = path.resolve("assets/fonts/DejaVuSansMono.ttf");
  const before = { ...fontReadHandles };
  const gate = holdFontRead();
  const file = await open(filename, "r");
  const data = Buffer.alloc((await file.stat()).size);
  let completed = false;
  const read = file.read(data, 0, data.length, 0).then(() => {
    completed = true;
  });
  try {
    await gate.entered;
    expect(completed).toBe(false);
    gate.release();
    await read;
    expect(data).toEqual(await readFile(filename));
  } finally {
    releaseFontReads();
    await read;
    await file.close();
  }
  expect(fontReadHandles.opened - before.opened).toBe(1);
  expect(fontReadHandles.closed - before.closed).toBe(1);
});

it.each(["current", "old-post-read"] as const)(
  "builds the supervised native fixture headlessly (%s), without replacing discovery/preload/runtime",
  async (control) => {
    const root = await mkdtemp(
      path.join(tmpdir(), "omxterm-read-reload-build-"),
    );
    try {
      await buildFixture(root, "recipe", control);
      const main = await readFile(path.join(root, "main.cjs"), "utf8");
      const renderer = await readFile(
        path.join(root, "renderer/index.js"),
        "utf8",
      );
      const preload = await readFile(path.join(root, "preload.cjs"), "utf8");
      expect(main).toContain("fontReadHandles.opened += 1");
      expect(main).toContain("await gate.wait");
      expect(main).toContain(
        "Started A must complete; old post-read rejection fails here",
      );
      expect(renderer).toContain("record.fontName = lease.fonts[0]?.name");
      expect(renderer).toContain('record.status = "mounted"');
      expect(renderer).not.toContain("releaseFontInitialization");
      expect(preload).toContain("exposeInMainWorld");
      const completionCheck =
        /const loaded = await options.load\(family\);\s+if \(([^]*?)\)\s+throw new Error\("Terminal Font request was superseded"\)/u.exec(
          main,
        )?.[1];
      expect(completionCheck).toBeDefined();
      expect(completionCheck?.includes("options.generation()")).toBe(
        control === "old-post-read",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
