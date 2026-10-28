import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { PACKAGE_LIMITS } from "../installed-packages/archive";

export class ExtensionDownloadError extends Error {
  constructor(
    readonly code:
      | "invalid-url"
      | "download-failed"
      | "download-limit"
      | "download-timeout"
      | "cancelled",
  ) {
    super(code);
  }
}

export function extensionDownloadUrl(value: string): URL {
  if (value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value))
    throw new ExtensionDownloadError("invalid-url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExtensionDownloadError("invalid-url");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new ExtensionDownloadError("invalid-url");
  return url;
}

function response(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        signal,
        agent: false,
        maxHeaderSize: 16 * 1024,
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

function redirect(
  incoming: IncomingMessage,
  url: URL,
  count: number,
): URL | undefined {
  if (![301, 302, 303, 307, 308].includes(incoming.statusCode ?? 0)) return;
  if (count >= 5) throw new ExtensionDownloadError("download-limit");
  const location = incoming.headers.location;
  if (!location || location.length > 8192 || /[\x00-\x20\x7f\\]/.test(location))
    throw new ExtensionDownloadError("invalid-url");
  return extensionDownloadUrl(new URL(location, url).href);
}

async function body(
  incoming: IncomingMessage,
  signal: AbortSignal,
  maximum: number,
): Promise<Buffer> {
  if (
    incoming.statusCode !== 200 ||
    (incoming.headers["content-encoding"] &&
      incoming.headers["content-encoding"] !== "identity")
  )
    throw new ExtensionDownloadError("download-failed");
  const length = incoming.headers["content-length"];
  if (
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > maximum)
  )
    throw new ExtensionDownloadError("download-limit");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    signal.throwIfAborted();
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maximum) throw new ExtensionDownloadError("download-limit");
    chunks.push(bytes);
  }
  signal.throwIfAborted();
  if (!size || (length !== undefined && size !== Number(length)))
    throw new ExtensionDownloadError("download-failed");
  return Buffer.concat(chunks, size);
}

/** No browser session, cookies, credentials, proxy discovery or automatic redirects.
 * Only the explicit URL and each validated redirect are requested; nothing is logged. */
export async function downloadExtension(
  value: string,
  owner: AbortSignal,
  maximum: number = PACKAGE_LIMITS.archiveBytes,
): Promise<Buffer> {
  let url = extensionDownloadUrl(value);
  const timeout = AbortSignal.timeout(60_000);
  const signal = AbortSignal.any([owner, timeout]);
  try {
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const incoming = await response(url, signal);
      try {
        const next = redirect(incoming, url, redirects);
        if (!next) return await body(incoming, signal, maximum);
        url = next;
      } finally {
        incoming.destroy();
      }
    }
  } catch (error) {
    if (owner.aborted) throw new ExtensionDownloadError("cancelled");
    if (timeout.aborted) throw new ExtensionDownloadError("download-timeout");
    if (error instanceof ExtensionDownloadError) throw error;
    throw new ExtensionDownloadError("download-failed");
  }
}
