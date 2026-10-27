import { UserConfigurationError } from "./user-configuration-error";

export function validateTerminalMenu(
  terminal: Record<string, unknown> | undefined,
  configurationPath: string,
): boolean {
  const unknown = Object.keys(terminal ?? {}).find(
    (key) => key !== "padding" && key !== "contextMenu",
  );
  if (unknown !== undefined)
    throw new UserConfigurationError(
      configurationPath,
      `terminal.${unknown}`,
      "is unknown",
    );
  const value = terminal?.contextMenu;
  if (value === undefined) return true;
  if (typeof value !== "boolean")
    throw new UserConfigurationError(
      configurationPath,
      "terminal.contextMenu",
      "must be a boolean",
    );
  return value;
}
