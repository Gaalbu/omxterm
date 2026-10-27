# ADR 0038: Serialize installation transactions and pin immutable package versions

- Status: accepted for the internal installation foundation; user-facing extension support remains planned
- Context: [#715](https://github.com/luizomf/omxterm/issues/715), under [#712](https://github.com/luizomf/omxterm/issues/712)

## Decision

Use one deep Installed Packages module for local archive installation, bounded validation/extraction, compatibility, aggregate registry publication, installation generations, disable/tombstones and eligible cleanup. Its caller interface is shared by implementation tests and future management/bootstrap consumers; no extension code executes during installation.

Keep registry writer transactions short and independently pin immutable digest-addressed versions with shared native use leases. Collection requires registry nonreference and exclusive version ownership; detach to unique garbage and delete outside the writer interval. Staging and active garbage deletion also retain independent leases. Permanent lock sidecars are never deleted while the namespace can be used. Use a small host-distributed Node-API 8 adapter, with potentially blocking open/stat/close operations off-main, nonblocking POSIX `flock` / Windows `LockFileEx`, noninherited handles and explicit native cleanup lifetime.

Multiple independent app instances may eventually run their own backends. A surviving backend delays only its pinned version's physical removal, not all extension management. Disable means blocked new admission, not globally stopped trusted code. Uninstall means tombstoned admission with possibly pending physical cleanup. Same-byte reinstall increments generation; stale activation/update permits remain stale. Actual runtime/IPC/bootstrap handoff is a later consumer, not a success-returning stub here.

A fresh process reads valid published state and creates fresh authority; it does not adopt dead channels or replay unknown mutations. Known prepublication failures preserve old registry state; publication/response-loss uncertainty is not automatic rollback. Native locks and atomic rename do not imply universal power-loss durability or hostile same-user containment.

## Alternatives and cost

A whole-root process-lifetime lock/quarantine would block ordinary independent instances after a main crash while children survive. Boot witnesses, support-only/reboot recovery, PID-file stealing and a general descendant supervisor are rejected. Writer-only locking cannot protect late imports from a surviving backend. Keeping every version forever avoids deletion races but fails manageable cleanup. A database/daemon does not remove the need for independent reader lifetime and is unnecessary for a bounded registry without a general state API.

The selected adapter adds a small per-target native build obligation, including Windows C++/SDK/import-library and runtime-loading qualification. Node-API reduces ABI churn, not architecture/deployment/signing obligations. It is separate from the future Files no-clobber move primitive. Pinned `yauzl` and `semver` are direct runtime dependencies; implementing ZIP parsing or semver from scratch would increase security/maintenance cost.

## Delivery boundary

The [foundation contract](../extension-installation-foundation.md) governs implemented interface, limits, build and error behavior. This checkpoint has no application startup caller, graphical install, catalog networking, public SDK, extension execution, action contribution or Files release. Normal app build/startup remain unchanged; the isolated module/addon build is explicit. Production bootstrap/protocol readers, packaging, trust UI and combined-consumer qualification remain integration work. No change to terminal ownership, application network policy or ADR 0018.
