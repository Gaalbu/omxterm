import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { verifyExactWindowsInstaller } from "../../scripts/windows-installer-transaction.mjs";

// Real filesystem, controlled Windows command outcomes: no NSIS or PowerShell
// execution. On Unix a relative Windows-looking path satisfies the transaction's
// Windows ownership checks while keeping all fixture files in one owned tree.
async function transaction(
  remnant: "absent" | "empty" | "payload" | "unknown",
) {
  const root = await mkdtemp(
    process.platform === "win32"
      ? path.join(tmpdir(), "omxterm-transaction-test-")
      : "C:\\omxterm-transaction-test-",
  );
  const installer = path.join(root, "setup.exe");
  const unpackedRoot = path.join(root, "unpacked");
  const localAppData = path.join(root, "Local");
  const cache = path.join(localAppData, "omxterm-updater");
  let installRoot = "";
  let relocatedUninstaller = "";
  let registered = false;
  let cleanInspections = 0;
  await mkdir(unpackedRoot);
  await writeFile(installer, "controlled installer bytes");
  await writeFile(path.join(unpackedRoot, "OMXTerm.exe"), "payload bytes");
  const verifyInstalled = vi.fn(async (installed: string) => {
    expect(await readFile(path.join(installed, "OMXTerm.exe"), "utf8")).toBe(
      "payload bytes",
    );
  });
  const execute = vi.fn(async (file: string, args: string[]) => {
    if (file === installer) {
      installRoot = args[1]!.slice(3);
      await copyFile(
        path.join(unpackedRoot, "OMXTerm.exe"),
        path.join(installRoot, "OMXTerm.exe"),
      );
      await writeFile(
        path.join(installRoot, "Uninstall OMXTerm.exe"),
        "uninstaller bytes",
      );
      await mkdir(cache, { recursive: true });
      await copyFile(installer, path.join(cache, "installer.exe"));
      registered = true;
    } else if (path.basename(file) === "Uninstall OMXTerm.exe") {
      relocatedUninstaller = file;
      expect(args).toEqual(["/S", "/currentuser", `_?=${installRoot}`]);
      expect(await readFile(file, "utf8")).toBe("uninstaller bytes");
      registered = false;
      if (remnant === "payload") {
        // Registration cleanup succeeds but the actual installed executable stays.
        await rm(path.join(installRoot, "Uninstall OMXTerm.exe"));
      } else {
        await rm(installRoot, { recursive: true });
        if (remnant !== "absent") await mkdir(installRoot);
        if (remnant === "unknown") {
          await mkdir(path.join(installRoot, "unexpected"));
          await writeFile(
            path.join(installRoot, "unexpected", "evidence.txt"),
            "retain me",
          );
        }
      }
    } else {
      if (relocatedUninstaller) cleanInspections++;
      return {
        stdout: JSON.stringify({
          registrations: registered
            ? [
                {
                  hive: "CurrentUser",
                  view: "Registry64",
                  kind: "install",
                  location: installRoot,
                  uninstall: null,
                  shortcut: "OMXTerm",
                  menu: null,
                },
                {
                  hive: "CurrentUser",
                  view: "Registry64",
                  kind: "uninstall",
                  location: null,
                  uninstall: `"${path.win32.join(installRoot, "Uninstall OMXTerm.exe")}" /currentuser`,
                  shortcut: null,
                  menu: null,
                },
              ]
            : [],
          paths: [],
          processes: false,
        }),
      };
    }
    return { stdout: "" };
  });
  try {
    const result = verifyExactWindowsInstaller({
      installer,
      unpackedRoot,
      projectRoot: process.cwd(),
      disposableVm: true,
      verifyInstalled,
      execute,
      temporaryDirectory: root,
      localAppData,
    });
    if (remnant === "absent" || remnant === "empty") {
      await expect(result).resolves.toEqual({
        replacedExisting: false,
        installerCacheRemoved: true,
        sha256: createHash("sha256")
          .update("controlled installer bytes")
          .digest("hex"),
      });
      await expect(readdir(installRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(relocatedUninstaller)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else {
      await expect(result).rejects.toThrow(
        /installed payload removal not established/,
      );
      expect(await readFile(relocatedUninstaller, "utf8")).toBe(
        "uninstaller bytes",
      );
      expect(
        await readFile(
          path.join(
            installRoot,
            remnant === "payload" ? "OMXTerm.exe" : "unexpected/evidence.txt",
          ),
          "utf8",
        ),
      ).toBe(remnant === "payload" ? "payload bytes" : "retain me");
    }
    expect(verifyInstalled).toHaveBeenCalledOnce();
    expect(cleanInspections).toBe(1);
    // Exact owned-cache removal is independent of installed-payload proof.
    await expect(readdir(cache)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("exact Windows transaction installed-payload removal", () => {
  it.each(["absent", "empty"] as const)(
    "accepts an %s installation root after uninstall",
    transaction,
  );
  it.each(["payload", "unknown"] as const)(
    "rejects and preserves %s residuals despite cleared Windows state",
    transaction,
  );
});
