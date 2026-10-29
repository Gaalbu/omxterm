import assert from "node:assert/strict";
import {
  app,
  BrowserWindow,
  dialog,
  webContents,
  type WebContents,
} from "electron";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isSavedLayout,
  type SavedLayout,
} from "../../src/shared/terminal-layout";
import {
  RESTORATION_CHECKS,
  RESTORATION_RESULT,
  type RestorationReceipt,
} from "./restoration-native-contract";
import {
  click,
  focus,
  input,
  menu,
  observeRestorationProduction,
  isolateRestorationProfile,
  quote,
  selectPane,
  text,
  until,
} from "./restoration-production-support";

// Built production app, real bridge/bootstrap/state/native lease/Surfaces/PTYS.
// Only chooser consent, isolated account home and observation are controlled.
const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  await readFile(path.join(root, "fixture.json"), "utf8"),
) as { source: string; archiveSha256: string; evidence: string };
const { home, profile, reported, missing } =
  await isolateRestorationProfile(root);
const { ptys, children } = observeRestorationProduction(fixture.source);
const checks: string[] = [];
let failed = false;
let approvals = 0;
let sourcePreserved = false;
let freshOutput = false;
let fallbackNotice = false;
let verifiedPanes = 0;
let quitting = false;
function fail(error: unknown) {
  if (failed) return;
  failed = true;
  process.exitCode = 1;
  process.stderr.write(
    `${error instanceof Error ? error.stack : "Restoration fixture failure"}\n`,
  );
  app.quit(); // Supervisor owns identity-checked recovery if normal retirement fails.
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
dialog.showOpenDialog = (async () => ({
  canceled: false,
  filePaths: [path.join(root, "restoration.omxext")],
})) as typeof dialog.showOpenDialog;
dialog.showMessageBox = (async (
  _window: BrowserWindow,
  options: Electron.MessageBoxOptions,
) => {
  assert.equal(
    options.title,
    "Trust extension code?",
    "unexpected confirmation/failure dialog",
  );
  assert.ok(options.detail?.includes(fixture.archiveSha256));
  approvals++;
  return { response: 1, checkboxChecked: false };
}) as typeof dialog.showMessageBox;
dialog.showErrorBox = () => {
  throw new Error("Unexpected production error dialog");
};
app.once("will-quit", () => {
  try {
    assert.ok(quitting && !failed, "scenario did not reach deliberate Quit");
    assert.ok(
      children.every((child) => child.closed),
      "backend close not joined",
    );
    assert.ok(
      ptys.every((pty) => pty.exited),
      "actual native exits not joined",
    );
  } catch {
    failed = true;
    process.exitCode = 1;
  }
  const receipt: RestorationReceipt = {
    failed,
    checks,
    approvals,
    quit:
      children.every((child) => child.closed) && ptys.every((pty) => pty.exited)
        ? "joined"
        : "unsettled",
    ptys: ptys.map(({ pid, exited }) => ({ pid, exited })),
    backends: children.map(({ pid, closed }) => ({ pid, closed })),
    sourcePreserved,
    freshOutput,
    fallbackNotice,
    verifiedPanes,
  };
  writeFileSync(
    path.join(fixture.evidence, "scenario.json"),
    JSON.stringify(receipt, null, 2),
  );
  process.stdout.write(RESTORATION_RESULT + JSON.stringify(receipt) + "\n");
});
const hosted = () =>
  webContents
    .getAllWebContents()
    .filter(
      (contents) =>
        !contents.isDestroyed() &&
        contents.getURL().startsWith("omx-extension://"),
    );
async function settings(window: BrowserWindow) {
  await focus(window);
  menu(window, "Settings");
  await until(
    () =>
      window.webContents.executeJavaScript(
        "!!document.querySelector('#settings-tab-extensions')",
      ),
    "Settings tab",
  );
  await click(window.webContents, "Extensions");
  await until(
    () =>
      window.webContents.executeJavaScript(
        "!!document.querySelector('.extensions-panel') && !document.querySelector('.extensions-panel')?.closest('[hidden]')",
      ),
    "Extensions panel",
  );
}
async function closeSettings(window: BrowserWindow) {
  await window.webContents.executeJavaScript(
    "document.querySelector('.settings-close').click()",
  );
  await until(
    () =>
      window.webContents.executeJavaScript(
        "!document.querySelector('.settings-dialog') || !!document.querySelector('.settings-dialog').closest('[hidden]')",
      ),
    "Settings departure",
  );
}
async function page(window: BrowserWindow) {
  await focus(window);
  menu(window, "Saved Layout");
  await until(
    async () =>
      hosted().length === 1 &&
      Boolean(
        await hosted()[0]!.executeJavaScript(
          "!!document.querySelector('[data-action=refresh]') && !document.querySelector('[data-action=refresh]').disabled",
        ),
      ),
    "Saved Layout page ready",
  );
  return hosted()[0]!;
}
async function marker(window: BrowserWindow, label: string) {
  await input(window.webContents, `printf '\\n${label}\\n'`);
  await until(
    () => ptys.some((pty) => pty.output.includes(`\r\n${label}\r\n`)),
    "actual PTY marker",
  );
}
async function report(window: BrowserWindow, directory: string, label: string) {
  const uri = pathToFileURL(directory).href.replace(
    "file://",
    "file://localhost",
  );
  await input(
    window.webContents,
    `cd ${quote(directory)}; printf '\\033]7;%s\\007' ${quote(uri)}; printf '\\n${label}\\n'`,
  );
  await until(
    () => ptys.some((pty) => pty.output.includes(`\r\n${label}\r\n`)),
    "synthetic OSC7 consumed before capture",
  );
}
async function arrange(window: BrowserWindow) {
  await selectPane(window, 0, 0);
  await report(window, reported, "OMX_LAYOUT_REPORTED");
  menu(window, "Split Right");
  await until(() => ptys.length === 2, "first split PTY");
  // Split original again: mixed row/column; leave right pane launch-only.
  await selectPane(window, 0, 0);
  menu(window, "Split Down");
  await until(() => ptys.length === 3, "mixed split PTY");
  await selectPane(window, 0, 1);
  await report(window, missing, "OMX_LAYOUT_VANISHES");
  await window.webContents
    .executeJavaScript(`for (const divider of document.querySelectorAll('.terminal-pane-divider')) {
    const key = divider.getAttribute('aria-orientation') === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    divider.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true}));
  }`);
  menu(window, "New Tab");
  await until(() => ptys.length === 4, "second tab PTY");
  await selectPane(window, 1, 0);
  await marker(window, "OMX_LAYOUT_SOURCE_SECOND");
  await selectPane(window, 0, 0);
  await marker(window, "OMX_LAYOUT_SOURCE_ONLY");
  await window.webContents.executeJavaScript(
    "window.__restorationSourceCanvases = [...document.querySelectorAll('.terminal-tab canvas')]",
  );
  checks.push(RESTORATION_CHECKS[1]);
}
async function state() {
  const document = JSON.parse(
    await readFile(
      path.join(profile, "extension-state/omxterm.restoration/state.json"),
      "utf8",
    ),
  ) as { revision: string; value: SavedLayout };
  assert.ok(isSavedLayout(document.value));
  return document;
}
async function evidence(contents: WebContents, name: string) {
  await contents.executeJavaScript(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  await writeFile(
    path.join(fixture.evidence, name),
    (await contents.capturePage()).toPNG(),
  );
}
async function disable(window: BrowserWindow, backend: number) {
  await settings(window);
  await until(
    () =>
      window.webContents.executeJavaScript(
        "[...document.querySelectorAll('.extensions-panel button')].some(b => b.textContent === 'Disable' && !b.disabled)",
      ),
    "Disable admission",
  );
  await click(window.webContents, "Disable");
  await until(
    () => hosted().length === 0 && children[backend]!.closed,
    "actual page/backend retirement",
  );
  // Retirement precedes the completed Settings snapshot; wait for Enable too.
  await until(
    () =>
      window.webContents.executeJavaScript(
        "[...document.querySelectorAll('.extensions-panel button')].some(b => b.textContent === 'Enable' && !b.disabled)",
      ),
    "completed disabled snapshot",
  );
}
async function verifyRestored(window: BrowserWindow, saved: SavedLayout) {
  await until(
    () =>
      ptys.length === 8 &&
      ptys.slice(4).every((pty) => pty.output.includes("OMX_LAYOUT_READY")),
    "all restored shells, including background tab, started",
  );
  assert.ok(
    ptys
      .slice(4)
      .every(
        (pty) =>
          !pty.output.includes("OMX_LAYOUT_SOURCE_ONLY") &&
          !pty.writes.includes("clear"),
      ),
    "no prior output or clear injection",
  );
  freshOutput = true;
  assert.deepEqual(
    ptys
      .slice(4)
      .map((pty) => pty.cwd)
      .sort(),
    [reported, reported, home, home].sort(),
  );
  await until(
    () =>
      window.webContents.executeJavaScript(
        "document.querySelector('.terminal-layout-status')?.dataset.phase === 'completed'",
      ),
    "core restoration status",
  );
  fallbackNotice = (await window.webContents.executeJavaScript(
    "document.querySelector('.terminal-layout-status')?.textContent.includes('1 folder fallbacks')",
  )) as boolean;
  assert.equal(fallbackNotice, true);
  await until(() => window.isVisible(), "restored native window visible");
  await focus(window);
  await evidence(window.webContents, "restored-window-fallback.png");
  const before = new Map(
    ptys.slice(4).map((pty) => [pty.pid, pty.sizes.at(-1)!.join(",")]),
  );
  const [width, height] = window.getSize();
  assert.ok(width !== undefined && height !== undefined);
  window.setSize(width + 80, height + 60);
  const exercised = new Set<number>();
  for (let tab = 0; tab < saved.tabs.length; tab++) {
    for (let pane = 0; pane < saved.tabs[tab]!.panes.length; pane++) {
      await selectPane(window, tab, pane);
      const label = `OMX_LAYOUT_RESTORED_${tab}_${pane}`;
      await input(window.webContents, `printf '\\n${label}\\n'; pwd`);
      await until(
        () =>
          ptys.slice(4).some((pty) => pty.output.includes(`\r\n${label}\r\n`)),
        "restored pane input/output",
      );
      const record = ptys
        .slice(4)
        .find((pty) => pty.output.includes(`\r\n${label}\r\n`))!;
      assert.ok(
        !exercised.has(record.pid),
        "each restored pane must reach a distinct PTY",
      );
      exercised.add(record.pid);
      const directory = saved.tabs[tab]!.panes[pane]!;
      const expected =
        directory.kind === "home" || directory.path === missing
          ? home
          : directory.path;
      await until(
        () => record.output.includes(`\r\n${label}\r\n${expected}\r\n`),
        "literal restored cwd",
      );
      await until(
        () => record.sizes.at(-1)!.join(",") !== before.get(record.pid),
        "live native refit including background selection",
      );
      assert.ok(record.sizes.at(-1)!.every((value) => value > 0));
      const [cols, rows] = record.sizes.at(-1)!;
      const grid = `OMX_LAYOUT_GRID_${tab}_${pane}`;
      await input(window.webContents, `printf '\\n${grid}\\n'; stty size`);
      await until(
        () => record.output.includes(`\r\n${grid}\r\n${rows} ${cols}\r\n`),
        "actual native PTY grid",
      );
      verifiedPanes++;
    }
  }
  checks.push(RESTORATION_CHECKS[6]);
}
async function run(source: BrowserWindow) {
  source.setSize(1100, 760);
  await until(
    () =>
      source.webContents.executeJavaScript(
        "!!document.querySelector('.terminal-surface canvas')",
      ),
    "initial production Surface",
  );
  await until(
    () => ptys.length === 1 && ptys[0]!.output.includes("OMX_LAYOUT_READY"),
    "initial Default Shell ready marker",
  );
  await settings(source);
  await click(source.webContents, "Install local .omxext…");
  await until(
    () =>
      source.webContents.executeJavaScript(
        "document.querySelector('.extensions-panel').textContent.includes('local dormant')",
      ),
    "dormant install",
  );
  assert.equal(children.length, 0);
  checks.push(RESTORATION_CHECKS[0]);
  await closeSettings(source);
  await arrange(source);
  const first = await page(source);
  await click(first, "Save this window");
  await until(
    async () => (await text(first)).includes("Window layout saved"),
    "state commit acknowledgement",
  );
  const saved = await state();
  assert.equal(saved.value.tabs.length, 2);
  assert.equal(saved.value.tabs[0]!.panes.length, 3);
  assert.equal(saved.value.selected, 0);
  assert.ok(saved.value.omitted >= 1);
  const splits = saved.value.tabs[0]!.nodes.filter(
    (node) => "direction" in node,
  );
  assert.deepEqual(splits.map((node) => node.direction).sort(), [
    "column",
    "row",
  ]);
  assert.ok(splits.every((node) => node.weights[0] !== node.weights[1]));
  const directories = saved.value.tabs.flatMap((tab) => tab.panes);
  assert.ok(
    directories.some(
      (pane) => pane.kind === "reported-local" && pane.path === reported,
    ),
  );
  assert.ok(
    directories.some(
      (pane) => pane.kind === "launch-local" && pane.path === reported,
    ),
  );
  assert.ok(
    directories.some(
      (pane) => pane.kind === "reported-local" && pane.path === missing,
    ),
  );
  const lock = path.join(
    profile,
    "extension-state/omxterm.restoration/state.lock",
  );
  const lockIdentity = await stat(lock);
  checks.push(RESTORATION_CHECKS[2]);
  menu(source, "Close Tab");
  await until(() => first.isDestroyed(), "first page actually destroyed");
  await disable(source, 0);
  checks.push(RESTORATION_CHECKS[3]);
  await rm(missing, { recursive: true });
  await click(source.webContents, "Enable");
  await until(
    () =>
      source.webContents.executeJavaScript(
        "document.querySelector('.extensions-panel').textContent.includes('local dormant')",
      ),
    "enabled dormant snapshot",
  );
  assert.equal(children.length, 1, "Enable must not activate code");
  await closeSettings(source);
  await selectPane(source, 0, 0);
  const cold = await page(source);
  await until(
    () => children.length === 2 && !children[1]!.closed && !cold.isDestroyed(),
    "fresh bootstrap",
  );
  assert.notEqual(cold, first);
  assert.notEqual(children[0]!.child, children[1]!.child);
  await until(
    () =>
      cold.executeJavaScript(
        "!document.querySelector('[data-action=open]').disabled",
      ),
    "cold page validated persisted snapshot",
  );
  assert.deepEqual(await state(), saved);
  assert.equal(
    (await stat(lock)).ino,
    lockIdentity.ino,
    "stable native lease file identity",
  );
  assert.equal((await stat(lock)).mode & 0o777, 0o600);
  await evidence(cold, "cold-saved-layout.png");
  checks.push(RESTORATION_CHECKS[4]);
  await click(cold, "Open saved layout in a new window");
  await until(
    () => BrowserWindow.getAllWindows().length === 2,
    "one new core window",
  );
  const restored = BrowserWindow.getAllWindows().find(
    (window) => window !== source,
  )!;
  await until(
    async () => (await text(cold)).includes("New window accepted"),
    "accepted core transfer",
  );
  await until(() => ptys.length === 8, "no dummy shell");
  sourcePreserved =
    ptys.slice(0, 4).every((pty) => !pty.exited) &&
    ((await source.webContents.executeJavaScript(
      "window.__restorationSourceCanvases.length === document.querySelectorAll('.terminal-tab canvas').length && window.__restorationSourceCanvases.every((canvas, i) => canvas === document.querySelectorAll('.terminal-tab canvas')[i])",
    )) as boolean);
  assert.equal(sourcePreserved, true);
  checks.push(RESTORATION_CHECKS[5]);
  await verifyRestored(restored, saved.value);
  await disable(source, 1);
  assert.deepEqual(await state(), saved, "disable retains saved data");
  assert.equal(ptys.length, 8);
  assert.ok(
    ptys.every((pty) => !pty.exited),
    "extension retirement must not close core terminals",
  );
  await selectPane(restored, 1, 0);
  await marker(restored, "OMX_LAYOUT_AFTER_DISABLE");
  await closeSettings(source);
  await selectPane(source, 0, 0);
  await marker(source, "OMX_LAYOUT_SOURCE_AFTER");
  checks.push(RESTORATION_CHECKS[7]);
  quitting = true;
  app.quit();
}
const ready = new Promise<BrowserWindow>((resolve) =>
  app.once("browser-window-created", (_event, window) =>
    window.once("ready-to-show", () => resolve(window)),
  ),
);
await import(
  pathToFileURL(path.join(fixture.source, "dist/main/index.js")).href
);
// Never block ESM evaluation on app.ready: production owns that lifecycle.
void ready.then(run).catch(fail);
