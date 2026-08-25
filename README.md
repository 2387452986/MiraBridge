<p align="center">
  <img src="./plugins/mira-bridge/assets/mirabridge-logo.png" width="168" alt="MiraBridge logo" />
</p>

<h1 align="center">MiraBridge</h1>

<p align="center"><strong>Use your Windows PC from Codex on your Mac—without a proxy, Codex installation, or OpenAI sign-in on Windows.</strong></p>

<p align="center">Codex stays on your Mac. Windows simply does the work and sends the results back.</p>

<p align="center"><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="https://github.com/2387452986/MiraBridge/releases/tag/v2.0.0-rc.6">Download 2.0.0-rc.6</a>
  · <a href="#install-in-one-conversation">Install</a>
  · <a href="./docs/TEST_REPORT.md">Real test evidence</a>
  · <a href="./SECURITY.md">Security</a>
</p>

---

## Your Mac thinks. Your Windows PC does the work.

You may already use Codex comfortably on a Mac, while a Windows PC holds the GPU, project, compiler, packaging tool, or files you actually need.

MiraBridge connects those two computers without turning Windows into another Codex machine:

```text
You → Codex on Mac → approved operation → MiraBridge Worker on Windows
You ← answer and evidence ← logs, files, screenshots, and finished artifacts
```

The Agent, account, conversation, planning, approval, and completion judgment stay with Codex on the Mac. Windows runs a model-free Worker that performs concrete operations and returns evidence. It does not run Codex, another Agent, or an LLM.

## Why use MiraBridge?

Codex's native SSH connection is useful when the remote computer can run Codex itself. The [official setup](https://learn.chatgpt.com/docs/remote-connections) requires Codex to be installed and authenticated on the remote host.

MiraBridge is for the other case: **Windows should be usable by Codex without installing Codex, signing in to OpenAI, or giving that PC access to an OpenAI proxy.**

| | Codex native remote connection | MiraBridge |
|---|---|---|
| Install Codex on Windows | Required for SSH mode | Not required |
| Sign in to OpenAI on Windows | Required | Not required |
| OpenAI/proxy access from Windows | Follows the remote Codex setup | Not needed for the MiraBridge control path |
| Where Codex works | Connected remote computer | Codex stays on the Mac; Windows only executes operations |
| General desktop and mouse control | Available with Computer Use on supported hosts | Not a goal |
| Windows execution model | General remote Codex environment | Structured, auditable Worker operations |

> **Network note:** MiraBridge itself does not require Windows to reach OpenAI. Software or model downloads requested by a task may still need their own internet or mirror access.

## Things you can ask Codex to do

### Build and test a Windows project

> “Open my .NET project on Windows, fix the failing tests, create the Release package, and bring the installer back to my Mac.”

Codex can inspect and edit the Windows project, run its native toolchain, verify the output, and transfer the finished artifact back.

### Use the Windows GPU

> “Check which GPU is available, render this video on Windows, keep it running if the connection drops, and verify the finished file.”

MiraBridge reports the actual hardware instead of assuming one GPU vendor. Long renders and compute jobs continue independently of the SSH session and can be found again later.

### Test a website in Microsoft Edge

> “Run this website on Windows, check desktop and mobile layouts in Edge, fix the errors, and return the screenshots and build.”

MiraBridge can keep the local server running, capture isolated Edge screenshots, report page and console errors, and return the results.

### Inspect files and clean up carefully

> “Show me what is on the Windows Desktop and in the Recycle Bin. Ask me before deleting anything.”

Codex can inspect allowed locations, present exact candidates, and verify the result after an approved change.

## Built for real work

- **Windows-native tools:** run `.exe`, `.cmd`, `.bat`, PowerShell, build tools, interactive terminals, and Chinese-language output correctly.
- **Recoverable long jobs:** builds, servers, renders, scans, and inference keep running through an SSH or MCP reconnect.
- **Controlled file access:** read, search, edit, copy, move, and delete only inside configured Windows locations.
- **Verified transfers:** move one file or a complete directory between Mac and Windows with size and SHA-256 checks.
- **Evidence, not guesses:** return exit status, logs, hashes, generated files, browser errors, screenshots, and hardware details for Codex to evaluate on the Mac.

