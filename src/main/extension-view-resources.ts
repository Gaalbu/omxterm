import { isExtensionResource } from "../shared/extensions.js";
export { isExtensionResource } from "../shared/extensions.js";

export interface CapturedResourceOwner {
  // Adapter contract: already-pinned immutable bytes, no latest lookup. Bound
  // allocation DURING the read (not readFile followed by a size check), retain
  // the pin through actual I/O, and settle even when cancellation arrives late.
  read(
    relativeResource: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  // A rejected release is unknown. The host never retries it.
  release(): Promise<void>;
}

export const extensionResourceLimits = {
  bytes: 2 * 1024 * 1024,
  reads: 4,
  activeBytes: 8 * 1024 * 1024,
} as const;
export const extensionViewCsp =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const types: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function extensionResourceFromUrl(
  url: string,
  origin: string,
): string | null {
  if (!url.startsWith(`${origin}/`)) return null;
  const resource = url.slice(origin.length + 1);
  return isExtensionResource(resource) ? resource : null;
}

// Only fully materialized Responses cross this seam. Chromium never receives a
// root, handle, file URL, stream or capability to reopen an installed package.
export function createExtensionResources(
  owner: CapturedResourceOwner,
  origin: string,
) {
  let revoked = false;
  let reservedBytes = 0;
  const active = new Map<AbortController, Promise<void>>();
  return {
    async respond(request: Request): Promise<Response> {
      const path = extensionResourceFromUrl(request.url, origin);
      const suffix = path?.split(".").at(-1) ?? "";
      const mime = Object.hasOwn(types, suffix) ? types[suffix] : undefined;
      if (
        revoked ||
        request.signal.aborted ||
        request.method !== "GET" ||
        path === null ||
        !mime
      )
        return new Response(null, { status: 403 });
      if (
        active.size >= extensionResourceLimits.reads ||
        reservedBytes + extensionResourceLimits.bytes >
          extensionResourceLimits.activeBytes
      )
        return new Response(null, { status: 429 });
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      let finish!: () => void;
      active.set(
        controller,
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      );
      reservedBytes += extensionResourceLimits.bytes;
      try {
        const bytes = await owner.read(
          path,
          extensionResourceLimits.bytes,
          controller.signal,
        );
        if (revoked || controller.signal.aborted)
          return new Response(null, { status: 410 });
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength > extensionResourceLimits.bytes ||
          bytes.buffer.byteLength > extensionResourceLimits.bytes
        )
          return new Response(null, { status: 413 });
        // Response copies this bounded view; browser-held response bytes are not
        // an outstanding filesystem read or an unbounded host response queue.
        return new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: {
            "Content-Type": mime,
            "Content-Security-Policy": extensionViewCsp,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          },
        });
      } catch {
        return new Response(null, {
          status: controller.signal.aborted ? 410 : 404,
        });
      } finally {
        request.signal.removeEventListener("abort", abort);
        reservedBytes -= extensionResourceLimits.bytes;
        active.delete(controller);
        finish();
      }
    },
    revoke() {
      revoked = true;
      for (const controller of active.keys()) controller.abort();
    },
    async drain() {
      await Promise.all(active.values());
    },
  };
}
