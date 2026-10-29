import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { IpcEvent } from "../../src/main/terminal-ipc-types";
const runtime = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcEvent, value: unknown) => void>(),
  owners: new Map<object, BrowserWindow>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, handler: (event: IpcEvent, value: unknown) => void) =>
      runtime.handlers.set(channel, handler),
  },
  BrowserWindow: {
    fromWebContents: (contents: object) => runtime.owners.get(contents),
  },
}));
vi.mock("../../src/main/ssh-terminal-launch", async (original) => ({
  ...(await original<typeof import("../../src/main/ssh-terminal-launch")>()),
  findSsh: async () => "/synthetic/ssh",
}));
import { registerSshTerminalLaunch } from "../../src/main/ssh-terminal-ipc";
function owner() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
  }) as unknown as BrowserWindow;
  runtime.owners.set(contents, window);
  return {
    window,
    contents,
    event: {
      sender: contents,
      senderFrame: contents.mainFrame,
    } as unknown as IpcEvent,
  };
}
it("composes main-frame and original-window IPC admission with real one-shot launch ownership", async () => {
  const a = owner(),
    b = owner();
  let trusted = true;
  const launch = registerSshTerminalLaunch(
    () => trusted,
    () => false,
  );
  launch.register(a.window);
  const receive = runtime.handlers.get("terminal:ssh-pane")!;
  const opening = launch.open(
    a.window,
    {},
    "source",
    { host: "alias" },
    async (commit) => commit(),
  );
  await Promise.resolve();
  await Promise.resolve();
  const token = (a.contents.send.mock.calls[0]![1] as { token: string }).token;
  const reject = { token, accepted: false };
  receive({ ...a.event, senderFrame: {} } as IpcEvent, reject);
  receive(b.event, reject);
  trusted = false;
  receive(a.event, reject);
  trusted = true;
  receive(a.event, { ...reject, extra: true });
  expect(launch.consume(a.window, token).request.arguments).toEqual([
    "--",
    "alias",
  ]);
  expect(await opening).toMatchObject({ status: "accepted" });
  expect(() => launch.consume(a.window, token)).toThrow();
  const pending = launch.open(
    a.window,
    {},
    "source",
    { host: "next" },
    async (commit) => commit(),
  );
  await Promise.resolve();
  await Promise.resolve();
  a.contents.emit("render-process-gone");
  expect(await pending).toMatchObject({ error: "outcome-unknown" });
  launch.dispose();
  runtime.owners.clear();
});
