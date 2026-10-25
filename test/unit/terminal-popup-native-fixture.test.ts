import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildFixture } from "../fixtures/window-chrome-build";
import {
  POPUP_READY,
  popupLaunchRequest,
  popupPtyObservation,
} from "../fixtures/terminal-popup-native-pty";

it("observes child readiness and exact input bytes across native output chunks", () => {
  const observation = popupPtyObservation();
  observation.observe(
    `${POPUP_READY}\r\nsynthetic-popup-selection\r\n__POPUP_IN`,
  );
  expect(observation.ready()).toBe(true);
  expect(observation.input()).toBe("");
  observation.observe(
    "PUT__6e61746976652d7061737465\n__POPUP_INPUT__1b5b3230307e\n",
  );
  expect(observation.input()).toBe("native-paste\u001b[200~");
});
it("rejects malformed or excessive child reports rather than weakening the oracle", () => {
  expect(() => popupPtyObservation().observe("__POPUP_INPUT__0\n")).toThrow();
  expect(() =>
    popupPtyObservation().observe("__POPUP_INPUT__not-hex\n"),
  ).toThrow();
  expect(() => popupPtyObservation().observe("x".repeat(65_537))).toThrow(
    "fixture budget",
  );
  expect(() =>
    popupPtyObservation().observe(
      "__POPUP_INPUT__" + "00".repeat(16_385) + "\n",
    ),
  ).toThrow("fixture budget");
  const launch = popupLaunchRequest();
  expect(launch.kind).toBe("explicit-command");
  if (launch.kind !== "explicit-command")
    throw new Error("Expected direct child");
  expect(launch.executable).toBe("/usr/bin/python3");
  expect(launch.arguments.slice(0, 2)).toEqual(["-u", "-c"]);
  expect(launch.arguments).toHaveLength(3);
});
it("builds the actual popup native entry with production renderer/preload without opening a window", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omxterm-popup-build-"));
  try {
    await buildFixture(
      root,
      "recipe",
      "test/fixtures/terminal-popup-native-main.ts",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
