import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PackageError } from "../../src/installed-packages/archive.js";
import { withCleanup } from "../../src/installed-packages/registry.js";
import type { OpenVersion } from "../../src/installed-packages/installed-packages.js";
import {
  active,
  deferred,
  fixture,
  flush,
  observe,
  pin,
  selection,
} from "../fixtures/extension-runtime-controlled.js";
import {
  backendEnvironment,
  createExtensionRuntime,
} from "../../src/extension-runtime/electron-runtime.js";
import {
  boundedValue,
  decode,
  encode,
  exact,
  MESSAGE_BYTES,
} from "../../src/extension-runtime/protocol.js";

describe("extension runtime error and cancellation contracts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(["initial", "call", "revalidation"])(
    "preserves primary plus cleanup failure from %s store operation",
    async (boundary) => {
      const failure = await withCleanup(async () => {
        throw new PackageError("invalid-store");
      }, [
        async () => {
          throw new Error("synthetic cleanup failure");
        },
      ]).catch((error: unknown) => error);
      const f = fixture();
      let operation: Promise<unknown>;
      if (boundary === "call") {
        const a = await active(f);
        f.openVersion.mockRejectedValueOnce(failure);
        operation = observe(a.backend.call(null));
      } else {
        if (boundary === "initial")
          f.openVersion.mockRejectedValueOnce(failure);
        else vi.mocked(f.guard.revalidate).mockRejectedValueOnce(failure);
        operation = observe(f.runtime.activate(selection.id));
        await flush();
        if (boundary === "revalidation") f.children[0]!.reply("pinned");
      }
      await flush();
      const code =
        boundary === "initial"
          ? "activation-failed"
          : boundary === "call"
            ? "outcome-unknown"
            : "protocol";
      expect(await operation).toMatchObject({ code, message: code });
      const retirement = f.runtime.retire(selection.id);
      if (f.children[0]) {
        f.children[0].exit(0, null);
        f.children[0].close();
      }
      await vi.advanceTimersByTimeAsync(2000);
      expect(await retirement).toMatchObject({
        settled: false,
        cleanupFailed: true,
      });
      expect(await observe(f.runtime.activate(selection.id))).toMatchObject({
        code: "unavailable",
      });
      expect(f.spawn).toHaveBeenCalledTimes(boundary === "initial" ? 0 : 1);
    },
  );

  it.each(["retire", "abort"])(
    "removes admission infrastructure immediately on %s but retains I/O",
    async (action) => {
      const f = await active();
      const acquired = deferred<OpenVersion>();
      f.openVersion.mockReturnValueOnce(acquired.promise);
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const pending = observe(f.backend.call(null, controller.signal));
      expect(vi.getTimerCount()).toBe(1);
      if (action === "abort") {
        controller.abort();
        expect(remove).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      }
      const retirement = f.backend.retire();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(await pending).toMatchObject({
        code: action === "abort" ? "cancelled" : "unavailable",
      });
      f.child.exit(0, null);
      f.child.close();
      await vi.advanceTimersByTimeAsync(2000);
      expect(await retirement).toMatchObject({ settled: false });
      expect(vi.getTimerCount()).toBe(0);
      expect(await observe(f.runtime.activate(selection.id))).toMatchObject({
        code: "unavailable",
      });
      const late = pin();
      acquired.resolve(late);
      await flush();
      expect(late.release).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(f.child.kinds()).not.toContain("call");
    },
  );

  it.each(["initial", "call"])(
    "records late %s acquisition cleanup failure before releasing ownership",
    async (boundary) => {
      const f = fixture();
      const acquired = deferred<OpenVersion>();
      let operation: Promise<unknown>;
      if (boundary === "call") {
        const a = await active(f);
        f.openVersion.mockReturnValueOnce(acquired.promise);
        operation = observe(a.backend.call(null));
      } else {
        f.openVersion.mockReturnValueOnce(acquired.promise);
        operation = observe(f.runtime.activate(selection.id));
      }
      const retirement = f.runtime.retire(selection.id);
      if (f.children[0]) {
        f.children[0].exit(0, null);
        f.children[0].close();
      }
      await flush();
      expect(await operation).toMatchObject({ code: "unavailable" });
      acquired.reject(
        Object.assign(new PackageError("invalid-store"), {
          cleanupFailed: true,
        }),
      );
      await flush();
      expect(await retirement).toMatchObject({
        settled: false,
        cleanupFailed: true,
      });
      expect(await observe(f.runtime.activate(selection.id))).toMatchObject({
        code: "unavailable",
      });
      expect(f.spawn).toHaveBeenCalledTimes(boundary === "initial" ? 0 : 1);
    },
  );

  it.each(["guard", "late-call-pin"])(
    "retains explicit %s release failure",
    async (boundary) => {
      const f = fixture();
      if (boundary === "guard") {
        vi.mocked(f.guard.release).mockRejectedValueOnce(
          new Error("synthetic release"),
        );
        const activation = observe(f.runtime.activate(selection.id));
        await flush();
        f.children[0]!.reply("pinned");
        await flush();
        expect(await activation).toMatchObject({ code: "outcome-unknown" });
      } else {
        const a = await active(f);
        const acquired = deferred<OpenVersion>();
        f.openVersion.mockReturnValueOnce(acquired.promise);
        const call = observe(a.backend.call(null));
        void a.backend.retire();
        expect(await call).toMatchObject({ code: "unavailable" });
        const late = pin();
        vi.mocked(late.release).mockRejectedValueOnce(
          new Error("synthetic release"),
        );
        acquired.resolve(late);
        await flush();
      }
      const retirement = f.runtime.retire(selection.id);
      f.children[0]!.exit(0, null);
      f.children[0]!.close();
      await flush();
      expect(await retirement).toMatchObject({
        settled: false,
        cleanupFailed: true,
      });
      expect(await observe(f.runtime.activate(selection.id))).toMatchObject({
        code: "unavailable",
      });
      expect(f.spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("reports late import cleanup failure before the retirement deadline", async () => {
    const f = fixture();
    const checked = deferred<boolean>();
    vi.mocked(f.guard.revalidate).mockReturnValueOnce(checked.promise);
    void observe(f.runtime.activate(selection.id));
    await flush();
    const child = f.children[0]!;
    child.reply("pinned");
    await flush();
    const retirement = f.runtime.retire(selection.id);
    child.exit(0, null);
    child.close();
    await flush();
    checked.reject(
      Object.assign(new PackageError("invalid-store"), { cleanupFailed: true }),
    );
    await flush();
    expect(await retirement).toMatchObject({
      settled: false,
      cleanupFailed: true,
    });
    expect(await observe(f.runtime.activate(selection.id))).toMatchObject({
      code: "unavailable",
    });
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("returns fixed Promise rejections without executing caller getters or hooks", async () => {
    const f = await active();
    for (const key of ["value", "toJSON"]) {
      const getter = vi.fn(() => {
        throw new Error("synthetic private detail");
      });
      const value = Object.defineProperty({}, key, {
        get: getter,
        enumerable: key === "value",
      });
      let result!: Promise<unknown>;
      expect(() => {
        result = f.backend.call(value);
      }).not.toThrow();
      expect(result).toBeInstanceOf(Promise);
      expect(await observe(result)).toMatchObject({
        code: "protocol",
        message: "protocol",
      });
      expect(getter).not.toHaveBeenCalled();
    }
    expect(f.child.kinds()).not.toContain("call");
  });
});

const envelope = { epoch: "a".repeat(36), sequence: 1, kind: "call" };
describe("extension runtime protocol bounds", () => {
  it("rejects nonenumerable serialization substitution without invoking it", () => {
    const hook = vi.fn(() => "x".repeat(MESSAGE_BYTES * 2));
    const value = Object.defineProperty({}, "toJSON", { value: hook });
    expect(boundedValue(value)).toBe(false);
    expect(() => encode({ ...envelope, value })).toThrow("protocol");
    expect(hook).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects changing/throwing accessors with zero reads (%s)",
    (throws) => {
      let reads = 0;
      const value = Object.defineProperty({}, "data", {
        enumerable: true,
        get() {
          reads++;
          if (throws) throw new Error("synthetic private detail");
          return reads === 1 ? null : "x".repeat(MESSAGE_BYTES * 2);
        },
      });
      expect(boundedValue(value)).toBe(false);
      expect(() => encode({ ...envelope, value })).toThrow("protocol");
      expect(reads).toBe(0);
    },
  );

  it("rejects proxies without invoking traps", () => {
    const trap = vi.fn(() => {
      throw new Error("synthetic trap");
    });
    const value = new Proxy(
      {},
      { ownKeys: trap, getPrototypeOf: trap, get: trap },
    );
    expect(boundedValue(value)).toBe(false);
    expect(() => encode({ ...envelope, value })).toThrow("protocol");
    expect(trap).not.toHaveBeenCalled();
  });

  it("safely captures special keys and arrays without inherited serialization hooks", () => {
    const value: unknown = JSON.parse(
      '{"__proto__":{"safe":true},"constructor":"data","array":[1,null]}',
    );
    expect(decode(encode({ ...envelope, value })).value).toEqual(value);
    const hook = vi.fn(() => "substituted");
    Object.defineProperty(Array.prototype, "toJSON", {
      value: hook,
      configurable: true,
    });
    try {
      expect(decode(encode({ ...envelope, value: [1, 2] })).value).toEqual([
        1, 2,
      ]);
      expect(hook).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(Array.prototype, "toJSON");
    }
  });

  it("round-trips bounded JSON values and checks exact envelope fields", () => {
    const message = {
      ...envelope,
      request: 1,
      value: { nested: [null, true, 2, "text"] },
    };
    expect(boundedValue(message.value)).toBe(true);
    expect(decode(encode(message))).toEqual(message);
    expect(exact(message, ["request", "value"])).toBe(true);
    expect(exact({ ...message, extra: null }, ["request", "value"])).toBe(
      false,
    );
    expect(exact(envelope, ["request"])).toBe(false);
  });

  it.each([
    NaN,
    Infinity,
    undefined,
    1n,
    new Date(0),
    () => null,
    Symbol("invalid"),
  ])("rejects non-JSON value %s", (value) => {
    expect(boundedValue(value)).toBe(false);
  });

  it("rejects oversized collections, excessive depth, cycles and string budget before encoding", () => {
    expect(boundedValue(Array.from({ length: 256 }, () => null))).toBe(true);
    expect(boundedValue(Array.from({ length: 257 }, () => null))).toBe(false);
    expect(
      boundedValue(
        Object.fromEntries(
          Array.from({ length: 257 }, (_, i) => [String(i), null]),
        ),
      ),
    ).toBe(false);
    let nested: unknown = null;
    for (let i = 0; i < 17; i++) nested = [nested];
    expect(boundedValue(nested)).toBe(false);
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(boundedValue(cycle)).toBe(false);
    expect(boundedValue("x".repeat(MESSAGE_BYTES))).toBe(false);
    expect(() =>
      encode({ ...envelope, value: "x".repeat(MESSAGE_BYTES) }),
    ).toThrow("protocol");
  });

  it.each([
    null,
    {},
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...envelope, epoch: "short" }),
    JSON.stringify({ ...envelope, sequence: 0 }),
    JSON.stringify({ ...envelope, sequence: 1.5 }),
    JSON.stringify({ ...envelope, sequence: Number.MAX_SAFE_INTEGER + 1 }),
    JSON.stringify({ ...envelope, kind: 2 }),
  ])("rejects malformed envelope %#", (raw) => {
    expect(() => decode(raw)).toThrow("protocol");
  });

  it("enforces actual UTF-8 bytes, not just UTF-16 length", () => {
    const raw = JSON.stringify({
      ...envelope,
      value: "é".repeat(MESSAGE_BYTES / 2),
    });
    expect(raw.length).toBeLessThan(MESSAGE_BYTES);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(MESSAGE_BYTES);
    expect(() => decode(raw)).toThrow("protocol");
    expect(() => decode(" ".repeat(MESSAGE_BYTES + 1))).toThrow("protocol");
  });
});

describe("extension runtime environment boundary", () => {
  it("copies only explicit normal-user helper variables and excludes injected Node, RunAsNode and OMXTerm inputs", () => {
    const source = {
      PATH: "/synthetic/bin",
      Home: "/synthetic/home",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      SSH_AUTH_SOCK: "/synthetic/agent",
      XDG_RUNTIME_DIR: "/synthetic/run",
      SYSTEMROOT: "C:\\Windows",
      NODE_OPTIONS: "--require=evil",
      node_options: "--inspect",
      NODE_PATH: "/injected",
      ELECTRON_RUN_AS_NODE: "1",
      electron_run_as_node: "1",
      OMXTERM_TEST: "1",
      OMXTERM_CONFIG: "/injected",
      AWS_SECRET_ACCESS_KEY: "synthetic",
      UNRELATED: "value",
      TMP: undefined,
    };
    const environment = backendEnvironment(source);
    expect(environment).toEqual({
      PATH: source.PATH,
      Home: source.Home,
      LANG: source.LANG,
      LC_ALL: source.LC_ALL,
      SSH_AUTH_SOCK: source.SSH_AUTH_SOCK,
      XDG_RUNTIME_DIR: source.XDG_RUNTIME_DIR,
      SYSTEMROOT: source.SYSTEMROOT,
    });
    source.PATH = "/changed";
    expect(environment.PATH).toBe("/synthetic/bin");
  });

  it("refuses the Electron browser factory in headless Node before opening any store", async () => {
    await expect(
      createExtensionRuntime({
        root: "/synthetic/store",
        addon: "/synthetic/addon.node",
        bootstrap: "/synthetic/bootstrap.js",
        environment: {},
        runtime: { appVersion: "1.0.0", apiVersion: "1.0.0" },
        owner: new AbortController().signal,
      }),
    ).rejects.toThrow("electron-main-required");
  });
});
