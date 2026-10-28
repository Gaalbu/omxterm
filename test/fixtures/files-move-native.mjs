import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  symlink,
  readlink,
  stat,
  chmod,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

assert.equal(process.platform, "linux");
assert.equal(process.arch, "arm64");
assert.ok(process.versions.electron, "must use bundled Electron Run-as-Node");
assert.notEqual(
  process.getuid(),
  0,
  "permission evidence requires ordinary user",
);
const native = createRequire(import.meta.url)(path.resolve(process.argv[2]));
const root = await mkdtemp(path.join(os.tmpdir(), "omx-files-native-"));
const other = await mkdtemp("/dev/shm/omx-files-native-");
const checks = [];
let failure;
try {
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await writeFile(source, "source");
  await writeFile(destination, "preserved");
  await assert.rejects(native.moveNoReplace(source, destination), {
    code: "EEXIST",
  });
  assert.equal(await readFile(destination, "utf8"), "preserved");
  assert.equal(await readFile(source, "utf8"), "source");
  checks.push("existing-file-no-clobber");
  await native.moveNoReplace(source, path.join(root, "moved"));
  assert.equal(await readFile(path.join(root, "moved"), "utf8"), "source");
  checks.push("file-move");
  await mkdir(path.join(root, "folder"));
  await writeFile(path.join(root, "folder", "entry"), "inside");
  await native.moveNoReplace(
    path.join(root, "folder"),
    path.join(root, "renamed-folder"),
  );
  assert.equal(
    await readFile(path.join(root, "renamed-folder", "entry"), "utf8"),
    "inside",
  );
  checks.push("directory-move");
  await symlink("destination", path.join(root, "link"));
  await native.moveNoReplace(
    path.join(root, "link"),
    path.join(root, "moved-link"),
  );
  assert.equal(await readlink(path.join(root, "moved-link")), "destination");
  assert.equal(await readFile(destination, "utf8"), "preserved");
  checks.push("symlink-entry-not-target");
  await symlink("absent", path.join(root, "dangling"));
  await assert.rejects(
    native.moveNoReplace(destination, path.join(root, "dangling")),
    { code: "EEXIST" },
  );
  checks.push("dangling-destination-conflict");
  const raceA = path.join(root, "race-a"),
    raceB = path.join(root, "race-b"),
    winner = path.join(root, "winner");
  await writeFile(raceA, "A");
  await writeFile(raceB, "B");
  const races = await Promise.allSettled([
    native.moveNoReplace(raceA, winner),
    native.moveNoReplace(raceB, winner),
  ]);
  assert.equal(
    races.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const loser = races.find((result) => result.status === "rejected");
  assert.equal(loser.reason.code, "EEXIST");
  const winningText = await readFile(winner, "utf8");
  assert.equal(
    await readFile(winningText === "A" ? raceB : raceA, "utf8"),
    winningText === "A" ? "B" : "A",
  );
  checks.push("competing-destination");
  const denied = path.join(root, "denied");
  await mkdir(denied);
  await chmod(denied, 0o500);
  try {
    await assert.rejects(
      native.moveNoReplace(destination, path.join(denied, "target")),
      { code: "EACCES" },
    );
  } finally {
    await chmod(denied, 0o700);
  }
  assert.equal(await readFile(destination, "utf8"), "preserved");
  checks.push("ordinary-user-permission");
  assert.notEqual(
    (await stat(root)).dev,
    (await stat(other)).dev,
    "cross-device precondition",
  );
  await assert.rejects(
    native.moveNoReplace(destination, path.join(other, "target")),
    { code: "EXDEV" },
  );
  assert.equal(await readFile(destination, "utf8"), "preserved");
  checks.push("cross-device-refusal");
} catch (error) {
  failure = error;
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(other, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      checks,
      passed: checks.length,
      failed: failure ? 1 : 0,
      runtime: process.versions,
      platform: process.platform,
      arch: process.arch,
      cleanup: "completed",
    }),
  );
}
if (failure) throw failure;
