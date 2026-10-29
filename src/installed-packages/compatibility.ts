import { satisfies } from "semver";

/** The unchanged Files preview is explicitly supported by this SSH preview host. */
export function packageCompatible(
  manifest: {
    id: string;
    version: string;
    engines: { omxterm: string; api: string };
  },
  runtime: { appVersion: string; apiVersion: string },
): boolean {
  const unchangedFilesPreview =
    runtime.appVersion === "0.24.0-dev.0" &&
    manifest.id === "omxterm.files" &&
    manifest.version === "0.1.0" &&
    manifest.engines.omxterm === ">=0.23.0-dev.8 <0.24.0" &&
    manifest.engines.api === "0.1.x";
  return (
    (unchangedFilesPreview ||
      satisfies(runtime.appVersion, manifest.engines.omxterm)) &&
    satisfies(runtime.apiVersion, manifest.engines.api)
  );
}
