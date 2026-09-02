# Detachable Local Sessions

OMXTerm may eventually separate its graphical client from a local session host
so closing the client can detach from Live Terminal Sessions instead of
terminating them. Reopening the client would reconnect to sessions that remain
alive while the host process and operating system continue running.

This is a possible future direction, not accepted product scope or a commitment
to implement a session manager. The current contract remains unchanged: tabs
are ephemeral, closing them terminates their processes, closing the last window
quits OMXTerm, and tmux remains the user's session manager.

## Motivation

Daily use has exposed a recurring cost in depending on tmux for all session
lifecycle and layout behavior. That dependency also places tmux between terminal
applications and OMXTerm's Terminal Surface; the currently claimed Kitty image
subset works only in direct sessions and is unsupported through tmux.

The desired behavior is specifically **detach and reconnect**, not serializing a
screen and pretending to resume it. A client/server terminal keeps the PTY,
shell, and child processes alive in a session host after the graphical client
disconnects. Reconnection attaches another client to that existing live state.

Herdr and the former OMXTerm Web architecture demonstrate the general shape:
terminal client -> transport adapter -> broker/session owner -> PTY. OMXTerm Web
used destroy-on-disconnect SSH sessions, so it is an architectural reference,
not a reusable persistence implementation. Herdr may already satisfy most of
the practical workflow that motivated this idea; it should be dogfooded before
OMXTerm assumes the cost of owning an overlapping runtime.

## Smallest credible product slice

If reconsidered, the first slice should remain narrower than tmux:

- a per-user local session host owns `node-pty` instances;
- the Electron application lists, attaches to, and detaches from those sessions;
- explicitly closing a Terminal Tab terminates its session;
- closing or quitting the graphical client may detach without terminating live
  sessions, with unambiguous user-facing semantics;
- sessions survive a client restart only while the host and operating system
  remain alive;
- no reboot resurrection, remote access, multi-user service, splits, workspaces,
  command language, prefix key, or tmux compatibility layer;
- no Terminal Payload, transcript, scrollback, Kitty image bytes, command line,
  or environment contents are persisted to disk;
- one attached client per session is sufficient initially unless dogfooding
  proves concurrent attachment necessary.

Restoring only window/tab counts with newly spawned shells is a different,
smaller feature. It must not be presented as session reconnection because the
original processes and terminal state would be gone.

## Architectural consequences

The existing `TerminalSessionAdapter` seam is useful, but its lifecycle assumes
`start -> use -> close`, where disposal closes the owned session. Reconnection
would require explicit operations such as create, attach, detach, terminate,
and resynchronize. This revises the ownership decisions in ADR 0008 and ADR
0016 rather than fitting beneath them unchanged.

A credible design must resolve:

- session identity and protocol versioning across client upgrades;
- startup, discovery, shutdown, crash recovery, and orphan cleanup for the
  local host;
- owner-only local IPC through Unix sockets on macOS/Linux and an equivalent
  protected transport on Windows;
- ordered output with sequence numbers, acknowledgements, bounded replay, and a
  defined resynchronization path;
- terminal reconstruction while detached, including alternate-screen TUIs,
  resize behavior, scrollback, and Kitty image state;
- bounded memory and backpressure when a detached session produces output;
- the distinction between detach, terminate, close window, and quit;
- native packaging and automated lifecycle coverage on every Supported
  Platform;
- compatibility behavior when the client and host binaries have different
  versions.

The hardest issue is not opening a local socket. A PTY can continue producing
output while no Terminal Surface is attached. Reconstructing a correct xterm
state later requires a bounded replay/checkpoint strategy or terminal-state
ownership in the host. Persisting serialized terminal contents would cross the
current Terminal Payload privacy boundary and is not the default answer.

## Reasons not to build it

- Herdr may provide the workflow with less project and maintenance cost.
- tmux remains mature, portable, scriptable, and already understood by the
  maintainer.
- A background host adds operational and security surface to a deliberately
  small desktop terminal.
- Reconnection, replay, packaging, and cross-platform lifecycle behavior form a
  product phase, not an isolated convenience feature.
- Splits and richer layout behavior can create pressure to expand the host into
  a general multiplexer despite the intended narrow scope.

## Reconsideration trigger

Revisit this direction only after sustained dogfooding shows that tmux and Herdr
both fail an important OMXTerm workflow that cannot be solved through ordinary
direct sessions. Before opening an implementation issue, record the concrete
missing behavior, verify that it justifies ownership of a long-running local
session host, and write a dedicated ADR and corresponding `docs/spec.md` change.

Relevant current decisions:

- ADR 0005 — keep OMXTerm and OMXTerm Web independent;
- ADR 0008 — keep detachable and reconnectable sessions outside the current
  Terminal Surface interface;
- ADR 0016 — session restoration and splits are deferred, not foreclosed;
- ADR 0022 — Kitty images are memory-only and unsupported through a
  multiplexer.
