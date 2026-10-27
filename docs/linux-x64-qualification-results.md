# Linux x64 qualification: partial results (#706)

Reported by [@Gaalbu](https://github.com/Gaalbu) on 2026-10-27 in
[PR #714](https://github.com/luizomf/omxterm/pull/714). This is contributor-reported
bounded evidence, not a maintainer reproduction, complete desktop or installer
qualification, or a new release gate.

## Published artifact

- Release: v0.22.0; annotated tag resolves to source commit
  `933156e929aa890cf3853aa52d2c52aafd8c7c0e`.
- Artifact build source: `2327043305e7101e45fb572727a8994d3fbf15c3`, from the
  [hosted build](https://github.com/luizomf/omxterm/actions/runs/40198230904)
  recorded in #706. The release-tag target is distinct from this build input.
- AppImage: `OMXTerm-0.22.0-x64.AppImage`, SHA-256
  `150ad9a0ca834137574bfde9009df20cf6baba724c8bc76b224d29fc2f2ba927`.
- Matching `linux_install.sh`: SHA-256
  `8fd28b00d2854325dae7f5cc988c8a44e9d77157382f1a79f989bd0115d834c4`;
  reports version 0.22.0.
- Both published checksum files verified. AppImage inspected as x86-64 ELF.

Environment: native x86_64 Linux, kernel 7.0.0-38-generic, glibc 2.43,
Wayland session with XWayland. `/dev/fuse` available. No existing OMXTerm
installation or configuration was found at the documented per-user paths.

The exact AppImage launched directly with an isolated configuration/cache and
`--remote-debugging-port=0`. No graphics compatibility flag or extracted payload
was substituted. The initial launcher exited 0 while the application continued;
the first observer incorrectly treated launcher exit as application exit. That
failed observation was retained. The existing instance was then observed through
its profile's DevTools endpoint, without relaunching it.

Through CDP mouse/text/key events, a synthetic shell command executed, displayed
`OMX706_INPUT_OK`, and wrote the exact expected marker to an isolated file. The
rendered output was captured and visually inspected. This proves synthetic
interactive input/output, not physical keyboard/HID or provisioned OS injection.

`Browser.getWindowForTarget` was unsupported; that failed diagnostic was retained.
Using the existing renderer's `window.resizeTo` instead changed observed outer
bounds from 960×640 to 1000×650; the canvas changed from 944×598 to 984×608.
Sending `exit` closed the endpoint and all eight recorded AppImage/application
processes were absent afterward. No forced termination was used. Because the
launcher detached, the application's final numeric exit status was not collected.

## Development checkout

Separately, `npm run check:portable` at
`7c61d5d2d7135c7b4434f379ddb8276082e3d5b0` failed with exit 139 during
`prettier --check .`: `Segmentation fault (core dumped)`. Lint, typecheck,
tests and trailing build were not reached. This result is not attributed to the
published AppImage. No unchanged full-suite retry was performed. A selected
single-file Prettier check subsequently passed; that does not clear the full
formatting failure or identify its cause.

## Installed helper and desktop entry

After explicit consent, the exact published helper installed its three per-user
files without compatibility mode. The installed AppImage hash matched the release.
There was no prior installation to replace.

The first `gio launch` observer timed out after 10 seconds while capturing pipes;
it did not produce a window receipt and remains inconclusive. The next controlled
cycle retained the same deadline but redirected output to a file instead of
awaiting inherited-pipe EOF. `gio launch` of the exact installed desktop entry
returned 0. An owned OMXTerm X11 window was identified through its PID and
AppImage environment and observed as viewable at 960×640. It received the standard
`WM_DELETE_WINDOW` request and retired. This is desktop-entry launch evidence,
not a physical launcher-menu click or an installed interactive-shell test.

In both cycles, the actual published helper's `uninstall` returned 0 and all three
owned files were absent afterward. A valid synthetic `config.json`, created only
because none existed, retained its exact SHA-256 through uninstall. Only that
synthetic file was then removed. Generated application profile/cache files and
empty directories may remain; no preexisting personal configuration was removed.
A final process-environment audit found no remaining installed-AppImage actor.

## Additional development observations

At source `b47218fc2f8ef5533e13e45d253a790728025027`, the built development shell
accepted the same synthetic command, displayed the exact marker, produced the
expected file, resized to 1000×650 and retired after `exit`. Its initial launcher
also detached, so observation continued through the existing profile endpoint
without relaunch. Numeric final application exit status was not captured.

Separate lint, typecheck and build commands passed. A full Prettier diagnostic
with debug logging passed after the earlier segmentation fault; the crash cause
remains unknown. This does not turn the original `check:portable` into a pass.

One subsequent standalone `npm test` completed: **3,672 passed, 16 failed, 48
skipped**, across 328 reported files (305 passed, 7 failed, 16 skipped). This is
separate-stage evidence, not a successful full pipeline. Failure groups:

| File                                  | Failed assertions | Observed boundary                                         |
| ------------------------------------- | ----------------: | --------------------------------------------------------- |
| `linux-desktop-launch.test.ts`        |                 3 | Synthetic image architecture rejected on x64              |
| `linux-installer-lifecycle.test.ts`   |                 3 | Missing actor registration during cleanup; state retained |
| `restty-appearance-rendering.test.ts` |                 1 | Native appearance fixture assertion                       |
| `restty-scrollback-rendering.test.ts` |                 1 | Native scroll/selection observation mismatch              |
| `terminal-popup-native.test.ts`       |                 3 | Provisioned native-input prerequisite absent              |
| `window-chrome.test.ts`               |                 1 | Native Settings exercise assertion                        |
| `tab-removal-host-readiness.test.ts`  |                 4 | esbuild service stopped/no longer running                 |

The log includes a Go runtime crash from the esbuild service. Its cause is not
established. The native-input prerequisite was not bypassed, and neither native
failures nor retained installer cleanup diagnostics were erased or relabeled.
No unchanged full-suite retry was performed.

## Disposition

The bounded published-artifact and helper checks above are delivered, with
synthetic-input and numeric-exit-status limits. Physical input remains unverified.
Full development qualification is **failed/incomplete**, not waived. No new x64
package was built: the portable prerequisite failed, and this checkout's
`check:linux` targets ARM64 packaging; it was not substituted for x64 verification.
No release, package publication, new release gate or product fix is claimed.
The remaining failed checks and their causes remain follow-up work under #706;
this report does not close that issue.
