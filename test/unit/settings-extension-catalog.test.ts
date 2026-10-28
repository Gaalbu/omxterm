// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import { renderExtensions } from "../../src/renderer/settings/settings-extensions";
import { translatorFor } from "../../src/shared/i18n";
import type { Translate } from "../../src/renderer/renderer-language";
import type {
  ExtensionsRequest,
  ExtensionsResult,
} from "../../src/shared/extensions";
afterEach(() => document.body.replaceChildren());
const catalog = {
  loaded: true,
  stale: false,
  entries: [
    {
      selection: "a".repeat(36),
      id: "omxterm.files",
      name: "<img src=x>",
      description: "<script>evil()</script>",
      version: "0.1.0",
      installedVersion: "0.2.0",
      compatible: true,
      action: "replace" as const,
    },
  ],
};
const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (item) => item.textContent === text,
  )!;
it("loads only explicitly, renders plain text, localizes retained cards and binds selection", async () => {
  const request = vi
    .fn<(request: ExtensionsRequest) => Promise<ExtensionsResult>>()
    .mockResolvedValueOnce({ ok: true, entries: [] })
    .mockResolvedValueOnce({ ok: true, catalog })
    .mockResolvedValue({ ok: true, entries: [], catalog });
  const labels: ((t: Translate) => void)[] = [];
  document.body.append(
    renderExtensions(document, { request }, () => true, labels),
  );
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(request).toHaveBeenLastCalledWith({ operation: "snapshot" });
  button("Browse official extensions").click();
  await vi.waitFor(() =>
    expect(button("Replace installed version")).toBeDefined(),
  );
  expect(document.querySelector("script,img")).toBeNull();
  expect(document.body.textContent).toContain("<script>evil()</script>");
  expect(document.body.textContent).toContain(
    "older version or different bytes",
  );
  const retained = button("Replace installed version");
  retained.focus();
  labels.forEach((label) => label(translatorFor("pt-BR").t));
  expect(button("Substituir versão instalada")).toBe(retained);
  expect(document.activeElement).toBe(retained);
  expect(request).toHaveBeenCalledTimes(2);
  retained.click();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls[2]![0]).toMatchObject({
    operation: "catalog-install",
    selection: catalog.entries[0]!.selection,
  });
});
it("keeps local controls usable during cold offline loading and failure, with owned cancellation", async () => {
  let finish!: (result: ExtensionsResult) => void;
  const request = vi
    .fn<(request: ExtensionsRequest) => Promise<ExtensionsResult>>()
    .mockImplementation(async (value) =>
      value.operation === "catalog-refresh"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { ok: true, entries: [] },
    );
  const disposers: (() => void)[] = [];
  document.body.append(
    renderExtensions(document, { request }, () => true, [], disposers),
  );
  await vi.waitFor(() =>
    expect(button("Install from link").disabled).toBe(false),
  );
  button("Browse official extensions").click();
  expect(button("Install from link").disabled).toBe(false);
  const selected = request.mock.calls[1]![0];
  disposers.forEach((dispose) => dispose());
  expect(request).toHaveBeenLastCalledWith({
    operation: "cancel-install",
    token: "token" in selected ? selected.token : undefined,
  });
  finish({
    ok: false,
    error: "download-failed",
    catalog: { loaded: false, stale: true, entries: [] },
  });
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Catalog unavailable."),
  );
  expect(document.body.textContent).not.toContain("no published extensions");
  expect(button("Install from link").disabled).toBe(false);
  expect(button("Retry catalog").disabled).toBe(false);
});
it("shows stale success rather than an empty catalog after a failed refresh", async () => {
  const request = vi
    .fn<(request: ExtensionsRequest) => Promise<ExtensionsResult>>()
    .mockResolvedValueOnce({ ok: true, entries: [], catalog })
    .mockResolvedValueOnce({
      ok: false,
      error: "download-failed",
      catalog: { ...catalog, stale: true },
    });
  document.body.append(renderExtensions(document, { request }, () => true));
  await vi.waitFor(() => expect(button("Refresh catalog")).toBeDefined());
  button("Refresh catalog").click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("last successful snapshot"),
  );
  expect(button("Replace installed version").disabled).toBe(false);
  expect(document.body.textContent).toContain("Installed: 0.2.0");
});