The plugin exposes exactly 28 focused `mira_bridge_*` tools. Ordinary Mac work remains local and does not wake or contact Windows.

## Install in one conversation

### What you need

- A Mac where Codex already works.
- A supported Windows PC reachable over the same trusted LAN or an existing secure SSH network.
- The Windows installer from the same MiraBridge release as the Mac plugin.

### 1. Ask Codex on the Mac to install MiraBridge

> Install `v2.0.0-rc.6` from `https://github.com/2387452986/MiraBridge`, run doctor, and create a Windows pairing request.

Codex verifies the fixed release, installs the managed Mac runtime and plugin, and creates the pairing request.

### 2. Install MiraBridge on Windows

Download the matching x64 or ARM64 Setup from the [2.0.0-rc.6 release](https://github.com/2387452986/MiraBridge/releases/tag/v2.0.0-rc.6), run it, and open **Connect Mac**.

### 3. Pair the two computers

1. Copy the complete `mirabridge pair create` command from Windows and give it to Codex on the Mac.
2. Paste the request code into Windows and select **Authorize & create response**.
3. Copy the completion command from Windows and give it back to Codex.

The normal flow requires no password, private-key copy, TOML editing, manual SSH file editing, or typed host fingerprint.

<details>
<summary>Manual Mac installation commands</summary>

```sh
git clone --branch v2.0.0-rc.6 --depth 1 https://github.com/2387452986/MiraBridge.git
cd MiraBridge
./plugins/mira-bridge/scripts/install-mac.sh
~/.local/bin/mirabridge doctor
~/.local/bin/mirabridge pair create
```

</details>

## Safety and current limits

- MiraBridge is not remote desktop and does not control arbitrary Windows GUI applications, mouse input, or an existing signed-in browser profile.
- Windows must remain reachable from the Mac over a trusted LAN, VPN, mesh network, or other secure SSH path.
- File tools stay inside configured locations, but native programs still have the permissions of the Windows account running them. The product currently defaults to Administrator.
- Pairing uses public-key SSH and a pinned host fingerprint. MiraBridge opens no custom command listener and sends no background telemetry.
- `2.0.0-rc.6` is an unsigned release candidate. Windows SmartScreen may show **Unknown publisher**. Download it only from this repository's Release page and verify the published SHA-256 manifest.

See the [security policy](./SECURITY.md), [support matrix](./SUPPORT_MATRIX.md), and [pairing guide](./docs/PAIRING.md) before using MiraBridge on a sensitive or production machine.

## Verified on a real Windows PC

MiraBridge is tested beyond mocks and compile checks. The current release was installed on a physical Windows 11 x64 PC, exercised through the public Mac plugin, and used for native builds, reconnectable jobs, interactive terminals, Edge snapshots, file transfers, and a complete GPU video workflow. The transferred artifact was verified on the Mac with a matching SHA-256.

Read the [real test report](./docs/TEST_REPORT.md) for the full evidence, known limitations, and release gates.

## Technical documentation

- [Install on macOS](./docs/INSTALL_MAC.md)
- [Install on Windows](./docs/INSTALL_WINDOWS.md)
- [Pairing and SSH trust](./docs/PAIRING.md)
- [Architecture](./plugins/mira-bridge/docs/ARCHITECTURE.md)
- [Tool coverage and explicit gaps](./plugins/mira-bridge/docs/TOOL_PARITY.md)
- [1.x migration and rollback](./docs/MIGRATION_1X.md)
- [Release notes](./docs/release-notes-v2.0.0-rc.6.md)

## License

MiraBridge is licensed under the [MIT License](./LICENSE). See [third-party notices](./THIRD_PARTY_NOTICES.md).
