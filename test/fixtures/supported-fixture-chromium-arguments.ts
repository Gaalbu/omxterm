import { applyChromiumSandboxPolicy } from "../../src/main/chromium-sandbox-policy";

// Custom Surface/host mains bypass production startup. Select the supported
// Linux backend before Electron bootstrap, not through a late appendSwitch.
// Production-entry fixtures use the bootstrap sandbox policy below but leave
// display selection/relaunch to production main.
export function productionFixtureArguments(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const args: string[] = [];
  applyChromiumSandboxPolicy(
    { appendSwitch: (name) => args.push(`--${name}`) },
    platform,
  );
  return [...args, root];
}

export function supportedFixtureChromiumArguments(
  platform: NodeJS.Platform = process.platform,
): string[] {
  const args: string[] = [];
  applyChromiumSandboxPolicy(
    { appendSwitch: (name) => args.push(`--${name}`) },
    platform,
  );
  if (platform === "linux") args.push("--ozone-platform=x11");
  return args;
}
