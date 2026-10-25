import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFixture } from "../fixtures/window-chrome-build";
import { runNativeFixture } from "../fixtures/run-native-fixture";

const executable = createRequire(import.meta.url)("electron") as string;
const prefix = "__OMXTERM_POPUP_NATIVE__";

describe.skipIf(process.platform !== "linux")(
  "native terminal popup ownership with real PTYs",
  () => {
    it.for(["none", "close-retarget", "clipboard-retarget"])(
      "checks %s routing with settled native ownership",
      { timeout: 120_000 },
      async (control, context) => {
        context.signal.throwIfAborted();
        const root = await mkdtemp(
          path.join(tmpdir(), "omxterm-popup-native-"),
        );
        let supervised = false;
        try {
          context.signal.throwIfAborted();
          supervised = true;
          const execution = await runNativeFixture({
            executable,
            args: [
              "--no-sandbox",
              "--ozone-platform=x11",
              root,
              `--popup-control=${control}`,
            ],
            root,
            timeout: 90_000,
            testContext: context,
            prepare: () =>
              buildFixture(
                root,
                "runner",
                "test/fixtures/terminal-popup-native-main.ts",
              ),
          });
          expect(
            execution,
            `${execution.stdout}\n${execution.stderr}`,
          ).toMatchObject({
            exitCode: control === "none" ? 0 : 1,
            signal: null,
            reason: "exit",
            cleanupErrors: [],
          });
          if (control !== "none") {
            expect(execution.stdout).not.toContain(prefix);
            expect(execution.stderr).toContain(
              control === "close-retarget"
                ? "stale Close Pane must not inspect/confirm the surviving Busy child"
                : "source popup must not read clipboard after selected-window change",
            );
            return;
          }
          const results = execution.stdout
            .split("\n")
            .filter((line) => line.startsWith(prefix));
          expect(results).toHaveLength(1);
          expect(
            JSON.parse(results[0]!.slice(prefix.length)) as unknown,
          ).toEqual({
            realNativePopup: true,
            nativeActivationFocusedWindow: true,
            clickedChildPaste: true,
            nativeClipboardSelection: true,
            nullableRemappedLocalized: true,
            busySharedSlot: true,
            ordinaryExitStaleInert: true,
            selectedWindowChangeInert: true,
            survivorCanvasRetained: true,
            childCount: 4,
            screenshot: !!process.env.OMXTERM_POPUP_EVIDENCE_DIR,
            syntheticInput: true,
            physicalInput: false,
            confirmationAnswers:
              "fixture-controlled; native dialog widgets not exercised",
          });
        } finally {
          if (!supervised) await rm(root, { recursive: true, force: true });
        }
      },
    );
  },
);
