import { expect, it } from "vitest";
import {
  validateUserConfiguration,
  DEFAULT_USER_CONFIGURATION,
} from "../../src/main/user-configuration";
import { terminalRendererConfiguration } from "../../src/main/active-user-configuration";
import { isTerminalRendererConfiguration } from "../../src/shared/user-configuration";
const configPath = "/synthetic/config.json";

it("defaults terminal context menus on and accepts an explicit opt-out", () => {
  expect(
    validateUserConfiguration({ version: 1 }, configPath, new Set())
      .terminalContextMenu,
  ).toBe(true);
  expect(
    validateUserConfiguration(
      { version: 1, terminal: { contextMenu: false } },
      configPath,
      new Set(),
    ).terminalContextMenu,
  ).toBe(false);
});

it.each([null, 0, "false", {}])(
  "rejects non-boolean terminal.contextMenu %j",
  (value) => {
    expect(() =>
      validateUserConfiguration(
        { version: 1, terminal: { contextMenu: value } },
        configPath,
        new Set(),
      ),
    ).toThrow(/terminal\.contextMenu/u);
  },
);

it("validates the context-menu preference at the renderer boundary", () => {
  const configuration = terminalRendererConfiguration(
    { configuration: DEFAULT_USER_CONFIGURATION, userFileErrors: [] },
    0,
  );
  expect(configuration.terminalContextMenu).toBe(true);
  expect(
    isTerminalRendererConfiguration({
      ...configuration,
      terminalContextMenu: false,
    }),
  ).toBe(true);
  for (const value of [null, 0, "false", {}])
    expect(
      isTerminalRendererConfiguration({
        ...configuration,
        terminalContextMenu: value,
      }),
    ).toBe(false);
});
