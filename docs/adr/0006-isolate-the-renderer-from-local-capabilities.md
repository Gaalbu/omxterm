# Isolate the renderer from local capabilities

The Terminal Surface runs in a context-isolated renderer without unrestricted
Node.js access. Electron main owns PTYs, filesystem access, configuration, logs
and window lifecycle. A minimal preload bridge exposes only typed, validated
operations and events the renderer needs.

The core Command Palette bridge exposes a bounded action snapshot and invocation
by action ID plus one-shot token, not caller-chosen windows, paths, shell text or
arbitrary IPC. Main checks the selected trusted main frame, token/catalog
identity and palette eligibility before calling an existing Action Catalog
callback. Renderer-bound dispatch additionally validates the captured selected
content before entering its original payload-validated handler. These checks
preserve action ownership; they do not turn the internal catalog into a public
Extension SDK or grant third-party code a sandbox. See
[ADR 0018](0018-deliver-menu-refused-accelerators-in-main.md).

Chromium sandboxing remains enabled on macOS and Windows. Linux deliberately
disables it under [ADR 0024](0024-disable-the-chromium-sandbox-on-linux.md).
Context isolation and the preload bridge remain useful boundaries, but do not
replace the Chromium sandbox or provide equivalent protection.
