import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { terminalWindowOptions } from "../../src/main/terminal-window";
import { registerTerminalWindowHost } from "../../src/main/terminal-window-host";
import {
  registerTerminalIpcRouter,
  type IpcMainPort,
} from "../../src/main/terminal-ipc-controller";
import { installedFontFamilyMetrics } from "../../src/main/installed-font-family";
import type { ActiveUserConfiguration } from "../../src/main/user-configuration-reloader";
import { loadTerminalFontData } from "../../src/main/terminal-font-data";
import { terminalRendererConfiguration } from "../../src/main/active-user-configuration";
import {
  DEFAULT_USER_CONFIGURATION,
  loadUserConfiguration,
} from "../../src/main/user-configuration";
import {
  createUserConfigurationReloader,
  terminalSurfaceFontBaseline,
} from "../../src/main/user-configuration-reloader";
import type { LocalTerminalSession } from "../../src/main/local-terminal-session";
import { terminalIpc } from "../../src/shared/terminal-ipc";
import type { TerminalFontData } from "../../src/shared/terminal-font-data";
import { spawnFixturePty } from "./native-fixture-pty";
import { receivedFontReloadInput } from "./font-read-reload-input";
import { nativeFixturePlatform } from "./restty-host-platform";
import { createResttyHostSessions } from "./restty-host-sessions";
import {
  fontReadHandles,
  holdFontRead,
  releaseFontReads,
} from "./font-read-reload-io";

