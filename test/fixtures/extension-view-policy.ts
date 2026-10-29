import assert from "node:assert/strict";
import type { WebContents } from "electron";
import { waitFor } from "./window-chrome-exercise";

// Executes only synthetic packaged/local/blob probes, never an external endpoint.
export async function exerciseExtensionPolicy(contents: WebContents) {
  const policy = (await contents.executeJavaScript("probePolicy()")) as {
    workers: Array<{ kind: string; source: string; outcome: string }>;
    violations: Array<{ directive: string; blocked: string }>;
    serviceWorker: string;
    connect: string;
    popup: string;
  };
  assert.equal(policy.workers.length, 4);
  assert.ok(
    policy.workers.every((entry) => ["error", "threw"].includes(entry.outcome)),
  );
  await waitFor(
    async () =>
      (await contents.executeJavaScript(
        "receipts.violations.filter(v => v.directive === 'worker-src').length",
      )) === 4,
    "four actual CSP worker refusal receipts",
  );
  await waitFor(
    async () =>
      (await contents.executeJavaScript(
        "receipts.violations.some(v => v.directive === 'connect-src')",
      )) === true,
    "actual connect CSP refusal receipt",
  );
  policy.violations = (await contents.executeJavaScript(
    "receipts.violations",
  )) as typeof policy.violations;
  assert.equal(policy.serviceWorker, "failed");
  assert.deepEqual(contents.session.serviceWorkers.getAllRunning(), {});
  assert.equal(policy.connect, "failed");
  assert.equal(policy.popup, "denied");
  const originalUrl = contents.getURL();
  let navigationPrevented = false;
  const navigationRefusals: string[] = [];
  // Electron can refuse the frame event before emitting will-navigate.
  const record = (name: string) => (event: Electron.Event) => {
    if (event.defaultPrevented) {
      navigationPrevented = true;
      navigationRefusals.push(name);
    }
  };
  contents.once("will-frame-navigate", record("will-frame-navigate"));
  contents.once("will-navigate", record("will-navigate"));
  await contents.executeJavaScript(
    "location.href = 'index.html?forbidden-navigation'",
  );
  await waitFor(
    () => navigationPrevented,
    "production navigation preventDefault",
  );
  assert.equal(contents.getURL(), originalUrl);
  return {
    ...policy,
    navigationPrevented,
    navigationRefusals,
    runningServiceWorkers: 0,
  };
}
