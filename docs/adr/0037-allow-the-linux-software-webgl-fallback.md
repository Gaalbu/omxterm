# Allow the Linux software WebGL fallback

## Context

Restty is the only Terminal Surface and needs an actual WebGL2 backend under
[ADR 0025](0025-use-restty-as-the-terminal-surface.md). Linux virtual machines
without 3D acceleration, GPU-less hosts and blocklisted drivers can lack usable
hardware WebGL2. Current Chromium requires `--enable-unsafe-swiftshader` to
permit its SwiftShader WebGL fallback. Without an available backend, a plain
launch can report "Restty did not initialize an available rendering backend"
and start no shell. The opt-in Mesa/blocklist compatibility choices
([ADR 0031](0031-keep-linux-installer-choices-small-and-local.md)) remain separate
from this fallback permission.

## Decision

On Linux, Electron main appends `enable-unsafe-swiftshader` before readiness,
next to the retained sandbox policy of
[ADR 0024](0024-disable-the-chromium-sandbox-on-linux.md). Apply the permission
before readiness and rendering-backend creation; launchers need no change.
Native startup evidence must establish that this placement is sufficient for
the pinned Electron runtime.

This is a fallback permission, not detection or an override. Chromium still
chooses usable hardware WebGL2 first, keeps its GPU blocklist and driver
selection, and may use SwiftShader when hardware WebGL2 is unavailable and the
software backend is available. The switch does not guarantee backend
availability or successful initialization. No VM, desktop or driver probe is
added, and `LIBGL_ALWAYS_SOFTWARE` and `--ignore-gpu-blocklist` stay explicit
compatibility choices for graphics troubleshooting, not an inferred driver
diagnosis. macOS and Windows keep Chromium's default.

[Chromium documents](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md)
this switch as opting into lower security guarantees: a JIT-based software
renderer executes in the GPU process. OMXTerm accepts that tradeoff on Linux,
where the GPU process is already unsandboxed under ADR 0024.

The application-owned renderer, production CSP and denied navigation constrain
exposure, but do not remove it or replace sandbox containment. Shader source
comes from the application and its rendering dependencies, not terminal-supplied
shader programs. Terminal text, image textures and rendering workloads still
contain untrusted data and can exercise graphics/JIT implementation bugs.
Application-owned shaders do not establish that software rendering is safe.

## Consequences

Linux VMs and GPU-less hosts may obtain a usable terminal without extra flags
or reinstallation when SwiftShader WebGL2 is available, at the CPU cost of
software rendering and with the lower security guarantees above. The policy
does not force software rendering on usable hardware. ADR 0025's requirement
for an actual WebGL2 backend and its no-fallback-renderer decision stand:
SwiftShader supplies WebGL2 to the same Restty Surface, not a second Surface
implementation. A host where neither hardware nor SwiftShader WebGL2 works
still fails visibly before any PTY starts.
