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
