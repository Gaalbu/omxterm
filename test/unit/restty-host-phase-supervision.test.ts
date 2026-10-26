import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNativeFixture } from "../fixtures/run-native-fixture";

it(
  "retains the entered host phase when the real supervisor terminates a stalled existing inner wait",
  { timeout: 15_000 },
  async (testContext) => {
    const owned = await mkdtemp(
      path.join(tmpdir(), "omxterm-phase-supervision-"),
    );
    const root = path.join(owned, "profile");
    const evidencePath = path.join(owned, "outcome.json");
    try {
      await mkdir(root);
      const result = await runNativeFixture({
        executable: process.execPath,
        args: [path.join(root, "main.cjs")],
        root,
        evidencePath,
        // Unit-control deadline only. The actual inner waiter remains 120 s;
        // the native host/oracle supervisors and source deadlines are untouched.
        timeout: 3_000,
        testContext,
        async prepare() {
          await build({
            stdin: {
              resolveDir: fileURLToPath(new URL("../..", import.meta.url)),
              contents: `
            import {app} from 'electron';
            import {EventEmitter} from 'node:events';
            import {initializeResttyHostWindow} from './test/fixtures/restty-host-window';
            import {createResttyHostSessions} from './test/fixtures/restty-host-sessions';
            const sessions=createResttyHostSessions({app, windows:()=>[], signals:process,
              spawn(){throw Error('No PTY in headless control')}, reportError: message=>process.stderr.write(message)});
            const window=Object.assign(new EventEmitter(), {
              async loadFile(){}, showInactive(){}, focus(){}, isFocused:()=>false,
              webContents:{executeJavaScript(){throw Error('DOM must not be reached')}}});
            void initializeResttyHostWindow(window, '/synthetic', ()=>true, sessions.waitFor)
              .then(()=>{throw Error('Stall unexpectedly completed')}).catch(error=>{process.stderr.write(String(error));process.exit(1)});
          `,
            },
            bundle: true,
            platform: "node",
            format: "cjs",
            logLevel: "silent",
            outfile: path.join(root, "main.cjs"),
            plugins: [
              {
                name: "headless-electron-port",
                setup(plugin) {
                  plugin.onResolve({ filter: /^electron$/ }, () => ({
                    path: "electron",
                    namespace: "headless-electron",
                  }));
                  plugin.onLoad(
                    { filter: /.*/, namespace: "headless-electron" },
                    () => ({
                      contents: `
              import {EventEmitter} from 'node:events';
              export const app=Object.assign(new EventEmitter(), {isActive:()=>true, exit:code=>process.exit(code)});
              export class BrowserWindow {}
            `,
                    }),
                  );
                },
              },
            ],
          });
        },
      });
      expect(result.reason).toBe("timeout");
      expect(result.cleanupErrors).toEqual([]);
      expect(result.stderr).toBe(""); // Outer deadline wins before inner error.
      const phases = result.stdout
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line.slice("__OMXTERM_RESTTY_HOST_PHASE__".length)) as {
              phase: string;
              status: string;
            },
        );
      expect(phases.map((p) => [p.phase, p.status])).toEqual([
        ["window-load", "begin"],
        ["window-load", "complete"],
        ["first-session", "begin"],
        ["first-session", "complete"],
        ["native-focus-request", "begin"],
        ["native-focus-request", "complete"],
        ["native-focus", "begin"],
      ]);
      const persisted = JSON.parse(await readFile(evidencePath, "utf8")) as {
        ownedProcesses: readonly unknown[];
      };
      expect(persisted.ownedProcesses.length).toBeGreaterThan(0);
      expect(persisted).toEqual(result);
      expect(existsSync(root)).toBe(false);
    } finally {
      // Never remove a profile that the real supervisor retained as uncertain.
      if (!existsSync(root)) await rm(owned, { recursive: true, force: true });
    }
  },
);
