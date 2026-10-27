import { createRequire } from "node:module";

export type VersionLease = { release(): Promise<void> };
export type LeaseAdapter = {
  tryAcquire(
    filePath: string,
    exclusive: boolean,
  ): Promise<VersionLease | null>;
};

type NativeLeases = {
  tryAcquire(filePath: string, exclusive: boolean): Promise<object | null>;
  release(token: object): Promise<void>;
};

export function createNativeLeaseAdapter(addonPath: string): LeaseAdapter {
  let native: NativeLeases;
  try {
    native = createRequire(import.meta.url)(addonPath) as NativeLeases;
    if (
      typeof native.tryAcquire !== "function" ||
      typeof native.release !== "function"
    ) {
      throw new Error("LEASE_LOAD");
    }
  } catch {
    // Loader diagnostics can contain private paths. Keep the public failure fixed.
    throw Object.assign(new Error("LEASE_LOAD"), { code: "LEASE_LOAD" });
  }
  return {
    async tryAcquire(filePath, exclusive) {
      const token = await native.tryAcquire(filePath, exclusive);
      if (token === null) return null;
      // The closure owns the token even after acquire's promise is collected.
      // Concurrent and subsequent releases join the same native operation.
      let released: Promise<void> | undefined;
      return { release: () => (released ??= native.release(token)) };
    },
  };
}
