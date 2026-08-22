# MiraBridge

**MiraBridge exposes a Windows computer as a remote native tool runtime for an Agent reasoning on macOS.**

**MiraBridge 将 Windows 电脑暴露为 Mac Agent 的远程原生工具执行环境。**

The Agent thinks, plans and decides completion on the Mac. A deterministic Windows Worker runs native processes, files, durable Jobs, interactive terminals, transfers and local Edge snapshots, then returns structured evidence. Windows does not run an LLM or a second Agent.

> `2.0.0-rc.1` is an unsigned release candidate. Windows SmartScreen may show an unknown-publisher warning. Download only from this repository's Release page and verify the published SHA-256 manifest. Stable `2.0.0` will not ship until Windows code signing and physical Windows 10/ARM64 acceptance are complete.

[Download MiraBridge 2.0.0-rc.1](https://github.com/2387452986/MiraBridge/releases/tag/v2.0.0-rc.1)

## Architecture

```text
Codex / Agent on macOS                         Windows computer
┌──────────────────────────────┐               ┌─────────────────────────────┐
│ reasoning, planning, approval│               │ MiraBridge for Windows GUI  │
│ completion judgment          │               │ onboarding/status/config    │
└──────────────┬───────────────┘               └─────────────┬───────────────┘
               │ MCP                                          │ Worker JSON CLI
┌──────────────▼───────────────┐    pinned SSH / stdio         ▼
│ managed mirabridge-mcp       ├──────────────────────────────►┌──────────────┐
│ node config + host trust     │                               │ deterministic│
└──────────────────────────────┘◄──────────────────────────────┤ Worker       │
                         structured results                    └──────────────┘

reasoning_host = Mac
tool_host      = Windows
```

There is no remote desktop, GUI control, Bash-to-PowerShell translator, custom command port, cloud relay, sync engine, Windows Agent or Windows LLM.

## Install in one conversation

Tell Codex on the Mac:

> 请从 `https://github.com/2387452986/MiraBridge` 安装 `v2.0.0-rc.1`，完成 doctor 并生成 Windows 配对码。

Codex clones the fixed tag, verifies `release-manifest.json`, and runs the idempotent installer. The installer downloads the exact official Node.js 24.19.0 archive, verifies its pinned SHA-256, installs it under `~/Library/Application Support/MiraBridge`, builds the locked MCP/CLI bundle, and registers the `mirabridge` Git marketplace. It does not use Homebrew or replace the system Node.

Equivalent explicit commands:

```sh
git clone --branch v2.0.0-rc.1 --depth 1 https://github.com/2387452986/MiraBridge.git
cd MiraBridge
./plugins/mira-bridge/scripts/install-mac.sh
~/.local/bin/mirabridge doctor
~/.local/bin/mirabridge pair create
```

Then on Windows:

1. Download the matching x64 or ARM64 `MiraBridge.Windows-*-Setup.exe` from the same Release and compare its SHA-256.
2. Run Setup, open **MiraBridge for Windows**, keep the default `%USERPROFILE%\MiraBridge` root and click **Install / Repair**. Approve the single UAC prompt.
3. Paste the Mac request code. Copy the Windows response code back to the Mac.
4. Run `mirabridge pair accept '<response>'`. The Mac performs a fresh `ssh-keyscan`, requires the exact returned Host Fingerprint, commits config atomically, and completes a real `describe_node` handshake.

No password, private key, TOML edit or manually typed fingerprint is part of the normal path.

## Product defaults

- Windows account: Administrator-first.
- Allowed root: `%USERPROFILE%\MiraBridge`, read-write.
- Desktop: read-write, explicitly reported by node capabilities.
- Recycle Bin: enabled; emptying still requires a fresh scan credential and Mac approval.
- Web snapshots: loopback/local only; external navigation disabled.
- OpenSSH: existing service reused; port 22 limited to `LocalSubnet`; public-key-only for the paired administrator.
- Logs: ordinary output 7 days, Job logs 14 days, metadata/audit 90 days, 10 GiB total quota, 2 GiB minimum free space.
- Installation ownership: app/update files use a RID-specific Velopack root (`%LOCALAPPDATA%\MiraBridge.Windows` on x64, `.ARM64` suffix on ARM64); durable Worker data uses `%LOCALAPPDATA%\MiraBridge`.

## Commands

```text
mirabridge install | update [VERSION] | uninstall [--purge-data] | doctor
mirabridge pair create [--id windows-main]
mirabridge pair accept RESPONSE
mirabridge pair list
mirabridge pair revoke NODE [--local-only]
mirabridge node add | list | test

MiraBridge.Host worker --version | doctor | serve --stdio
MiraBridge.Host worker config show | init | add-root | remove-root | set-capability
MiraBridge.Host worker jobs list | jobs inspect JOB_ID
MiraBridge.Host worker storage status | storage prune --dry-run | --execute
```

The Codex plugin exposes exactly 28 `mira_bridge_*` MCP tools. Ordinary Mac-local work remains local and does not contact Windows.

## Documentation

- [Mac installation](docs/INSTALL_MAC.md)
- [Windows installation](docs/INSTALL_WINDOWS.md)
- [Pairing and trust](docs/PAIRING.md)
- [1.x migration and rollback](docs/MIGRATION_1X.md)
- [Support matrix](SUPPORT_MATRIX.md)
- [Security policy](SECURITY.md)
- [Test report](docs/TEST_REPORT.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)

## License

MiraBridge is licensed under the [MIT License](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
