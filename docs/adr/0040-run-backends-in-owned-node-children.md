# ADR 0040: Run extension backends in owned bundled-Node children

- Status: accepted internal backend runtime, consumed by explicit actions in the Linux ARM64 Files development preview
- Context: [#719](https://github.com/luizomf/omxterm/issues/719), under [#712](https://github.com/luizomf/omxterm/issues/712)
- Supersedes: the #712 proposal's `utilityProcess` placement for extension backends, not ADR 0038 immutable-version ownership or #718 web-content hosting

## Decision

Use one lazy standard Node ChildProcess per explicitly active extension per application runtime. Fork the app-owned bootstrap with the bundled Electron executable (`execPath: process.execPath`), empty debug arguments, a deliberate normal-user environment plus Electron Run-as-Node, and bounded epoch-bound Node IPC. No stock Node installation, Electron upgrade or weakened security fuse is part of this decision. A missing required runtime mode fails startup before package import.

The bootstrap is a real Installed Packages consumer. Main retains its startup guard until independent child acquisition or settled cancellation; child independently pins the captured generation/digest before import, then main revalidates admission. No registry writer is held while spawning, importing, awaiting IPC or retiring. Child holds its version pin until actual process exit, not merely deactivate completion. Admission is point-in-time; disable does not undo already admitted ordinary trusted-code effects or prove every instance stopped.

Revoke infrastructure authority first, allow two seconds of cooperative grace, then request at most one forced termination through the retained ChildProcess object. Cancel escalation on actual exit and separately join exit and bounded stream closure. Node is the sole direct-child reaper. Preserve unknown outcomes; do not infer exit from a kill return, logical disposal, lock release or deactivation acknowledgement. Do not retry unknown effects. Stdout/stderr are ignored rather than retained as unbounded extension logs.

This is ordinary direct-child lifetime ownership, not absolute PID-reuse immunity, a malicious-code sandbox or descendant containment. No raw saved-PID signaling, custom waitpid loop, Mach-port adapter, extra supervisor, boot quarantine or descendant scanner is added.

## Why change the utility choice?

The actual utility runtime/store checkpoint `4b66db07eff813a0292b90ac0fce083e430b8c3b` preserved independent pins and observed actual child exit, but macOS Electron 43.8.1 forced retirement produced a **2008ms main timer gap**. Normalized exit 0 did not mean cooperation. This contradicted responsive main-thread retirement; the failed outcome remains failed.

A separately authorized throwaway discriminator using standard Node ChildProcess, the same bundled Electron 43.8.1/Node 24.22.0 and the same two-second grace/<250ms timer oracle passed on Fedora/macOS ARM64. Refusing-loop main gaps were approximately 159ms/29ms, with one owned SIGKILL, actual exit and stream closure, and pin retention/collection. It also refused a no-Node-mode negative control before import. Those bounded results justified the narrower production substitution, not automatic qualification of subsequent code or signed packages.

Keeping utilityProcess while silently raising the responsiveness threshold would weaken the requirement. A custom native termination capability or supervising process hierarchy adds ownership/build/lifetime obligations that the selected direct-child API does not need for the demonstrated behavior. Moving trusted backend execution into main/terminal renderers would remove fault locality. A separate stock Node runtime adds distribution and version ownership without a demonstrated need.

## Consequences and boundary

The [runtime contract](../extension-backend-runtime.md) governs actual caller/export interfaces, limits, cancellation and settlement. The environment allowlist excludes app bootstrap/diagnostic variables but cannot isolate trusted code from user files or credentials. Each application establishes fresh authority; surviving orphan versions can remain Pending Cleanup while unrelated management and fresh admission continue.

### Original delivery boundary

The #719 checkpoint exposed activation only to explicit internal callers, without an application startup/user activation path, catalog or composed Files/action/tab/web-host integration. Normal application build/startup were unchanged; runtime artifacts were built explicitly. Those were the module's original delivery boundaries, not permanent exclusions on application consumers.

### Current application consumer

On Linux ARM64, `src/main/application-extensions.ts` now constructs the runtime during application startup, without activating installed code. Its application manager composes separate installation/trust, backend and web-content owners. Settings local-file, explicit HTTPS-link and official-catalog installation and enable remain dormant. Explicit shared actions activate the separately installed [Files development preview](../files-development-preview.md), with independent generation-matched backend/view pins, application tabs and bounded normal Quit retirement. The runtime itself does not own Settings, catalog acquisition, action discovery or web-content hosting, and exposes no stable SDK.

Normal Linux ARM64 `npm run build` includes runtime artifacts and the native lease/Files move addons; explicit runtime builds remain available. The Files archive is built and distributed separately, not bundled into the host. The Files guide records the published host dev.9/Files 0.1.0 preview and exact extracted-AppImage public-consumption lifecycle with controlled input/consent. Package inspection and module-native tests alone are not that composed lifecycle evidence.

Prototype evidence, historical failures and subsequent platform/product observations retain their exact source identities and limits. Surviving-browser main-death file-read exclusion remains unqualified. FUSE/helper installation, physical dialogs/input, security-fuse bytes, signing/notarization, selected deployment floors, ordinary-user Windows behavior and other-platform qualification are not established by this integration or the bounded public-consumption milestone.
