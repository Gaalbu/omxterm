# ADR 0038: Serialize installation transactions and pin immutable package versions

- Status: accepted internal installation foundation, consumed by the Linux ARM64 Files development preview
- Context: [#715](https://github.com/luizomf/omxterm/issues/715), under [#712](https://github.com/luizomf/omxterm/issues/712)

## Decision

Use one deep Installed Packages module for local archive installation, bounded validation/extraction, compatibility, aggregate registry publication, installation generations, disable/tombstones and eligible cleanup. Its caller interface is shared by implementation tests and management/bootstrap consumers; no extension code executes during installation.

Keep registry writer transactions short and independently pin immutable digest-addressed versions with shared native use leases. Collection requires registry nonreference and exclusive version ownership; detach to unique garbage and delete outside the writer interval. Staging and active garbage deletion also retain independent leases. Permanent lock sidecars are never deleted while the namespace can be used. Use a small host-distributed Node-API 8 adapter, with potentially blocking open/stat/close operations off-main, nonblocking POSIX `flock` / Windows `LockFileEx`, noninherited handles and explicit native cleanup lifetime.

Multiple independent app instances may run their own backends. A surviving backend delays only its pinned version's physical removal, not all extension management. Disable means blocked new admission, not globally stopped trusted code. Uninstall means tombstoned admission with possibly pending physical cleanup. Same-byte reinstall increments generation; stale activation/update permits remain stale. Actual runtime/IPC/bootstrap handoff belongs to the separate [backend runtime consumer](../extension-backend-runtime.md), not this module.

A fresh process reads valid published state and creates fresh authority; it does not adopt dead channels or replay unknown mutations. Known prepublication failures preserve old registry state; publication/response-loss uncertainty is not automatic rollback. Native locks and atomic rename do not imply universal power-loss durability or hostile same-user containment.

## Alternatives and cost

A whole-root process-lifetime lock/quarantine would block ordinary independent instances after a main crash while children survive. Boot witnesses, support-only/reboot recovery, PID-file stealing and a general descendant supervisor are rejected. Writer-only locking cannot protect late imports from a surviving backend. Keeping every version forever avoids deletion races but fails manageable cleanup. A database/daemon does not remove the need for independent reader lifetime and is unnecessary for a bounded registry without a general state API.

The selected adapter adds a small per-target native build obligation, including Windows C++/SDK/import-library and runtime-loading qualification. Node-API reduces ABI churn, not architecture/deployment/signing obligations. It is separate from the Files no-clobber move primitive. Pinned `yauzl` and `semver` are direct runtime dependencies; implementing ZIP parsing or semver from scratch would increase security/maintenance cost.

## Original delivery boundary

The #715 checkpoint delivered the isolated module/addon with an explicit build, without an application startup caller, graphical installation, catalog acquisition, extension execution, action contribution or Files release. Normal app build/startup were unchanged at that checkpoint. Those were delivery boundaries, not permanent exclusions on consumers or transfers of their responsibilities into Installed Packages.

## Current integration and qualification

The [foundation contract](../extension-installation-foundation.md) governs the implemented interface, limits, build and error behavior. On Linux ARM64, `src/main/application-extensions.ts` now opens the store and constructs runtime/management infrastructure during application startup; it never activates installed code at startup. Settings composes local-file, explicit HTTPS-link and official-catalog installation with captured-byte trust. Installation and enable remain dormant; explicit shared actions activate the separately installed [Files development preview](../files-development-preview.md).

Normal Linux ARM64 `npm run build` includes the backend bootstrap and native lease/Files move addons. The isolated foundation build remains available. Files is built and distributed separately, not bundled into the host. Execution, web-content hosting, acquisition and trust UI remain consumer responsibilities, not capabilities owned by this module. Terminal ownership and ADR 0018 are unchanged; the current application network policy is governed by the [specification](../spec.md#configuration-and-local-state).

The Files guide records the published host dev.9 and separate Files 0.1.0 preview and its exact extracted-AppImage public-consumption evidence with controlled input/consent. Neither source wiring nor module tests qualify FUSE/helper installation, physical dialogs/input, other platforms, signing or a stable SDK. Historical failures remain failures; surviving-browser main-death file-read exclusion remains unqualified as documented there.
