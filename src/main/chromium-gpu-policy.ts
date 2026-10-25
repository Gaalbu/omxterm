import type { CommandLine } from "electron";

// Permit Chromium's SwiftShader WebGL fallback on Linux when available;
// do not force software rendering or bypass the GPU blocklist. Apply before
// readiness/backend creation. This accepts lower JIT security guarantees,
// including for untrusted terminal data and workloads (ADR 0037).
export function applyChromiumGpuPolicy(
  commandLine: Pick<CommandLine, "appendSwitch">,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "linux")
    commandLine.appendSwitch("enable-unsafe-swiftshader");
}
