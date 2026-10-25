import { SETTINGS_FIELDS, type SettingsPath } from "../../shared/settings";
import { SUPPORTED_LANGUAGES, type MessageKey } from "../../shared/i18n";
import type { RendererLanguage, Translate } from "../renderer-language";

// Labels are message keys, so an open dialog relabels in place when the
// Interface Language changes.
export type Control =
  | {
      readonly kind: "toggle";
      readonly path: SettingsPath;
      readonly label: MessageKey;
    }
  | {
      readonly kind: "choice";
      readonly path: SettingsPath;
      readonly label: MessageKey;
      readonly options: readonly (readonly [string, MessageKey])[];
    }
  | {
      readonly kind: "number";
      readonly path: SettingsPath;
      readonly label: MessageKey;
      readonly min: number;
      readonly max: number;
      readonly step?: number;
    }
  | {
      readonly kind: "text";
      readonly path: SettingsPath;
      readonly label: MessageKey;
      // Shown when empty: the field then inherits this default.
      readonly placeholder: MessageKey;
    };

export interface Page {
  readonly id: string;
  readonly label: MessageKey;
  readonly controls: readonly Control[];
}

export function pages(platform: string): readonly Page[] {
  return [
    {
      id: "general",
      label: "settings.page.general",
      controls: [
        {
          kind: "choice",
          path: "language",
          label: "settings.language",
          // Each language is named in itself, whatever the current one is.
          options: SUPPORTED_LANGUAGES.map(
            (language) => [language, `language.${language}`] as const,
          ),
        },
        {
          kind: "toggle",
          path: "confirmClose",
          label: "settings.confirmClose",
        },
        {
          kind: "choice",
          path: "logLevel",
          label: "settings.logLevel",
          options: [
            ["error", "settings.logLevel.error"],
            ["info", "settings.logLevel.info"],
            ["debug", "settings.logLevel.debug"],
          ],
        },
        ...(platform === "win32"
          ? [
              {
                kind: "text",
                path: "windowsShell",
                label: "settings.windowsShell",
                placeholder: "settings.windowsShell.default",
              } as const,
            ]
          : []),
      ],
    },
    {
      id: "appearance",
      label: "settings.page.appearance",
      controls: [
        {
          kind: "text",
          path: "font.family",
          label: "settings.fontFamily",
          placeholder: "settings.fontFamily.default",
        },
        {
          kind: "number",
          path: "font.size",
          label: "settings.fontSize",
          min: 8,
          max: 72,
        },
        {
          kind: "number",
          path: "font.lineHeight",
          label: "settings.lineHeight",
          min: 1,
          max: 2,
          step: 0.05,
        },
        {
          kind: "toggle",
          path: "font.ligatures",
          label: "settings.ligatures",
        },
        {
          kind: "text",
          path: "theme.path",
          label: "settings.themePath",
          placeholder: "settings.themePath.default",
        },
      ],
    },
    {
      id: "terminal",
      label: "settings.page.terminal",
      controls: [
        {
          kind: "number",
          path: "scrollback.lines",
          label: "settings.scrollback",
          min: 0,
          max: 100_000,
          step: 1_000,
        },
        ...(["top", "right", "bottom", "left"] as const).map(
          (side) =>
            ({
              kind: "number",
              path: `terminal.padding.${side}`,
              label: `settings.padding.${side}`,
              min: 0,
              max: 128,
            }) as const,
        ),
        ...(platform === "darwin"
          ? [
              {
                kind: "choice",
                path: "keyboard.optionAsAlt",
                label: "settings.optionAsAlt",
                options: [
                  ["none", "settings.optionAsAlt.none"],
                  ["left", "settings.optionAsAlt.left"],
                  ["right", "settings.optionAsAlt.right"],
                  ["both", "settings.optionAsAlt.both"],
                ],
              } as const,
            ]
          : []),
      ],
    },
    {
      id: "window",
      label: "settings.page.window",
      controls: [
        {
          kind: "toggle",
          path: "window.showTitleBar",
          label: "settings.showTitleBar",
        },
        {
          kind: "toggle",
          path: "window.showTabBar",
          label: "settings.showTabBar",
        },
        {
          kind: "toggle",
          path: "window.alwaysOnTop",
          label: "settings.alwaysOnTop",
        },
      ],
    },
  ];
}

// What every control registers with its dialog: value syncs after each
// snapshot, and relabels after each Interface Language change.
export interface SettingsViewHooks {
  readonly syncs: (() => void)[];
  readonly relabels: ((t: Translate) => void)[];
  readonly language: RendererLanguage;
}

export function renderControl(
  document: Document,
  control: Control,
  value: (path: SettingsPath) => unknown,
  change: (path: SettingsPath, value: unknown) => void,
  { syncs, relabels, language }: SettingsViewHooks,
): HTMLElement {
  const row = document.createElement("label");
  row.className = `settings-row settings-${control.kind}`;
  const caption = document.createElement("span");
  relabels.push((t) => {
    caption.textContent = t(control.label);
  });
  let input: HTMLInputElement | HTMLSelectElement;
  if (control.kind === "choice") {
    const select = document.createElement("select");
    for (const [optionValue, label] of control.options) {
      const option = document.createElement("option");
      option.value = optionValue;
      relabels.push((t) => {
        option.textContent = t(label);
      });
      select.append(option);
    }
    select.addEventListener("change", () => change(control.path, select.value));
    syncs.push(() => {
      select.value = String(value(control.path) ?? "");
    });
    input = select;
  } else {
    const field = document.createElement("input");
    if (control.kind === "toggle") {
      field.type = "checkbox";
      field.addEventListener("change", () =>
        change(control.path, field.checked),
      );
      syncs.push(() => {
        field.checked = value(control.path) === true;
      });
    } else {
      field.type = control.kind === "number" ? "number" : "text";
      field.spellcheck = false;
      if (control.kind === "number") {
        field.min = String(control.min);
        field.max = String(control.max);
        field.step = String(control.step ?? 1);
      } else {
        const { placeholder } = control;
        relabels.push((t) => {
          field.placeholder = t(placeholder);
        });
      }
      const sync = () => {
        const current = value(control.path);
        field.value = current === undefined ? "" : String(current);
      };
      field.addEventListener("change", () => {
        const text = field.value.trim();
        const next =
          text === "" ? null : control.kind === "number" ? Number(text) : text;
        if (next !== null && !SETTINGS_FIELDS[control.path].accepts(next)) {
          sync();
          field.setCustomValidity(language.t("settings.outOfRange"));
          field.reportValidity();
          field.setCustomValidity("");
          return;
        }
        change(control.path, next);
      });
      syncs.push(sync);
    }
    input = field;
  }
  if (control.kind === "toggle") row.append(input, caption);
  else row.append(caption, input);
  return row;
}
