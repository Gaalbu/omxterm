import { fork } from "node:child_process";
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
  const child = fork(bootstrap, [], {
    execPath: process.execPath,
    execArgv: [],
    env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
    // Retain no extension stdout/stderr at all. IPC has separate bounded admission.
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
  });
  const failures = new Set<() => void>();
  child.on("error", () => {
    for (const listener of failures) listener();
  });
  return {
    send: (message) => {
      if (!child.connected) throw new Error("channel-closed");
      child.send(message, (error) => {
        if (error) for (const listener of failures) listener();
      });
    },
    disconnect: () => {
      if (child.connected) child.disconnect();
    },
    // Sole runtime owner/reaper, no stored PID or alternate signal authority.
    kill: () => child.kill("SIGKILL"),
    onMessage: (listener) => {
      child.on("message", listener);
    },
    onDisconnect: (listener) => {
      child.once("disconnect", listener);
    },
    onSpawn: (listener) => {
      child.once("spawn", listener);
    },
    onError: (listener) => {
      failures.add(listener);
    },
    onClose: (listener) => {
      child.once("close", listener);
    },
    onExit: (listener) => {
      child.once("exit", listener);
    },
  };
}
/** Constructed by an internal owner after Electron ready; does not activate code. */
export async function createExtensionRuntime(options: {
  root: string;
  runtime: PackageRuntime;
  addon: string;
  bootstrap: string;
  environment: NodeJS.ProcessEnv;
  owner: AbortSignal;
}): Promise<ExtensionRuntime> {
  if (process.type !== "browser" || !process.versions.electron)
    throw new Error("electron-main-required");
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
