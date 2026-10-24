import type { MenuItemConstructorOptions } from "electron";
import type {
  TerminalActionName,
  TerminalKeybinds,
} from "../shared/terminal-keybinds";
import type {
  TerminalPaneFocusTarget,
  TerminalSplitDirection,
} from "../shared/terminal-panes";

interface TerminalApplicationMenuActions {
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
  readonly splitSelectedPane: (direction: TerminalSplitDirection) => void;
  readonly closeSelectedPane: () => void;
  readonly focusSelectedPane: (target: TerminalPaneFocusTarget) => void;
  readonly equalizeSelectedPanes: () => void;
}

export function terminalApplicationMenuTemplate(
  applicationName: string,
  actions: TerminalApplicationMenuActions,
  keybinds: TerminalKeybinds,
): MenuItemConstructorOptions[] {
  return [
    {
      label: applicationName,
      submenu: [
        {
          id: "about",
          label: "About OMXTerm",
          click: actions.showAbout,
        },
        { type: "separator" },
        {
          label: `Quit ${applicationName}`,
          ...accelerator(keybinds.quit),
          click: actions.requestQuit,
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        {
          label: "Copy",
          ...accelerator(keybinds.copy),
          click: actions.copySelectedTerminal,
        },
        {
          label: "Paste",
          ...accelerator(keybinds.paste),
          click: actions.pasteSelectedTerminal,
        },
        { type: "separator" },
        {
          label: "Select All",
          ...accelerator(keybinds.selectAll),
          click: actions.selectAllSelectedTerminal,
        },
        { type: "separator" },
        {
          label: "Find…",
          ...accelerator(keybinds.find),
          click: actions.findInSelectedTerminal,
        },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          ...accelerator(keybinds.newWindow),
          click: actions.newWindow,
        },
        {
          label: "New Tab",
          ...accelerator(keybinds.newTab),
          click: actions.newTabInSelectedWindow,
        },
        { type: "separator" },
        {
          label: "Open Local Image…",
          click: actions.openLocalImage,
        },
        { type: "separator" },
        {
          label: "Close Tab",
          ...accelerator(keybinds.closeTab),
          click: actions.closeSelectedTab,
        },
        {
          label: "Close Window",
          ...accelerator(keybinds.closeWindow),
          click: actions.closeSelectedWindow,
        },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Zoom In",
          ...accelerator(keybinds.zoomIn),
          click: actions.zoomInSelectedWindow,
        },
        {
          label: "Zoom Out",
          ...accelerator(keybinds.zoomOut),
          click: actions.zoomOutSelectedWindow,
        },
        {
          label: "Actual Size",
          ...accelerator(keybinds.actualSize),
          click: actions.resetSelectedWindowZoom,
        },
        { type: "separator" },
        {
          label: "Toggle Snippets",
          ...accelerator(keybinds.toggleSnippets),
          click: actions.toggleSelectedSnippets,
        },
        {
          label: "Toggle Tab Bar",
          ...accelerator(keybinds.toggleTabBar),
          click: actions.toggleSelectedTabBar,
        },
        {
          label: "Toggle Title Bar",
          ...accelerator(keybinds.toggleTitleBar),
          click: actions.toggleSelectedTitleBar,
        },
        { type: "separator" },
        { label: "Pane", submenu: paneMenu(actions, keybinds) },
        { type: "separator" },
        {
          label: "Reload User Configuration",
          ...accelerator(keybinds.reloadConfig),
          click: actions.reloadUserConfiguration,
        },
        {
          label: "Toggle Developer Tools",
          click: actions.toggleSelectedDevTools,
        },
        { type: "separator" },
        {
          label: "Toggle Full Screen",
          ...accelerator(keybinds.toggleFullScreen),
          click: actions.toggleSelectedFullScreen,
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        {
          label: "Always on Top",
          click: actions.toggleSelectedAlwaysOnTop,
        },
        { type: "separator" },
        {
          label: "Show Next Tab",
          ...accelerator(keybinds.nextTab),
          click: actions.selectNextTab,
        },
        {
          label: "Show Previous Tab",
          ...accelerator(keybinds.previousTab),
          click: actions.selectPreviousTab,
        },
        {
          label: "Select Tab",
          submenu: Array.from({ length: 9 }, (_, index) => {
            const position = index + 1;
            return {
              label: `Tab ${position}`,
              ...accelerator(
                keybinds[`selectTab${position}` as SelectTabAction],
              ),
              click: () => actions.selectTabInSelectedWindow(position),
            };
          }),
        },
      ],
    },
  ];
}

