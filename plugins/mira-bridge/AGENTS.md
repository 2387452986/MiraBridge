# MiraBridge local rules

- The Agent and all semantic completion decisions remain on macOS.
- The Windows worker is a deterministic executor; never add an LLM, planner, conversation store, or autonomous loop.
- Keep the public MCP surface at the declared `mira_bridge_*` tools.
- Use SSH and Windows account permissions; do not add a custom network listener or cryptography.
- File and cwd inputs must pass code-level workspace and allowed-root checks.
- Preserve structured argv. PowerShell remains a separate, higher-risk tool.
- Mock and macOS tests must never be reported as real Windows verification.
