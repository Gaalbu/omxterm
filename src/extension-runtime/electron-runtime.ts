import { MessageChannelMain, utilityProcess } from "electron";
import path from "node:path";
import {
  InstalledPackages,
  createNativeLeaseAdapter,
  type PackageRuntime,
} from "../installed-packages/installed-packages.js";
import { ExtensionRuntime, type BackendProcess } from "./runtime.js";
export { ExtensionRuntime, type Backend, type Retirement } from "./runtime.js";
export { RuntimeError, type Value } from "./protocol.js";

/** Explicit helper-compatible user environment, not credential isolation. */
export function backendEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const allowed =
    /^(PATH|PATHEXT|HOME|USER|USERNAME|LOGNAME|SHELL|USERPROFILE|HOMEDRIVE|HOMEPATH|SYSTEMROOT|WINDIR|COMSPEC|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|TEMP|TMP|TMPDIR|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|COLORTERM|SSH_AUTH_SOCK|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_(CONFIG_HOME|DATA_HOME|STATE_HOME|CACHE_HOME|RUNTIME_DIR|SESSION_TYPE|CURRENT_DESKTOP))$/;
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && allowed.test(entry[0].toUpperCase()),
    ),
  );
}
function spawn(
  bootstrap: string,
  environment: Record<string, string>,
): BackendProcess {
  const { port1, port2 } = new MessageChannelMain();
  let process: Electron.UtilityProcess;
  try {
    process = utilityProcess.fork(bootstrap, [], {
      env: environment,
      execArgv: [],
      stdio: "ignore",
      serviceName: "OMXTerm extension backend",
    });
  } catch (error) {
    port1.close();
    port2.close();
    throw error;
  }
  // Queue a single app-owned connection. No extension-selected channel target.
  process.postMessage("omxterm-extension-connect-v1", [port2]);
  port1.start();
  return {
    send: (message) => port1.postMessage(message),
    close: () => port1.close(),
    kill: () => process.kill(),
    onMessage: (listener) => {
      port1.on("message", (event) => listener(event.data));
    },
    onClose: (listener) => {
      port1.on("close", listener);
    },
    onExit: (listener) => {
      process.once("exit", listener);
    },
  };
}
/** Called by an explicit internal owner after Electron ready, not app startup. */
export async function createUtilityExtensionRuntime(options: {
  root: string;
  runtime: PackageRuntime;
  addon: string;
  bootstrap: string;
  environment: NodeJS.ProcessEnv;
  owner: AbortSignal;
}): Promise<ExtensionRuntime> {
  if (!path.isAbsolute(options.bootstrap) || !path.isAbsolute(options.addon))
    throw new Error("invalid-runtime-artifact");
  const environment = backendEnvironment(options.environment);
  const packages = await InstalledPackages.open({
    root: options.root,
    runtime: options.runtime,
    leases: createNativeLeaseAdapter(options.addon),
  });
  return new ExtensionRuntime({
    packages,
    bootstrap: {
      root: options.root,
      runtime: options.runtime,
      addon: options.addon,
    },
    spawn: () => spawn(options.bootstrap, environment),
    owner: options.owner,
  });
}