type SelectTabAction = keyof TerminalKeybinds & `selectTab${number}`;

const PANE_FOCUS_ITEMS = [
  ["Focus Next Pane", "focusNextPane", "next"],
  ["Focus Previous Pane", "focusPreviousPane", "previous"],
  ["Focus Pane Left", "focusPaneLeft", "left"],
  ["Focus Pane Right", "focusPaneRight", "right"],
  ["Focus Pane Above", "focusPaneUp", "up"],
  ["Focus Pane Below", "focusPaneDown", "down"],
] as const satisfies readonly (readonly [
  string,
  TerminalActionName,
  TerminalPaneFocusTarget,
])[];

// View -> Pane: splits and pane focus act on the selected tab's focused pane.
function paneMenu(
  actions: TerminalApplicationMenuActions,
  keybinds: TerminalKeybinds,
): MenuItemConstructorOptions[] {
  return [
    {
      label: "Split Right",
      ...accelerator(keybinds.splitRight),
      click: () => actions.splitSelectedPane("right"),
    },
    {
      label: "Split Down",
      ...accelerator(keybinds.splitDown),
      click: () => actions.splitSelectedPane("down"),
    },
    { type: "separator" },
    ...PANE_FOCUS_ITEMS.map(([label, action, target]) => ({
      label,
      ...accelerator(keybinds[action]),
      click: () => actions.focusSelectedPane(target),
    })),
    { type: "separator" },
    {
      label: "Equalize Panes",
      ...accelerator(keybinds.equalizePanes),
      click: actions.equalizeSelectedPanes,
    },
    {
      label: "Close Pane",
      ...accelerator(keybinds.closePane),
      click: actions.closeSelectedPane,
    },
  ];
}

// A null keybind leaves the item without a shortcut; the action stays usable.
function accelerator(value: string | null): { accelerator?: string } {
  return value === null ? {} : { accelerator: value };
}

// The keybind vocabulary keyed by action name, invoking the same application
// actions as the menu items above. The main-process key-event delivery path
// (see keybind-delivery.ts) calls these so a keybind works even when the
// platform refuses to fire its registered menu accelerator, keeping the menu
// the single behavior definition.
export function terminalActionInvocations(
  actions: TerminalApplicationMenuActions,
): Readonly<Record<TerminalActionName, () => void>> {
  return Object.freeze({
    quit: actions.requestQuit,
    copy: actions.copySelectedTerminal,
    paste: actions.pasteSelectedTerminal,
    selectAll: actions.selectAllSelectedTerminal,
    find: actions.findInSelectedTerminal,
    newWindow: actions.newWindow,
    closeWindow: actions.closeSelectedWindow,
    newTab: actions.newTabInSelectedWindow,
    closeTab: actions.closeSelectedTab,
    nextTab: actions.selectNextTab,
    previousTab: actions.selectPreviousTab,
    ...(Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => {
        const position = index + 1;
        return [
          `selectTab${position}`,
          () => actions.selectTabInSelectedWindow(position),
        ];
      }),
    ) as Record<SelectTabAction, () => void>),
    zoomIn: actions.zoomInSelectedWindow,
    zoomOut: actions.zoomOutSelectedWindow,
    actualSize: actions.resetSelectedWindowZoom,
    toggleFullScreen: actions.toggleSelectedFullScreen,
    toggleSnippets: actions.toggleSelectedSnippets,
    toggleTabBar: actions.toggleSelectedTabBar,
    toggleTitleBar: actions.toggleSelectedTitleBar,
    reloadConfig: actions.reloadUserConfiguration,
    splitRight: () => actions.splitSelectedPane("right"),
    splitDown: () => actions.splitSelectedPane("down"),
    closePane: actions.closeSelectedPane,
    ...(Object.fromEntries(
      PANE_FOCUS_ITEMS.map(([, action, target]) => [
        action,
        () => actions.focusSelectedPane(target),
      ]),
    ) as Record<(typeof PANE_FOCUS_ITEMS)[number][1], () => void>),
    equalizePanes: actions.equalizeSelectedPanes,
  });
}

export function terminalClipboardContextMenuTemplate(actions: {
  readonly copy: () => void;
  readonly paste: () => void;
  readonly selectAll: () => void;
}): MenuItemConstructorOptions[] {
  return [
    { label: "Copy", click: actions.copy },
    { label: "Paste", click: actions.paste },
    { type: "separator" },
    { label: "Select All", click: actions.selectAll },
  ];
}
