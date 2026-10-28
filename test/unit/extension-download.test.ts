import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({
  request:
    vi.fn<
      (
        url: URL,
        options: { signal: AbortSignal },
        callback: (message: IncomingMessage) => void,
      ) => EventEmitter & { end(): void }
    >(),
}));
vi.mock("node:https", () => ({ request: transport.request }));
import {
  downloadExtension,
  extensionDownloadUrl,
} from "../../src/main/extension-download";
const responses: Readable[] = [];
function reply(status = 200, headers = {}, chunks = [Buffer.from("archive")]) {
  const stream = Object.assign(Readable.from(chunks), {
    statusCode: status,
    headers,
  });
  responses.push(stream);
  transport.request.mockImplementationOnce((_url, _options, callback) => {
    const req = new EventEmitter();
    return Object.assign(req, {
      end: () => callback(stream as unknown as IncomingMessage),
    });
  });
  return stream;
}
afterEach(() => {
  transport.request.mockReset();
  responses.splice(0).forEach((s) => s.destroy());
  vi.useRealTimers();
});
it("admits deliberate HTTPS including signed queries, but not credentials, downgrade or ambiguous input", () => {
  expect(
    extensionDownloadUrl("https://example.org/archive?signature=abc").search,
  ).toBe("?signature=abc");
  for (const value of [
    "http://example.org/a",
    "file:///a",
    "https://u:p@example.org/a",
    "https://example.org/a#x",
    "https://example.org/a\n",
    "https:\\example.org/a",
    " ",
    "https://example.org/" + "x".repeat(8192),
  ])
    expect(() => extensionDownloadUrl(value)).toThrow("invalid-url");
});
it("captures exact streamed bytes through validated relative/cross-origin redirects with no browser authority", async () => {
  reply(302, { location: "/next" });
  reply(307, { location: "https://cdn.example.org/archive?sig=abc" });
  reply(200, { "content-length": "3" }, [
    Buffer.from([0, 1]),
    Buffer.from([255]),
  ]);
  expect(
    await downloadExtension(
      "https://example.org/start",
      new AbortController().signal,
    ),
  ).toEqual(Buffer.from([0, 1, 255]));
  expect(transport.request.mock.calls.map((call) => call[0].href)).toEqual([
    "https://example.org/start",
    "https://example.org/next",
    "https://cdn.example.org/archive?sig=abc",
  ]);
  expect(transport.request.mock.calls[0]![1]).toMatchObject({
    agent: false,
    maxHeaderSize: 16384,
    headers: { "Accept-Encoding": "identity" },
  });
  expect(responses.every((s) => s.destroyed)).toBe(true);
});
it("refuses unsafe redirects before another request and bounds loops", async () => {
  reply(302, { location: "http://example.org/a" });
  await expect(
    downloadExtension("https://example.org", new AbortController().signal),
  ).rejects.toThrow("invalid-url");
  expect(transport.request).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 6; i++) reply(302, { location: "/loop" });
  await expect(
    downloadExtension("https://example.org", new AbortController().signal),
  ).rejects.toThrow("download-limit");
  expect(transport.request).toHaveBeenCalledTimes(7);
});
it("rejects HTTP errors, encoded, empty, truncated and oversized bodies", async () => {
  for (const [status, headers, chunks, error] of [
    [404, {}, [Buffer.from("missing")], "download-failed"],
    [200, { "content-encoding": "gzip" }, [], "download-failed"],
    [200, {}, [], "download-failed"],
    [200, { "content-length": "9" }, [Buffer.from("short")], "download-failed"],
    [200, { "content-length": "67108865" }, [], "download-limit"],
    [
      200,
      {},
      [
        Buffer.alloc(32 * 1024 * 1024),
        Buffer.alloc(32 * 1024 * 1024),
        Buffer.from("x"),
      ],
      "download-limit",
    ],
  ] as const) {
    reply(status, headers, [...chunks]);
    await expect(
      downloadExtension("https://example.org", new AbortController().signal),
    ).rejects.toThrow(error);
  }
});
it("enforces the smaller catalog budget on declared and actual streamed bytes", async () => {
  const maximum = 256 * 1024;
  reply(200, { "content-length": String(maximum + 1) }, []);
  await expect(
    downloadExtension(
      "https://example.org/catalog",
      new AbortController().signal,
      maximum,
    ),
  ).rejects.toThrow("download-limit");
  reply(200, {}, [Buffer.alloc(maximum), Buffer.from("x")]);
  await expect(
    downloadExtension(
      "https://example.org/catalog",
      new AbortController().signal,
      maximum,
    ),
  ).rejects.toThrow("download-limit");
  reply(200, {}, [Buffer.alloc(maximum)]);
  expect(
    (
      await downloadExtension(
        "https://example.org/catalog",
        new AbortController().signal,
        maximum,
      )
    ).length,
  ).toBe(maximum);
});
it("enforces the one total deadline and returns only a safe timeout category", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(deadline.signal);
  transport.request.mockImplementationOnce((_url, options) => {
    const req = new EventEmitter();
    options.signal.addEventListener("abort", () =>
      req.emit("error", new Error("private transport detail")),
    );
    return Object.assign(req, { end() {} });
  });
  try {
    const pending = downloadExtension(
      "https://example.org",
      new AbortController().signal,
    );
    deadline.abort();
    await expect(pending).rejects.toThrow("download-timeout");
    expect(timeout).toHaveBeenCalledWith(60_000);
  } finally {
    timeout.mockRestore();
  }
});
it("cancellation closes the actual pending request and masks native error details", async () => {
  const owner = new AbortController();
  transport.request.mockImplementationOnce((_url, options) => {
    const req = new EventEmitter();
    options.signal.addEventListener("abort", () =>
      req.emit("error", new Error("private URL")),
    );
    return Object.assign(req, { end() {} });
  });
  const pending = downloadExtension(
    "https://example.org/private",
    owner.signal,
  );
  owner.abort();
  await expect(pending).rejects.toThrow("cancelled");
  await expect(
    downloadExtension("https://example.org", owner.signal),
  ).rejects.toThrow("cancelled");
  expect(transport.request).toHaveBeenCalledTimes(1);
});
