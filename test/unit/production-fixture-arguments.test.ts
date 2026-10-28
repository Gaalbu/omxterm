import { expect, it } from "vitest";
import { productionFixtureArguments } from "../fixtures/supported-fixture-chromium-arguments";

it("supplies the accepted Linux sandbox flag before the literal app path, without overriding production display selection", () => {
  const root = "/fixture directory/app";
  expect(productionFixtureArguments(root, "linux")).toEqual([
    "--no-sandbox",
    root,
  ]);
});
it.each(["darwin", "win32"] as const)(
  "preserves %s sandbox and literal argument boundaries",
  (platform) => {
    const root = "fixture with spaces;not-a-shell-command";
    expect(productionFixtureArguments(root, platform)).toEqual([root]);
  },
);
