import {
  DEFAULT_LANGUAGE,
  translatorFor,
  type Translator,
} from "../shared/i18n";
import {
  TERMINAL_ACTION_NAMES,
  terminalActionForKeyboardInput,
  type AcceleratorKeyboardInput,
  type TerminalActionName,
  type TerminalKeybinds,
} from "../shared/terminal-keybinds";
import type {
  TerminalPaneFocusTarget,
  TerminalSplitDirection,
} from "../shared/terminal-panes";

export interface TerminalApplicationMenuActions {
  readonly newWindow: () => void;
  readonly closeSelectedWindow: () => void;
  readonly newTabInSelectedWindow: () => void;
  readonly closeSelectedTab: () => void;
  readonly selectNextTab: () => void;
  readonly selectPreviousTab: () => void;
  readonly selectTabInSelectedWindow: (position: number) => void;
  readonly requestQuit: () => void;
  readonly toggleSelectedFullScreen: () => void;
  readonly toggleSelectedAlwaysOnTop: () => void;
  readonly toggleSelectedDevTools: () => void;
  readonly zoomInSelectedWindow: () => void;
  readonly zoomOutSelectedWindow: () => void;
  readonly resetSelectedWindowZoom: () => void;
  readonly copySelectedTerminal: () => void;
  readonly pasteSelectedTerminal: () => void;
  readonly selectAllSelectedTerminal: () => void;
  readonly findInSelectedTerminal: () => void;
  readonly toggleSelectedSnippets: () => void;
  readonly toggleSelectedTabBar: () => void;
  readonly toggleSelectedTitleBar: () => void;
  readonly reloadUserConfiguration: () => void;
  readonly openLocalImage: () => void;
  readonly showAbout: () => void;
  readonly showSettings: () => void;
  readonly showCommandPalette: () => void;
  readonly splitSelectedPane: (direction: TerminalSplitDirection) => void;
  readonly closeSelectedPane: () => void;
  readonly focusSelectedPane: (target: TerminalPaneFocusTarget) => void;
  readonly equalizeSelectedPanes: () => void;
}

export type CoreActionId =
  | TerminalActionName
  | "about"
  | "settings"
  | "openLocalImage"
  | "alwaysOnTop"
  | "devTools";
export type CoreActionTarget = "application" | "window" | "content";

export interface CoreAction {
  readonly id: CoreActionId;
  readonly label: string;
  readonly accelerator: string | null;
  readonly invoke: () => void;
  // Metadata for the composition owner to capture/validate targets, not a
  // second dispatcher. Supplied callbacks retain their existing guards.
  readonly target: CoreActionTarget;
  readonly palette: boolean;
}
export type CoreActionCatalog = Readonly<Record<CoreActionId, CoreAction>>;
type SelectTabAction = TerminalActionName & `selectTab${number}`;

