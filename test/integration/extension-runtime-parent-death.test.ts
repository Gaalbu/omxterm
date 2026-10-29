import { test, expect } from "vitest";
import { build } from "esbuild";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
// Read-only observer: no signaling, waitpid/waitid, reaping or supervision.
// Open while the reported backend still belongs to the retained live main.
const observer = `
import os, sys, select, time, json
pid, parent = map(int, sys.argv[1:])
fd = os.pidfd_open(pid)
poller = select.poll()
poller.register(fd, select.POLLIN)
with open('/proc/%d/stat' % pid) as source:
    fields = source.read().rsplit(')', 1)[1].split()
if int(fields[1]) != parent or fields[0] == 'Z' or poller.poll(0):
    raise RuntimeError('backend not live under expected main')
print(json.dumps({'kind':'watching', 'pid':pid}), flush=True)
deadline = time.monotonic() + 45
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd, sys.stdin], [], [], min(1, max(0, deadline-time.monotonic())))
    if fd in ready:
        print(json.dumps({'kind':'kernel-exit', 'pid':pid}), flush=True)
        os.close(fd)
        sys.exit(0)
    if sys.stdin in ready:
        command = sys.stdin.readline()
        if command != 'check\\n':
            raise RuntimeError('invalid observer command or closed input')
        if poller.poll(0):
            raise RuntimeError('backend exited before live check')
        print(json.dumps({'kind':'alive', 'pid':pid}), flush=True)
os.close(fd)
raise RuntimeError('kernel exit observation timed out')
`;

type Receipt = { code: number | null; signal: string | null };
function retain(child: ChildProcess, name: string) {
  const state = {
    child,
    name,
    output: "",
    messages: [] as Record<string, unknown>[],
    exit: undefined as Receipt | undefined,
    close: undefined as Receipt | undefined,
    error: undefined as string | undefined,
  };
  const capture = (chunk: Buffer) => {
    state.output = (state.output + chunk.toString()).slice(-32_768);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.on("message", (message: Record<string, unknown>) => {
    if (state.messages.length < 16) state.messages.push(message);
  });
  child.on("error", (error) => {
    state.error = error.message;
  });
  child.once("exit", (code, signal) => {
    state.exit = { code, signal };
  });
  child.once("close", (code, signal) => {
    state.close = { code, signal };
  });
  return state;
}
type Owned = ReturnType<typeof retain>;
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 10_000,
) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error(label + " timed out");
}
async function message(owned: Owned, kind: string) {
  await until(() => {
    if (owned.error || owned.close)
      throw new Error(
        `${owned.name} ended before ${kind}: ${owned.output} ${owned.error ?? ""}`,
      );
    return owned.messages.some((value) => value.kind === kind);
  }, kind);
  return owned.messages.find((value) => value.kind === kind)!;
}
async function observed(owned: Owned, kind: string) {
  await until(() => {
    if (owned.output.includes(`"kind": "${kind}"`)) return true;
    if (owned.error || owned.close)
      throw new Error(
        `pidfd observer unavailable: ${owned.output} ${owned.error ?? ""}`,
      );
    return false;
  }, kind);
}
async function marker(file: string) {
  await until(
    async () => (await readFile(file, "utf8").catch(() => "")) === "waiting",
    "backend deactivation waiting",
  );
}

