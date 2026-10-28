import { expect, it } from "vitest";
import { compare, markdown } from "../../scripts/performance/compare.mjs";

function report(extraMemory = 0, extraCpu = 0) {
  const hashes = Object.fromEntries(
    [
      "scripts/performance/run.mjs",
      "scripts/performance/main.cjs",
      "test/fixtures/performance-renderer.ts",
      "test/fixtures/restty-depth-renderer.ts",
      "test/fixtures/restty-hidden-session.ts",
      "test/fixtures/restty-hidden-presentation.ts",
    ].map((file) => [file, "fixture-hash"]),
  );
  return {
    schema: 1,
    source: "a".repeat(40),
    environment: "controlled-machine",
    mode: "normal",
    hashes,
    protocol: "surface-1-3-1-v1",
    repetitions: 3,
    runs: [0, 1, 2].map((trial) => {
      const snapshot = (timeMs) => ({
        timeMs,
        processes: ["Browser", "Tab", "GPU"].map((type, index) => ({
          pid: index + 1,
          creationTime: 1,
          type,
          workingSetKiB:
            (100 + trial + (type === "Tab" ? extraMemory : 0)) * 1024,
          cpuSeconds:
            (timeMs / 1000) * (0.01 + (type === "Tab" ? extraCpu : 0)),
        })),
      });
      return {
        platform: "linux",
        arch: "arm64",
        release: "controlled",
        versions: { electron: "test" },
        cpu: "controlled",
        logicalCpus: 4,
        totalMemoryBytes: 1024,
        gpu: {},
        contentBounds: { width: 800, height: 500 },
        phases: ["one", "three", "closed"].map((name) => ({
          name,
          rendering: {
            surfaces: [
              { width: 800, height: 500, dpr: 1, renderer: "controlled" },
            ],
          },
          before: snapshot(0),
          samples: [100, 1100, 2100, 3100].map(snapshot),
        })),
      };
    }),
  };
}

it("reports ordinary spread separately from a retained-memory and CPU cost", () => {
  const normal = compare(report(), report());
  expect(normal.comparable).toBe(true);
  expect(
    normal.rows.every((row) => row.signal === "overlapping observed ranges"),
  ).toBe(true);
  const control = report(128, 0.2);
  control.mode = "control";
  const changed = compare(report(), control);
  expect(changed.calibration).toBe(true);
  expect(
    changed.rows.find((row) => row.metric === "closed/Tab/workingSetMiB"),
  ).toMatchObject({ delta: 128, signal: "higher, separated observed ranges" });
  expect(
    changed.rows.find((row) => row.metric === "one/Tab/idleCpuPercentOneCore")
      .delta,
  ).toBeCloseTo(20);
  expect(markdown(changed)).toContain("not confidence intervals");
});

it("refuses cross-environment, geometry, runtime and fixture comparisons", () => {
  for (const mutate of [
    (value) => {
      value.environment = "other-machine";
    },
    (value) => {
      value.runs[1].contentBounds.width++;
    },
    (value) => {
      value.runs[2].versions.electron = "different";
    },
    (value) => {
      value.hashes["scripts/performance/main.cjs"] = "different";
    },
  ]) {
    const candidate = report();
    mutate(candidate);
    expect(compare(report(), candidate).comparable).toBe(false);
  }
});

it("refuses incomplete, unavailable or restarted process measurements", () => {
  for (const mutate of [
    (value) => {
      value.runs.pop();
    },
    (value) => {
      value.runs[0].phases[0].samples[2].processes[1].pid++;
    },
    (value) => {
      value.runs[0].phases[0].samples[2].processes[1].workingSetKiB = 0;
    },
    (value) => {
      value.runs[0].phases[0].samples.pop();
    },
  ]) {
    const candidate = report();
    mutate(candidate);
    const result = compare(report(), candidate);
    expect(result.comparable).toBe(false);
    expect(markdown(result)).toContain("NON-COMPARABLE");
  }
});
