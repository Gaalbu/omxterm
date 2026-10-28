import { depthRenderingFixture } from "./restty-depth-renderer";

// This opt-in fixture reuses #317's real 1 -> 3 -> 1 rendering workload.
// It is never imported by the production application.
const fixture = depthRenderingFixture();
let retained: Uint8Array | undefined;
Object.assign(globalThis, {
  performanceFixture: {
    async phase(count: number, control: boolean) {
      if (control && !retained) {
        retained = new Uint8Array(128 * 1024 * 1024);
        retained.fill(42); // Commit physical pages, not just virtual capacity.
      }
      const result = await (await fixture).phase(count);
      if (document.visibilityState !== "visible")
        throw new Error("Performance fixture document is not visible");
      for (const surface of result.surfaces)
        if (
          surface.foregroundPixels <= 0 ||
          !surface.calls.drawArraysInstanced ||
          surface.renderError !== 0 ||
          surface.glError !== 0
        )
          throw new Error("Performance workload did not render correctly");
      return result;
    },
    controlCpu() {
      const end = performance.now() + 200;
      while (performance.now() < end) {
        // Deliberate fixture-only CPU cost, separately labelled in the report.
      }
      return retained?.[0];
    },
    async dispose() {
      (await fixture).dispose();
      retained = undefined;
    },
  },
});
