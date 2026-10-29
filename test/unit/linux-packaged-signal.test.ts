import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

// Exercise the actual Python helper with a controlled Linux syscall/proc model.
// No native PID is opened or signaled. Windows does not require Python for this
// Linux-only packaging capability; macOS can run these headless controls too.
const model = `
import builtins, errno, io, json, os, select, signal, sys
source = open(sys.argv[1], encoding="utf-8").read()
mode = sys.argv[2]
trace = {"opened": [], "read": [], "signaled": [], "closed": []}
first = 0 if mode == "invalid-zero" else 101
retired = False

def pidfd_open(pid):
    trace["opened"].append(pid)
    if pid == first and mode not in ("signal-retired", "identity-reused"):
        raise OSError(errno.EPERM if mode == "permission-retired" else errno.EINVAL, "controlled open failure")
    return pid + 1000

def proc_open(name, *args, **kwargs):
    pid = int(name.split('/')[2])
    trace["read"].append(pid)
    if pid == first and mode == "open-unreadable":
        raise PermissionError(errno.EACCES, "controlled unreadable identity")
    if pid == first and (retired or mode not in ("open-live", "open-reused", "signal-retired", "identity-reused")):
        raise FileNotFoundError(errno.ENOENT, "controlled disappearance")
    fields = ['S', '1', '2'] + ['0'] * 16 + ['88' if pid == first and mode in ("open-reused", "identity-reused") else '77']
    return io.StringIO(str(pid) + ' (fixture) ' + ' '.join(fields))

class Poll:
    def register(self, *args): pass
    def poll(self, *args): return []

def send(fd, sig):
    global retired
    if fd == first + 1000 and mode == "signal-retired":
        retired = True
        raise OSError(errno.EINVAL, "controlled signal failure")
    trace["signaled"].append(fd - 1000)

os.pidfd_open = pidfd_open
os.close = lambda fd: trace["closed"].append(fd)
select.poll = Poll
signal.pidfd_send_signal = send
builtins.open = proc_open
try:
    exec(compile(source, sys.argv[1], "exec"))
finally:
    print(json.dumps(trace))
`;

it.skipIf(process.platform === "win32").each([
  ["open-retired", 0],
  ["open-live", 1],
  ["open-reused", 1],
  ["open-unreadable", 1],
  ["identity-reused", 1],
  ["permission-retired", 1],
  ["signal-retired", 1],
  ["invalid-zero", 1],
] as const)(
  "handles %s without unsafe signaling or dropping later targets",
  (mode, status) => {
    const first = mode === "invalid-zero" ? 0 : 101;
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        model,
        path.resolve("scripts/linux-packaged-signal.py"),
        mode,
      ],
      {
        input: JSON.stringify({
          targets: [first, 102].map((pid) => ({
            pid,
            parent: 1,
            group: 2,
            start: "77",
          })),
          signal: "SIGKILL",
          recovery: true,
        }),
        encoding: "utf8",
        timeout: 2_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    expect(JSON.parse(result.stdout)).toMatchObject({
      opened: [first, 102],
      signaled: [102],
      closed: ["signal-retired", "identity-reused"].includes(mode)
        ? [1101, 1102]
        : [1102],
    });
    if (status === 0) expect(result.stderr).toBe("");
    else expect(result.stderr).toContain(`target ${first}:`);
  },
);
