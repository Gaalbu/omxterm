import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const range = (values) => ({
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
});
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fixtureFiles = [
  "scripts/performance/run.mjs",
  "scripts/performance/main.cjs",
  "test/fixtures/performance-renderer.ts",
  "test/fixtures/restty-depth-renderer.ts",
  "test/fixtures/restty-hidden-session.ts",
  "test/fixtures/restty-hidden-presentation.ts",
];

function signature(report, run) {
  return {
    environment: report.environment,
    buildNode: report.buildNode,
    electronSha256: report.electronSha256,
    protocol: report.protocol,
    fixture: fixtureFiles.map((file) => report.hashes[file]),
    platform: run.platform,
    arch: run.arch,
    release: run.release,
    versions: run.versions,
    cpu: run.cpu,
    logicalCpus: run.logicalCpus,
    totalMemoryBytes: run.totalMemoryBytes,
    gpu: run.gpu,
    contentSize: [run.contentBounds.width, run.contentBounds.height],
    geometry: run.phases.map((phase) =>
      phase.rendering.surfaces.map((surface) => [
        surface.width,
        surface.height,
        surface.dpr,
        surface.renderer,
      ]),
    ),
  };
}

function metrics(run) {
  if (
    !equal(
      run.phases.map((phase) => phase.name),
      ["one", "three", "closed"],
    )
  )
    throw new Error("Expected one, three, closed phases in order");
  const result = {};
  const identities = new Map();
  for (const phase of run.phases) {
    if (phase.samples.length !== 4)
      throw new Error("Expected four phase snapshots");
    const snapshots = [phase.before, ...phase.samples];
    if (
      snapshots.some(
        (sample, index) =>
          !Number.isFinite(sample.timeMs) ||
          (index > 0 && sample.timeMs <= snapshots[index - 1].timeMs),
      )
    )
      throw new Error("Invalid snapshot times");
    const initial = phase.samples[0];
    const final = phase.samples.at(-1);
    const duration = (final.timeMs - initial.timeMs) / 1000;
    if (!(duration > 0)) throw new Error("Invalid sampling duration");
    for (const role of ["Browser", "Tab", "GPU"]) {
      const rows = snapshots.map((sample) =>
        sample.processes.filter((row) => row.type === role),
      );
      if (rows.some((row) => row.length !== 1))
        throw new Error(`Expected exactly one ${role} process`);
      const all = rows.map((row) => row[0]);
      const identity = identities.get(role) ?? [
        all[0].pid,
        all[0].creationTime,
      ];
      identities.set(role, identity);
      if (
        all.some(
          (row) =>
            !Number.isSafeInteger(row.pid) ||
            row.pid <= 0 ||
            !Number.isFinite(row.creationTime) ||
            !equal([row.pid, row.creationTime], identity),
        )
      )
        throw new Error(`Process changed during repetition: ${role}`);
      for (const [index, row] of all.entries())
        if (
          !Number.isFinite(row.workingSetKiB) ||
          row.workingSetKiB <= 0 ||
          !Number.isFinite(row.cpuSeconds) ||
          row.cpuSeconds < 0 ||
          (index > 0 && row.cpuSeconds < all[index - 1].cpuSeconds)
        )
          throw new Error("Unavailable or decreasing memory/CPU metric");
      const processes = all.slice(1);
      const cpu = processes.at(-1).cpuSeconds - processes[0].cpuSeconds;
      if (cpu < 0) throw new Error("CPU counter decreased");
      result[`${phase.name}/${role}/workingSetMiB`] = median(
        processes.slice(1).map((row) => row.workingSetKiB / 1024),
      );
      result[`${phase.name}/${role}/idleCpuPercentOneCore`] =
        (100 * cpu) / duration;
      result[`${phase.name}/${role}/workloadCpuSeconds`] =
        processes[0].cpuSeconds - all[0].cpuSeconds;
    }
  }
  return result;
}

