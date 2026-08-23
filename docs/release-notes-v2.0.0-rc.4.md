# MiraBridge 2.0.0-rc.4

## Important RC notice

This Windows installer is not code-signed. SmartScreen may show an unknown-publisher warning. Download only from this GitHub Release and verify the matching SHA-256 manifest. Stable `2.0.0` remains blocked on signing plus physical Windows 10 and ARM64 GUI acceptance.

## What changed

- Fixed a fail-closed Job cancellation reliability defect found by the post-release Windows x64 gate. Under heavy parallel CPU and process pressure, a cold Windows process-identity probe could exceed its bounded 10-second timeout. MiraBridge now retries only the transient unavailable-probe result once before returning a retryable error.
- PID reuse safety is unchanged: an exited process or a real creation-time mismatch is never retried and remains rejected before `taskkill` can run.
- Retains the rc.3 atomic Mac runtime switch and exact-tag marketplace upgrade repair.
- Retains the modern Windows task navigation, consistent language/capability selectors, Figure-2 mascot icon, single-instance tray ownership, and the existing 28-tool product boundary.

## Compatibility

- RPC remains `2.0`.
- The MCP surface remains exactly 28 tools.
- SQLite remains `user_version=5`; existing Worker data is retained.
- Mac plugin and Windows Worker should be upgraded together.

## Still not verified

- Signed Windows installer.
- Physical Windows 10 22H2 GUI acceptance.
- Physical Windows ARM64 GUI acceptance (native ARM64 CI remains required).
