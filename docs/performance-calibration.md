# Initial Surface performance calibration — #705

**Result: useful large-cost sensitivity; reporting only, not a small-regression
threshold.** Nine serial native executions completed with exit 0, empty stderr
and no supervisor cleanup errors. No product performance change was measured.

## Provenance and reproduction

Measured source: `eb1dfaf698167fa05f7f00e6ff3159fd9f3b24d6`, tree
`9c4e7a2736ea50ebb12b4b329d31be6f55db5650`, on 2026-10-28. All three sets use
identical source, dependency lock, fixture and compiled bundle hashes. The only
selected difference is the explicit fixture-only `control` argument. Later
report/documentation commits are not relabelled as measured executions.

Raw results (unaltered measurements, formatting only):
[baseline](evidence/performance-705/baseline.json),
[unchanged-source repeat](evidence/performance-705/repeat.json),
[positive control](evidence/performance-705/control.json).
Regenerate both complete per-process reports without launching Electron:

```sh
mkdir -p .scratch
node scripts/performance/compare.mjs \
  docs/evidence/performance-705/baseline.json \
  docs/evidence/performance-705/repeat.json .scratch/calibration-noise
node scripts/performance/compare.mjs \
  docs/evidence/performance-705/baseline.json \
  docs/evidence/performance-705/control.json .scratch/calibration-sensitivity
```

For fresh native measurements, follow the [workflow](performance-baseline.md).
The order here was baseline normal ×3, repeat normal ×3, then control ×3, each in
a new process/profile. No retries or discarded repetitions. Installation,
static checks and build finished before the first measurement. The assigned
desktop was active/unlocked and no other graphical test was running. This does
not establish isolation from hypervisor contention, thermals or cache-order
effects. Guest one-minute load averages at each run's end ranged 0.67–0.96;
these include the fixture itself and are not continuous host-load measurements.

Environment: Ubuntu 26.04.1 LTS ARM64, kernel `7.0.0-38-generic`, four logical CPUs,
15.07 GiB guest memory; CPU model reported `unknown`. Build Node `22.22.1`,
Electron `43.8.1`, Chromium `150.0.7871.250`, Electron Node `24.22.0`. X11 through
XWayland, DPR 1, 800×500 content. Actual WebGL reports
`ANGLE (Mesa, virgl (Apple M4 Max (Compat)), OpenGL 4.0)`. Basic GPU metadata is
preserved verbatim even where it reports `gl=none,angle=none`; that field is not
substituted for the actual WebGL context renderer. Exact runtime/bundle hashes
and individual process identity/counters remain in each raw result.

The reused 1→3→1 fixture rendered all five Surface observations per repetition:
800×500 for one/closed and 800×479 for the three-tab phase. All 45 observations
had nonzero real draws, zero GL/render errors and matching corresponding text
pixel hashes across the nine executions. Foreground counts were 17,798 at
one/closed and 16,620 per Surface at three. Every final close-state array was
`[false, true, true]`. Natural allocation/GC/driver behavior remained enabled;
no forced GC or deliberate renderer suspension was used.

## Memory-first result

Renderer working-set MiB: median of three repetition summaries, with each
repetition using the median of its three post-workload samples. Brackets are
observed repetition min–max, **not confidence intervals**.

| Phase  |               Baseline |       Unchanged repeat |       Positive control | Control minus baseline median |
| ------ | ---------------------: | ---------------------: | ---------------------: | ----------------------------: |
| One    | 179.32 [179.16–186.55] | 180.09 [180.02–180.77] | 309.58 [308.98–312.26] |                   +130.26 MiB |
| Three  | 199.97 [193.01–203.06] | 193.79 [193.62–194.50] | 329.31 [328.48–329.52] |                   +129.34 MiB |
| Closed | 194.45 [190.82–197.45] | 194.85 [193.75–202.54] | 334.39 [331.41–334.52] |                   +139.93 MiB |

The normal ranges overlap in every renderer memory phase. The touched/retained
128 MiB control is clearly separated in every phase, including after closing
back to one Surface. Its measured delta is not exactly 128 MiB: natural heaps,
readback buffers and reclamation timing still vary. The closed normal range
also remains above its initial one-tab range; one bounded lifecycle cannot
distinguish caches/high-water marks from long-term growth and does not establish
a leak. No total application, native-font, GPU-allocation or RAM-saving claim
follows from these process working sets.

## CPU and noise

Renderer post-workload CPU, one core = 100%:

| Phase  | Baseline median [range] | Unchanged repeat median [range] | Control median [range] |
| ------ | ----------------------: | ------------------------------: | ---------------------: |
| One    |       4.53% [4.32–5.29] |               4.62% [3.96–5.57] |   20.02% [19.99–20.81] |
| Three  |       3.91% [3.90–4.32] |               4.30% [3.90–4.63] |   20.39% [20.04–20.50] |
| Closed |       4.50% [3.44–4.54] |               4.94% [4.62–5.27] |   18.87% [18.60–19.29] |

The injected 200ms busy work per nominal interval separates from normal ranges
in all phases: median increases 15.48, 16.48 and 14.37 percentage points. The
control interval is about 1.2s, not 1s; actual elapsed time is the denominator.
It also changes scheduling, so it is not an independent GPU-cost experiment.
Workload CPU includes readback/hash/lifecycle and has coarse counters: short
Browser/GPU phases often measured zero, while renderer workload values ranged
0.02–0.10 CPU seconds across all sets. This does not calibrate throughput or
physical presentation latency.

**Four of 27 normal-versus-normal rows have separated ranges despite unchanged
source:** Browser working set at one (+0.375 MiB) and three (+0.438 MiB), renderer
closed CPU (+0.439 percentage points), and GPU closed CPU (−0.290 points).
These are observed run-to-run differences, not product regressions. Twenty-three
rows overlap. Therefore range separation alone is too sensitive for automatic
pass/fail: inspect magnitude alongside this noise record and the relevant source
change before choosing a focused attribution experiment. Do not turn the largest
observed normal difference into a universal budget or silently refresh away a
cost. No small-regression detection limit or false-positive rate is established
by this single ordered calibration session.

This satisfies the initial reporting-stage sensitivity objective for a
substantial persistent memory/CPU cost. Small effects, different machines,
runtimes, native fonts, real PTYs, extensions and full application startup need
their own justified measurements. The documented review and baseline-update
policy remains mandatory: preserve old results and explain accepted benefit/cost
tradeoffs rather than treating every separated range as feature rejection.

## Verification and review

At the measured SHA: clean locked install/preparation; full format check,
type-aware lint (767 files, zero warnings/errors), typecheck, four focused
headless comparator tests and unpackaged build passed. Nine real native
measurement executions and both comparisons completed successfully. Raw samples,
source hashes, close states and all nine native settlement receipts were checked
before this report; execution receipts remain private because they can contain
local paths. The install reported the existing one high dependency advisory;
no dependency change or advisory resolution is claimed here.

Independent review covered base `4709dc62f6f08725cda3164a27153ae2b33508d1` through
`d45bb5aa875f05071dd19ef770a6756ecebf8f17`. All four correctness findings were
accepted and corrected at the measured SHA: reject malformed observations,
require continuous process identity across phases, await warm-fixture readiness
before CPU sampling, and use weak canvas keys so instrumentation does not retain
closed Surfaces. The outstanding native-evidence finding is resolved by this
calibration. Later documentation/evidence is author-checked, not represented as
part of the earlier independent pass.

The broad `check:portable` default graphical suite, packaging, macOS and Windows
native qualification were not run for this bounded diagnostic-only change. No
production source, dependency, application version or release artifact changed.
