import { open as realOpen } from "node:fs/promises";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let next: ReturnType<typeof holdFontRead> | undefined;
const releases = new Set<() => void>();
export const fontReadHandles = { opened: 0, closed: 0, reads: 0 };

// Test-only filesystem adapter. The build redirects ONLY installed-font-family's
// open import here. Discovery, stat/size checks, real positional read, parser and
// finally-close remain production code; no runtime-init delay substitutes for I/O.
export function holdFontRead() {
  const entered = deferred();
  const finish = deferred();
  const gate = {
    entered: entered.promise,
    signal: entered.resolve,
    wait: finish.promise,
    release() {
      finish.resolve();
      releases.delete(gate.release);
    },
  };
  releases.add(gate.release);
  next = gate;
  return gate;
}
export function releaseFontReads() {
  for (const release of releases) release();
  next = undefined;
}
export const open: typeof realOpen = async (...args) => {
  const file = await realOpen(...args);
  fontReadHandles.opened += 1;
  return new Proxy(file, {
    get(target, key) {
      if (key === "read")
        return async (...readArgs: unknown[]) => {
          fontReadHandles.reads += 1;
          const gate = next;
          if (gate) {
            next = undefined;
            gate.signal();
            await gate.wait;
          }
          const result: unknown = Reflect.apply(target.read, target, readArgs);
          return result;
        };
      if (key === "close")
        return async () => {
          await target.close();
          fontReadHandles.closed += 1;
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
};
