<p align="center">
  <img src="./plugins/mira-bridge/assets/mirabridge-logo.png" width="168" alt="MiraBridge logo" />
</p>

<h1 align="center">MiraBridge</h1>

<p align="center"><strong>Use a Windows PC as the native tool runtime for Codex reasoning on your Mac.</strong></p>

<p align="center">MiraBridge 将 Windows 电脑变成 Mac 上 Codex 可直接使用的远程原生工具环境。</p>

<p align="center">
  <a href="https://github.com/2387452986/MiraBridge/releases/tag/v2.0.0-rc.2">Download 2.0.0-rc.2</a>
  · <a href="#install-in-one-conversation">Install</a>
  · <a href="./docs/TEST_REPORT.md">Real test evidence</a>
  · <a href="./SECURITY.md">Security</a>
</p>

---

MiraBridge keeps the Agent, LLM, planning, approval, and completion judgment on macOS. Its Windows Worker has no model and no autonomous loop: it executes exact file, process, terminal, browser, transfer, and maintenance operations, then returns structured evidence to the Mac.

## Real work, not remote-command demos

### Deliver a Windows project end to end

> “检查 Windows 上的这个 .NET 项目，修复测试，完成 Release 打包，把安装产物传回 Mac。”

Codex can inspect the existing Windows workspace, search and read source, make SHA-guarded edits, run tests, inspect failures, build the native package, verify its files and hashes, and pull only the finished artifacts back to the Mac.

### Build and visually verify a website on Windows

> “在 Windows 上制作一个 Vite 网页，启动服务，用 Edge 检查桌面和移动端效果，修完控制台错误后把源码和构建目录传回来。”

MiraBridge can install dependencies, keep the dev server running as a durable Job, verify HTTP with Windows `curl.exe`, render isolated Edge screenshots, report console/page errors, run the production build, and transfer the complete project directory.

### Run GPU and media workloads without tying up the Mac

> “检测这台 Windows 的显卡能力，用可用编码器渲染视频；断线也要继续，结束后验证分辨率、帧率和时长。”

The node reports NVIDIA, AMD, Intel, virtual, or CPU-only hardware instead of assuming one GPU vendor. Codex can probe the real encoder path, start FFmpeg or another renderer as a persistent Job, recover it after SSH/MCP reconnect, inspect bounded logs, verify output with `ffprobe`, and pull the result to macOS.

### Use Windows-only engineering toolchains

> “在 Windows 上运行 PowerShell、交互式 CLI 和打包工具，处理中文输出，失败后继续排查。”

Structured argv execution avoids shell translation. Separate PowerShell, UTF-8/Windows code-page decoding, durable stdin, and ConPTY terminal snapshots support normal CLI tools, REPLs, prompts, control keys, resizes, and full-screen TUIs.

### Inspect and maintain the actual PC safely

> “告诉我 Windows 桌面有哪些文件，扫描 D 盘和回收站里可以清理的内容，先给候选，确认后再精确删除。”

Desktop access uses the real Windows Known Folder. Recycle Bin and storage workflows scan first, return sizes and evidence, require a fresh receipt or explicit target for destructive work, then rescan to verify the result. Unknown personal files are never treated as cache merely because they are large.

## What the Agent can operate

- Files and projects: list, stat, page, search, glob, create, exact edit, copy, move, and guarded delete.
- Native execution: structured `.exe`, `.cmd`, `.bat`, PowerShell, timeouts, process-tree cancellation, and Chinese output.
- Durable work: discoverable Jobs, idempotent start, log paging, reconnect recovery, stdin, and ConPTY terminal snapshots.
- Transfers: verified single-file or complete-directory push/pull with SHA-256 and atomic replacement—not background sync.
- Web acceptance: local HTTP verification and isolated installed-Edge desktop/mobile screenshots without using a signed-in profile.
- PC capabilities: real architecture, CPU, memory, display adapters, Desktop authorization, Recycle Bin scan, storage retention, and quota status.

The Codex plugin exposes exactly 28 `mira_bridge_*` MCP tools. Ordinary Mac-local work stays local and does not contact Windows.

## Install in one conversation

This is an unsigned release candidate. Windows SmartScreen may show **Unknown publisher**. Download only from this repository’s Release page and verify the published SHA-256 manifest. Stable `2.0.0` remains blocked on Windows code signing plus physical Windows 10 and ARM64 GUI acceptance.

Tell Codex on the Mac:

> 请从 `https://github.com/2387452986/MiraBridge` 安装 `v2.0.0-rc.2`，完成 doctor 并生成 Windows 配对码。

Codex verifies the fixed tag and release manifest, installs the managed Node 24 runtime, MCP server and CLI without Homebrew, and registers `mira-bridge@mirabridge`.

On Windows, download the matching x64 or ARM64 Setup from the same Release, run it, and use **Connect Mac** to paste the request and return the response. The normal path requires no password, private-key copy, TOML edit, or manually typed host fingerprint.

<details>
<summary>Explicit Mac commands</summary>

```sh
git clone --branch v2.0.0-rc.2 --depth 1 https://github.com/2387452986/MiraBridge.git
cd MiraBridge
./plugins/mira-bridge/scripts/install-mac.sh
~/.local/bin/mirabridge doctor
~/.local/bin/mirabridge pair create
```

</details>

## Architecture and trust boundary

```text
Mac                                                    Windows
┌──────────────────────────────┐                       ┌─────────────────────────┐
│ Codex / Agent                │                       │ MiraBridge for Windows  │
│ reasoning, planning, approval│                       │ setup, status, access   │
└──────────────┬───────────────┘                       └────────────┬────────────┘
               │ MCP                                                │ Worker CLI
┌──────────────▼───────────────┐       pinned SSH / stdio            ▼
│ mirabridge-mcp               ├──────────────────────────────► deterministic Worker
│ node config + host trust     │◄────────────────────────────── structured evidence
└──────────────────────────────┘

reasoning_host = Mac
tool_host      = Windows
```

MiraBridge is not remote desktop, a Windows Agent, a cloud relay, a Bash translator, or a bidirectional sync engine. It opens no custom command port and stores no LLM conversation or goal state on Windows.

## Product defaults

- Administrator-first Windows route, with Worker path boundaries and Mac-side approvals still enforced.
- `%USERPROFILE%\MiraBridge` and Desktop access are configurable from the Windows app.
- Recycle Bin clearing requires a fresh unchanged scan receipt.
- Web snapshots are loopback/local-only by default and never use browser cookies or extensions.
- OpenSSH uses public keys, pinned host fingerprints, and a `LocalSubnet` firewall rule.
- Output retention: ordinary output 7 days, Job logs 14 days, metadata/audit 90 days, 10 GiB quota, 2 GiB free-space reserve.
- x64 and ARM64 packages; 32-bit x86 Windows is not supported by the bundled Node 24 runtime.

## Documentation

- [Install on macOS](./docs/INSTALL_MAC.md)
- [Install on Windows](./docs/INSTALL_WINDOWS.md)
- [Pairing and SSH trust](./docs/PAIRING.md)
- [1.x migration and rollback](./docs/MIGRATION_1X.md)
- [Support matrix](./SUPPORT_MATRIX.md)
- [Security policy](./SECURITY.md)
- [Real test report](./docs/TEST_REPORT.md)

## License

MiraBridge is licensed under the [MIT License](./LICENSE). See [third-party notices](./THIRD_PARTY_NOTICES.md).
