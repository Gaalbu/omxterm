import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runNativeFixture } from "../fixtures/run-native-fixture";
import { productionFixtureArguments } from "../fixtures/supported-fixture-chromium-arguments";
import { prepareRestorationFixture } from "../fixtures/restoration-production-build";
import {
  assertRestorationReceipt,
  RESTORATION_RESULT,
} from "../fixtures/restoration-native-contract";

// Opt-in ONLY on an assigned idle/unlocked Linux ARM64 desktop. This imports the
// built production app and executes native PTYs/lease/bootstrap; it is not a
// headless test merely because Vitest itself has no browser environment.
// Required absolute paths: OMXTERM_RESTORATION_SOURCE, _ARCHIVE, _EVIDENCE;
// _ARCHIVE_SHA256 is the inspected separate archive's lowercase SHA-256.
const prefix = "OMXTERM_RESTORATION_";
const names = ["SOURCE", "ARCHIVE", "ARCHIVE_SHA256", "EVIDENCE"] as const;
const enabled = names.some((name) => process.env[prefix + name] !== undefined);
it.skipIf(!enabled)(
  "roundtrips Saved Layout through a cold production backend and preserves live core terminals",
  { timeout: 210_000 },
  async (testContext) => {
    assert.equal(process.platform, "linux");
    assert.equal(process.arch, "arm64");
    assert.notEqual(process.getuid?.(), 0);
    assert.ok(
      ["/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh"].includes(
        os.userInfo().shell ?? "",
      ),
    );
    const values = Object.fromEntries(
      names.map((name) => {
        const value = process.env[prefix + name];
        assert.ok(value, `${prefix}${name} is required`);
        return [name, value];
      }),
    ) as Record<(typeof names)[number], string>;
    for (const name of ["SOURCE", "ARCHIVE", "EVIDENCE"] as const)
      assert.ok(path.isAbsolute(values[name]));
    await mkdir(values.EVIDENCE, { recursive: true });
    const evidence = await mkdtemp(path.join(values.EVIDENCE, "run-"));
    const root = await mkdtemp(
      path.join(os.tmpdir(), "omxterm-restoration-production-"),
    );
    const executable = createRequire(path.join(values.SOURCE, "package.json"))(
      "electron",
    ) as string;
    const execution = await runNativeFixture({
      executable,
      args: productionFixtureArguments(root),
      root,
      timeout: 150_000,
      testContext,
      prepare: () =>
        prepareRestorationFixture(root, {
          source: values.SOURCE,
          archive: values.ARCHIVE,
          archiveSha256: values.ARCHIVE_SHA256,
          evidence,
        }),
    });
    await writeFile(
      path.join(evidence, "supervisor.json"),
      JSON.stringify(execution, null, 2),
    );
    expect(
      execution,
      `stdout:\n${execution.stdout}\nstderr:\n${execution.stderr}`,
    ).toMatchObject({
      exitCode: 0,
      signal: null,
      reason: "exit",
      cleanupErrors: [],
    });
    const lines = execution.stdout
      .split("\n")
      .filter((line) => line.startsWith(RESTORATION_RESULT));
    expect(lines).toHaveLength(1);
    const receipt: unknown = JSON.parse(
      lines[0]!.slice(RESTORATION_RESULT.length),
    );
    assertRestorationReceipt(receipt);
  },
);
