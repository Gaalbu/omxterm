import omthemeDocument from "../../docs/omtheme.json";

export const TERMINAL_THEME_VERSION = 1;
export const MAX_TERMINAL_THEME_NAME_CODE_POINTS = 64;

export const TERMINAL_THEME_COLOR_KEYS = [
  "background",
  "foreground",
  "cursor",
  "selectionBackground",
  "selectionForeground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export type TerminalThemeColorKey = (typeof TERMINAL_THEME_COLOR_KEYS)[number];
export type TerminalThemeColors = Readonly<
  Record<TerminalThemeColorKey, string>
>;

export const TERMINAL_THEME_APPEARANCE_KEYS = [
  "paneDivider",
  "auxiliaryPanelDivider",
  "activePaneHighlight",
] as const;

export type TerminalThemeAppearance = Readonly<
  Partial<
    Record<(typeof TERMINAL_THEME_APPEARANCE_KEYS)[number], string | null>
  >
>;

export interface TerminalTheme {
  readonly version: 1;
  readonly name: string;
  readonly colors: TerminalThemeColors;
  readonly appearance?: TerminalThemeAppearance;
}

export const DEFAULT_TERMINAL_THEME: TerminalTheme = Object.freeze({
  version: TERMINAL_THEME_VERSION,
  name: omthemeDocument.name,
  colors: Object.freeze({ ...omthemeDocument.colors }),
});

export function isTerminalTheme(value: unknown): value is TerminalTheme {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some(
      (key) => !["version", "name", "colors", "appearance"].includes(key),
    ) ||
    !["version", "name", "colors"].every((key) => key in value)
  )
    return false;
  if ("appearance" in value) {
    const appearance = value.appearance;
    if (!isRecord(appearance)) return false;
    if (
      Object.keys(appearance).some(
        (key) =>
          !TERMINAL_THEME_APPEARANCE_KEYS.some((allowed) => allowed === key),
      ) ||
      !Object.values(appearance).every(
        (color) => color === null || isTerminalThemeColor(color),
      )
    )
      return false;
  }
  if (value.version !== TERMINAL_THEME_VERSION) return false;
  if (!isTerminalThemeName(value.name) || !isRecord(value.colors)) return false;
  const colors = value.colors;
  if (!hasExactKeys(colors, TERMINAL_THEME_COLOR_KEYS)) return false;
  return TERMINAL_THEME_COLOR_KEYS.every((key) =>
    isTerminalThemeColor(colors[key]),
  );
}

export function isTerminalThemeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    [...value].length <= MAX_TERMINAL_THEME_NAME_CODE_POINTS &&
    !/[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/u.test(value)
  );
}

export function isTerminalThemeColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length && expected.every((key) => key in value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
