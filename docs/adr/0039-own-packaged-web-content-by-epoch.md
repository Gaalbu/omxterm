# ADR 0039: Own packaged web content by activation epoch

Status: Accepted internal module; end-user activation and main-death qualification remain gated.

## Context

Optional web content must not run in the terminal renderer or acquire terminal
filesystem/PTY capabilities. Native child views paint above DOM, so ordinary
CSS stacking cannot provide modal exclusion. Installation ownership is separate
from browser lifetime ([ADR 0038](0038-pin-immutable-installed-packages.md)).

## Decision

A lazy `Extension View Host` owns one nonpersistent session/origin and at most
eight `WebContentsView` instances for one epoch/window. It uses Node-off,
context-isolated content and an app-owned visibility/own-backend-request preload. This is an
internal adapter, not an extension SDK, security sandbox or user activation path.
Core tab ordering includes hosted slots alongside terminal and retained Settings
content. Main issues view identities; only the owning terminal main frame can
present/close them. The window router maps each issued identity to its epoch and
acknowledges hiding every other epoch before presenting a new selection. Child
requests authenticate the actual child main frame and live view; bounded JSON
routes only to its captured backend callback, with cancellation on destruction.
Neither caller-provided IDs nor terminal renderer requests can select a backend. Monotonic layout revisions, owner lifetime and main-approved
content bounds prevent stale presentation and keep host chrome outside the view.
CSS geometry is converted using actual page zoom, not terminal font zoom.

DOM selection and overlay opening await an acknowledged native hide. Overlay
closure can restore only the same still-current content owner. Failed hides
suppress presentation rather than showing a DOM modal behind live native pixels.
Pending or failed terminal handoffs also refuse terminal injection, Find,
clipboard and Snippets targeting; refused actions are not buffered or replayed.
Field input stays in the child; core commands use the existing matcher with the
owning window. Native clipboard operations target selected hosted contents,
never a former terminal field. Host Close retains its Enter gesture through
repeats/release using the same window dismissal owner as Settings. Closing a
hosted tab does not close a PTY.

The resource consumer retains the whole captured `openVersion()` pin privately.
Fresh admission is revalidated before epoch creation; existing reads never follow
a latest-version pointer. Only bounded, fully materialized Responses cross the
custom `omx-extension` protocol: at most four admitted reads, two MiB per resource
and eight MiB of reserved read buffers. The package reader bounds allocation and
closes file handles before settlement. No file URL, stream, descriptor or package
directory is exposed to Chromium. Only explicitly supported packaged resource
paths/types are served; no catalog, download or remote networking is enabled.

CSP and session request policy deny connect, workers, frames, popups, navigation,
downloads and permission requests. The sole `loadURL` exception in the application
network source guard is the exact owned epoch-entry call, with behavior coverage
for foreign origin/scheme/epoch/path/navigation. Other callers remain prohibited.
The app-owned scheme does not register service-worker or CSP-bypass privileges.

Retirement first revokes admission, hides/closes known views, unhandles the route,
settles actual resource reads, closes connections and clears session data. It
releases the pin only after views and reads drain. Native close, storage or pin
release failure is not successful retirement. A bounded timeout leaves the
original cleanup running and reports failure; it neither releases early nor
silently retries. Tab retirement is published only after native destruction and,
for the final epoch view, successful read/session/pin settlement. Failed epochs
keep their core-owned tab and recovery notice; they do not publish an empty
window. The owner-bound IPC route continues acknowledging safe null presentations
after settled retirement, but never admits old view identities. No session-destroy
API or arbitrary-descendant containment is
invented. Renderer loss conservatively retires all views in that epoch; actual
renderer IDs are observed, and sharing the core renderer refuses continued use.
There is no per-view process-isolation promise.

## Gates and consequences

The module has no installer/catalog/backend/Files activation UI. Its consumers
are internal composition and test harnesses using the same host/reader/tab seam.
The installed-package adapter and ordinary browser retirement must be qualified
separately. Main death may leave already delivered bytes in browser memory;
materialized Responses alone do not prove that a surviving Chromium process has
no later disk route. Until a bounded actual-death discriminator establishes that
property, **main-death file-read exclusion remains unqualified** and cannot be
claimed as package cleanup safety after main death. No reboot, quarantine or
extra supervisor compensates for this missing evidence.

Retained native views have material memory cost; create substantial views lazily,
not one native view per widget. Hidden views retain drafts only within their
epoch. A future activation layer must supply trusted admission, the main-approved
slot and existing core command routing; this module is not successful no-op
extension support. Theme/language adaptation beyond the owning core tab chrome
is not a public web-content capability in this internal slice.
