# MiraBridge 2.0.0-rc.2

## Important RC notice

This Windows installer is not code-signed. SmartScreen may show an unknown-publisher warning. Download only from this GitHub Release and verify the matching SHA-256 manifest. Stable `2.0.0` remains blocked on signing plus physical Windows 10 and ARM64 GUI acceptance.

## What changed

- Rebuilt MiraBridge for Windows around a modern custom window frame, restrained task navigation, consistent controls, clearer capability copy, and the new MiraBridge mascot across the app, installer, tray, and Codex plugin.
- Replaced the native-looking language selector with the same visual and interaction system used by the rest of the application.
- Added process-level single-instance ownership. Reopening MiraBridge now activates the existing window instead of creating another window and tray icon; startup-package builds exercise this behavior.
- Rewrote the public GitHub introduction around concrete project delivery, Edge web acceptance, GPU/media Jobs, Windows-only toolchains, transfers, and safe PC maintenance.
- Removed internal Agent/module development summaries and implementation checklists from the public source tree while retaining product, security, installation, test, and release evidence.

## Compatibility

- RPC remains `2.0`.
- The MCP surface remains exactly 28 tools.
- SQLite remains `user_version=5` and existing Worker data is retained.
- Mac plugin and Windows Worker should be upgraded together.

## Still not verified

- Signed Windows installer.
- Physical Windows 10 22H2 GUI acceptance.
- Physical Windows ARM64 GUI acceptance (native ARM64 CI remains required).
