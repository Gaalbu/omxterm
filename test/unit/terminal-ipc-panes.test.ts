import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  registerTerminalIpcRouter,
  type TrustedWebContents,
} from "../../src/main/terminal-ipc-controller";
import { terminalIpc } from "../../src/shared/terminal-ipc";
import {
  clipboardOptions,
  createIpcHarness,
} from "../fixtures/terminal-ipc-harness";

function window(ipc: ReturnType<typeof createIpcHarness>) {
  const frame = {};
  const webContents: TrustedWebContents = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn(),
  };
  return { owner: { sender: webContents, senderFrame: frame }, webContents };
}

describe("pane session IPC", () => {
  it.each([false, true])(
    "excludes SSH local-looking OSC7 and retains nonzero exit (early: %s)",
    (early) => {
      const ipc = createIpcHarness();
      const router = registerTerminalIpcRouter(ipc.ipcMain);
      const { owner, webContents } = window(ipc);
      const callbacks: import("../../src/main/terminal-ipc-types").SessionCallbacks[] =
        [];
      const ssh = {
        request: {
          kind: "explicit-command" as const,
          executable: "/ssh",
          arguments: ["--", "alias"],
        },
        title: "SSH · alias",
      };
      let tokenAvailable = true;
      const createSession = vi.fn(
        (
          next: import("../../src/main/terminal-ipc-types").SessionCallbacks,
          _directory?: string,
          launch?: import("../../src/main/ssh-terminal-launch").SshLaunch,
        ) => {
          callbacks.push(next);
          if (launch) {
            next.onOutput(
              `\u001b]7;${pathToFileURL(realpathSync(tmpdir())).href}\u0007`,
            );
            if (early)
              next.onExit({ exitCode: 255, signal: 0 }, "explicit-command");
          }
          return {
            close: vi.fn(),
            write: vi.fn(),
            resize: vi.fn(),
            launchKind: launch
              ? ("explicit-command" as const)
              : ("default-shell" as const),
            hasForegroundChildProcess: () => !!launch,
          };
        },
      );
      const controller = router.registerController({
        ...clipboardOptions(),
        webContents,
        onSessionStartError: vi.fn(),
        onSessionExit: vi.fn(),
        createSession,
        consumeSshLaunch() {
          if (!tokenAvailable) throw new Error("consumed");
          tokenAvailable = false;
          return ssh;
        },
      });
      const start = ipc.handlers.get(terminalIpc.start)!;
      const token = "00000000-0000-0000-0000-000000000001";
      expect(start(owner, { launchToken: token })).toBe("s1");
      expect(controller.reportedWorkingDirectory?.("s1")).toBeUndefined();
      start(owner, { workingDirectoryOf: "s1" });
      expect(createSession.mock.calls[1]?.[1]).toBeUndefined();
      expect(createSession.mock.calls[1]?.[2]).toBeUndefined();
      if (!early) {
        expect(controller.hasBusySession()).toBe(true);
        callbacks[0]!.onExit({ exitCode: 1, signal: 0 }, "explicit-command");
      }
      expect(webContents.send).toHaveBeenCalledWith(terminalIpc.exit, {
        sessionId: "s1",
        exitCode: early ? 255 : 1,
        signal: 0,
        retained: true,
      });
      expect(controller.hasBusySession()).toBe(false);
      expect(() => start(owner, { launchToken: token })).toThrow("consumed");
      router.dispose();
    },
  );
  it("starts a split pane in its source's reported local directory only", () => {
    const ipc = createIpcHarness();
    const router = registerTerminalIpcRouter(ipc.ipcMain);
    const first = window(ipc);
    const second = window(ipc);
    const outputs: Array<(data: string) => void> = [];
    const createSession = vi.fn(
      (callbacks: { onOutput(data: string): void }, _directory?: string) => {
        outputs.push(callbacks.onOutput);
        return {
          close: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          hasForegroundChildProcess: () => false,
        };
      },
    );
    for (const { webContents } of [first, second])
      router.registerController({
        ...clipboardOptions(),
        webContents,
        onSessionStartError: vi.fn(),
        onSessionExit: vi.fn(),
        createSession,
      });
    const start = ipc.handlers.get(terminalIpc.start)!;
    const osc7 = (index: number, uri: string) =>
      outputs[index]!(`\u001b]7;${uri}\u0007`);
    const directory = realpathSync(tmpdir());

    expect(start(first.owner)).toBe("s1");
    osc7(0, pathToFileURL(directory).href);
    expect(start(first.owner, { workingDirectoryOf: "s1" })).toBe("s2");
    expect(createSession.mock.calls.at(-1)?.[1]).toBe(directory);

    // Another window cannot borrow the directory, and paths are never accepted.
    expect(start(second.owner, { workingDirectoryOf: "s1" })).toBe("s1");
    expect(createSession.mock.calls.at(-1)?.[1]).toBeUndefined();
    expect(() => start(first.owner, { workingDirectory: directory })).toThrow(
      "Invalid terminal start payload",
    );

    // A remote report replaces the local one; the pane then starts at home.
    osc7(0, "file://remote-host/srv");
    start(first.owner, { workingDirectoryOf: "s1" });
    expect(createSession.mock.calls.at(-1)?.[1]).toBeUndefined();
    router.dispose();
  });
});
