# Files development preview implementation

Work in progress for [#723](https://github.com/luizomf/omxterm/issues/723).
Linux ARM64 source builds wire the production Settings install route and shared
Files action. This is not yet a qualified distribution or a stable extension SDK.

## Concrete consumer

`extensions/files` is separately built, not imported into application main or the
terminal renderer. Maintainers run `node scripts/build-files-extension.mjs` to
produce `dist/extensions/files-0.1.0.omxext`. This build needs Python 3's ZIP
writer and the locked esbuild tool; users receive the precompiled archive and do
not run Python/npm or compilation to install it. An existing destination is not
overwritten. The archive includes its MIT license. Existing #622 attribution and
third-party notices elsewhere in the application remain unchanged.

The backend lists directories using `opendir` and sequential `lstat`, with a
5,000-entry visit limit and explicit truncation. Replies contain at most100 rows,
with at most eight active backend invocations; snapshots/cursors are ephemeral,
not filesystem watchers. Links are labeled as links. Home and explicit absolute
local paths are supported. Exclusive file creation and nonrecursive folder
creation never overwrite an existing entry. Rename/move uses the host-provided
async no-replace primitive, not a check-then-rename or copy/delete fallback.

Permanent deletion requires a separately issued, one-shot confirmation token
bound to the captured entry path/device/inode. This is protection against ordinary
UI retargeting, not a hostile same-user filesystem race sandbox. Symlink entries
are removed/moved without following their targets. Recursive deletion may fail
after partial effects and is then outcome-unknown. Linux trash invokes the OS
`/usr/bin/gio trash -- <literal-path>` facility asynchronously with no shell, an
eight-second timeout and bounded output; unavailable or failed trash never falls
back to permanent deletion. Dispatched desktop-command failure is conservatively
unknown. No failed or uncertain mutation is retried automatically.

## Owned composition modules

`createExtensionManager` owns consent/store/runtime/view composition. It reopens
an independent UI pin for the exact backend generation/digest, then revalidates
before creating views. Invocation context is copied before asynchronous
activation. Management revokes local callbacks and pending admissions, publishes
through the existing short store transaction and joins known views/backend;
status distinguishes installed metadata from local dormant/starting/active/
stopping/failed/unknown and other-instance uncertainty. Disposal latches admission
and reports actual known settlement rather than treating a kill request as exit.
`startApplicationExtensions` connects the production startup, Settings, shared
action catalog and Quit. Startup opens infrastructure but never imports installed
code. Settings → Extensions offers local selection, explicit native trust,
Refresh, enable/disable and uninstall. Selecting another archive for the same ID
is an explicit replacement/reinstall with the observed generation. Its captured
bytes, identity, version and digest are shown before approval; third-party authors
remain responsible for trusted code, including its filesystem/program/network
access. Missing runtime/store infrastructure leaves terminals usable.

Files appears in the shared palette, File menu and terminal context menu with no
default or configurable shortcut. Each invocation owns its copied terminal
context and independent view pin, even within one window; backends remain shared.
Use terminal directory reports captured local OSC7 provenance, never later
selection or process inspection. No local report means an explicit unavailable
result, with Home and explicit paths still usable. Views reserve a 34-DIP
core-owned recovery strip, further intersected with the real renderer slot.

Management shows registry generations and tombstones separately from local state,
other-instance uncertainty and Pending Cleanup. Normal Quit revokes admission,
joins known extension retirement for at most 15 seconds and records an unsettled
outcome without vetoing Quit. Native PTY exit joining remains independent.

The view router now multiplexes epochs by actual owner WebContents, with issued
ID-to-host mappings and one monotonic presentation revision per window. A new
selection must acknowledge hiding every other epoch. The child preload exposes
bounded own-view requests; main validates the actual sender/main frame and live
view, captures bounded JSON and binds cancellation to view destruction. A payload
cannot choose a backend/window/epoch. The terminal renderer has no Files request
route. Late replies after retirement cannot regain view authority.

## Build and evidence boundary

Normal Linux ARM64 application builds include the bootstrap, independent native
lease addon and Files no-replace addon. The tiny Node-API8 worker-pool adapter
uses Linux `renameat2(RENAME_NOREPLACE)`, at most32 pending calls and fixed error
categories. Destination conflicts, permissions, unsupported filesystems and
cross-device moves fail explicitly. Other platforms are not enabled by this
preview and have no overwrite fallback. Explicit runtime builds remain available.
No fuse or Electron version change is required.

`test/fixtures/files-move-native.mjs <absolute-addon>` must run under the bundled
Electron executable with `ELECTRON_RUN_AS_NODE=1`, as an ordinary Linux ARM64
user, inside an assigned disposable environment. It checks actual file/directory/
symlink moves, destination races, permissions and cross-device refusal. Source
inspection and controlled adapter tests are not native qualification.

The opt-in `test/integration/files-production.test.ts` runs the already-built
production entry point when `OMXTERM_FILES_PRODUCTION_SOURCE` names its exact
source directory on an assigned Linux ARM64 guest. Build the app and separate
archive first. `OMXTERM_FILES_PRODUCTION_EVIDENCE` optionally captures fixture-only
screenshots and the native supervisor receipt. Native chooser/consent answers are
fixture-controlled, not physical-dialog-widget qualification; terminal input is
synthetic Chromium input. Native input-lane admission is verified separately.
Production Settings/actions/Quit, visual inspection, same-terminal continuity,
real renderer failure domains and the surviving-browser main-death resource gate
remain outstanding until their actual composed fixtures run. All-browser exit or normal
retirement is not proof of surviving-browser read exclusion.
