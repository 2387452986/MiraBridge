# Mac installation

## Supported path

The user asks Codex to install the fixed `v2.0.0-rc.1` tag. Codex should:

1. Clone `https://github.com/2387452986/MiraBridge` at that exact tag.
2. Run `node scripts/verify-release-manifest.mjs release-manifest.json .` if a suitable Node is already available; `install-mac.sh` repeats the check with its managed Node.
3. Run `plugins/mira-bridge/scripts/install-mac.sh`.
4. Run `~/.local/bin/mirabridge doctor` and `mirabridge pair create`.

The installer uses macOS `curl`, `tar`, `shasum` and `sh`. It installs, without `sudo`:

```text
~/Library/Application Support/MiraBridge/
├── cache/                         # verified official Node archive
├── releases/2.0.0-rc.1/
│   ├── node/                      # managed Node 24.19.0
│   ├── mcp/index.mjs
│   ├── cli/index.mjs
│   └── scripts/
└── current -> releases/2.0.0-rc.1

~/.local/bin/mirabridge
~/.config/mirabridge/              # pairing keys, config, managed known_hosts
```

It registers `2387452986/MiraBridge` at ref `v2.0.0-rc.1` using the official Codex marketplace CLI, then installs `mira-bridge@mirabridge`.

## Update and rollback

`mirabridge update 2.0.0-rc.1` downloads the exact tag archive and invokes the same idempotent installer. A new release is staged completely, doctor runs, and only then does the atomic `current` symlink switch remain active. Failure restores the previous link.

## Uninstall

`mirabridge uninstall` removes the plugin and managed runtime but preserves node config, pairing identity and `known_hosts`. `mirabridge uninstall --purge-data` explicitly removes both runtime and local pairing/configuration state. It does not modify the Windows computer.

## Offline/failure behavior

MiraBridge MCP startup reads local configuration only. It does not probe nodes. An offline or absent Windows computer does not block normal Mac file or shell work.
