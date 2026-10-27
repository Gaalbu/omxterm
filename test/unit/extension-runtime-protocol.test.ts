import { describe, expect, it } from "vitest";
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

const envelope = { epoch: "a".repeat(36), sequence: 1, kind: "call" };
describe("extension runtime protocol bounds", () => {
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
