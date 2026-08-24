# Mac installation

## Supported path

The user asks Codex to install the fixed `v2.0.0-rc.6` tag. Codex should:

1. Clone `https://github.com/2387452986/MiraBridge` at that exact tag.
2. Run `node scripts/verify-release-manifest.mjs release-manifest.json .` if a suitable Node is already available; `install-mac.sh` repeats the check with its managed Node.
3. Run `plugins/mira-bridge/scripts/install-mac.sh`.
4. Run `~/.local/bin/mirabridge doctor` and `mirabridge pair create`.

The installer uses macOS `curl`, `tar`, `shasum` and `sh`. It installs, without `sudo`:

```text
~/Library/Application Support/MiraBridge/
├── cache/                         # verified official Node archive
├── releases/2.0.0-rc.6/
│   ├── node/                      # managed Node 24.19.0
│   ├── mcp/index.mjs
│   ├── cli/index.mjs
│   └── scripts/
└── current -> releases/2.0.0-rc.6

~/.local/bin/mirabridge
~/.config/mirabridge/              # pairing keys, config, managed known_hosts
```

It removes only an existing MiraBridge plugin/marketplace registration, registers
`2387452986/MiraBridge` at the exact `v2.0.0-rc.6` ref using the official Codex
marketplace CLI, then installs `mira-bridge@mirabridge`. Replacing the
registration is intentional: a Git marketplace first added at an immutable RC
tag remains pinned to that tag when merely refreshed.

## Update and rollback

`mirabridge update 2.0.0-rc.6` downloads the exact tag archive and invokes the
same idempotent installer. A new release is staged completely, doctor runs, and
the macOS directory symlink is replaced with `mv -fh` so the link itself—not
its old target directory—is updated. After the Codex plugin cache is replaced,
the installer reasserts the selected runtime and runs a final user-visible
doctor. Failure before that handoff restores the previous link.

## Uninstall

`mirabridge uninstall` removes the plugin and managed runtime but preserves node config, pairing identity and `known_hosts`. `mirabridge uninstall --purge-data` explicitly removes both runtime and local pairing/configuration state. It does not modify the Windows computer.

## Offline/failure behavior

MiraBridge MCP startup reads local configuration only. It does not probe nodes. An offline or absent Windows computer does not block normal Mac file or shell work.
