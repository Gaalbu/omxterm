import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HoverSnapshot } from "./restty-hover";
import type { HoverPixels } from "./restty-hover-evidence";

export interface HoverBitmap {
  readonly bitmap: Buffer;
  readonly width: number;
  readonly height: number;
}
export interface HoverFailureDestination {
  readonly directory: string;
  readonly sourceDirectory: string;
  readonly sourceCommit: string;
}

// Only the synthetic early-capture control supplies this destination. Retain
// exactly the two buffers already inspected, never request another native image.
export async function retainHoverFailure(
  destination: HoverFailureDestination,
  baseline: HoverBitmap,
  modified: HoverBitmap,
  pixels: HoverPixels,
  snapshots: {
    before: HoverSnapshot | undefined;
    after: HoverSnapshot | undefined;
    stimulus: HoverSnapshot | undefined;
  },
): Promise<void> {
  let status = "write-failed";
  try {
    for (const image of [baseline, modified]) {
      if (
        !Number.isSafeInteger(image.width) ||
        !Number.isSafeInteger(image.height) ||
        image.width <= 0 ||
        image.height <= 0 ||
        image.bitmap.length !== image.width * image.height * 4 ||
        image.bitmap.length > 32 * 1024 * 1024
      )
        throw new Error("Hover evidence exceeds bitmap bounds");
    }
    // A unique runner-owned sibling of the supervisor receipt, not its profile.
    // Refuse reuse; a partially written directory remains available to its owner.
    await mkdir(path.dirname(destination.directory), { recursive: true });
    await mkdir(destination.directory, { mode: 0o700 });
    const source: Record<string, string> = {};
    for (const file of ["main.cjs", "preload.cjs", "renderer/index.js"]) {
      source[file] = createHash("sha256")
        .update(await readFile(path.join(destination.sourceDirectory, file)))
        .digest("hex");
    }
    await writeFile(
      path.join(destination.directory, "metadata.json"),
      JSON.stringify({
        version: 1,
        sourceCommit: destination.sourceCommit,
        sourceBundleSha256: source,
        control: "early-capture",
        phase: "modified",
        category: "cue-not-drawn",
        format: "BGRA",
        baseline: { width: baseline.width, height: baseline.height },
        modified: { width: modified.width, height: modified.height },
        pixels,
        snapshots: Object.fromEntries(
          Object.entries(snapshots).map(([key, value]) => [
            key,
            value && {
              canvasId: value.canvasId,
              geometry: value.geometry,
              draw: value.draw,
            },
          ]),
        ),
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    for (const [name, image] of [
      ["baseline", baseline],
      ["modified", modified],
    ] as const)
      await writeFile(
        path.join(destination.directory, `${name}.bgra`),
        image.bitmap,
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    status = "retained";
  } catch {
    // Diagnostic I/O must never replace the original draw failure or prevent
    // the control's existing finally block from releasing its held callback.
  }
  try {
    process.stdout.write(
      "__OMXTERM_HOVER_FAILURE__" + JSON.stringify({ status }) + "\n",
    );
  } catch {
    // A closed diagnostic stream cannot replace the original failure either.
  }
}
