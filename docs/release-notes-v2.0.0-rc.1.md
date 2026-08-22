# MiraBridge 2.0.0-rc.1

This release candidate moves MiraBridge into its independent MIT repository and replaces manual installation with a managed Mac runtime, two-code pairing, and a self-contained Windows app.

## Important RC notice

The Windows installers are **not code-signed**. Windows SmartScreen may show an unknown-publisher warning. Download only from this Release, verify `SHA256SUMS`, and use GitHub's artifact attestation. Stable `2.0.0` is blocked on signing plus physical Windows 10 and ARM64 GUI validation.

Use the aggregate `SHA256SUMS` file as the canonical checksum source. The two
Mac `.sha256` sidecars retain a CI-relative filename in this RC; their hash
values are correct, but direct `shasum -c` use requires substituting the asset
basename.

## What changed

- `mirabridge` Git marketplace and selector `mira-bridge@mirabridge`.
- Mac installation without Homebrew, npm, TOML editing or manual SSH commands.
- 30-minute public-key pairing codes plus live pinned Host Fingerprint verification.
- Self-contained Windows x64/ARM64 WPF app with onboarding, status, configuration, repair, local help and tray state.
- Transactional active-Job/update exclusion, Worker/SQLite backup, verified
  previous-package receipt, post-update Worker/SSH health check and external
  rollback path.
- Bundled Node 24.19.0, Worker, Playwright Core and self-contained ConPTY helper.
- Existing RPC 2.0, 28 MCP tools and SQLite v5 remain compatible.

## Not verified in this RC report

Consult `docs/TEST_REPORT.md` for current evidence. This RC does **not** claim:

- physical Windows 10 22H2 or physical ARM64 GUI acceptance;
- a clean Windows VM onboarding run with no Node/.NET/OpenSSH;
- tray startup after a real interactive desktop login;
- an end-to-end old-public-RC download/apply/real-package downgrade (the recovery
  success/failure state paths are Windows-tested);
- destructive full-data uninstall against the live historical data root; or
- Windows code signing/SmartScreen reputation.

Public tag workflow `32605676616` completed native Windows x64/ARM64 jobs,
Intel/Apple Silicon Mac jobs, SHA-256 aggregation, SBOM generation and GitHub
artifact attestation before publishing these assets. This CI evidence is not
substituted for the physical gates above.
