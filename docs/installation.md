# Install OMXTerm

OMXTerm ships packages for Apple Silicon Macs, Linux ARM64 or x64, and Windows 11 ARM64 or x64. Both x64 downloads have **build-only qualification** from native hosted CI, not desktop, GPU, installer or ordinary-user integration qualification. See the [0.22.0 release notes](https://github.com/luizomf/omxterm/releases/tag/v0.22.0) for coverage. Grab the file for your system from the [downloads table](../README.md#platforms-and-downloads) and follow the steps below.

**[macOS](#macos)** · **[Linux](#linux)** · **[Windows](#windows)** · **[Update or uninstall](#updating-or-uninstalling)**

## Optional Files preview

Files is separately installed, never bundled. It requires a compatible Linux ARM64
preview host (local/link installation from `0.23.0-dev.8`; catalog browsing from
`0.23.0-dev.9`), not the stable `v0.22.0` download. The published
[Linux ARM64 host preview](https://github.com/luizomf/omxterm/releases/tag/v0.23.0-dev.9)
and separate [Files 0.1.0 archive](https://github.com/luizomf/omxterm/releases/tag/ext-files-v0.1.0)
include checksums. Both are prereleases; `v0.22.0` remains Latest.

In a catalog-capable preview, open Settings → Extensions → **Browse official
extensions**. Choose Install/Update/Reinstall, then review the exact version/digest
and trusted-code warning. Installation is dormant until you explicitly open Files
from the palette or File menu. Official means project-maintained, not sandboxed.
The catalog connects only on Browse/Refresh; installed management and local `.omxext`
installation remain usable offline. A catalog error is not an empty list; failed
refresh shows the last successful snapshot as stale. No npm/Python or source build
is required for a published archive. See [Files](files-development-preview.md#official-catalog)
for compatibility and evidence limits.

## macOS

You need an Apple Silicon Mac (M1 or later) with macOS 12 Monterey or newer.

1. Download the **DMG**.
2. Open it and drag **OMXTerm.app** to your **Applications** folder.
3. Launch OMXTerm from Applications or Spotlight.

### First launch on macOS

OMXTerm is not notarized by Apple, so macOS blocks it the first time. To allow it:

1. Open **System Settings → Privacy & Security**.
2. Scroll down to **Security**.
3. Click **Open Anyway** next to the OMXTerm message.

You only do this once. Later, macOS may also ask before OMXTerm opens protected folders such as Documents or Downloads.

<details>
<summary>Optional: verify the download</summary>

Download the matching `.sha256` file, then run this in the folder where both files are:

```sh
shasum -a 256 -c OMXTerm-0.22.0-arm64.dmg.sha256
```

A valid file prints `OK`.

</details>

## Linux

Use `-arm64.AppImage` on `aarch64` (ARM64), or `-x64.AppImage` on `x86_64`
(Intel/AMD). The examples below use ARM64; substitute `x64` in both the AppImage
and checksum filenames on Intel/AMD. The common `linux_install.sh` helper accepts
either architecture and rejects mismatched host/ELF architectures before
execution.

Linux x64 is a **build-only** download from native hosted CI. Checks include
exact AppImage content/architecture inspection, packaged Electron/addon loading
and real headless PTY output/exit/resize. Desktop/GPU, FUSE launch, helper
installation and ordinary-user integration remain unverified, not release gates.
See the [0.22.0 release notes](https://github.com/luizomf/omxterm/releases/tag/v0.22.0)
for actual checks and limits.

### Requirements

The ARM64 AppImage needs an `aarch64` processor and **glibc 2.42 or newer**. Check your architecture and glibc with:

```sh
uname -m
getconf GNU_LIBC_VERSION
```

Recent releases such as Fedora 43, Ubuntu 25.10, and Arch meet the ARM64 requirement. Ubuntu 24.04 LTS and other older releases ship an older glibc and cannot run the ARM64 package.

Linux x64 headless checks ran on Ubuntu 22.04 with glibc 2.35. That observed environment is not a minimum-version or broad distro compatibility guarantee; do not infer x64 requirements from the ARM64 package.

Then install the few desktop packages OMXTerm relies on (most desktops already have them):

```sh
# Ubuntu / Debian
sudo apt install fontconfig file xwayland

# Fedora
sudo dnf install fontconfig file xorg-x11-server-Xwayland
```

### Run the AppImage

Make the AppImage executable and run it:

```sh
chmod +x OMXTerm-0.22.0-arm64.AppImage
./OMXTerm-0.22.0-arm64.AppImage
```

If you get a FUSE error, run it this way instead:

```sh
./OMXTerm-0.22.0-arm64.AppImage --appimage-extract-and-run
```

### Add it to your application menu (optional)

Download `linux_install.sh` next to the AppImage and run:

```sh
chmod +x linux_install.sh
./linux_install.sh install ./OMXTerm-0.22.0-arm64.AppImage
```

OMXTerm now shows up in your application launcher. The [Linux installer guide](linux-installer.md) has the details. For blur, HiDPI scaling, or VM graphics, see [Linux desktop tips](linux-desktop.md).

<details>
<summary>Optional: verify the download</summary>

Download the matching `.sha256` file next to the AppImage and run:

```sh
sha256sum --check OMXTerm-0.22.0-arm64.AppImage.sha256
```

</details>

## Windows

You need a Windows 11 PC with an ARM64 or x64 (Intel/AMD) processor (check **System type** in **Settings → System → About**). Use the `-arm64.exe` installer on ARM and the `-x64.exe` installer on Intel/AMD.

Windows x64 has **build-only qualification** from native hosted Windows Server x64 CI, not ARM64 emulation. Checks inspect the unpacked app and load its packaged addon in packaged Electron Run-as-Node. They do not execute NSIS, prove its payload equivalent to the inspected tree, or spawn real ConPTY. Desktop/GPU, ordinary-user integration, Windows 11 and SmartScreen/UAC remain unverified for this x64 package. See the [0.22.0 release notes](https://github.com/luizomf/omxterm/releases/tag/v0.22.0) for separate ARM64 and x64 coverage.

1. Install the Microsoft Visual C++ Redistributable for your architecture (ARM64 or x64) if you don't have it yet. See [Microsoft's download page](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist).
2. Download and run the matching installer: `OMXTerm-0.22.0-arm64.exe` or `OMXTerm-0.22.0-x64.exe`.
3. If SmartScreen warns about an unrecognized app, click **More info → Run anyway**.
4. Launch **OMXTerm** from the Start menu.

OMXTerm starts Windows PowerShell by default. You can [switch to PowerShell 7 or Git Bash](configuration.md#choose-the-windows-default-shell) in your settings.

<details>
<summary>Optional: verify the download</summary>

In PowerShell, in your download folder:

```powershell
$name = "OMXTerm-0.22.0-arm64.exe" # Use OMXTerm-0.22.0-x64.exe on Intel/AMD
Get-FileHash $name -Algorithm SHA256
```

Compare the result with the hash inside the matching `$name.sha256` file.

</details>

## Ready to go

Try your [first session](../README.md#first-session), then explore [everyday use](usage.md) or [change a setting](configuration.md).

Something went wrong? Check [installation troubleshooting](usage.md#the-download-will-not-open) or [ask for help](../CONTRIBUTING.md#report-a-problem).

## Updating or uninstalling

OMXTerm does not update itself. To update, quit OMXTerm, download the new version, and replace the old one:

| System                 | Update                                                  | Uninstall                                               |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| macOS                  | Replace OMXTerm.app in Applications.                    | Move the app to the Trash.                              |
| Linux, AppImage only   | Replace the AppImage file.                              | Delete the AppImage file.                               |
| Linux, with the helper | Run `./linux_install.sh install` with the new AppImage. | Run `./linux_install.sh uninstall`.                     |
| Windows                | Run the new installer.                                  | Settings → Apps → Installed apps → OMXTerm → Uninstall. |

Updating or uninstalling never touches your settings, themes, snippets, or logs. See [Configuration](configuration.md) and [Local diagnostics](usage.md#local-diagnostics) for where they live.