const root = __dirname;
for (const name of ["userData", "sessionData"] as const) {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
const windows: BrowserWindow[] = [];
const sessions: LocalTerminalSession[] = [];
const outputs: string[][] = [];
const inputs: string[][] = [];
const owner = createResttyHostSessions({
  app,
  spawn: spawnFixturePty,
  windows: () => windows,
  signals: process,
  reportError: (message) => process.stderr.write(`${message}\n`),
});
function fail(error: unknown) {
  releaseFontReads();
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  void owner.complete(1);
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

function launchRequest() {
  return {
    kind: "explicit-command" as const,
    executable: nativeFixturePlatform.defaultShell,
    arguments:
      process.platform === "win32"
        ? [
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "[Console]::WriteLine('READY'); while ($null -ne ($line=[Console]::ReadLine())) { [Console]::WriteLine('RECEIVED:'+$line) }",
          ]
        : [
            "-c",
            "stty -echo || exit 1; printf 'READY\\n'; while IFS= read -r line; do printf 'RECEIVED:%s\\n' \"$line\"; done",
          ],
  };
}

async function createFixture() {
  await app.whenReady();
  const A = nativeFixturePlatform.configuredFontFamily;
  const B = nativeFixturePlatform.reloadedFontFamily;
  const received: Array<{
    family: unknown;
    status: "pending" | "fulfilled" | "rejected";
  }> = [];
  const requestSettlements: Promise<void>[] = [];
  const port: IpcMainPort = {
    handle(channel, handler) {
      ipcMain.handle(channel, (event, payload) => {
        const result = handler(event, payload);
        if (channel === terminalIpc.fontData) {
          const record: (typeof received)[number] = {
            family: payload,
            status: "pending",
          };
          received.push(record);
          requestSettlements.push(
            Promise.resolve(result).then(
              () => {
                record.status = "fulfilled";
              },
              () => {
                record.status = "rejected";
              },
            ),
          );
        }
        return result;
      });
    },
    on: (channel, listener) => {
      ipcMain.on(channel, listener);
    },
    removeHandler: (channel) => {
      ipcMain.removeHandler(channel);
    },
    removeListener: (channel, listener) => {
      ipcMain.removeListener(channel, listener);
    },
  };
  const loads: Array<string | undefined> = [];
  let activeLoads = 0;
  const router = registerTerminalIpcRouter(port, undefined, async (family) => {
    loads.push(family);
    activeLoads += 1;
    assert.equal(
      activeLoads,
      1,
      "One bounded load per window, including queued B",
    );
    try {
      const data: TerminalFontData = await loadTerminalFontData(family);
      assert.equal(data.configured?.family, family);
      if (family)
        assert.ok(
          data.configured!.data.byteLength > 0,
          "Real validated native bytes",
        );
      return data;
    } finally {
      activeLoads -= 1;
    }
  });
  const initial = {
    configuration: DEFAULT_USER_CONFIGURATION,
    userFileErrors: [],
  };
  let active: ActiveUserConfiguration = initial;
  const nativeSessionIndexes = new Map<string, number>();
  function createWindow() {
    const window = new BrowserWindow({
      ...terminalWindowOptions(
        path.join(root, "preload.cjs"),
        active.configuration,
        process.platform,
      ),
      show: false,
    });
    windows.push(window);
    let createdIndex: number | undefined;
    const controller = router.registerController({
      webContents: window.webContents,
      configuration: terminalRendererConfiguration(active, 0),
      createSession(callbacks) {
        const index = sessions.length;
        outputs[index] = [];
        inputs[index] = [];
        const terminal = owner.createSession({
          shell: nativeFixturePlatform.defaultShell,
          launchRequest: launchRequest(),
          platform: process.platform,
          homeDirectory: root,
          environment: { ...process.env, HOME: root },
          applicationVersionProvider: app,
          onOutput(data) {
            outputs[index]!.push(data);
            callbacks.onOutput(data);
          },
          onExit: callbacks.onExit,
        });
        sessions.push(terminal);
        createdIndex = index;
        return {
          ...terminal,
          write(data) {
            inputs[index]!.push(data);
            terminal.write(data);
          },
        };
      },
      onSessionStartError() {
        throw new Error("Unexpected PTY start failure");
      },
      onSessionExit() {},
      onSessionStarted(sessionId) {
        assert.notEqual(createdIndex, undefined);
        nativeSessionIndexes.set(`${window.id}:${sessionId}`, createdIndex!);
      },
      onSessionSelected() {},
      onTitleRequest() {},
      onBell() {},
      onUserInteraction() {},
      writeClipboardText() {},
      readClipboardText: () => paste,
      confirmPaste: async () => true,
      showClipboardContextMenu() {},
      openExternalLink: async () => {},
      onExternalLinkOpenError() {},
      loadSnippets: async () => ({ snippets: [] }),
      loadLocalImage: async () => null,
    });
    registerTerminalWindowHost(window, controller, () => {});
    return window;
  }
  const configRoot = path.join(root, "configuration");
  mkdirSync(path.join(configRoot, "omxterm"), { recursive: true });
  const reloader = createUserConfigurationReloader({
    initial,
    ...terminalSurfaceFontBaseline(initial.configuration),
    load: () =>
      loadUserConfiguration({
        environment: { XDG_CONFIG_HOME: configRoot },
        homeDirectory: root,
        platform: process.platform,
        getInstalledFontFamilyMetrics: installedFontFamilyMetrics,
      }),
    apply(state) {
      active = state;
      router.applyConfiguration(terminalRendererConfiguration(state, 0));
    },
    activeTerminalSurfaceFontConfigurations:
      router.activeTerminalSurfaceFontConfigurations,
  });
  let paste = "";
  const window = createWindow();
  const evaluate = (script: string) =>
    window.webContents.executeJavaScript(script);
  const wait = (script: string, label: string) =>
    owner.waitFor(async () => Boolean(await evaluate(script)), label);
  async function reload(family: string) {
    await writeFile(
      path.join(configRoot, "omxterm/config.json"),
      JSON.stringify({ version: 1, font: { family } }),
    );
    await reloader.reload();
    assert.equal(
      active.configuration.fontFamily,
      family,
      "Real configuration validation/application succeeded",
    );
  }
  const command = (action: "new" | "close") =>
    window.webContents.send(terminalIpc.tabCommand, { action });
  async function usable(
    position: number,
    token: string,
    mountIndex = position - 1,
  ) {
    // Capture the independently observed start receipt for the expected Surface,
    // not whichever child happens to receive Paste or report selection.
    const sessionId: unknown = await evaluate(
      `readReloadEvidence.sessionIds[${mountIndex}]`,
    );
    assert.equal(typeof sessionId, "string");
    const expected = nativeSessionIndexes.get(
      `${window.id}:${String(sessionId)}`,
    );
    assert.notEqual(
      expected,
      undefined,
      "Expected Surface owns a known native child",
    );
    window.webContents.send(terminalIpc.tabCommand, {
      action: "select",
      position,
    });
    await wait(
      `document.querySelectorAll('[role=tab]')[${position - 1}]?.getAttribute('aria-selected') === 'true'`,
      "surviving tab selected",
    );
    const offsets = inputs.map((values) => values.length);
    paste = token;
    window.webContents.send(terminalIpc.clipboardAction, "paste");
    await owner.waitFor(
      () => receivedFontReloadInput(inputs, offsets, expected!, token),
      "exact Surface/preload Paste reaches its expected child and no sibling",
    );
    sessions[expected!]!.write("\r");
    await owner.waitFor(
      () => outputs[expected!]!.join("").includes(`RECEIVED:${token}`),
      "actual child acknowledges input, not terminal echo",
    );
  }
  return {
    A,
    B,
    router,
    received,
    requestSettlements,
    loads,
    window,
    reload,
    command,
    wait,
    evaluate,
    usable,
    createWindow,
  };
}

async function run() {
  const {
    A,
    B,
    router,
    received,
    requestSettlements,
    loads,
    window,
    reload,
    command,
    wait,
    evaluate,
    usable,
    createWindow,
  } = await createFixture();
  await window.loadFile(path.join(root, "renderer/index.html"));
  window.show();
  await wait(
    "readReloadEvidence.hostReady",
    "actual first-tab host command readiness",
  );
  await owner.waitFor(
    () => outputs[0]?.join("").includes("READY") ?? false,
    "healthy initial PTY ready",
  );
  const healthy = sessions[0];

  // Original race: two A consumers, one actual read, B admitted/queued during it.
  await reload(A);
  const gate = holdFontRead();
  command("new");
  command("new");
  await gate.entered;
  await owner.waitFor(
    () => router.activeTerminalSurfaceFontConfigurations().length === 3,
    "both pending A Surface owners retained",
  );
  assert.equal(sessions.length, 1, "No PTY before actual read completes");
  assert.deepEqual(loads, [undefined, A]);
  await reload(B);
  command("new");
  await owner.waitFor(
    () => received.some((record) => record.family === B),
    "B reaches production main request boundary",
  );
  assert.deepEqual(
    loads,
    [undefined, A],
    "B load serialized behind physical A read",
  );
  gate.release();
  await owner.waitFor(
    () =>
      received.length === 3 &&
      received.every((record) => record.status !== "pending"),
    "actual main request results",
  );
  assert.deepEqual(
    received.map(({ family, status }) => [family, status]),
    [
      [undefined, "fulfilled"],
      [A, "fulfilled"],
      [B, "fulfilled"],
    ],
    "Started A must complete; old post-read rejection fails here",
  );
  await wait(
    "readReloadEvidence.mounts.length === 4 && readReloadEvidence.mounts.every(record => record.status === 'mounted')",
    "both A and B real Surfaces mount",
  );
  assert.equal(sessions.length, 4);
  assert.equal(
    sessions[0],
    healthy,
    "Healthy native session identity retained",
  );
  assert.deepEqual(
    await evaluate(
      "readReloadEvidence.mounts.map(({family, lineHeight}) => [family, lineHeight])",
    ),
    [
      [undefined, 1],
      [A, 1],
      [A, 1],
      [B, 1],
    ],
  );
  assert.deepEqual(
    await evaluate(
      "readReloadEvidence.mounts.slice(1).map(record => record.fontName)",
    ),
    [A, A, B],
  );
  for (let position = 1; position <= 4; position += 1)
    await usable(position, `read-reload-${position}`);

  // A cancelled sibling during reload must not revoke the other A consumer.
  await reload(A);
  const siblingGate = holdFontRead();
  command("new");
  command("new");
  await siblingGate.entered;
  await wait(
    "readReloadEvidence.mounts.length === 6",
    "both new A mounts entered",
  );
  await reload(B);
  command("close");
  await wait(
    "readReloadEvidence.mounts[5].cancelled",
    "one pending A owner cancelled",
  );
  command("new");
  await owner.waitFor(
    () => received.filter((record) => record.family === B).length === 2,
    "second B queued",
  );
  siblingGate.release();
  await wait(
    "readReloadEvidence.mounts.length === 7 && readReloadEvidence.mounts.every(record => record.status !== 'pending')",
    "cancelled and surviving mounts settle",
  );
  assert.equal(
    sessions.length,
    6,
    "Cancelled A never starts; live sibling and B start once",
  );
  assert.deepEqual(
    router
      .activeTerminalSurfaceFontConfigurations()
      .map((value) => value.fontFamily),
    [undefined, A, A, B, A, B],
  );
  await usable(5, "surviving-sibling");
  await usable(6, "new-b-sibling", 6); // Cancelled mount 5 owns no tab/session.

  // Destroy a separate window at the same read boundary: production host disposal
  // invalidates its late IPC result, with no PTY or resurrected failure owner.
  await reload(A);
  const disposeGate = holdFontRead();
  const removed = createWindow();
  await removed.loadFile(path.join(root, "renderer/index.html"));
  await disposeGate.entered;
  const countBeforeDisposal = sessions.length;
  removed.destroy();
  disposeGate.release();
  await Promise.all(requestSettlements);
  assert.equal(
    received.at(-1)?.status,
    "rejected",
    "Controller disposal still invalidates completion",
  );
  assert.equal(
    sessions.length,
    countBeforeDisposal,
    "No late native initialization",
  );
  assert.equal(router.activeTerminalSurfaceFontConfigurations().length, 6);
  assert.equal(
    fontReadHandles.opened,
    fontReadHandles.closed,
    "Every real native font handle closed",
  );
  router.dispose();
  writeSync(
    1,
    "__OMXTERM_FONT_READ_RELOAD_RESULT__" +
      JSON.stringify({
        acceptedA: true,
        queuedB: true,
        cancelledSibling: true,
        disposed: true,
        sessions: sessions.length,
        usable: true,
        handlesClosed: true,
      }) +
      "\n",
  );
  await owner.complete(0);
}
void run().catch(fail);
