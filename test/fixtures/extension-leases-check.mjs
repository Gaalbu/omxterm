// Standalone headless native contract. Run with --expose-gc and UV_THREADPOOL_SIZE=1.
// argv: bundled production adapter, addon. Children use the same runtime and bytes.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { pbkdf2 } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as immediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";

const [adapterPath, addonPath, mode, lockPath] = process.argv.slice(2);
const adapterURL = pathToFileURL(adapterPath).href;
const { createNativeLeaseAdapter } = await import(adapterURL);
const adapter = createNativeLeaseAdapter(addonPath);
if (mode === "hold" || mode === "hold-shared") {
  const lease = await adapter.tryAcquire(lockPath, mode === "hold");
  assert.ok(lease);
  process.send("held");
  process.on("message", async (message) => {
    if (message === "release") await lease.release();
    process.exit(0);
  });
} else {
  assert.equal(process.env.UV_THREADPOOL_SIZE, "1");
  assert.equal(typeof global.gc, "function");
  const root = await mkdtemp(path.join(os.tmpdir(), "extension-leases-"));
  const file = path.join(root, "permanent.lock");
  const children = new Set();
  const workers = new Set();
  const checks = [];
  const deadline = setTimeout(async () => {
    console.error("FAIL extension lease fixture deadline");
    await Promise.all([...workers].map((worker) => worker.terminate()));
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise((resolve) => {
            child.once("close", resolve);
            child.kill("SIGKILL");
          }),
      ),
    );
    process.exit(1);
  }, 45_000);
  deadline.unref();
  const check = async (name, run) => {
    await run();
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  const child = async (target = file, shared = false) => {
    const child = fork(
      fileURLToPath(import.meta.url),
      [adapterPath, addonPath, shared ? "hold-shared" : "hold", target],
      {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv: ["--expose-gc"],
      },
    );
    children.add(child);
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        children.delete(child);
        resolve({ code, signal });
      });
    });
    await new Promise((resolve, reject) => {
      child.once("message", (message) =>
        message === "held" ? resolve() : reject(new Error("child receipt")),
      );
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error("child exited before receipt")),
      );
    });
    return { child, closed };
  };
  try {
    await check(
      "shared/exclusive independent descriptors and permanent inode",
      async () => {
        const a = await adapter.tryAcquire(file, false);
        const b = await adapter.tryAcquire(file, false);
        assert.ok(a);
        assert.ok(b);
        const before = await stat(file);
        assert.equal(await adapter.tryAcquire(file, true), null);
        await a.release();
        assert.equal(await adapter.tryAcquire(file, true), null);
        await b.release();
        const exclusive = await adapter.tryAcquire(file, true);
        assert.ok(exclusive);
        assert.equal(await adapter.tryAcquire(file, false), null);
        assert.equal(await adapter.tryAcquire(file, true), null);
        const first = exclusive.release();
        assert.equal(exclusive.release(), first);
        global.gc();
        await first;
        await exclusive.release();
        assert.equal((await stat(file)).ino, before.ino);
      },
    );
    await check(
      "fixed failures, symlink and nonregular rejection",
      async () => {
        assert.throws(
          () => createNativeLeaseAdapter(path.join(root, "missing.node")),
          { code: "LEASE_LOAD", message: "LEASE_LOAD" },
        );
        await symlink(file, path.join(root, "link"));
        await mkdir(path.join(root, "directory"));
        for (const candidate of [
          path.join(root, "link"),
          path.join(root, "directory"),
          path.join(root, "missing", "lock"),
          "bad\0path",
        ]) {
          await assert.rejects(adapter.tryAcquire(candidate, true), (error) => {
            assert.match(error.message, /^LEASE_(OBJECT|OPEN|PATH)$/);
            assert.equal(error.code, error.message);
            return true;
          });
        }
      },
    );
    await check("open dispatched off main with bounded admission", async () => {
      let blocked = true;
      const blocker = new Promise((resolve, reject) =>
        pbkdf2("fixture", "fixture", 2_000_000, 32, "sha256", (error) => {
          blocked = false;
          if (error) reject(error);
          else resolve();
        }),
      );
      const target = path.join(root, "async.lock");
      const pending = adapter.tryAcquire(target, true);
      await immediate();
      assert.equal(blocked, true);
      assert.equal(existsSync(target), false, "open must not run on main");
      const requests = Array.from({ length: 140 }, (_, index) =>
        adapter.tryAcquire(path.join(root, `capacity-${index}`), false),
      );
      // Install rejection handlers before unblocking the queue.
      const outcomes = Promise.allSettled(requests);
      await blocker;
      const lease = await pending;
      assert.ok(lease);
      const results = await outcomes;
      assert.ok(
        results.some(
          (result) =>
            result.status === "rejected" &&
            result.reason.code === "LEASE_CAPACITY",
        ),
      );
      for (const result of results) {
        if (result.status === "fulfilled") await result.value.release();
        else assert.equal(result.reason.code, "LEASE_CAPACITY");
      }
      await lease.release();
    });
    await check(
      "live lease survives GC; discarded lease closes asynchronously",
      async () => {
        let retained = await adapter.tryAcquire(file, true);
        for (let i = 0; i < 3; i++) {
          global.gc();
          await immediate();
        }
        assert.equal(await adapter.tryAcquire(file, true), null);
        await retained.release();
        retained = null;
        await (async () => {
          assert.ok(await adapter.tryAcquire(file, true));
        })();
        let recovered = null;
        for (let i = 0; i < 100 && !recovered; i++) {
          global.gc();
          await immediate();
          recovered = await adapter.tryAcquire(file, true);
        }
        assert.ok(recovered, "unreachable lease must retire");
        await recovered.release();
      },
    );
    await check(
      "cross-process shared leases coexist and exclude writers",
      async () => {
        const lease = await adapter.tryAcquire(file, false);
        assert.ok(lease);
        const { child: holder, closed } = await child(file, true);
        assert.equal(await adapter.tryAcquire(file, true), null);
        await lease.release();
        assert.equal(await adapter.tryAcquire(file, true), null);
        holder.send("release");
        assert.deepEqual(await closed, { code: 0, signal: null });
        const recovered = await adapter.tryAcquire(file, true);
        assert.ok(recovered);
        await recovered.release();
      },
    );
    await check(
      "child exec does not inherit an independent parent lock",
      async () => {
        const lease = await adapter.tryAcquire(file, true);
        assert.ok(lease);
        const { child: holder, closed } = await child(
          path.join(root, "child-independent.lock"),
        );
        await lease.release();
        const recovered = await adapter.tryAcquire(file, true);
        assert.ok(recovered, "child must not retain the parent's descriptor");
        await recovered.release();
        holder.send("release");
        assert.deepEqual(await closed, { code: 0, signal: null });
      },
    );
    for (const action of ["release", "exit", "kill"]) {
      await check(`child contention and ${action} settlement`, async () => {
        const { child: holder, closed } = await child();
        assert.equal(await adapter.tryAcquire(file, false), null);
        assert.equal(await adapter.tryAcquire(file, true), null);
        if (action === "kill") holder.kill("SIGKILL");
        else holder.send(action);
        const result = await closed;
        assert.deepEqual(
          result,
          action === "kill"
            ? { code: null, signal: "SIGKILL" }
            : { code: 0, signal: null },
        );
        const recovered = await adapter.tryAcquire(file, true);
        assert.ok(recovered);
        await recovered.release();
      });
    }
    await check(
      "worker environment teardown releases live native lease",
      async () => {
        const worker = new Worker(
          `
        const { parentPort } = require('node:worker_threads');
        (async () => {
          const { createNativeLeaseAdapter } = await import(${JSON.stringify(adapterURL)});
          const retained = await createNativeLeaseAdapter(${JSON.stringify(addonPath)}).tryAcquire(${JSON.stringify(file)}, true);
          if (!retained) throw new Error('worker acquire');
          parentPort.on('message', () => retained.release());
          parentPort.postMessage('held');
        })();`,
          { eval: true, execArgv: [] },
        );
        workers.add(worker);
        await new Promise((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        });
        assert.equal(await adapter.tryAcquire(file, true), null);
        await worker.terminate();
        workers.delete(worker);
        const recovered = await adapter.tryAcquire(file, true);
        assert.ok(recovered);
        await recovered.release();
      },
    );
    await check("worker teardown joins pending acquisition", async () => {
      const worker = new Worker(
        `
        const { parentPort } = require('node:worker_threads');
        const { pbkdf2 } = require('node:crypto');
        (async () => {
          const { createNativeLeaseAdapter } = await import(${JSON.stringify(adapterURL)});
          pbkdf2('fixture', 'fixture', 2_000_000, 32, 'sha256', () => {});
          const pending = createNativeLeaseAdapter(${JSON.stringify(addonPath)}).tryAcquire(${JSON.stringify(file)}, true);
          parentPort.postMessage('queued');
          await pending;
        })();`,
        { eval: true, execArgv: [] },
      );
      workers.add(worker);
      await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      await worker.terminate();
      workers.delete(worker);
      const recovered = await adapter.tryAcquire(file, true);
      assert.ok(recovered);
      await recovered.release();
    });
    console.log(
      JSON.stringify({
        checks,
        versions: process.versions,
        arch: process.arch,
        platform: process.platform,
      }),
    );
  } finally {
    for (const worker of workers) await worker.terminate();
    await Promise.all(
      [...children].map(
        (child) =>
          new Promise((resolve) => {
            child.once("close", resolve);
            child.kill("SIGKILL");
          }),
      ),
    );
    clearTimeout(deadline);
    await rm(root, { recursive: true, force: true });
  }
}
