// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { translatorFor } from "../../src/shared/i18n";
import type { Translate } from "../../src/renderer/renderer-language";
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
it("relabels retained pending controls and status without replaying or changing generations", async () => {
  let finish!: (result: ExtensionsResult) => void;
  const request = vi
    .fn<(_request: ExtensionsRequest) => Promise<ExtensionsResult>>()
    .mockResolvedValueOnce(snapshot)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const labels: ((t: Translate) => void)[] = [];
  document.body.append(
    renderExtensions(document, { request }, () => true, labels),
  );
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("generation 4"),
  );
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Disable",
  )!;
  button.click();
  labels.forEach((label) => label(translatorFor("pt-BR").t));
  expect(button.isConnected).toBe(true);
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("Desabilitar");
  expect(document.body.textContent).toContain(
    "geração 4 · habilitada · local desconhecida",
  );
  expect(document.body.textContent).toContain("Limpeza pendente");
  expect(request).toHaveBeenCalledTimes(2);
  finish({ ok: false, error: "outcome-unknown" });
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      "Resultado da operação desconhecido",
    ),
  );
  expect(button.disabled).toBe(false);
  expect(request).toHaveBeenLastCalledWith({
    operation: "disable",
    id: "omxterm.files",
    generation: 4,
  });
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
