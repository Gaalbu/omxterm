// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { renderExtensions } from "../../src/renderer/settings/settings-extensions";
import type {
  ExtensionsRequest,
  ExtensionsResult,
} from "../../src/shared/extensions";
afterEach(() => document.body.replaceChildren());
const snapshot: ExtensionsResult = {
  ok: true,
  pendingCleanup: true,
  entries: [
    {
      id: "omxterm.files",
      generation: 4,
      name: "Files",
      version: "0.1.0",
      installed: true,
      enabled: true,
      local: "unknown",
    },
  ],
};
function click(text: string) {
  [...document.querySelectorAll("button")]
    .find((button) => button.textContent === text)!
    .click();
}
it("shows separate registry/local/other-instance/cleanup states and captures the displayed generation", async () => {
  const request = vi
    .fn<(_request: ExtensionsRequest) => Promise<ExtensionsResult>>()
    .mockResolvedValue(snapshot);
  document.body.append(renderExtensions(document, { request }, () => true));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Pending Cleanup"),
  );
  expect(document.body.textContent).toContain(
    "generation 4 · enabled · local unknown · other instances unknown",
  );
  click("Disable");
  await vi.waitFor(() =>
    expect(request).toHaveBeenLastCalledWith({
      operation: "disable",
      id: "omxterm.files",
      generation: 4,
    }),
  );
});
it("does not repeat unknown mutation outcomes; Refresh is a separate deliberate snapshot", async () => {
  const request = vi
    .fn<(_request: ExtensionsRequest) => Promise<ExtensionsResult>>()
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce({ ok: false, error: "outcome-unknown" })
    .mockResolvedValue(snapshot);
  document.body.append(renderExtensions(document, { request }, () => true));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("generation 4"),
  );
  click("Uninstall");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("No automatic retry"),
  );
  expect(request).toHaveBeenCalledTimes(2);
  click("Refresh");
  await vi.waitFor(() =>
    expect(request).toHaveBeenLastCalledWith({ operation: "snapshot" }),
  );
  expect(request).toHaveBeenCalledTimes(3);
});