test.skipIf(process.platform !== "linux")(
  "retains the independent backend pin after actual Electron main death until pidfd kernel exit",
  async () => {
    await mkdir(".scratch", { recursive: true });
    const root = await mkdtemp(
      path.resolve(".scratch/extension-runtime-parent-death-"),
    );
    const artifact = path.join(root, "build");
    const owned: Owned[] = [];
    let parent: Owned | undefined;
    let watcher: Owned | undefined;
    let manager: Owned | undefined;
    let parentKilled = false;
    let passed = false;
    let settled = false;
    try {
      await exec(
        process.execPath,
        ["scripts/build-extension-runtime.mjs", artifact],
        { timeout: 90_000, maxBuffer: 65_536 },
      );
      const fixture = path.join(root, "fixture.mjs");
      await build({
        entryPoints: ["test/fixtures/extension-runtime-parent-death.ts"],
        outfile: fixture,
        bundle: true,
        platform: "node",
        format: "esm",
        external: ["electron"],
      });
      await writeFile(path.join(root, "observer.py"), observer);
      function launch(role: string) {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.NODE_OPTIONS;
        const result = retain(
          spawn(
            require("electron") as string,
            [
              "--no-sandbox",
              "--ozone-platform=headless",
              "--disable-gpu",
              fixture,
              artifact,
              root,
              role,
            ],
            { env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
          ),
          role,
        );
        owned.push(result);
        return result;
      }
      parent = launch("parent");
      const ready = await message(parent, "ready");
      const diagnostic = ready.diagnostic as { pid: number };
      expect(Number.isSafeInteger(diagnostic.pid) && diagnostic.pid > 0).toBe(
        true,
      );
      expect(ready.mainPid).toBe(parent.child.pid);
      watcher = retain(
        spawn(
          "python3",
          [
            "-u",
            path.join(root, "observer.py"),
            String(diagnostic.pid),
            String(parent.child.pid),
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        ),
        "pidfd-observer",
      );
      owned.push(watcher);
      watcher.child.stdin!.on("error", (error) => {
        watcher!.error = error.message;
      });
      // Any pidfd-open failure aborts here, BEFORE parent death.
      await observed(watcher, "watching");
      expect(parent.exit).toBeUndefined();
      expect(watcher.exit).toBeUndefined();
      expect(parent.child.kill("SIGKILL")).toBe(true);
      parentKilled = true;
      // Exit proves owner death. Inherited descriptors can delay close until
      // the orphan retires; joining close here would prevent the pin oracle.
      await until(() => !!parent!.exit, "actual main exit");
      expect(parent.exit).toEqual({ code: null, signal: "SIGKILL" });
      await marker(path.join(root, "waiting"));
      manager = launch("manager");
      await message(manager, "managed");
      // This live check is AFTER uninstall, both collections and fresh admission.
      watcher.child.stdin!.write("check\n");
      await observed(watcher, "alive");
      expect(watcher.output).not.toContain('"kind": "kernel-exit"');
      await writeFile(path.join(root, "release"), "release");
      await observed(watcher, "kernel-exit");
      await until(() => !!watcher!.close, "observer exit and stdio closure");
      expect(watcher.exit).toEqual({ code: 0, signal: null });
      expect(watcher.close).toEqual(watcher.exit);
      await until(
        () => !!parent!.close,
        "main stdio closure after backend exit",
      );
      expect(parent.close).toEqual(parent.exit);
      expect(await readFile(path.join(root, "released"), "utf8")).toBe(
        "controlled",
      );
      manager.child.send("collect");
      await message(manager, "collected");
      manager.child.send("stop");
      await until(() => !!manager!.close, "manager exit and stdio closure");
      expect(manager.exit).toEqual({ code: 0, signal: null });
      expect(manager.close).toEqual(manager.exit);
      passed = true;
    } finally {
      // Before parent death the actual runtime retires its own child. Afterwards
      // only the release file / backend's 30s bailout can retire the orphan.
      await writeFile(path.join(root, "release"), "release");
      for (const item of [parent, manager]) {
        if (item?.child.connected) item.child.send("stop", () => {});
      }
      try {
        await until(
          () => owned.every((item) => !!item.close),
          "owned process settlement; artifacts retained",
          50_000,
        );
        const managerSettled =
          !manager ||
          (await readFile(path.join(root, "manager-settled.json"), "utf8").then(
            () => true,
            () => false,
          ));
        const backendSettled = parentKilled
          ? !!watcher?.output.includes('"kind": "kernel-exit"') &&
            watcher.exit?.code === 0
          : !parent ||
            (await readFile(
              path.join(root, "parent-settled.json"),
              "utf8",
            ).then(
              () => true,
              () => false,
            ));
        settled = managerSettled && backendSettled;
      } finally {
        const receipt = {
          case: "actual-parent-death-independent-pin",
          passed,
          settled,
          parentKilled,
          backendExit: watcher?.output.includes('"kind": "kernel-exit"')
            ? "kernel-pidfd-readable-no-exit-code"
            : null,
          processes: owned.map(({ child, ...state }) => ({
            pid: child.pid,
            ...state,
          })),
        };
        await writeFile(
          path.join(root, "result.json"),
          JSON.stringify(receipt, null, 2),
        );
        console.log(JSON.stringify(receipt));
        // Deliberately retain source/build/profile evidence for durable export.
        console.log("Parent-death artifacts retained:", root);
      }
      expect(settled, "known scope did not settle; retain all artifacts").toBe(
        true,
      );
    }
  },
  210_000,
);
