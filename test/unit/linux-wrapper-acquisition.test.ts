import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  chmod,
  symlink,
  mkdir,
  readdir,
  rm,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyLinuxWrapperPropagation } from "../../scripts/linux-packaged-process.mjs";

// Alter only external procfs visibility, through the unchanged verifier caller.
// Native actors, streams, outcomes, recovery and pidfd validation remain real.
const procView = vi.hoisted(() => ({
  sample: undefined as undefined | ((names: string[]) => string[]),
  stat: undefined as undefined | ((file: string, text: string) => string),
  ackFault: "" as string,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readdirSync(directory: string) {
      const names = fs.readdirSync(directory);
      return directory === "/proc" && procView.sample
        ? procView.sample(names)
        : names;
    },
    readFileSync(...args: Parameters<typeof fs.readFileSync>) {
      const value = fs.readFileSync(...args);
      return typeof args[0] === "string" &&
        args[0].startsWith("/proc/") &&
        typeof value === "string" &&
        procView.stat
        ? procView.stat(args[0], value)
        : value;
    },
    renameSync(from: string, to: string) {
      if (procView.ackFault && to.endsWith(".acquired.json")) {
        if (procView.ackFault === "missing") return;
        const ack = JSON.parse(fs.readFileSync(from, "utf8")) as {
          control: string;
          pid: number;
          start: string;
        };
        if (procView.ackFault === "stale") ack.start = "0";
        if (procView.ackFault === "wrong-actor") ack.pid = process.pid;
        if (procView.ackFault === "wrong-control") ack.control = "signal";
        fs.writeFileSync(
          from,
          procView.ackFault === "malformed" ? "{" : JSON.stringify(ack),
        );
      }
      return fs.renameSync(from, to);
    },
  };
});
const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];
const cleanup: Identity[] = [];
interface Identity {
  pid: number;
  parent: number;
  group: number;
  start: string;
}
interface Receipt {
  acquired?: Identity;
  beforeCleanup: {
    outcome?: { code: number | null; signal: string | null };
    closed: boolean;
    remaining: Identity[];
  };
  outcome: { code: number | null; signal: string | null };
  closed: boolean;
  remaining: Identity[];
  stdout: string;
  failures: string[];
}
function identity(pid: number): Identity {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = text
    .slice(text.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  return {
    pid,
    parent: Number(fields[1]),
    group: Number(fields[2]),
    start: fields[19]!,
  };
}
function json<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Acquisition fixture deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function setup(mode = "control-streams") {
  const root = await mkdtemp(path.join(tmpdir(), "omxterm-acquisition-test-"));
  roots.push(root);
  const launcher = path.join(root, "AppImage");
  await writeFile(
    launcher,
    '#!/bin/sh\nexec "$OMXTERM_FIXTURE_NODE" "$OMXTERM_FIXTURE_ENTRY" wrapper "$@"\n',
  );
  await chmod(launcher, 0o700);
  await symlink(process.execPath, path.join(root, "omxterm"));
  vi.stubEnv("OMXTERM_FIXTURE_NODE", process.execPath);
  vi.stubEnv(
    "OMXTERM_FIXTURE_ENTRY",
    path.resolve("test/fixtures/linux-packaged-process.mjs"),
  );
  vi.stubEnv("OMXTERM_FIXTURE_ROOT", root);
  vi.stubEnv("OMXTERM_FIXTURE_MODE", mode);
  return { root, launcher };
}
async function failed(launcher: string) {
  let failure: unknown;
  try {
    await verifyLinuxWrapperPropagation(launcher, 250);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  const error = failure as AggregateError;
  const directory = /wrapper controls retained at (.+)$/u.exec(
    error.message,
  )![1]!;
  const receipt = json<Receipt>(path.join(directory, "zero.json"));
  roots.push(directory);
  const retained = path.resolve(
    ".scratch/694-acquisition-controls",
    path.basename(directory),
  );
  await cp(directory, retained, {
    recursive: true,
    filter: (source) => !fs.lstatSync(source).isFIFO(),
  });
  const witness = path.join(path.dirname(launcher), "control-ready.json");
  if (fs.existsSync(witness))
    await cp(witness, path.join(retained, "fixture-witness.json"));
  return { error, directory, receipt };
}
function rootOnlyUntilReleased(
  released: () => boolean,
  heldSample: () => void = () => undefined,
) {
  let rootPid: number | undefined;
  procView.sample = (names) => {
    rootPid ??= names.map(Number).find((pid) => {
      try {
        const row = identity(pid);
        return row.parent === process.pid && row.group === pid;
      } catch {
        return false;
      }
    });
    if (released()) return names;
    heldSample();
    return names.filter((name) => Number(name) === rootPid);
  };
}
afterEach(async () => {
  procView.sample = undefined;
  procView.stat = undefined;
  procView.ackFault = "";
  vi.unstubAllEnvs();
  // Independent native witnesses are for test recovery only, including when an
  // ordering assertion fails. Never inject them into the verifier's ownership.
  for (const root of roots) {
    if (!fs.existsSync(`${root}/control-ready.json`)) continue;
    const witness = json<{ leader: Identity; worker: Identity }>(
      `${root}/control-ready.json`,
    );
    cleanup.push(witness.worker, witness.leader);
  }
  if (cleanup.length) {
    const targets = cleanup.splice(0);
    const result = spawnSync(
      "python3",
      ["-I", path.resolve("scripts/linux-packaged-signal.py")],
      {
        input: JSON.stringify({ targets, signal: "SIGKILL", recovery: true }),
        encoding: "utf8",
        timeout: 2_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    await until(() =>
      targets.every((target) => !fs.existsSync(`/proc/${target.pid}/stat`)),
    );
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")(
  "Linux finite wrapper acquisition through the verifier",
  () => {
    it("holds a ready stream-owning worker through a collection gap until actual retention, then preserves exit 7 and timeout on recovery", async () => {
      const { root, launcher } = await setup();
      let release = false;
      let sampledReady = false;
      rootOnlyUntilReleased(
        () => release,
        () => {
          sampledReady ||= fs.existsSync(`${root}/control-ready.json`);
        },
      );
      const pending = failed(launcher);
      try {
        await until(() => sampledReady);
        const witness = json<{ leader: Identity; worker: Identity }>(
          `${root}/control-ready.json`,
        );
        cleanup.push(witness.worker, witness.leader);
        const stem = fs.readFileSync(`${root}/control-path`, "utf8");
        // Readiness alone cannot release the wrapper or authorize a signal target.
        expect(identity(witness.leader.pid).start).toBe(witness.leader.start);
        expect(identity(witness.worker.pid).parent).toBe(witness.leader.pid);
        expect(fs.existsSync(`${stem}.acquired.json`)).toBe(false);
        release = true;
      } finally {
        release = true;
        await pending;
      }
      const { receipt } = await pending;
      const witness = json<{ worker: Identity }>(`${root}/control-ready.json`);
      expect(receipt.acquired).toEqual(witness.worker);
      expect(receipt.beforeCleanup).toMatchObject({
        outcome: { code: 7, signal: null },
        closed: false,
      });
      expect(receipt.beforeCleanup.remaining).toEqual([
        { ...witness.worker, parent: 1 },
      ]);
      expect(receipt.outcome).toEqual({ code: 7, signal: null });
      expect(receipt.remaining).toEqual([]);
      expect(receipt.closed).toBe(true);
      expect(receipt.failures).toEqual([
        "Linux wrapper outcome control did not settle",
      ]);
    });

    it("keeps the generated Run-as-Node actor alive without acknowledgement before exercising all three native outcomes", async () => {
      const { root, launcher } = await setup("normal");
      let release = false;
      let sampledReady = false;
      rootOnlyUntilReleased(
        () => release,
        () => {
          sampledReady ||=
            fs.existsSync(`${root}/control-path`) &&
            fs.existsSync(
              `${fs.readFileSync(`${root}/control-path`, "utf8")}.proposal.json`,
            );
        },
      );
      const pending = verifyLinuxWrapperPropagation(launcher, 250);
      try {
        await until(() => sampledReady);
        const stem = fs.readFileSync(`${root}/control-path`, "utf8");
        const proposed = json<{ pid: number; start: string }>(
          `${stem}.proposal.json`,
        );
        cleanup.push(identity(proposed.pid));
        expect(identity(proposed.pid).start).toBe(proposed.start);
        expect(fs.existsSync(`${stem}.acquired.json`)).toBe(false);
        release = true;
      } finally {
        release = true;
        await pending;
      }
      await expect(pending).resolves.toMatch(/^[a-f0-9]{64}$/u);
    });

    it("keeps generated actor paths literal across shell metacharacters", async () => {
      const { root, launcher } = await setup("normal");
      const temporary = path.join(root, "space $HOME `literal` ' \" control");
      await mkdir(temporary);
      vi.stubEnv("TMPDIR", temporary);
      await expect(
        verifyLinuxWrapperPropagation(launcher, 250),
      ).resolves.toMatch(/^[a-f0-9]{64}$/u);
      expect(await readdir(temporary)).toEqual([]);
    });

    it("still exposes the missed orphan when an early-release control deliberately bypasses acquisition", async () => {
      const { root, launcher } = await setup("control-early-release");
      // Expose only the root until it is absent; then expose the orphan. This
      // forces the diagnosed ordering rather than relying on incidental timing.
      let rootPid: number | undefined;
      rootOnlyUntilReleased(
        () => rootPid !== undefined && !fs.existsSync(`/proc/${rootPid}/stat`),
      );
      const sample = procView.sample!;
      procView.sample = (names) => {
        const visible = sample(names);
        rootPid ??= visible.map(Number).find((pid) => {
          try {
            return identity(pid).parent === process.pid;
          } catch {
            return false;
          }
        });
        return visible;
      };
      const { error, directory, receipt } = await failed(launcher);
      const witness = json<{ worker: Identity }>(`${root}/control-ready.json`);
      cleanup.push(witness.worker);
      expect(identity(witness.worker.pid).start).toBe(witness.worker.start);
      expect(receipt.acquired).toBeUndefined();
      expect(receipt.beforeCleanup).toEqual({
        outcome: { code: 7, signal: null },
        closed: false,
        remaining: [],
      });
      expect(receipt.closed).toBe(false);
      expect(receipt.remaining).toEqual([]);
      expect(fs.existsSync(`${directory}/zero.acquired.json`)).toBe(false);
      expect(error.message).toContain("acquisition did not complete");
      expect(receipt.failures).toEqual(
        expect.arrayContaining([
          "Linux wrapper outcome control did not settle",
          "Linux wrapper control failure cleanup did not settle",
        ]),
      );
    });

    it.each([
      "missing",
      "malformed",
      "oversized",
      "stale",
      "wrong-control",
      "wrong-actor",
      "foreign",
      "symlink",
      "directory",
      "fifo",
    ])(
      "rejects %s proposals without acknowledging or signaling a foreign sentinel",
      async (fault) => {
        const { launcher } = await setup(`control-${fault}`);
        const sentinel = spawn(
          process.execPath,
          ["-e", "setTimeout(() => process.exit(98), 10000)"],
          { detached: true, stdio: "ignore" },
        );
        const foreign = identity(sentinel.pid!);
        cleanup.push(foreign);
        vi.stubEnv(
          "OMXTERM_FIXTURE_FOREIGN",
          JSON.stringify({ pid: foreign.pid, start: foreign.start }),
        );
        const { error, directory, receipt } = await failed(launcher);
        expect(receipt.acquired).toBeUndefined();
        expect(fs.existsSync(`${directory}/zero.acquired.json`)).toBe(false);
        expect(receipt.remaining).toEqual([]);
        expect(receipt.closed).toBe(true);
        expect(identity(foreign.pid).start).toBe(foreign.start);
        expect(sentinel.exitCode).toBeNull();
        expect(sentinel.signalCode).toBeNull();
        expect(error.message).toMatch(
          /acquisition|JSON|Oversized|wrapper control file|ELOOP/u,
        );
      },
    );

    it.each(["initial-gap", "reused-root", "exited-root"])(
      "never seeds ownership from a later %s observation",
      async (gap) => {
        const { root, launcher } = await setup();
        let samples = 0;
        let leaderPid: number | undefined;
        let leaderReads = 0;
        procView.sample = (names) => {
          leaderPid ??= names.map(Number).find((pid) => {
            try {
              const row = identity(pid);
              return row.parent === process.pid && row.group === pid;
            } catch {
              return false;
            }
          });
          if (++samples === 1 && gap === "initial-gap") return [];
          return names;
        };
        procView.stat = (file, text) => {
          if (
            gap === "initial-gap" ||
            file !== `/proc/${leaderPid}/stat` ||
            ++leaderReads === 1
          )
            return text;
          const end = text.lastIndexOf(")") + 2;
          const fields = text.slice(end).trim().split(/\s+/u);
          if (gap === "reused-root") fields[19] = "0";
          else fields[0] = "Z";
          return text.slice(0, end) + fields.join(" ");
        };
        const { receipt, directory } = await failed(launcher);
        const witness = json<{ leader: Identity; worker: Identity }>(
          `${root}/control-ready.json`,
        );
        cleanup.push(witness.worker, witness.leader);
        expect(receipt.acquired).toBeUndefined();
        expect(receipt.beforeCleanup.remaining).toEqual([]);
        expect(receipt.remaining).toEqual([]);
        expect(receipt.closed).toBe(false);
        expect(fs.existsSync(`${directory}/zero.acquired.json`)).toBe(false);
        expect(identity(witness.worker.pid).start).toBe(witness.worker.start);
        expect(receipt.failures).toEqual([
          "Linux wrapper control acquisition did not complete",
          "Linux wrapper outcome control did not settle",
          "Linux wrapper control failure cleanup did not settle",
        ]);
      },
    );

    it.each(["missing", "stale", "wrong-actor", "wrong-control", "malformed"])(
      "does not execute a generated actor's native action with %s acknowledgement",
      async (fault) => {
        const { launcher } = await setup("normal");
        procView.ackFault = fault;
        const { error, receipt } = await failed(launcher);
        expect(receipt.acquired).toBeDefined();
        expect(receipt.stdout).toBe("");
        expect(receipt.closed).toBe(true);
        expect(receipt.remaining).toEqual([]);
        expect(error.message).toMatch(
          /control did not settle|masks or fails zero outcome/u,
        );
      },
    );

    it("does not release a worker when acknowledgement publication is missing", async () => {
      const { root, launcher } = await setup();
      procView.ackFault = "missing";
      const { receipt } = await failed(launcher);
      const witness = json<{ leader: Identity; worker: Identity }>(
        `${root}/control-ready.json`,
      );
      expect(receipt.acquired?.pid).toBe(witness.worker.pid);
      expect(receipt.beforeCleanup.outcome).toBeUndefined();
      expect(receipt.outcome).toEqual({ code: null, signal: "SIGKILL" });
      expect(receipt.closed).toBe(true);
      expect(receipt.remaining).toEqual([]);
      expect(receipt.failures).toEqual([
        "Linux wrapper outcome control did not settle",
      ]);
    });
  },
);