export function compare(baseline, candidate) {
  try {
    const reasons = [];
    for (const report of [baseline, candidate]) {
      if (
        report.schema !== 1 ||
        report.protocol !== "surface-1-3-1-v1" ||
        report.repetitions !== 3 ||
        report.runs?.length !== 3
      )
        reasons.push(
          "Incomplete or unsupported report (three settled repetitions required)",
        );
      if (!/^[a-f0-9]{40}$/u.test(report.source ?? ""))
        reasons.push("Missing exact source identity");
      if (
        !report.environment ||
        fixtureFiles.some((file) => !report.hashes?.[file])
      )
        reasons.push("Missing environment/fixture provenance");
    }
    if (reasons.length) return { comparable: false, reasons, rows: [] };
    const reference = signature(baseline, baseline.runs[0]);
    for (const report of [baseline, candidate])
      for (const run of report.runs)
        if (!equal(reference, signature(report, run)))
          reasons.push(
            "Environment, runtime, fixture, GPU or geometry differs (including within a run set)",
          );
    if (reasons.length)
      return { comparable: false, reasons: [...new Set(reasons)], rows: [] };
    const before = baseline.runs.map(metrics);
    const after = candidate.runs.map(metrics);
    if (!equal(Object.keys(before[0]), Object.keys(after[0])))
      throw new Error("Scenario metrics differ");
    const rows = Object.keys(before[0]).map((metric) => {
      const a = range(before.map((run) => run[metric]));
      const b = range(after.map((run) => run[metric]));
      return {
        metric,
        baseline: a,
        candidate: b,
        delta: b.median - a.median,
        percent:
          a.median === 0 ? null : (100 * (b.median - a.median)) / a.median,
        signal:
          b.min > a.max
            ? "higher, separated observed ranges"
            : b.max < a.min
              ? "lower, separated observed ranges"
              : "overlapping observed ranges",
      };
    });
    return {
      comparable: true,
      calibration: baseline.mode !== "normal" || candidate.mode !== "normal",
      baselineSource: baseline.source,
      candidateSource: candidate.source,
      dependencyChanged:
        baseline.hashes["package-lock.json"] !==
        candidate.hashes["package-lock.json"],
      rows,
    };
  } catch (error) {
    return { comparable: false, reasons: [error.message], rows: [] };
  }
}

export function markdown(result) {
  if (!result.comparable)
    return `# Performance comparison: NON-COMPARABLE\n\n${result.reasons.map((reason) => `- ${reason}`).join("\n")}\n`;
  return `# Performance comparison${result.calibration ? " (positive-control calibration)" : ""}\n\nBaseline: ${result.baselineSource}\nCandidate: ${result.candidateSource}\nDependency lock changed: ${result.dependencyChanged}\n\nReporting only. Ranges are min–max of three repetition summaries, not confidence intervals. Separated ranges prompt investigation; overlapping ranges do not establish equivalence. CPU uses one core = 100%. Memory domains/processes are not summed.\n\n| Metric | Baseline median [range] | Candidate median [range] | Delta | Observation |\n| --- | ---: | ---: | ---: | --- |\n${result.rows.map((row) => `| ${row.metric} | ${row.baseline.median.toFixed(3)} [${row.baseline.min.toFixed(3)}, ${row.baseline.max.toFixed(3)}] | ${row.candidate.median.toFixed(3)} [${row.candidate.min.toFixed(3)}, ${row.candidate.max.toFixed(3)}] | ${row.delta.toFixed(3)} | ${row.signal} |`).join("\n")}\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [a, b, destination] = process.argv.slice(2);
  if (!a || !b || !destination)
    throw new Error(
      "Usage: node scripts/performance/compare.mjs BASELINE.json CANDIDATE.json NEW_REPORT_PREFIX",
    );
  const result = compare(
    JSON.parse(await readFile(a, "utf8")),
    JSON.parse(await readFile(b, "utf8")),
  );
  await writeFile(
    `${destination}.json`,
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
  await writeFile(`${destination}.md`, markdown(result), { flag: "wx" });
  console.log(
    result.comparable
      ? "Comparison recorded (reporting only)"
      : "NON-COMPARABLE: inspect report",
  );
  if (!result.comparable) process.exitCode = 2;
}
