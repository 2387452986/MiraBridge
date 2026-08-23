# MiraBridge 2.0.0-rc.2 Mac setup

The supported public installation path is maintained once, at
[`../../../docs/INSTALL_MAC.md`](../../../docs/INSTALL_MAC.md).

For a normal installation, ask Codex:

> 请从 `https://github.com/2387452986/MiraBridge` 安装 `v2.0.0-rc.2`，完成 doctor 并生成 Windows 配对码。

MiraBridge installs a verified, managed Node.js 24.19.0 runtime without
Homebrew, builds the locked MCP/CLI bundle, registers the Git marketplace and
installs `mira-bridge@mirabridge`. Do not install the CLI globally with npm or
copy a private SSH key to Windows.

Developer-only source validation runs from the plugin directory:

```sh
npm ci
npm run check
npm run smoke:stdio
npm run smoke:cli
npm run smoke:packages
```

Pairing, update, rollback and uninstall instructions are in the canonical Mac
installation guide and [`../../../docs/PAIRING.md`](../../../docs/PAIRING.md).
