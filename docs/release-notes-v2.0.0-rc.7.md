# MiraBridge 2.0.0-rc.7

This release candidate fixes intermittent black rendering in the Windows WPF
control panel and adds a host-key-safe reconnect path for paired Windows PCs
whose DHCP hostname or IP address changes.

## What changed

- The Windows control panel now uses process-scoped WPF software rendering,
  isolating this lightweight UI from mixed physical/virtual display-adapter and
  graphics-driver compositor resets. No display driver or system registry value
  is changed.
- Added `mirabridge node reconnect NODE_ID --host NEW_HOST` on the Mac.
- A reconnect accepts the candidate address only when its live SSH host key
  matches the node's existing pinned fingerprint, then completes a real Worker
  handshake. A mismatch or failed handshake restores both config and
  `known_hosts`.
- Added English and Simplified Chinese reconnect prompts to the CLI, public
  README files, pairing/troubleshooting guides, and Windows Help.
- Added deterministic rollback, mismatch, shared-endpoint, CLI guard, and WPF
  rendering regressions.

## 中文说明

- Windows 控制面板改为应用进程级 WPF 软件渲染，降低实体显卡、虚拟显示器
  和驱动合成状态变化造成间歇性黑屏的风险；不会修改显卡驱动或系统注册表。
- Mac 新增 `mirabridge node reconnect NODE_ID --host NEW_HOST`。
- 只有新地址提供原节点已固定的 SSH 主机密钥，并通过真实 Worker 握手时，
  地址才会迁移；指纹不一致或握手失败会恢复配置与 `known_hosts`。
- CLI、公开中英文 README、配对/排障说明和 Windows 帮助均加入中英双语重连
  提示。

## Compatibility

- Product/plugin/Worker: `2.0.0-rc.7`
- RPC: `2.0` (unchanged)
- MCP tools: 28 (unchanged)
- SQLite `user_version`: 5 (unchanged)
- Existing pairings, identities, nodes, Jobs, logs, workspaces, configuration,
  and audit state remain compatible.

## Release-candidate warning

The Windows installer remains unsigned. Windows SmartScreen may show
**Unknown publisher**. Download only from this GitHub Release and verify the
matching SHA-256 manifest. Stable `2.0.0` remains blocked on code signing and
the documented physical-platform acceptance gates.
