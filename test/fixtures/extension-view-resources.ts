import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { extensionResourceOwner } from "../../src/main/extension-view-reader";
import type { CapturedResourceOwner } from "../../src/main/extension-view-resources";

// Immutable synthetic A/B directories; the real reader captures A once. Changing
// the caller's current pointer must never change the epoch's resource bytes.
export async function createExtensionFixtureResources(root: string) {
  const directory = path.join(root, "resource-A");
  const replacement = path.join(root, "resource-B");
  await Promise.all([mkdir(directory), mkdir(replacement)]);
  const html = `<!doctype html><meta charset="utf-8"><title>Captured A</title>
<link rel="stylesheet" href="page.css"><h1>Captured A</h1>
<label>Synthetic draft <input id="draft" value="A draft"></label>
<script src="page.js"></script>`;
  await Promise.all([
    writeFile(path.join(directory, "index.html"), html),
    writeFile(
      path.join(replacement, "index.html"),
      html.replaceAll("Captured A", "Latest B"),
    ),
    writeFile(
      path.join(directory, "page.css"),
      "body { background: #202430; color: white; font: 18px sans-serif; padding: 20px; } input { font: inherit; }",
    ),
    writeFile(
      path.join(directory, "canary.js"),
      "throw new Error('Worker canary executed');",
    ),
    writeFile(
      path.join(directory, "page.js"),
      `
window.receipts = { violations: [], workers: [], serviceWorker: null, connect: null, popup: null, keys: [] };
document.addEventListener('securitypolicyviolation', event => receipts.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI }));
document.addEventListener('keydown', event => receipts.keys.push(event.key));
window.probePolicy = async () => {
  for (const kind of ['Worker', 'SharedWorker']) for (const source of ['local', 'blob']) {
    const url = source === 'local' ? new URL('canary.js', location.href).href : URL.createObjectURL(new Blob(['throw new Error("Worker canary executed")'], {type:'text/javascript'}));
    const outcome = await new Promise(resolve => {
      let worker;
      const timer = setTimeout(() => { worker?.terminate?.(); resolve('timeout'); }, 2000);
      const finish = value => { clearTimeout(timer); worker?.terminate?.(); worker?.port?.close(); resolve(value); };
      try { worker = new window[kind](url); worker.onerror = event => { event.preventDefault(); finish('error'); }; worker.onmessage = () => finish('executed'); }
      catch { finish('threw'); }
    });
    receipts.workers.push({kind, source, outcome});
    if (source === 'blob') URL.revokeObjectURL(url);
  }
  try { await navigator.serviceWorker.register('canary.js'); receipts.serviceWorker = 'registered'; } catch { receipts.serviceWorker = 'failed'; }
  try { await fetch(new URL('canary.js', location.href)); receipts.connect = 'allowed'; } catch { receipts.connect = 'failed'; }
  receipts.popup = window.open('index.html') === null ? 'denied' : 'opened';
  return receipts;
};
`,
    ),
  ]);
  let current = directory;
  let released = 0;
  let active = 0;
  let attempts = 0;
  let attemptsAtRelease = -1;
  const reads: Array<{ resource: string; bytes: number; sha256: string }> = [];
  const captured = extensionResourceOwner({
    directory: current,
    async release() {
      assert.equal(
        active,
        0,
        "captured owner releases only after actual reads settle",
      );
      attemptsAtRelease = attempts;
      released += 1;
    },
  });
  const resources: CapturedResourceOwner = {
    async read(resource, maximum, signal) {
      attempts += 1;
      assert.equal(
        released,
        0,
        "no resource read after captured-owner release",
      );
      active += 1;
      try {
        const bytes = await captured.read(resource, maximum, signal);
        if (resource === "index.html")
          assert.equal(Buffer.from(bytes).toString(), html);
        reads.push({
          resource,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        return bytes;
      } finally {
        active -= 1;
      }
    },
    release: () => captured.release(),
  };
  return {
    resources,
    replaceCurrent() {
      current = replacement;
    },
    async assertRetired() {
      assert.equal(current, replacement);
      assert.equal(released, 1);
      assert.equal(active, 0);
      assert.equal(
        attempts,
        attemptsAtRelease,
        "retired host never calls captured owner again",
      );
      const count = reads.length;
      await assert.rejects(
        captured.read("index.html", 1024, new AbortController().signal),
      );
      assert.equal(reads.length, count);
      return {
        reads: [...reads],
        capturedVersion: "A",
        callerCurrentVersion: "B",
        attempts,
        attemptsAtRelease,
        released,
        active,
        postReleaseRead: "rejected",
      };
    },
  };
}
