import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the same private interface awaited by the generated native actor.
// Only clock/timer I/O is controlled; proposal and ack files remain real.
const clock = vi.hoisted(() => ({
  now: 1_000,
  advance: undefined as undefined | (() => void),
}));
vi.mock("node:timers/promises", () => ({
  setTimeout() {
    if (!clock.advance) throw new Error("Unexpected acquisition timer");
    clock.advance();
    return Promise.resolve();
  },
}));
const { acquireWrapperControl } = await vi.importActual<{
  acquireWrapperControl(
    stem: string,
    control: string,
    deadline: number,
  ): Promise<void>;
}>("../../scripts/linux-wrapper-control.mjs");

let root: string;
let stem: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "omxterm-acquisition-clock-"));
  stem = path.join(root, "zero");
  clock.now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
});
afterEach(async () => {
  clock.advance = undefined;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function acknowledge(fault = "matching") {
  if (fault === "missing") return;
  const proposal = JSON.parse(
    readFileSync(`${stem}.proposal.json`, "utf8"),
  ) as {
    control: string;
    pid: number;
    start: string;
  };
  expect(proposal.control).toBe("zero");
  expect(proposal.pid).toBe(process.pid);
  expect(proposal.start).toMatch(/^\d+$/u);
  if (fault === "wrong-control") proposal.control = "signal";
  if (fault === "wrong-pid") proposal.pid += 1;
  if (fault === "wrong-start") proposal.start = "0";
  writeFileSync(`${stem}.acquired.json`, JSON.stringify(proposal));
}

describe.skipIf(process.platform !== "linux")(
  "Linux actor acknowledgement deadline",
  () => {
    it("permits the action continuation with an exact acknowledgement just before expiry", async () => {
      clock.advance = () => {
        clock.now = 1_099;
        clock.advance = undefined;
        acknowledge();
      };
      let acted = false;
      const pending = acquireWrapperControl(stem, "zero", 1_100).then(() => {
        acted = true;
      });
      await expect(pending).resolves.toBeUndefined();
      expect(acted).toBe(true);
    });

    it.each([1_100, 1_101])(
      "rejects an exact acknowledgement at expired time %i without permitting action",
      async (at) => {
        clock.advance = () => {
          clock.now = at;
          clock.advance = undefined;
          acknowledge();
        };
        let acted = false;
        const pending = acquireWrapperControl(stem, "zero", 1_100).then(() => {
          acted = true;
        });
        await expect(pending).rejects.toThrow(
          "Linux wrapper actor acquisition deadline exceeded",
        );
        expect(acted).toBe(false);
      },
    );

    it.each(["missing", "wrong-control", "wrong-pid", "wrong-start"])(
      "never permits action with %s acknowledgement before expiring",
      async (fault) => {
        clock.advance = () => {
          if (clock.now === 1_000) {
            clock.now = 1_099;
            acknowledge(fault);
          } else {
            clock.now = 1_100;
            clock.advance = undefined;
          }
        };
        let acted = false;
        const pending = acquireWrapperControl(stem, "zero", 1_100).then(() => {
          acted = true;
        });
        await expect(pending).rejects.toThrow(
          "Linux wrapper actor acquisition deadline exceeded",
        );
        expect(acted).toBe(false);
      },
    );
  },
);
