// Private finite-actor handoff for the Linux wrapper verifier, not signal authority.
import {
  constants,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { setTimeout } from "node:timers/promises";

export function readWrapperControl(file) {
  let fd;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    if (!fstatSync(fd).isFile())
      throw new Error("Invalid wrapper control file");
    const bytes = Buffer.alloc(1_025);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 1_024) throw new Error("Oversized wrapper control file");
    return JSON.parse(bytes.toString("utf8", 0, size));
  } catch (cause) {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function publishWrapperControl(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(`${file}.tmp`, file);
}

export async function acquireWrapperControl(stem, control, deadline) {
  const text = readFileSync("/proc/self/stat", "utf8");
  const start = text
    .slice(text.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u)[19];
  const proposal = { control, pid: process.pid, start };
  publishWrapperControl(`${stem}.proposal.json`, proposal);
  while (Date.now() < deadline) {
    const ack = readWrapperControl(`${stem}.acquired.json`);
    if (
      ack?.control === control &&
      ack.pid === proposal.pid &&
      ack.start === start
    )
      return;
    await setTimeout(10);
  }
  throw new Error("Linux wrapper actor acquisition deadline exceeded");
}
