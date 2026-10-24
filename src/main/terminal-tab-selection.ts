import type { TerminalSessionId } from "../shared/terminal-contract";
import {
  isTerminalSessionStart,
  isTerminalTabSelection,
  type TerminalSessionStart,
} from "../shared/terminal-panes";
import { isSurfaceFontIdentity } from "../shared/user-configuration";

// The renderer-reported selection of one Terminal Window: the selected tab's
// focused pane, and every session of that tab for Close Tab's Busy count.
export function createTabSelection<State>(options: {
  readonly routed: (sessionId: TerminalSessionId) => State | undefined;
  readonly current: (sessionId: TerminalSessionId) => State | undefined;
  readonly isBusy: (state: State) => boolean;
  readonly hasBusySession: () => boolean;
  readonly reject: () => void;
  readonly onSessionSelected: (sessionId: TerminalSessionId) => void;
}) {
  let focused: TerminalSessionId | undefined;
  let tab: readonly TerminalSessionId[] = [];
  return {
    tabSelected(payload?: unknown) {
      if (!isTerminalTabSelection(payload)) {
        options.reject();
        return;
      }
      if (!options.routed(payload.sessionId)) return;
      focused = payload.sessionId;
      // Other panes' ids count only while this window owns them.
      tab = payload.tabSessionIds ?? [payload.sessionId];
      options.onSessionSelected(payload.sessionId);
    },
    hasBusySelectedSession() {
      const states = tab.flatMap((id) => {
        const state = options.current(id);
        return state === undefined ? [] : [state];
      });
      return states.length > 0
        ? states.some(options.isBusy)
        : options.hasBusySession();
    },
    hasBusyFocusedSession() {
      const state =
        focused === undefined ? undefined : options.current(focused);
      return state === undefined
        ? options.hasBusySession()
        : options.isBusy(state);
    },
  };
}

// A legacy start names only a Surface identity; a pane start may also name
// the session whose reported directory it inherits.
export function terminalSessionStart(
  payload: unknown,
  reject: () => void,
): TerminalSessionStart {
  if (payload === undefined) return {};
  if (typeof payload === "string") return { surfaceId: payload };
  if (!isTerminalSessionStart(payload, isSurfaceFontIdentity)) {
    reject();
    throw new TypeError("Invalid terminal start payload");
  }
  return payload;
}
