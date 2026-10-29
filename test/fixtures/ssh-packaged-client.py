#!/usr/bin/python3 -I
"""Synthetic SSH only: no network, config reads, subprocesses or credentials.

The copied executable lives at ROOT/bin/ssh. Each invocation atomically records
literal argv and Linux birth identity. fixture-fast exits 37 immediately after
output; 2001:db8::7 remains a single live raw-PTY process until core closes it.
Unknown argv fails closed. No command received on stdin is ever executed.
"""
import json
import os
from pathlib import Path
import sys
import tty


def publish(file, value):
    temporary = file.with_suffix(".tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    temporary.replace(file)


def main():
    root = Path(__file__).resolve().parent.parent
    arguments = sys.argv[1:]
    # Record even unexpected probes (for example ssh -G/-V) before refusing
    # them, so discovery cannot silently execute a client without evidence.
    with (root / "client-invocations.jsonl").open("a") as stream:
        stream.write(json.dumps(arguments) + "\n")
    if arguments == ["--", "fixture-fast"]:
        mode = "fast"
    elif arguments == ["-l", "fixture", "-p", "2207", "--", "2001:db8::7"]:
        mode = "live"
    else:
        raise SystemExit("Unexpected synthetic SSH arguments")
    fields = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()
    record = {"pid": os.getpid(), "start": fields[19], "argv": arguments,
              "cwd": os.getcwd(), "mode": mode}
    receipt = root / ("ssh-" + mode + ".json")
    # Exclusive creation catches accidental duplicate launches, rather than
    # silently replacing the receipt used by the input-release oracle.
    with (root / ("ssh-" + mode + ".claimed")).open("x"):
        pass
    publish(receipt, record)
    remote = root / "remote-cwd"
    os.write(1, ("\x1b]7;file://localhost" + str(remote) + "\x07"
                 "\x1b]2;SYNTHETIC-SSH-" + mode + "\x07"
                 "\r\nSYNTHETIC-SSH-" + mode + "-OUTPUT\r\n"
                 "No authentication or remote connectivity attempted.\r\n").encode())
    if mode == "fast":
        return 37
    tty.setraw(0)
    publish(root / "ssh-live-ready.json", record)
    while True:
        data = os.read(0, 4096)
        if not data:
            return 0
        with (root / "ssh-live-input.bin").open("ab") as stream:
            stream.write(data)
        os.write(1, b"\r\nSYNTHETIC-INPUT-ACK\r\n")


if __name__ == "__main__":
    raise SystemExit(main())
