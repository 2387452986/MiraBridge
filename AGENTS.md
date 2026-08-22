# MiraBridge agent instructions

- The repository root is the only source owner. The previous PAF copy is migration history until the GitHub-installed chain is verified, then it may be archived separately.
- Read `MODULE_DEVELOPMENT.md` before changing public API, installer, pairing, Worker config, persistence, dependencies or versioning.
- Keep exactly 28 MCP tools, RPC 2.0 and SQLite v5 for 2.0.0-rc.1.
- Preserve `reasoning_host = Mac` and `tool_host = Windows`; Windows never becomes an Agent.
- Use `apply_patch` for focused edits. Preserve unrelated dirty work and never commit credentials or machine-specific pairing state.
- A runtime fix requires `error_before` and `verify_after`. Report Mac, Windows-native, real-LAN and not-run evidence separately.
