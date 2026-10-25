import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { applyChromiumSandboxPolicy } from "../../src/main/chromium-sandbox-policy";
import { buildFixture } from "../fixtures/font-read-reload-build";
import { runNativeFixture } from "../fixtures/run-native-fixture";

const executable = createRequire(import.meta.url)("electron") as string;
const prefix = "__OMXTERM_FONT_READ_RELOAD_RESULT__";
it
  .skipIf(!["darwin", "linux", "win32"].includes(process.platform))
  .for(["current", "old-post-read"] as const)(
  "checks actual started font read/reload through native host/preload/Surface/PTY (%s)",
  { timeout: 110_000 },
  async (control, testContext) => {
    testContext.signal.throwIfAborted();
    const root = await mkdtemp(
      path.join(tmpdir(), "omxterm-font-read-reload-"),
    );
    let supervised = false;
    try {
      testContext.signal.throwIfAborted();
      const args: string[] = [];
      applyChromiumSandboxPolicy({
        appendSwitch: (name) => {
          args.push(`--${name}`);
        },
      });
      if (process.platform === "linux") args.push("--ozone-platform=x11");
      supervised = true;
      const execution = await runNativeFixture({
        executable,
        args: [...args, root],
        root,
        timeout: 90_000,
        testContext,
        prepare: () => buildFixture(root, "runner", control),
      });
      if (control === "old-post-read") {
        expect(execution).toMatchObject({
          exitCode: 1,
          signal: null,
          reason: "exit",
          cleanupErrors: [],
        });
        expect(execution.stderr).toContain(
          "Started A must complete; old post-read rejection fails here",
        );
        expect(execution.stdout).not.toContain(prefix);
        return;
      }
      expect(
        execution,
        `Font read/reload fixture failed.\nstdout:\n${execution.stdout}\nstderr:\n${execution.stderr}`,
      ).toMatchObject({
        exitCode: 0,
        signal: null,
        reason: "exit",
        cleanupErrors: [],
      });
      const result = execution.stdout
        .split("\n")
        .find((line) => line.startsWith(prefix));
      expect(result).toBeDefined();
      expect(JSON.parse(result!.slice(prefix.length)) as unknown).toEqual({
        acceptedA: true,
        queuedB: true,
        cancelledSibling: true,
        disposed: true,
        sessions: 6,
        usable: true,
        handlesClosed: true,
      });
    } finally {
      if (!supervised) await rm(root, { recursive: true, force: true });
    }
  },
);
