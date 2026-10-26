# Use standard xterm terminal capabilities

OMXTerm launches every Live Terminal Session with `TERM=xterm-256color`,
`COLORTERM=truecolor`, `TERM_PROGRAM=OMXTerm`, and `TERM_PROGRAM_VERSION` set to
the installed application version. These values describe the new PTY and
replace misleading inherited values. The rest of the user's environment is
inherited and remains outside log content.

Restty's parsed output seam retains device-attribute and cell-size ownership.
Ghostty answers cursor-position reports (CPR) from its parser cursor, including
wide/combining text, pending-wrap resize and origin-mode margins. At each parsed
CPR, the runtime synchronously submits the filtered prefix including the query
and drains its reply before later filter-owned replies. This removes the
UTF-16 cursor-hint interception without a second parser, render-frame lookup or
WASM change. Actual-core ingestion regressions cover the failures reported in
[#568](https://github.com/luizomf/omxterm/issues/568) and mixed reply ordering.
See [ADR 0025](0025-use-restty-as-the-terminal-surface.md#keyboard-input-and-terminal-controls).

The standard xterm capability vocabulary describes protocol compatibility.
OMXTerm uses the widely available `xterm-256color` contract and does not define `xterm-omxterm`, install
custom terminfo, or propagate terminfo automatically over SSH. A branded entry
would make ordinary shell, tmux, SSH, and full-screen application behavior
depend on installation state outside OMXTerm. That operational cost needs a
demonstrated capability gap before it is justified.
