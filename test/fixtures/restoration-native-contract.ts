import assert from "node:assert/strict";

export const RESTORATION_CHECKS = [
  "production-install-dormant",
  "two-tabs-unequal-mixed-splits",
  "persisted-reported-launch-and-missing-folders",
  "closed-page-disabled-backend-actual-retirement",
  "dormant-enable-cold-bootstrap-read",
  "fresh-default-shells-source-identities-preserved",
  "every-pane-input-output-refit-without-clear",
  "restored-window-survives-extension-retirement",
] as const;
export const RESTORATION_RESULT = "__RESTORATION_PRODUCTION__";
// Disable also leaves a dormant local runtime. Require the completed enabled
// snapshot's usable inverse action before leaving Settings and invoking its menu.
export const RESTORATION_ENABLED_SNAPSHOT = `(() => {
  const panel = document.querySelector('.extensions-panel');
  return !!panel?.textContent.includes('local dormant') &&
    [...panel.querySelectorAll('button')].some(button =>
      button.textContent === 'Disable' && !button.disabled);
})()`;
export type RestorationReceipt = {
  failed: boolean;
  checks: string[];
  approvals: number;
  quit: "joined" | "unsettled";
  ptys: { pid: number; exited: boolean }[];
  backends: { pid: number; closed: boolean }[];
  sourcePreserved: boolean;
  freshOutput: boolean;
  verifiedPanes: number;
  fallbackNotice: boolean;
};
export function assertRestorationReceipt(
  value: unknown,
): asserts value is RestorationReceipt {
  assert.ok(value && typeof value === "object");
  const receipt = value as RestorationReceipt;
  assert.equal(receipt.failed, false);
  assert.deepEqual(receipt.checks, RESTORATION_CHECKS);
  assert.equal(receipt.approvals, 1);
  assert.equal(receipt.quit, "joined");
  assert.equal(receipt.sourcePreserved, true);
  assert.equal(receipt.freshOutput, true);
  assert.equal(receipt.fallbackNotice, true);
  assert.equal(receipt.verifiedPanes, 4);
  assert.equal(receipt.ptys.length, 8);
  assert.equal(new Set(receipt.ptys.map((pty) => pty.pid)).size, 8);
  assert.ok(
    receipt.ptys.every(
      (pty) => Number.isSafeInteger(pty.pid) && pty.pid > 0 && pty.exited,
    ),
  );
  assert.equal(receipt.backends.length, 2);
  assert.ok(
    receipt.backends.every(
      (child) =>
        Number.isSafeInteger(child.pid) && child.pid > 0 && child.closed,
    ),
  );
}
