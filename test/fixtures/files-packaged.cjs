// Test-only observer injected through the main inspector after the untouched
// packaged application starts. Native dialog responses and input are controlled.
const { app, BrowserWindow, Menu, dialog, webContents } = require("electron");
const assert = require("node:assert/strict");
const { syncBuiltinESMExports } = require("node:module");
const { readFile, writeFile, stat } = require("node:fs/promises");
const { readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

// Runtime.evaluate has no dynamic-import callback. Load this ordinary CommonJS
// observer through Node's createRequire, without replacing the application entry.
function inspect(options) {
  assert.equal(app.isPackaged, true);
  assert.equal(app.getVersion(), options.version);
  assert.equal(app.getAppPath(), options.asar);
  assert.equal(process.execPath, options.executable);
  return {
    packaged: app.isPackaged,
    version: app.getVersion(),
    appPath: app.getAppPath(),
    executable: process.execPath,
    observer: "CommonJS",
    runType: typeof run,
  };
}

function assertNormalBackendRetirement(child) {
  assert.ok(
    child.closed && child.exit !== null,
    "backend exit and close joined",
  );
  assert.equal(
    child.exit.code,
    0,
    "ordinary backend retirement must exit zero",
  );
  assert.equal(
    child.exit.signal,
    null,
    "ordinary backend retirement must not be signaled",
  );
}

async function run(options) {
  inspect(options);
  const window = BrowserWindow.getAllWindows()[0];
  assert.ok(window);
  const core = window.webContents;
  const js = async (code) => {
    try {
      return await core.executeJavaScript(code);
    } catch (cause) {
      throw new Error(`Core renderer expression failed: ${code}`, { cause });
    }
  };
  const checks = [];
  const children = [];
  const childProcess = require("node:child_process");
  const originalFork = childProcess.fork;
  childProcess.fork = (...args) => {
    const child = originalFork(...args);
    if (String(args[0]).endsWith("extension-runtime/bootstrap.mjs")) {
      assert.equal(
        args[0],
        path.join(options.asar, "dist/extension-runtime/bootstrap.mjs"),
      );
      assert.equal(args[2].execPath, options.executable);
      const record = { pid: child.pid, closed: false, exit: null };
      child.once("exit", (code, signal) => {
        record.exit = { code, signal };
      });
      child.once("close", () => {
        record.closed = true;
      });
      children.push(record);
    }
    return child;
  };
  syncBuiltinESMExports();
  let approvals = 0;
  globalThis.__omxtermPackagedState = {
    checks,
    children,
    get approvals() {
      return approvals;
    },
  };
  dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [options.archive],
  });
  dialog.showMessageBox = async (_owner, prompt) => {
    assert.equal(prompt.title, "Trust extension code?");
    assert.ok(
      prompt.detail.includes(options.archiveSha256),
      "trust must identify exact separate archive",
    );
    assert.match(prompt.detail, /network/);
    approvals++;
    return { response: 1, checkboxChecked: false };
  };
  async function until(check, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out: ${label}`);
  }
  function menu(label) {
    const find = (items) => {
      for (const item of items) {
        if (item.label.replace(/…$/, "") === label) return item;
        const nested = item.submenu && find(item.submenu.items);
        if (nested) return nested;
      }
    };
    const item = find(Menu.getApplicationMenu().items);
    assert.ok(item, `menu ${label}`);
    item.click(item, window, {});
  }
  function click(contents, label) {
    return contents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)} && !b.closest('[hidden]'));
      if (!button || button.disabled || button.closest('[inert]')) throw Error('control unavailable');
      button.click();
    })()`);
  }
  const hosted = () =>
    webContents
      .getAllWebContents()
      .filter(
        (view) =>
          !view.isDestroyed() && view.getURL().startsWith("omx-extension://"),
      );
  const shell = JSON.parse(await readFile(options.readiness, "utf8"));
  const shellStat = () => {
    try {
      const text = readFileSync(`/proc/${shell.probePid}/stat`, "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      return { state: fields[0], start: fields[19] };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const identity = shellStat();
  assert.ok(identity);
  const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
  async function terminal(marker) {
    // A single terminal deliberately has no tab-strip button.
    await js("document.querySelector('#tab-strip [role=tab]')?.click()");
    await until(
      () => js("!!document.activeElement?.closest('.terminal-surface')"),
      "terminal focus",
    );
    assert.equal(shellStat()?.start, identity.start);
    const file = path.join(options.root, marker);
    await core.insertText(`printf '%s' "$$" > ${quote(file)}`);
    core.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    core.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await until(
      async () =>
        (await readFile(file, "utf8").catch(() => "")) ===
        String(shell.probePid),
      "same shell executed input",
    );
  }
  async function settings() {
    menu("Settings");
    await until(
      () => js("!!document.querySelector('#settings-tab-extensions')"),
      "Settings",
    );
    await click(core, "Extensions");
    await until(
      () =>
        js(
          "![...document.querySelectorAll('.extensions-panel button')].some(b => b.disabled)",
        ),
      "Settings admission",
    );
  }
  async function state(text) {
    await until(
      () =>
        js(
          `document.querySelector('.extensions-panel').textContent.includes(${JSON.stringify(text)}) && ![...document.querySelectorAll('.extensions-panel button')].some(b => b.disabled)`,
        ),
      text,
    );
  }
  async function openFiles() {
    await js("document.querySelector('.settings-close').click()");
    await until(
      () => js("!document.querySelector('.settings-dialog')"),
      "Settings closed",
    );
    menu("Files");
    await until(
      async () =>
        hosted().length === 1 &&
        (await hosted()[0].executeJavaScript(
          "!!document.querySelector('form.location') && document.querySelector('.summary').textContent.includes('entries')",
        )) &&
        (await js(
          "!!document.querySelector('#tab-strip [role=tab][aria-selected=true]')?.textContent.includes('Files')",
        )),
      "Files selected and initial listing complete",
    );
    return hosted()[0];
  }
  async function apply(view, value) {
    await view.executeJavaScript(
      `document.querySelector('.operation-editor input').value = ${JSON.stringify(value)}; document.querySelector('.operation-editor').requestSubmit()`,
    );
    await until(
      () =>
        view.executeJavaScript("!document.querySelector('.operations').inert"),
      "mutation settled",
    );
  }
  window.focus();
  await until(
    () => js("!!document.querySelector('.terminal-surface canvas')"),
    "Surface",
  );
  let terminalEntry;
  if (options.terminalOnly) {
    terminalEntry = await js(`(() => {
      const strip = document.querySelector('#tab-strip');
      const snapshot = { hidden: strip.hidden, tabs: strip.querySelectorAll('[role=tab]').length };
      try {
        document.querySelector('#tab-strip [role=tab]').click();
        return { ...snapshot, originalRejected: false };
      } catch (error) {
        return { ...snapshot, originalRejected: true, name: error.name, message: error.message };
      }
    })()`);
    globalThis.__omxtermPackagedState.terminalEntry = terminalEntry;
    // Discriminate the original null dereference, not just any renderer error.
    assert.equal(terminalEntry.hidden, true);
    assert.equal(terminalEntry.tabs, 0);
    assert.equal(terminalEntry.originalRejected, true);
    assert.equal(terminalEntry.name, "TypeError");
    assert.match(terminalEntry.message, /null.*click/);
  }
  await terminal("before");
  if (options.terminalOnly) {
    return {
      check: "terminal-entry-only",
      original: terminalEntry,
      correctedSameShell: true,
      shellPid: shell.probePid,
      shellStart: identity.start,
      approvals,
      children: children.length,
    };
  }
  await js(
    "window.__packagedCanvas = document.querySelector('.terminal-surface canvas')",
  );
  await settings();
  await click(core, "Install local .omxext…");
  await state("generation 1");
  assert.equal(approvals, 1);
  assert.equal(children.length, 0);
  assert.equal(hosted().length, 0);
  checks.push("exact-archive-trust-dormant-install");
  let view = await openFiles();
  assert.equal(children.length, 1);
  await view.executeJavaScript(
    `document.querySelector('[aria-label=Directory]').value = ${JSON.stringify(options.files)}; document.querySelector('form.location').requestSubmit()`,
  );
  await until(
    () =>
      view.executeJavaScript(
        "!![...document.querySelectorAll('.entries button')].find(b => b.textContent.includes('source.txt'))",
      ),
    "owned directory list",
  );
  await click(view, "New file");
  await apply(view, "created.txt");
  assert.equal(
    (await stat(path.join(options.files, "created.txt"))).isFile(),
    true,
  );
  await until(
    () =>
      view.executeJavaScript(
        "!![...document.querySelectorAll('.entries button')].find(b => b.textContent.includes('source.txt'))",
      ),
    "source entry",
  );
  await view.executeJavaScript(
    "[...document.querySelectorAll('.entries button')].find(b => b.textContent.includes('source.txt')).click()",
  );
  await click(view, "Rename / move");
  await apply(view, path.join(options.files, "conflict.txt"));
  assert.equal(
    await readFile(path.join(options.files, "source.txt"), "utf8"),
    "source",
  );
  assert.equal(
    await readFile(path.join(options.files, "conflict.txt"), "utf8"),
    "preserved",
  );
  await click(view, "Rename / move");
  await apply(view, path.join(options.files, "moved.txt"));
  assert.equal(
    await readFile(path.join(options.files, "moved.txt"), "utf8"),
    "source",
  );
  checks.push("packaged-backend-create-move-conflict");
  await writeFile(
    path.join(options.evidence, "files.png"),
    (await view.capturePage()).toPNG(),
  );
  await settings();
  await click(core, "Install local .omxext…");
  await state("generation 2");
  await until(
    () => hosted().length === 0 && children[0].closed,
    "replacement retired actual backend/view",
  );
  assertNormalBackendRetirement(children[0]);
  assert.equal(children.length, 1, "replacement remains dormant");
  assert.equal(approvals, 2);
  checks.push("explicit-reinstall-actual-retirement-dormant");
  view = await openFiles();
  assert.equal(children.length, 2);
  assert.notEqual(children[0].pid, children[1].pid);
  await settings();
  await click(core, "Disable");
  await state("generation 3");
  await until(
    () => hosted().length === 0 && children[1].closed,
    "Disable retirement",
  );
  assertNormalBackendRetirement(children[1]);
  await click(core, "Uninstall");
  await state("uninstalled");
  checks.push("fresh-activation-disable-uninstall");
  await terminal("after");
  assert.equal(
    await js(
      "window.__packagedCanvas === document.querySelector('.terminal-surface canvas')",
    ),
    true,
  );
  assert.equal(shellStat()?.start, identity.start);
  checks.push("same-PTY-and-Surface");
  await writeFile(
    path.join(options.evidence, "terminal-after.png"),
    (await core.capturePage()).toPNG(),
  );
  const result = {
    checks,
    approvals,
    children,
    shell: { ...shell, start: identity.start },
    host: app.getVersion(),
    executable: process.execPath,
    appPath: app.getAppPath(),
    input: "synthetic Chromium; native consent controlled; inspector observer",
  };
  app.once("will-quit", () => {
    const remaining = shellStat();
    assert.ok(
      !remaining ||
        remaining.start !== identity.start ||
        remaining.state === "Z",
      "shell kernel exit before will-quit",
    );
    children.forEach(assertNormalBackendRetirement);
    writeFileSync(
      path.join(options.evidence, "quit.json"),
      JSON.stringify(
        { ...result, quit: "joined", shellAtQuit: remaining },
        null,
        2,
      ),
    );
  });
  return result;
}

module.exports = {
  inspect,
  run,
  assertNormalBackendRetirement,
  quit: () => app.quit(),
};