// The only behavior table. Menu layout references IDs; palette and key delivery
// project this same snapshot. Rebuild it when language/effective bindings change.
export function createCoreActionCatalog(
  applicationName: string,
  actions: TerminalApplicationMenuActions,
  keybinds: TerminalKeybinds,
  t: Translator["t"] = translatorFor(DEFAULT_LANGUAGE).t,
): CoreActionCatalog {
  const action = (
    label: string,
    invoke: () => void,
    target: CoreActionTarget,
    palette = true,
  ) => ({ label, invoke, target, palette });
  const definitions = {
    about: action(t("menu.about"), actions.showAbout, "window"),
    settings: action(t("menu.settings"), actions.showSettings, "window"),
    quit: action(
      t("menu.quit", { name: applicationName }),
      actions.requestQuit,
      "application",
    ),
    copy: action(
      t("menu.copy"),
      actions.copySelectedTerminal,
      "content",
      false,
    ),
    paste: action(
      t("menu.paste"),
      actions.pasteSelectedTerminal,
      "content",
      false,
    ),
    selectAll: action(
      t("menu.selectAll"),
      actions.selectAllSelectedTerminal,
      "content",
      false,
    ),
    find: action(
      t("menu.find"),
      actions.findInSelectedTerminal,
      "content",
      false,
    ),
    newWindow: action(t("menu.newWindow"), actions.newWindow, "application"),
    newTab: action(t("menu.newTab"), actions.newTabInSelectedWindow, "window"),
    openLocalImage: action(
      t("menu.openLocalImage"),
      actions.openLocalImage,
      "window",
    ),
    closeTab: action(t("menu.closeTab"), actions.closeSelectedTab, "content"),
    closeWindow: action(
      t("menu.closeWindow"),
      actions.closeSelectedWindow,
      "window",
    ),
    commandPalette: action(
      t("action.commandPalette"),
      actions.showCommandPalette,
      "window",
      false,
    ),
    zoomIn: action(t("menu.zoomIn"), actions.zoomInSelectedWindow, "window"),
    zoomOut: action(t("menu.zoomOut"), actions.zoomOutSelectedWindow, "window"),
    actualSize: action(
      t("menu.actualSize"),
      actions.resetSelectedWindowZoom,
      "window",
    ),
    toggleSnippets: action(
      t("menu.toggleSnippets"),
      actions.toggleSelectedSnippets,
      "window",
    ),
    toggleTabBar: action(
      t("menu.toggleTabBar"),
      actions.toggleSelectedTabBar,
      "window",
    ),
    toggleTitleBar: action(
      t("menu.toggleTitleBar"),
      actions.toggleSelectedTitleBar,
      "window",
    ),
    splitRight: action(
      t("menu.splitRight"),
      () => actions.splitSelectedPane("right"),
      "content",
    ),
    splitDown: action(
      t("menu.splitDown"),
      () => actions.splitSelectedPane("down"),
      "content",
    ),
    focusNextPane: action(
      t("menu.focusNextPane"),
      () => actions.focusSelectedPane("next"),
      "content",
    ),
    focusPreviousPane: action(
      t("menu.focusPreviousPane"),
      () => actions.focusSelectedPane("previous"),
      "content",
    ),
    focusPaneLeft: action(
      t("menu.focusPaneLeft"),
      () => actions.focusSelectedPane("left"),
      "content",
    ),
    focusPaneRight: action(
      t("menu.focusPaneRight"),
      () => actions.focusSelectedPane("right"),
      "content",
    ),
    focusPaneUp: action(
      t("menu.focusPaneAbove"),
      () => actions.focusSelectedPane("up"),
      "content",
    ),
    focusPaneDown: action(
      t("menu.focusPaneBelow"),
      () => actions.focusSelectedPane("down"),
      "content",
    ),
    equalizePanes: action(
      t("menu.equalizePanes"),
      actions.equalizeSelectedPanes,
      "content",
    ),
    closePane: action(
      t("menu.closePane"),
      actions.closeSelectedPane,
      "content",
    ),
    reloadConfig: action(
      t("menu.reloadConfiguration"),
      actions.reloadUserConfiguration,
      "application",
    ),
    devTools: action(
      t("menu.toggleDeveloperTools"),
      actions.toggleSelectedDevTools,
      "window",
    ),
    toggleFullScreen: action(
      t("menu.toggleFullScreen"),
      actions.toggleSelectedFullScreen,
      "window",
    ),
    alwaysOnTop: action(
      t("menu.alwaysOnTop"),
      actions.toggleSelectedAlwaysOnTop,
      "window",
    ),
    nextTab: action(t("menu.showNextTab"), actions.selectNextTab, "window"),
    previousTab: action(
      t("menu.showPreviousTab"),
      actions.selectPreviousTab,
      "window",
    ),
    ...(Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => {
        const position = index + 1;
        return [
          `selectTab${position}`,
          action(
            t("menu.tab", { position }),
            () => actions.selectTabInSelectedWindow(position),
            "window",
            false,
          ),
        ];
      }),
    ) as Record<SelectTabAction, ReturnType<typeof action>>),
  } satisfies Record<CoreActionId, ReturnType<typeof action>>;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(definitions).map(([id, definition]) => [
        id,
        Object.freeze({
          id,
          ...definition,
          accelerator: Object.hasOwn(keybinds, id)
            ? keybinds[id as TerminalActionName]
            : null,
        }),
      ]),
    ) as Record<CoreActionId, CoreAction>,
  );
}

export function coreActionInvocations(
  catalog: CoreActionCatalog,
): Readonly<Record<TerminalActionName, () => void>> {
  return Object.freeze(
    Object.fromEntries(
      TERMINAL_ACTION_NAMES.map((id) => [id, catalog[id].invoke]),
    ) as Record<TerminalActionName, () => void>,
  );
}

export function coreActionKeybinds(
  catalog: CoreActionCatalog,
): TerminalKeybinds {
  return Object.freeze(
    Object.fromEntries(
      TERMINAL_ACTION_NAMES.map((id) => [id, catalog[id].accelerator]),
    ) as Record<TerminalActionName, string | null>,
  );
}

export function coreActionForKeyboardInput(
  catalog: CoreActionCatalog,
  input: AcceleratorKeyboardInput,
  platform = "darwin",
): CoreAction | undefined {
  const id = terminalActionForKeyboardInput(
    coreActionKeybinds(catalog),
    input,
    platform,
  );
  return id === undefined ? undefined : catalog[id];
}

export function corePaletteActions(
  catalog: CoreActionCatalog,
): readonly CoreAction[] {
  return Object.values(catalog).filter((action) => action.palette);
}
