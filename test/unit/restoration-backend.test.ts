import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { activate } from "../../extensions/restoration/backend";
import {
  createExtensionState,
  type ExtensionState,
  type StateSnapshot,
} from "../../src/extension-runtime/state";
import { savedLayout } from "../fixtures/restoration-layout";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
async function stateFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omxterm-restoration-"));
  roots.push(root);
  const state = createExtensionState({
    packageRoot: path.join(root, "extensions"),
    id: "omxterm.restoration",
    leases: { tryAcquire: async () => ({ release: async () => {} }) },
  });
  const backend = () => activate({ signal: signal(), state });
  return { state, backend };
}
it("composes real scoped state with cold backend read, CAS replacement and revisioned Forget", async () => {
  const f = await stateFixture();
  const first = f.backend();
  expect(await first.invoke({ operation: "read" }, signal())).toMatchObject({
    ok: true,
    status: "empty",
    revision: "absent",
  });
  const value = savedLayout();
  const saved = await first.invoke(
    { operation: "replace", expectedRevision: "absent", value },
    signal(),
  );
  expect(saved).toMatchObject({ ok: true, status: "saved", value });
  const cold = f.backend();
  expect(await cold.invoke({ operation: "read" }, signal())).toEqual(saved);
  expect(
    await cold.invoke(
      { operation: "replace", expectedRevision: "absent", value: null },
      signal(),
    ),
  ).toEqual({ ok: false, error: "conflict" });
  const current = await f.state.read();
  expect(
    await cold.invoke(
      { operation: "replace", expectedRevision: current.revision, value: null },
      signal(),
    ),
  ).toMatchObject({ ok: true, status: "empty", value: null });
  expect((await f.state.read()).revision).not.toBe("absent");
});
it("preserves an invalid-schema document and exposes only its revision for explicit recovery", async () => {
  const f = await stateFixture();
  const original = await f.state.replace("absent", {
    unknownSchema: true,
    private: "/do-not-display",
  });
  expect(await f.backend().invoke({ operation: "read" }, signal())).toEqual({
    ok: true,
    status: "invalid",
    revision: original.revision,
    value: null,
  });
  expect(await f.state.read()).toEqual(original);
  expect(
    await f.backend().invoke(
      {
        operation: "replace",
        expectedRevision: original.revision,
        value: savedLayout(),
      },
      signal(),
    ),
  ).toMatchObject({ ok: true, status: "saved" });
});
it("rejects unsupported operations, invalid schema and undeclared state without filesystem side effects", async () => {
  const state: ExtensionState = { read: vi.fn(), replace: vi.fn() };
  const backend = activate({ signal: signal(), state });
  for (const input of [
    { operation: "write", path: "/anything" },
    { operation: "read", extra: true },
    { operation: "replace", expectedRevision: "absent", value: {} },
    { operation: "replace", expectedRevision: "bad", value: null },
  ])
    expect(await backend.invoke(input, signal())).toEqual({
      ok: false,
      error: "invalid-request",
    });
  expect(state.read).not.toHaveBeenCalled();
  expect(state.replace).not.toHaveBeenCalled();
  expect(
    await activate({ signal: signal() }).invoke(
      { operation: "read" },
      signal(),
    ),
  ).toEqual({ ok: false, error: "unavailable" });
});
it("retains one backend operation through cancellation and returns busy without a queue", async () => {
  let finish!: () => void;
  const state: ExtensionState = {
    read: vi.fn(
      () =>
        new Promise<StateSnapshot>((resolve) => {
          finish = () => resolve({ revision: "absent", value: null });
        }),
    ),
    replace: vi.fn(),
  };
  const backend = activate({ signal: signal(), state });
  const owner = new AbortController();
  const read = backend.invoke({ operation: "read" }, owner.signal);
  owner.abort();
  expect(
    await backend.invoke(
      { operation: "replace", expectedRevision: "absent", value: null },
      signal(),
    ),
  ).toEqual({ ok: false, error: "busy" });
  expect(state.replace).not.toHaveBeenCalled();
  finish();
  await read;
  expect(await backend.invoke({ operation: "read" }, owner.signal)).toEqual({
    ok: false,
    error: "unavailable",
  });
});
it("does not retry an unknown write or expose exception paths", async () => {
  const state: ExtensionState = {
    read: vi.fn(),
    replace: vi.fn(async () => {
      throw new Error("/private/error");
    }),
  };
  const backend = activate({ signal: signal(), state });
  expect(
    await backend.invoke(
      {
        operation: "replace",
        expectedRevision: "absent",
        value: savedLayout(),
      },
      signal(),
    ),
  ).toEqual({ ok: false, error: "outcome-unknown" });
  expect(state.replace).toHaveBeenCalledTimes(1);
});
