# Linux x64 fixture corrections (#706)

Follow-up to the qualification report in #716. The first scope is the synthetic
architecture mismatch in `linux-desktop-launch` and `linux-installer-lifecycle`:
their `file` stub reports ARM aarch64 while the helper reads the real x64 host
through `uname`. The helper rejects the fixture before the intended assertions;
lifecycle cleanup then cannot find the actor registration.

Reproduce the existing failures first. Make synthetic host and image inspection
consistent, exercising both supported Linux architectures where practical.
Preserve the real helper, real GIO argument checks, TERM-resistant child, original
deadlines, cleanup ownership and negative assertions. No production architecture
validation should be weakened to accommodate a fixture.

Run focused installer/architecture suites, formatting, lint and typecheck. Report
which failures this fixes; the other #706 observations remain separate work.
Do not claim a clean portable gate or close #706 based on focused passes.

Implementation and validation are in progress. This planning commit alone does
not claim a fix or test pass.

## Implemented slice

Both integration suites now pair synthetic `uname` and `file` responses and run
for aarch64 and x86_64. The real installer, real GIO, lifecycle child, timeouts,
TERM assertions and cleanup checks are unchanged. No production code changed.

On Linux x64, the original two suites failed all six cases before the correction.
Afterward, their expanded matrix passed all 12 cases. Related installer and
architecture unit suites passed 51 tests. Repository lint, typecheck, targeted
Prettier and `git diff --check` passed. The complete portable gate has not been
rerun for this slice; the separately recorded failures remain unresolved.

## Retained native drag receipt

A second independent fixture correction preserves the exact acknowledged
pointer-down/move receipt through later release observation. Previously an
unrelated unpressed pointer move could replace the final `move`, even though the
matching trusted drag had already been acknowledged. Release validation and
native autoscroll assertions remain unchanged.

A new emitted-caller regression failed before the fix and passed afterward.
The focused run passed 20 acknowledgement cases, two native scrollback cases and
nine host-readiness cases (31 total). Lint, typecheck and targeted formatting
passed. The isolated host-readiness pass does not explain or clear the earlier
esbuild Go-runtime crash. Appearance, display-size and native-input prerequisites
remain under investigation.

## Acknowledged release identity

The mouse-up predicate now accepts a release only when that pointer id is the
acknowledged down and move. It no longer treats the latest `down` as the
gesture being released. The emitted receipt still restores the saved down and
move, so a later unpressed move cannot replace them, and it cannot pair those
saved fields with a different pointer's up. Native autoscroll assertions are
unchanged.

A headless emitted-caller probe delivered pointer 2 down and up at the release
point after the acknowledged gesture. Before this correction the oracle
accepted `down=1`, `move=1`, `up=2`. Afterward that case fails mouse-up as
stimulus-unavailable. The same-pointer unpressed-move case still passes. The
integration oracle also requires the emitted up id to match the emitted down.
