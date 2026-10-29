import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

let entry: string;
beforeAll(async () => {
  const result = await build({
    entryPoints: ["test/fixtures/application-menu-exercise.ts"],
    bundle: false,
    platform: "node",
    format: "cjs",
    write: false,
  });
  entry = result.outputFiles[0]!.text;
});
afterEach(() => vi.useRealTimers());

it("waits through an absent and then unfocused Surface before exercising the menu", async () => {
  vi.useFakeTimers();
  const install = vi.fn(() => ({ on() {} }));
  const exports: {
    exerciseApplicationMenu?: (...args: unknown[]) => Promise<unknown>;
  } = {};
  const module = { exports };
  runInNewContext(entry, {
    module,
    exports,
    process: { platform: "darwin" },
    Date,
    setTimeout,
    require: () => ({
      default: {},
      terminalDefaultKeybinds: () => ({}),
      terminalActionInvocations: () => ({}),
      deliverKeybindsFromKeyEvents() {},
      terminalApplicationMenuTemplate() {},
      installApplicationMenu: install,
    }),
  });
  let surface: { contains: () => boolean } | null = null;
  const document = { querySelector: () => surface, activeElement: {} };
  const executeJavaScript = vi.fn(
    async (script: string) => runInNewContext(script, { document }) as unknown,
  );
  const completion = module.exports.exerciseApplicationMenu!(
    { focus() {}, webContents: { executeJavaScript } },
    {},
    [],
    () => {},
  );
  // Observe rejection immediately while advancing the readiness boundary.
  const result = completion.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(25);
  expect(install).not.toHaveBeenCalled();
  surface = { contains: () => false };
  await vi.advanceTimersByTimeAsync(25);
  expect(install).not.toHaveBeenCalled();
  surface = { contains: () => true };
  await vi.advanceTimersByTimeAsync(25);
  expect(await result).toEqual({ value: "unchanged-macos" });
  expect(install).toHaveBeenCalledOnce();
  expect(executeJavaScript.mock.calls.length).toBeGreaterThanOrEqual(3);
});
