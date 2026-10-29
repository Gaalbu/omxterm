import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ABSENT_REVISION,
  createExtensionState,
  STATE_BYTES,
  StateError,
} from "../../src/extension-runtime/state.js";
import { parseManifest } from "../../src/installed-packages/archive.js";
import type { LeaseAdapter } from "../../src/installed-packages/native-leases.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

let profile: string;
let scoped: string;
let held: Set<string>;
let leases: LeaseAdapter;
const id = "test.saved-layout";
function client(extensionId = id) {
  return createExtensionState({
    packageRoot: path.join(profile, "extensions"),
    id: extensionId,
    leases,
  });
}
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "omxterm-state-"));
  scoped = path.join(profile, "extension-state", id);
  held = new Set();
  // Controlled exclusive ownership only: no addon or GUI. Production's native
  // regular-file/no-follow acquisition remains an assigned-guest gate.
  leases = {
    tryAcquire: vi.fn(async (file: string, exclusive: boolean) => {
      expect(exclusive).toBe(true);
      if (held.has(file)) return null;
      held.add(file);
      const handle = await fs.open(file, "a", 0o600);
      await handle.close();
      return {
        release: async () => {
          held.delete(file);
        },
      };
    }),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(profile, { recursive: true, force: true });
});

describe("extension-scoped state", () => {
  it("reads absent, saves, cold-reads and forgets with a retained revision and lease identity", async () => {
    const a = client();
    expect(await a.read()).toEqual({ revision: ABSENT_REVISION, value: null });
    const lock = path.join(scoped, "state.lock");
    const identity = await fs.stat(lock);
    const saved = await a.replace(ABSENT_REVISION, { folder: "/synthetic" });
    expect(await client().read()).toEqual(saved);
    const forgotten = await client().replace(saved.revision, null);
    expect(forgotten.revision).not.toBe(saved.revision);
    expect(forgotten.revision).not.toBe(ABSENT_REVISION);
    expect(await client().read()).toEqual(forgotten);
    expect(
      await fs.readFile(path.join(scoped, "state.json"), "utf8"),
    ).not.toContain("/synthetic");
    expect((await fs.stat(lock)).ino).toBe(identity.ino);
    expect(await fs.readdir(scoped)).toEqual(["state.json", "state.lock"]);
    expect(await client("test.other").read()).toEqual({
      revision: ABSENT_REVISION,
      value: null,
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(scoped)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(path.join(scoped, "state.json"))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("admits exactly one racing writer and refuses stale A→B→A and Forget revisions", async () => {
    const a = client();
    const b = client();
    await a.read();
    const race = await Promise.allSettled([
      a.replace(ABSENT_REVISION, "A"),
      b.replace(ABSENT_REVISION, "A"),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = race.find((result) => result.status === "rejected");
    const refusal: unknown = rejected?.reason;
    expect(refusal).toBeInstanceOf(StateError);
    expect(["busy", "conflict"]).toContain((refusal as StateError).code);
    const first = await a.read();
    const second = await a.replace(first.revision, "B");
    const third = await b.replace(second.revision, "A");
    expect(third.revision).not.toBe(first.revision);
    await expect(a.replace(first.revision, null)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await a.read()).toEqual(third);
  });

  it("returns busy without retry and releases transaction ownership after refusal", async () => {
    const a = client();
    await a.read();
    held.add(path.join(scoped, "state.lock"));
    const calls = vi.mocked(leases.tryAcquire).mock.calls.length;
    await expect(a.read()).rejects.toMatchObject({ code: "busy" });
    expect(vi.mocked(leases.tryAcquire).mock.calls.length).toBe(calls + 1);
    held.clear();
    expect((await a.read()).revision).toBe(ABSENT_REVISION);
  });

  it.each(["malformed", "oversized", "directory", "symlink", "bad-envelope"])(
    "preserves and refuses %s data rather than repairing it",
    async (kind) => {
      const a = client();
      await a.read();
      const file = path.join(scoped, "state.json");
      if (kind === "directory") await fs.mkdir(file);
      else if (kind === "symlink")
        await fs.symlink(path.join(profile, "missing"), file, "file");
      else
        await fs.writeFile(
          file,
          kind === "oversized"
            ? " ".repeat(STATE_BYTES + 1)
            : kind === "malformed"
              ? "{"
              : '{"value":null}',
        );
      const before = await fs.lstat(file);
      await expect(a.read()).rejects.toMatchObject({ code: "invalid-state" });
      await expect(a.replace(ABSENT_REVISION, null)).rejects.toMatchObject({
        code: "invalid-state",
      });
      expect((await fs.lstat(file)).ino).toBe(before.ino);
      expect(await fs.readdir(scoped)).toEqual(["state.json", "state.lock"]);
    },
  );

  it.each(["extension-state", id])(
    "refuses a symlink state directory at %s",
    async (component) => {
      const target = path.join(profile, "target");
      await fs.mkdir(target);
      const root = path.join(profile, "extension-state");
      if (component === id) await fs.mkdir(root);
      await fs.symlink(target, component === id ? scoped : root, "dir");
      await expect(client().read()).rejects.toMatchObject({
        code: "invalid-state",
      });
      expect(await fs.readdir(target)).toEqual([]);
    },
  );

  it("captures values before awaiting, rejects hooks/oversize and isolates invalid IDs", async () => {
    const a = client();
    const value = { nested: { number: 1 } };
    const saved = a.replace(ABSENT_REVISION, value);
    value.nested.number = 2;
    expect((await saved).value).toEqual({ nested: { number: 1 } });
    const getter = vi.fn(() => 1);
    await expect(
      a.replace(ABSENT_REVISION, {
        get number() {
          return getter();
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-value" });
    expect(getter).not.toHaveBeenCalled();
    await expect(
      a.replace(ABSENT_REVISION, "x".repeat(STATE_BYTES)),
    ).rejects.toMatchObject({ code: "invalid-value" });
    // Fits protocol capture but exceeds the state document's encoded-byte cap.
    await expect(
      a.replace(ABSENT_REVISION, "\u0000".repeat(45_000)),
    ).rejects.toMatchObject({ code: "invalid-value" });
    expect(() => client("../escape")).toThrow("invalid-state");
  });

  it("leaves the old document untouched on failure before publication", async () => {
    const a = client();
    const saved = await a.replace(ABSENT_REVISION, "old");
    const original = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(".tmp"))
        throw new Error("private path must not escape");
      return original(...args);
    });
    await expect(a.replace(saved.revision, "new")).rejects.toMatchObject({
      code: "invalid-state",
      message: "invalid-state",
    });
    expect(await a.read()).toEqual(saved);
  });

  it("flushes and closes the private exclusive temp before rename; flush failure preserves old state", async () => {
    const a = client();
    const saved = await a.replace(ABSENT_REVISION, "old");
    const original = fs.open;
    const rename = vi.spyOn(fs, "rename");
    let temporary = "";
    const close = vi.fn();
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith(".tmp")) {
        temporary = String(args[0]);
        expect(args.slice(1)).toEqual(["wx", 0o600]);
        vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("flush"));
        const originalClose = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          close();
          await originalClose();
        });
      }
      return handle;
    });
    await expect(a.replace(saved.revision, "new")).rejects.toMatchObject({
      code: "invalid-state",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
    expect(await a.read()).toEqual(saved);
    expect((await fs.stat(temporary)).isFile()).toBe(true);
  });

  it("reports unknown after a rename commits but its receipt fails, and never replays or sweeps", async () => {
    const a = client();
    const saved = await a.replace(ABSENT_REVISION, "old");
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
      await rename(...args);
      throw new Error("lost receipt");
    });
    await expect(a.replace(saved.revision, "new")).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect((await client().read()).value).toBe("new");
    await fs.writeFile(path.join(scoped, "state-interrupted.tmp"), "retained");
    await client().read();
    expect(
      await fs.readFile(path.join(scoped, "state-interrupted.tmp"), "utf8"),
    ).toBe("retained");
  });

  it("reports unknown when lease release fails after publication", async () => {
    const a = client();
    await a.read();
    const acquire = vi.mocked(leases.tryAcquire).getMockImplementation()!;
    vi.mocked(leases.tryAcquire).mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args);
      return {
        release: async () => {
          await lease!.release();
          throw new Error("release");
        },
      };
    });
    await expect(a.replace(ABSENT_REVISION, "committed")).rejects.toMatchObject(
      { code: "outcome-unknown" },
    );
    expect((await client().read()).value).toBe("committed");
  });
});

describe("state capability manifest", () => {
  const manifest = {
    format: 1,
    id,
    version: "1.0.0",
    name: "State fixture",
    engines: { omxterm: ">=0.24.0", api: "^0.1.0" },
    backend: "backend.mjs",
  };
  it("accepts explicit state alone or alongside the existing SSH capability", () => {
    for (const capabilities of [
      ["state.v1"],
      ["terminal.openSsh.v1", "state.v1"],
    ])
      expect(parseManifest({ ...manifest, capabilities }).capabilities).toEqual(
        capabilities,
      );
    expect(parseManifest(manifest).capabilities).toBeUndefined();
  });
  it.each([
    [[]],
    [["state.v2"]],
    [["state.v1", "state.v1"]],
    [["state.v1", "unknown"]],
  ])(
    "refuses empty, duplicate and unavailable declarations: %j",
    (capabilities) => {
      expect(() => parseManifest({ ...manifest, capabilities })).toThrow(
        "invalid-package",
      );
    },
  );
});
