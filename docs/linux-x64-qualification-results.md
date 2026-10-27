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

## Remaining work

Actual per-user helper installation, installed desktop-entry launch and helper
uninstall preserving configuration await explicit installation consent. They are
not established by the direct AppImage case or by deleting an isolated home.
Development-shell, complete portable and x64 package verification remain
unqualified. Raw local receipts are preserved separately; personal paths and shell
identity are not included in this report.
