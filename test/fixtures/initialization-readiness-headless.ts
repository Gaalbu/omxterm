import type { BuildOptions } from "esbuild";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { buildFixture } from "./initialization-cancellation-build";
import { terminalIpc } from "../../src/shared/terminal-ipc";
import { terminalRendererConfiguration } from "../../src/main/active-user-configuration";
import { DEFAULT_USER_CONFIGURATION } from "../../src/main/user-configuration";
import type { TerminalTabCommand } from "../../src/shared/terminal-contract";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html: string,
    options: { url: string; runScripts: "outside-only" },
  ) => { window: Window & typeof globalThis };
};

// The recipe and its importer hooks remain real. Replace only the GPU Surface
// behind the cancellation wrapper, holding A's return AFTER its Adapter start.
export function headlessInitializationSurface(
  options: BuildOptions,
): BuildOptions {
  return {
    ...options,
    plugins: [
      ...(options.plugins ?? []),
      {
        name: "headless-initialization-surface",
        setup(plugin) {
          plugin.onResolve({ filter: /restty-terminal-surface$/ }, (args) => {
            if (
              args.importer ===
                path.join(
                  process.cwd(),
                  "test/fixtures/initialization-cancellation-surface.ts",
                ) ||
              args.importer ===
                path.join(
                  process.cwd(),
                  "src/renderer/start-terminal-window.ts",
                )
            )
              return { path: "surface", namespace: "initialization-port" };
            return undefined;
          });
          plugin.onLoad(
            { filter: /^surface$/, namespace: "initialization-port" },
            () => ({
              loader: "js",
              contents: `export async function mountResttyTerminalSurface(container, adapter) {
              const first = ++globalThis.surfacePort.mounts === 1;
              await adapter.start({onOutput(){},onExit(){}});
              if(first) { globalThis.surfacePort.held = true; await globalThis.surfacePort.gate; }
              return {geometry(){},focus(){},dispose(){adapter.close()},
                applyConfiguration(){globalThis.surfacePort.adoptions++},applyTheme(){},zoom(){},
                copy(){},paste(){},selectAll(){},find(){},inject(){}};
            }`,
            }),
          );
        },
      },
    ],
  };
}

export async function initializationReadinessScene(
  boundary: "fonts" | "runtime" = "runtime",
  holdHostRegistration = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "omxterm-init-ready-"));
  let setupWindow: (Window & typeof globalThis) | undefined;
  try {
    await buildFixture(root);
    const dom = new JSDOM(await readFile("src/renderer/index.html", "utf8"), {
      url: `https://fixture.invalid/?boundary=${boundary}${holdHostRegistration ? "&holdHostRegistration" : ""}`,
      runScripts: "outside-only",
    });
    const window = dom.window;
    setupWindow = window;
    Object.defineProperty(window.document, "hasFocus", { value: () => true });
    Object.defineProperty(window.Uint8Array, "fromBase64", {
      value: (text: string) =>
        new window.Uint8Array(Buffer.from(text, "base64")),
    });
    const ipc = new EventEmitter();
    let starts = 0;
    let selected: unknown;
    // Run the actual emitted isolated preload, including validation, listener
    // installation/removal and contextBridge exposure. Only Electron transport is
    // adapted; no hand-built onTabCommand bridge substitutes for the preload.
    runInNewContext(await readFile(path.join(root, "preload.cjs"), "utf8"), {
      TextEncoder,
      TextDecoder,
      process: { platform: process.platform },
      require(name: string) {
        if (name !== "electron")
          throw new Error(`Unexpected preload import: ${name}`);
        return {
          contextBridge: {
            exposeInMainWorld(key: string, value: unknown) {
              Object.assign(window, { [key]: value });
            },
          },
          webUtils: {},
          ipcRenderer: {
            on: ipc.on.bind(ipc),
            removeListener: ipc.removeListener.bind(ipc),
            send(channel: string, payload: unknown) {
              if (channel === terminalIpc.tabSelected) selected = payload;
            },
            async invoke(channel: string) {
              if (channel === terminalIpc.configuration)
                return terminalRendererConfiguration(
                  {
                    configuration: DEFAULT_USER_CONFIGURATION,
                    userFileErrors: [],
                  },
                  0,
                );
              if (channel === terminalIpc.start) return `s${++starts}`;
              throw new Error(`Unexpected preload request: ${channel}`);
            },
          },
        };
      },
    });
    let release!: () => void;
    const surfacePort = {
      mounts: 0,
      adoptions: 0,
      held: false,
      gate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    Object.assign(window, { surfacePort });
    window.eval(await readFile(path.join(root, "renderer/index.js"), "utf8"));
    return {
      surfacePort,
      get starts() {
        return starts;
      },
      get selected() {
        return selected;
      },
      get listeners() {
        return ipc.listenerCount(terminalIpc.tabCommand);
      },
      release,
      releaseRegistration() {
        window.eval("globalThis.__omxtermInitializationHost.release()");
      },
      send(command: TerminalTabCommand) {
        ipc.emit(terminalIpc.tabCommand, {}, command);
      },
      // Independent arrival receipt deliberately bypasses the readiness wrapper.
      observeArrival(listener: () => void) {
        ipc.on(terminalIpc.tabCommand, listener);
        return () => ipc.removeListener(terminalIpc.tabCommand, listener);
      },
      renderer: {
        async executeJavaScript(script: string) {
          return window.eval(script) as unknown;
        },
      },
      pagehide() {
        window.dispatchEvent(new window.Event("pagehide"));
      },
      async dispose() {
        window.dispatchEvent(new window.Event("pagehide"));
        release();
        dom.window.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (setupWindow) {
      setupWindow.dispatchEvent(new setupWindow.Event("pagehide"));
      setupWindow.close();
    }
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
