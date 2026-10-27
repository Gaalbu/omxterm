import { test, expect } from "vitest";
import { build } from "esbuild";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const electron = require("electron") as string;

// This Node wrapper never loads the addon. Actual backend exit + stream closure
// and owner exit make the isolated build unlinkable, including on Windows.
async function launch(
  entry: string,
  args: string[],
  root: string,
  control?: "browser-mode" | "missing-ipc",
) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const nodeWithoutIPC = control === "missing-ipc";
  if (nodeWithoutIPC) env.ELECTRON_RUN_AS_NODE = "1";
  const browserArguments = [
    ...(process.platform === "linux"
      ? ["--no-sandbox", "--ozone-platform=headless", "--disable-gpu"]
      : []),
    `--user-data-dir=${path.join(root, "browser-profile")}`,
  ];
  const child = spawn(
    electron,
    [...(nodeWithoutIPC ? [] : browserArguments), entry, ...args],
    {
      env,
      stdio: nodeWithoutIPC
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  let exitObserved = false;
  let timedOut = false;
  let launchError: Error | undefined;
  const capture = (data: Buffer) => {
    output = (output + data.toString()).slice(-32_768);
  };
  child.stdout!.on("data", capture);
  child.stderr!.on("data", capture);
  child.on("error", (error) => {
    launchError = error;
  });
  child.once("exit", () => {
    exitObserved = true;
  });
  return new Promise<{
    code: number | null;
    signal: string | null;
    output: string;
  }>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        timedOut = true;
        if (control)
          child.kill("SIGKILL"); // This control cannot open a package.
        else if (child.connected) child.send({ stop: true }, () => {});
      },
      control ? 10_000 : 55_000,
    );
    const unresolved = setTimeout(() => {
      clearTimeout(timeout);
      // Keep the actual owner alive/retained, rather than orphaning its backend.
      reject(
        new Error("native runtime ownership unresolved; fixture retained"),
      );
    }, 70_000);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(unresolved);
      if (launchError || !exitObserved || timedOut) {
        reject(
          new Error(
            `native runtime launch/timeout failure; exit=${exitObserved}; ${output}`,
            { cause: launchError },
          ),
        );
      } else resolve({ code, signal, output });
    });
  });
}

test("runs the actual Node-IPC runtime and rejects browser-mode bootstrap before import", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(path.resolve(".scratch/extension-runtime-"));
  const artifact = path.join(root, "build");
  let safeToRemove = false;
  try {
    await exec(
      process.execPath,
      ["scripts/build-extension-runtime.mjs", artifact],
      { timeout: 90_000, maxBuffer: 65_536 },
    );
    const fixture = path.join(root, "fixture.mjs");
    await build({
      entryPoints: ["test/fixtures/extension-runtime-native.ts"],
      outfile: fixture,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["electron"],
    });
    for (const control of ["browser-mode", "missing-ipc"] as const) {
      const negative = await launch(
        path.join(artifact, "bootstrap.mjs"),
        [],
        root,
        control,
      );
      expect(negative.code, negative.output).toBe(78);
      expect(negative.signal).toBeNull();
      console.log(
        JSON.stringify({
          case: control,
          exitCode: negative.code,
          exitObserved: true,
          streamsClosed: true,
        }),
      );
    }
    const result = await launch(fixture, [artifact, root], root);
    await writeFile(
      path.join(root, "owner-result.json"),
      JSON.stringify(result),
    );
    const settled: unknown = JSON.parse(
      await readFile(path.join(root, "settled.json"), "utf8").catch(() => {
        throw new Error(
          `owner exited without settlement receipt: ${result.output}`,
        );
      }),
    );
    safeToRemove =
      Array.isArray(settled) &&
      settled.every(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "settled" in item &&
          item.settled === true,
      );
    expect(safeToRemove).toBe(true);
    expect(result.code, result.output).toBe(0);
    expect(result.signal).toBeNull();
    for (const name of [
      "lazy-real-import-request-cooperative-exit",
      "noncooperative-loop-retirement",
      "cancel-before-and-after-dispatch",
      "actual-channel-death-held-pin",
      "refusing-esm-import",
      "looping-esm-import",
      "owner-abort-active-backend",
    ]) {
      expect(result.output).toContain(`"case":"${name}"`);
    }
    console.log(result.output);
  } finally {
    if (safeToRemove) await rm(root, { recursive: true, force: true });
    else
      console.error(
        "Native runtime artifacts retained: settlement not established",
      );
  }
}, 210_000);
