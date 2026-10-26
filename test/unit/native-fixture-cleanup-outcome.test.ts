import { build } from "esbuild";
import * as childProcess from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  completedFixtureOutcome,
  createNativeFixtureUnitScope,
} from "../fixtures/native-fixture-unit-scope";

vi.mock("node:child_process", { spy: true });

let root: string, evidencePath: string;
let scope: ReturnType<typeof createNativeFixtureUnitScope>;
const outcome = {
  ...completedFixtureOutcome,
  cleanupFailure: {
    callsite: "registration-after-kill",
    elapsedMs: 5001,
    category: "timeout",
  },
};
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "omxterm-cleanup-outcome-"));
  evidencePath = path.join(root, "outcome.json");
  scope = createNativeFixtureUnitScope(root);
  // Start the host build service before selecting the Windows caller path.
  await build({ stdin: { contents: "" }, write: false });
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.mocked(childProcess.execFileSync).mockImplementation((_file, args) =>
    String(args?.at(-1)).includes("Invoke-CimMethod")
      ? "987654\n"
      : JSON.stringify([{ pid: process.pid, parent: 1, identity: "123" }]),
  );
});
afterEach(() => scope.teardown());

function run() {
  return scope.run({
    executable: process.execPath,
    args: [],
    root,
    evidencePath,
    timeout: 1000,
  });
}

it("propagates optional failure context after a missing read, retaining the profile and ownership block", async () => {
  vi.spyOn(process, "kill").mockImplementation(() => {
    writeFileSync(evidencePath, JSON.stringify(outcome));
    throw Object.assign(new Error("Supervisor settled"), { code: "ESRCH" });
  });
  await expect(run()).resolves.toEqual(outcome);
  expect(existsSync(root)).toBe(true);
  expect(existsSync(path.join(root, "ownership-blocked.json"))).toBe(true);
  const launches = vi.mocked(childProcess.execFileSync).mock.calls.length;
  await expect(run()).rejects.toThrow("ownership unresolved");
  expect(childProcess.execFileSync).toHaveBeenCalledTimes(launches);
  expect(childProcess.spawn).not.toHaveBeenCalled();
});

it("joins the owner even when a failure-context receipt is already published", async () => {
  writeFileSync(evidencePath, JSON.stringify(outcome));
  let observedAlive!: () => void;
  const alive = new Promise<void>((resolve) => {
    observedAlive = resolve;
  });
  let allowExit = false;
  vi.spyOn(process, "kill").mockImplementation(() => {
    observedAlive();
    if (allowExit)
      throw Object.assign(new Error("Supervisor settled"), { code: "ESRCH" });
    return true;
  });
  let settled = false;
  const operation = run().then((result) => {
    settled = true;
    return result;
  });
  try {
    await alive;
    expect(settled).toBe(false);
    expect(existsSync(path.join(root, "ownership-blocked.json"))).toBe(false);
  } finally {
    allowExit = true;
    await operation.catch(() => undefined);
  }
  await expect(operation).resolves.toEqual(outcome);
  expect(existsSync(path.join(root, "ownership-blocked.json"))).toBe(true);
});

it.each([
  null,
  { ...outcome.cleanupFailure, callsite: "monitor" },
  { ...outcome.cleanupFailure, elapsedMs: -1 },
  { ...outcome.cleanupFailure, category: "private-code" },
  { ...outcome.cleanupFailure, code: "private-code" },
])(
  "rejects malformed optional metadata through the actual Windows receipt reader (%j)",
  async (cleanupFailure) => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      writeFileSync(
        evidencePath,
        JSON.stringify({ ...outcome, cleanupFailure }),
      );
      throw Object.assign(new Error("Supervisor settled"), { code: "ESRCH" });
    });
    await expect(run()).rejects.toThrow(
      "Invalid native fixture supervisor outcome",
    );
    expect(existsSync(root)).toBe(true);
    expect(existsSync(path.join(root, "ownership-blocked.json"))).toBe(true);
  },
);
