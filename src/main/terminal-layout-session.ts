import type { TerminalSessionStart } from "../shared/terminal-panes";
import type { LayoutDirectory } from "../shared/terminal-layout";
import type { createWorkingDirectoryTracker } from "./terminal-working-directories";
import type { TerminalSessionLaunchKind } from "./local-terminal-session";

export function restoredDirectory(
  launch: TerminalSessionStart,
  consume?: (token: string) => string,
): string | undefined {
  if (launch.restoreToken === undefined) return undefined;
  const directory = consume?.(launch.restoreToken);
  if (directory === undefined) throw new Error("Unavailable restored pane");
  return directory;
}

export function captureSessionDirectory(
  sessionId: string,
  nextSessionNumber: number,
  sessions: ReadonlyMap<
    string,
    {
      closed: boolean;
      exited: boolean;
      session: { launchKind?: TerminalSessionLaunchKind };
    }
  >,
  tracker: ReturnType<typeof createWorkingDirectoryTracker>,
): LayoutDirectory {
  // Issued-but-ended identities become home slots; never consult another
  // controller or accept a reference this controller never allocated.
  const number = /^s([1-9][0-9]*)$/u.exec(sessionId)?.[1];
  if (!number || Number(number) >= nextSessionNumber)
    throw new Error("Unknown layout session");
  const state = sessions.get(sessionId);
  if (
    !state ||
    state.closed ||
    state.exited ||
    state.session.launchKind === "explicit-command"
  )
    return { kind: "home" };
  return tracker.provenance(sessionId);
}
