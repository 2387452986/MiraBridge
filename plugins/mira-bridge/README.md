# MiraBridge Codex plugin

MiraBridge exposes a Windows computer as a remote native tool runtime for an Agent reasoning on macOS. The plugin contains the Skill, the Mac-local MCP registration, protocol/Worker/CLI source and the 28-tool contract. The Windows app and public installation documentation live at the repository root.

```text
reasoning_host = Mac
tool_host = Windows
product         = 2.0.0-rc.6
RPC             = 2.0
MCP tools       = 28
SQLite          = v5
```

Windows is a deterministic executor. It does not contain an LLM, Agent, planner, dialogue memory or semantic completion judgment.

## User installation

Use the fixed public tag and the root [README](../../README.md). The normal Mac path is:

```sh
./plugins/mira-bridge/scripts/install-mac.sh
~/.local/bin/mirabridge doctor
~/.local/bin/mirabridge pair create
```

The installer supplies a managed Node 24.19.0 and installs `mira-bridge@mirabridge`. `.mcp.json` invokes only that managed MCP bundle; plugin startup reads configuration locally and never probes all Windows nodes.

## Development

Use the exact Node 24.19.0 release:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run validate:plugin
npm run validate:skill
npm run smoke:stdio
npm run smoke:cli
npm run smoke:packages
```

Windows builds run from the repository root:

```powershell
.\scripts\build-windows-release.ps1 -RuntimeIdentifier win-x64 -SkipPackage
```

The Worker configuration owner exposes JSON CLI commands for `show`, `init`, root mutation and capability mutation. The WPF app calls those commands; it does not duplicate TOML validation or persistence.

## Public tools

The plugin exposes exactly 28 `mira_bridge_*` tools for node discovery, workspaces, bounded file operations, structured exec/PowerShell, durable Jobs, ConPTY input/snapshots/resizing, output paging, file/directory transfer, Recycle Bin scan/confirmation and local Edge snapshots. Tool approvals remain defined in [.mcp.json](.mcp.json).

See [protocol](docs/PROTOCOL.md), [architecture](docs/ARCHITECTURE.md), [security](docs/SECURITY.md), [tool parity](docs/TOOL_PARITY.md), and the repository [test report](../../docs/TEST_REPORT.md).

Licensed under the repository [MIT License](../../LICENSE).
