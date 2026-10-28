// Disposable assigned-guest fixture. Runs the built production entry point;
// only native chooser/consent responses and observability are controlled here.
import { app, BrowserWindow, Menu, dialog, webContents } from "electron";
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = import.meta.dirname;
const fixture = JSON.parse(
  await readFile(path.join(root, "fixture.json"), "utf8"),
);
const source = fixture.source;
const require = createRequire(path.join(source, "package.json"));
await mkdir(path.join(root, "profile"));
app.setPath("userData", path.join(root, "profile"));
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.XDG_DATA_HOME = path.join(root, "data");
await mkdir(path.join(root, "config", "omxterm"), { recursive: true });
await writeFile(
  path.join(root, "config", "omxterm", "config.json"),
  JSON.stringify({ version: 1, language: "en-US", confirmClose: false }),
);
const files = path.join(root, "owned-files");
await mkdir(files);
await writeFile(path.join(files, "source.txt"), "preserved-source");
await writeFile(path.join(files, "conflict.txt"), "preserved-destination");
const checks = [];
let failed = false;
let output = "";
const ptys = [];
const pty = require("node-pty");
const spawnPty = pty.spawn;
pty.spawn = (...args) => {
  const session = spawnPty(...args);
  const record = { pid: session.pid, exited: false };
  ptys.push(record);
  session.onData((data) => {
    output = (output + data).slice(-65536);
  });
  session.onExit(() => {
    record.exited = true;
  });
  return session;
};
const children = [];
const childProcess = require("node:child_process");
const fork = childProcess.fork;
childProcess.fork = (...args) => {
  const child = fork(...args);
  if (String(args[0]).endsWith("extension-runtime/bootstrap.mjs")) {
    const record = { child, pid: child.pid, closed: false };
    child.once("close", () => {
      record.closed = true;
    });
    children.push(record);
  }
  return child;
};
syncBuiltinESMExports();
let approved = 0;
dialog.showOpenDialog = async () => ({
  canceled: false,
  filePaths: [path.join(source, "dist/extensions/files-0.1.0.omxext")],
});
dialog.showMessageBox = async (_window, options) => {
  assert.equal(
    options.title,
    "Trust extension code?",
    "unexpected production dialog",
  );
  assert.match(options.detail, /SHA-256: [a-f0-9]{64}/);
  assert.match(options.detail, /network/);
  assert.match(options.detail, /Third-party/);
  approved++;
  return { response: 1, checkboxChecked: false };
};
const ready = new Promise((resolve) =>
  app.once("browser-window-created", (_event, window) =>
    window.once("ready-to-show", () => resolve(window)),
  ),
);
await import(pathToFileURL(path.join(source, "dist/main/index.js")).href);
// Electron emits ready only after this ESM entry has finished evaluating.
// Observe window readiness without making module evaluation depend on it.
void ready.then(async (window) => {
  const core = window.webContents;
  const js = (code) => core.executeJavaScript(code);
  async function until(check, label, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out: ${label}`);
  }
  function menu(label) {
    const search = (items) => {
      for (const item of items) {
        if (item.label.replace(/…$/, "") === label) return item;
        const child = item.submenu && search(item.submenu.items);
        if (child) return child;
      }
    };
    const item = search(Menu.getApplicationMenu().items);
    assert.ok(item, `menu ${label}`);
    item.click(item, window, {});
  }
  function click(contents, label) {
    return contents.executeJavaScript(
      `(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)} && !b.closest('[hidden]')); if (!button) throw Error('button missing'); button.click(); })()`,
    );
  }
  const hosted = () =>
    webContents
      .getAllWebContents()
      .filter(
        (contents) =>
          contents.getURL().startsWith("omx-extension://") &&
          !contents.isDestroyed(),
      );
  async function terminal(marker) {
    await js("document.querySelector('#tab-strip [role=tab]')?.click()");
    await until(
      () => js("!!document.activeElement?.closest('.terminal-surface')"),
      "terminal focus",
    );
    await core.insertText(`printf '${marker}\\n'`);
    core.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    core.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await until(() => output.includes(`${marker}\r\n`), "real PTY marker");
  }
  async function location(contents) {
    await contents.executeJavaScript(
      `document.querySelector('[aria-label=Directory]').value = ${JSON.stringify(files)}; document.querySelector('form.location').requestSubmit()`,
    );
    await until(
      () =>
        contents.executeJavaScript(
          `document.querySelector('.summary').textContent.includes('entries') && document.querySelector('[aria-label=Directory]').value === ${JSON.stringify(files)}`,
        ),
      "directory list",
    );
  }
  async function select(contents, name) {
    await click(contents, "Refresh");
    await until(
      () =>
        contents.executeJavaScript(
          `!![...document.querySelectorAll('.entries button')].find(b => b.textContent.includes(${JSON.stringify(name)}))`,
        ),
      "entry",
    );
    await contents.executeJavaScript(
      `[...document.querySelectorAll('.entries button')].find(b => b.textContent.includes(${JSON.stringify(name)})).click()`,
    );
  }
  async function apply(contents, value) {
    await contents.executeJavaScript(
      `document.querySelector('.operation-editor input').value = ${JSON.stringify(value)}; document.querySelector('.operation-editor').requestSubmit()`,
    );
    await until(
      () =>
        contents.executeJavaScript(
          "!document.querySelector('.operations').inert",
        ),
      "mutation completion",
    );
  }
  app.once("will-quit", () => {
    assert.ok(
      children.every((child) => child.closed),
      "backend close joined before Quit",
    );
    assert.ok(
      ptys.every((session) => session.exited),
      "native PTY exits joined before Quit",
    );
    process.stdout.write(
      `__FILES_PRODUCTION__${JSON.stringify({ checks, failed, approved, backends: children.map(({ pid, closed }) => ({ pid, closed })), ptys, input: "synthetic-Chromium-input; native chooser responses controlled", quit: "joined" })}\n`,
    );
  });
  try {
    window.focus();
    await until(
      () => js("!!document.querySelector('.terminal-surface canvas')"),
      "real surface",
    );
    await terminal("OMX_FILES_BEFORE");
    assert.equal(ptys.length, 1);
    await js(
      "window.__filesOriginalCanvas = document.querySelector('.terminal-surface canvas')",
    );
    menu("Settings");
    await until(
      () => js("!!document.querySelector('#settings-tab-extensions')"),
      "production Settings",
    );
    await click(core, "Config File");
    await until(
      () => js("!!document.querySelector('.settings-config-file textarea')"),
      "retained draft",
    );
    await js(
      "window.__filesDraft = document.querySelector('.settings-config-file textarea'); window.__filesDraft.value += '\\n '; window.__filesDraft.dispatchEvent(new Event('input', {bubbles:true})); window.__filesDraftValue = window.__filesDraft.value",
    );
    await click(core, "Extensions");
    await click(core, "Install local .omxext…");
    await until(
      () =>
        js(
          "document.querySelector('.extensions-panel').textContent.includes('local dormant')",
        ),
      "dormant install",
    );
    assert.equal(children.length, 0);
    checks.push("Settings-captured-trust-dormant-no-backend");
    menu("Files");
    // A navigation URL precedes load completion and Application Tab selection.
    // Stabilize the intended palette owner; do not bypass its stale-target guard.
    await until(async () => {
      if (hosted().length !== 1) return false;
      if (
        !(await js(
          "!!document.querySelector('#tab-strip [role=tab][aria-selected=true]')?.textContent.includes('Files')",
        ))
      )
        return false;
      return hosted()[0].executeJavaScript(
        "!!document.querySelector('form.location')",
      );
    }, "first Files selected and loaded");
    menu("Command Palette");
    await until(
      () =>
        js(
          "!![...document.querySelectorAll('.command-palette [role=option]')].find(row => row.textContent === 'Files')",
        ),
      "shared Files palette contribution",
    );
    await js(
      "[...document.querySelectorAll('.command-palette [role=option]')].find(row => row.textContent === 'Files').click()",
    );
    await until(() => hosted().length === 2, "second Files view");
    assert.equal(children.length, 1, "two real views share one backend");
    checks.push("shared-menu-palette-two-real-views-one-backend");
    const view = hosted()[1];
    await until(
      () => view.executeJavaScript("!!document.querySelector('form.location')"),
      "Files UI loaded",
    );
    await until(
      () =>
        js(
          "[...document.querySelectorAll('#tab-strip [role=tab]')].filter(tab => tab.textContent.includes('Files')).length === 2 && !!document.querySelector('#tab-strip [role=tab][aria-selected=true]')?.textContent.includes('Files')",
        ),
      "two registered Files tabs",
    );
    await location(view);
    await click(view, "New file");
    await apply(view, "created.txt");
    assert.equal((await stat(path.join(files, "created.txt"))).isFile(), true);
    await click(view, "New folder");
    await apply(view, "created-folder");
    assert.equal(
      (await stat(path.join(files, "created-folder"))).isDirectory(),
      true,
    );
    await select(view, "source.txt");
    await click(view, "Rename / move");
    await apply(view, path.join(files, "conflict.txt"));
    assert.equal(
      await readFile(path.join(files, "source.txt"), "utf8"),
      "preserved-source",
    );
    assert.equal(
      await readFile(path.join(files, "conflict.txt"), "utf8"),
      "preserved-destination",
    );
    await click(view, "Rename / move");
    await apply(view, path.join(files, "moved.txt"));
    assert.equal(
      await readFile(path.join(files, "moved.txt"), "utf8"),
      "preserved-source",
    );
    await select(view, "created.txt");
    await click(view, "Delete permanently…");
    await until(
      () =>
        view.executeJavaScript(
          "document.querySelector('.operation-editor').textContent.includes('cannot be undone')",
        ),
      "separate delete confirmation",
    );
    assert.ok(await stat(path.join(files, "created.txt")));
    await click(view, "Delete permanently");
    await until(
      async () =>
        !(await stat(path.join(files, "created.txt")).catch(() => null)),
      "permanent delete",
    );
    await select(view, "moved.txt");
    await click(view, "Move to Trash");
    await until(
      async () =>
        !(await stat(path.join(files, "moved.txt")).catch(() => null)),
      "OS trash",
    );
    assert.equal(
      await readFile(path.join(root, "data/Trash/files/moved.txt"), "utf8"),
      "preserved-source",
    );
    checks.push("real-create-folder-no-clobber-move-trash-confirmed-delete");
    if (fixture.evidence) {
      await writeFile(
        path.join(fixture.evidence, "production-files.png"),
        (await view.capturePage()).toPNG(),
      );
      await writeFile(
        path.join(fixture.evidence, "production-window.png"),
        (await core.capturePage()).toPNG(),
      );
    }
    const sibling = hosted()[0];
    assert.notEqual(sibling.getOSProcessId(), view.getOSProcessId());
    view.forcefullyCrashRenderer();
    await until(() => view.isDestroyed(), "renderer-domain retirement");
    assert.equal(
      await sibling.executeJavaScript(
        "document.querySelector('h1').textContent",
      ),
      "Files",
    );
    assert.equal(children.length, 1);
    children[0].child.kill("SIGKILL");
    await until(() => children[0].closed, "actual backend close");
    await click(sibling, "Refresh");
    await until(
      () =>
        sibling.executeJavaScript(
          "document.body.textContent.includes('Outcome unknown')",
        ),
      "truthful backend transport failure",
    );
    checks.push("renderer-domain-isolation-backend-loss-no-mutation-retry");
    await terminal("OMX_FILES_WITH_VIEWS");
    assert.equal(
      await js(
        "window.__filesOriginalCanvas === document.querySelector('.terminal-surface canvas')",
      ),
      true,
    );
    menu("Settings");
    await until(
      () =>
        js("!document.querySelector('.settings-dialog').closest('[hidden]')"),
      "Settings return",
    );
    assert.equal(
      await js(
        "window.__filesDraft === document.querySelector('.settings-config-file textarea') && window.__filesDraft.value === window.__filesDraftValue",
      ),
      true,
    );
    await click(core, "Disable");
    await until(
      () => hosted().length === 0 && children[0].closed,
      "disable actual view and backend settlement",
    );
    await click(core, "Uninstall");
    await until(
      () =>
        js(
          "document.querySelector('.extensions-panel').textContent.includes('uninstalled')",
        ),
      "uninstall tombstone",
    );
    await terminal("OMX_FILES_AFTER");
    assert.equal(ptys.length, 1);
    checks.push("disable-uninstall-real-settlement-retained-draft-same-PTY");
    app.quit();
  } catch (error) {
    failed = true;
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
    app.quit();
  }
});
