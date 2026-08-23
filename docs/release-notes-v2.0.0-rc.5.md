# MiraBridge 2.0.0-rc.5

This release candidate closes the remaining first-run presentation and pairing guidance gaps without changing the execution protocol.

## What changed

- Rebuilt the Windows ICO with optically sized 16–32 px frames so the multicolour MiraBridge mascot remains recognizable in the taskbar and system tray.
- The tray now loads the icon directly from the installed package and asks Windows Shell to refresh stale icon associations.
- **Connect Mac** now shows the complete Mac request command and the complete response-accept command, each with a one-click copy action.
- Clarified that the Windows authorization button already handles the SSH public-key step; no manual SSH file, private-key, password, TOML, or fingerprint entry is required.
- Added a complete Simplified Chinese README alongside the English README, with matching productivity cases, architecture, installation, pairing, security defaults, and documentation links.

## Compatibility

- Product/plugin/Worker: `2.0.0-rc.5`
- RPC: `2.0` (unchanged)
- MCP tools: 28 (unchanged)
- SQLite `user_version`: 5 (unchanged)
- Existing nodes, pairings, Jobs, logs, workspaces, configuration, and audit state remain compatible.

## Release-candidate warning

The Windows installer remains unsigned. Windows SmartScreen may show **Unknown publisher**. Download only from this GitHub Release and verify the matching SHA-256 manifest. Stable `2.0.0` remains blocked on code signing and the documented physical-platform acceptance gates.
