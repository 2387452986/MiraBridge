# MiraBridge 2.0.0-rc.3

## Important RC notice

This Windows installer is not code-signed. SmartScreen may show an unknown-publisher warning. Download only from this GitHub Release and verify the matching SHA-256 manifest. Stable `2.0.0` remains blocked on signing plus physical Windows 10 and ARM64 GUI acceptance.

## What changed

- Fixed an upgrade-only Mac installer defect found during the real rc.1 → rc.2 rollout. On macOS, a plain `mv -f` followed the existing `current` symlink into the old release directory instead of replacing the link. MiraBridge now uses `mv -fh`, reasserts the selected runtime after plugin installation, and runs a final user-visible doctor.
- Fixed pinned Git marketplace upgrades. MiraBridge now removes only its own installed plugin and marketplace registration, re-adds the exact requested tag, then installs and verifies the matching plugin cache. An rc.1 marketplace can no longer silently remain on rc.1 while the installer reports a newer version.
- Retains the rc.2 Windows product experience: modern task navigation, consistent language/capability selectors, the new mascot icon, visible productivity capabilities, and process-level single-instance/tray ownership.
- Retains the rewritten public README, concrete productivity examples, public-source hygiene checks, and the 28-tool product boundary.

## Compatibility

- RPC remains `2.0`.
- The MCP surface remains exactly 28 tools.
- SQLite remains `user_version=5`; existing Worker data is retained.
- Mac plugin and Windows Worker should be upgraded together.

## Still not verified

- Signed Windows installer.
- Physical Windows 10 22H2 GUI acceptance.
- Physical Windows ARM64 GUI acceptance (native ARM64 CI remains required).
