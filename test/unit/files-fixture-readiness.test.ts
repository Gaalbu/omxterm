import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("releases the actual fixture entry module before Electron can satisfy window readiness", async () => {
  const source = await readFile(
    new URL("../fixtures/files-production.mjs", import.meta.url),
    "utf8",
  );
  // Exercise the real entry coordination after the finite production import,
  // without importing Electron, starting a window or running the scenario.
  const boundary =
    'await import(pathToFileURL(path.join(source, "dist/main/index.js")).href);';
  const pieces = source.split(boundary);
  expect(pieces).toHaveLength(2);
  const entry = "const ready = new Promise(() => {});\n" + pieces[1]!;
  const url =
    "data:text/javascript;base64," + Buffer.from(entry).toString("base64");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      import(/* @vite-ignore */ url).then(() => "entry-released"),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("blocked-on-readiness"), 500);
      }),
    ]);
    expect(result).toBe("entry-released");
  } finally {
    clearTimeout(timer);
  }
});
