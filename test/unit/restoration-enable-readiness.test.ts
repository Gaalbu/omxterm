// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { renderExtensions } from "../../src/renderer/settings/settings-extensions";
import type {
  ExtensionsRequest,
  ExtensionsResult,
} from "../../src/shared/extensions";
import { RESTORATION_ENABLED_SNAPSHOT } from "../fixtures/restoration-native-contract";

afterEach(() => document.body.replaceChildren());

it("requires completed Enable, not the retained disabled/dormant snapshot", async () => {
  const snapshot = (enabled: boolean): ExtensionsResult => ({
    ok: true,
    pendingCleanup: false,
    entries: [
      {
        id: "omxterm.restoration",
        generation: enabled ? 3 : 2,
        name: "Saved Layout",
        version: "0.1.0",
        installed: true,
        enabled,
        local: "dormant",
      },
    ],
  });
  let finish!: (result: ExtensionsResult) => void;
  const request = vi
    .fn<(value: ExtensionsRequest) => Promise<ExtensionsResult>>()
    .mockResolvedValueOnce(snapshot(false))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  document.body.append(renderExtensions(document, { request }, () => true));
  const ready = () =>
    runInNewContext(RESTORATION_ENABLED_SNAPSHOT, { document }) as unknown;
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("disabled · local dormant"),
  );
  const enable = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Enable",
  )!;
  expect(ready()).toBe(false);
  enable.click();
  expect(request).toHaveBeenLastCalledWith({
    operation: "enable",
    id: "omxterm.restoration",
    generation: 2,
  });
  expect(enable.disabled).toBe(true);
  expect(document.body.textContent).toContain("disabled · local dormant");
  expect(ready()).toBe(false);
  finish(snapshot(true));
  await vi.waitFor(() => expect(ready()).toBe(true));
  expect(document.body.textContent).toContain(
    "generation 3 · enabled · local dormant",
  );
  expect(request).toHaveBeenCalledTimes(2);
});
