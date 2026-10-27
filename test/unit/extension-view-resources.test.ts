import { expect, it, vi } from "vitest";
import {
  createExtensionResources,
  extensionResourceLimits,
  extensionResourceFromUrl,
} from "../../src/main/extension-view-resources";

it("rejects raw traversal, encoded separators, queries and origin lookalikes before URL normalization", () => {
  for (const path of [
    "%2e%2e/secret",
    "app.js?x",
    "app.js#x",
    "a%2fb.js",
    "a%5cb.js",
    "./app.js",
    "../app.js",
    "a//app.js",
    "file:///secret",
    "app.js%00",
    "app.js?",
  ]) {
    expect(
      extensionResourceFromUrl(
        `omx-extension://epoch/${path}`,
        "omx-extension://epoch",
      ),
    ).toBeNull();
  }
  expect(
    extensionResourceFromUrl(
      "omx-extension://epoch.evil/app.js",
      "omx-extension://epoch",
    ),
  ).toBeNull();
  expect(
    extensionResourceFromUrl(
      "omx-extension://epoch/ui/app.js",
      "omx-extension://epoch",
    ),
  ).toBe("ui/app.js");
});

it("refuses prototype-name MIME suffixes and unsupported paths without I/O", async () => {
  const read = vi.fn(async () => new Uint8Array());
  const resources = createExtensionResources(
    { read, release: async () => {} },
    "omx-extension://epoch",
  );
  for (const path of [
    "asset.constructor",
    "asset.__proto__",
    "asset.toString",
    "asset.hasOwnProperty",
    "constructor",
    "asset",
    "asset.txt",
  ])
    expect(
      (await resources.respond(new Request(`omx-extension://epoch/${path}`)))
        .status,
    ).toBe(403);
  expect(read).not.toHaveBeenCalled();
});

it("refuses invalid adapter payloads and oversized backing buffers, never forwarding handles", async () => {
  const read = vi.fn(
    async () => new Uint8Array(extensionResourceLimits.bytes + 1),
  );
  const resources = createExtensionResources(
    { read, release: async () => {} },
    "omx-extension://epoch",
  );
  const request = () => new Request("omx-extension://epoch/app.js");
  expect((await resources.respond(request())).status).toBe(413);
  read.mockResolvedValue(
    new Uint8Array(new ArrayBuffer(extensionResourceLimits.bytes + 1), 0, 1),
  );
  expect((await resources.respond(request())).status).toBe(413);
  read.mockResolvedValue(
    "file:///secret" as unknown as Uint8Array<ArrayBuffer>,
  );
  expect((await resources.respond(request())).status).toBe(413);
  resources.revoke();
  expect((await resources.respond(request())).status).toBe(403);
  expect(read).toHaveBeenCalledTimes(3);
});

it("refuses non-GET and pre-aborted requests without I/O; delivered responses own copied bytes", async () => {
  const bytes = new Uint8Array([65]);
  const read = vi.fn(async () => bytes);
  const resources = createExtensionResources(
    { read, release: async () => {} },
    "omx-extension://epoch",
  );
  const url = "omx-extension://epoch/app.js";
  expect(
    (await resources.respond(new Request(url, { method: "POST" }))).status,
  ).toBe(403);
  expect(
    (await resources.respond(new Request(url, { signal: AbortSignal.abort() })))
      .status,
  ).toBe(403);
  expect(read).not.toHaveBeenCalled();
  const response = await resources.respond(new Request(url));
  bytes[0] = 66;
  expect(await response.text()).toBe("A");
});
