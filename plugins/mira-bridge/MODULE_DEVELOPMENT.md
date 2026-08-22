# MiraBridge module development summary

Last updated: 2026-08-23

## Current public contract

- Product: **MiraBridge exposes a Windows computer as a remote native tool runtime for an Agent reasoning on macOS.**
- Version: `2.0.0-rc.1`; protocol: `2.0`; MCP tools: 28; SQLite `user_version`: 5.
- Source owner: this standalone MIT repository. The legacy PAF 1.x module is read-only migration input until the public Git-installed path passes acceptance.
- `reasoning_host = Mac`; `tool_host = Windows`. Windows has no LLM, Agent loop, goal context, semantic memory or completion judgment.
- Mac: managed Node 24.19.0, bundled MCP/CLI, Git marketplace selector `mira-bridge@mirabridge`, two-code pairing with live host-key verification.
- Windows: self-contained .NET 10 WPF app for x64/ARM64, bundled Node/Worker/Playwright/ConPTY, one elevated helper for OpenSSH/firewall/ACL only, no custom listener.
- Administrator is the default product route. Worker file roots, approvals, recycle scan credentials, retention and audit remain enforced.

## Locked design decisions

1. `2.0.0` major reflects installer, pairing, update and ownership reconstruction; RPC/tool/SQLite contracts stay compatible.
2. Pairing codes are base64url JSON, versioned, at most 16 KiB and valid for at most 30 minutes. They contain public material only and never replace live SSH host-key verification.
3. Fresh OpenSSH setup is public-key-only. Existing OpenSSH receives only a versioned managed block; unrelated users, keys, host keys and configuration remain untouched, and access conflicts stop installation.
4. Updates check at most daily, notify first and apply only after a click. Update/uninstall acquire one Worker-owned transactional execution-maintenance lease that atomically excludes active/new Job admission; config and SQLite are backed up before Velopack applies it.
5. Core dependencies are bundled. Optional developer/media tools use explicit WinGet actions and documented official-source fallback. GPU drivers are never managed.
6. RC is unsigned and must show SmartScreen/SHA-256 guidance. Stable `2.0.0` is blocked on signing and physical Windows 10/ARM64 GUI acceptance.
7. First-public-CI checkout/test gate fixes stay within `2.0.0-rc.1`; public/runtime contracts are unchanged.

## Verification evidence

- Mac TypeScript strict typecheck: PASS.
- Mac Vitest: PASS, 26 files / 130 tests after pairing/config, installer-path, public-validator and maintenance-admission additions.
- Public CI error-before: run `32604692142` exposed cross-checkout Manifest bytes plus Windows process-identity tests whose intended operation bound exceeds Vitest's default. Rerun `32604911050` passed the Manifest and transfer regression, then exposed the shared cold CIM identity probe timing out during Job cancellation; it now uses native `System.Diagnostics.Process.StartTime`. Windows verify-after is pending.
- Isolated Mac managed runtime: PASS with verified Node 24.19.0, build, CLI version and doctor; no Homebrew dependency.
- Real Windows 11 x64 `.NET 10.0.400` solution build: PASS, 0 warnings / 0 errors.
- Real Windows client contract runner: PASS, 8/8 including update success/rollback recovery paths.
- Real x64 Setup install/reinstall, in-place state takeover, stable Host switch, reboot Worker recovery and representative file/Job/Edge/transfer LAN loop: PASS.
- Real x64 maintenance race regression: PASS; lease acquisition rejects active Jobs, the held lease rejects MCP `start_job` with `NODE_MAINTENANCE`, and release restores Job admission.
- ARM64, Windows 10, clean VM, signing, interactive-login tray and injected update rollback remain `NOT_RUN` in the canonical root `docs/TEST_REPORT.md`.

## Reusable lessons

- Names shared with framework enums (for example `Architecture`) must be fully qualified in cross-platform host code.
- Exact TTL tests must derive start and expiry from one clock sample; weakening a security boundary to accommodate fixture jitter is incorrect.
- WPF plus WinForms tray support introduces type-name ambiguity; qualify `Application`, `Clipboard` and controls at the owner.
- A self-contained executable should be declared at publish time when a test project references its assembly.
- Quote managed runtime paths containing `Application Support` at invocation.
- Attach WPF change handlers only after ViewModel/DataContext construction and mark read-only bindings one-way.
- A stable stdio Host must pump all three child streams; self-replacement requires an external update receipt rather than blind RPC replay.
- Velopack package integrity is necessary but not a product health check; MiraBridge owns the previous-package hash, recovery receipt, Worker/SSH probe and external rollback.
- RID-qualified release manifests/SBOMs prevent x64/ARM64 asset collision during publication.
- An active-Job precheck alone is a TOCTOU bug; upgrade/uninstall and durable Job admission must share a transactional SQLite lease owned by the Worker.
- Byte manifests require LF-normalized Git checkout and explicit PowerShell native-exit checks; `$ErrorActionPreference` alone did not stop a failed Node verifier.
- Keep slow Windows WMI/taskkill ownership tests real, but give only those tests their operation-sized timeout instead of hiding the signal with a global timeout.
- Do not put cold CIM module loading on the Job cancellation path; query `System.Diagnostics.Process.StartTime` so the PID-reuse guard remains fail-closed without WMI startup latency.

## Open release gates

- GitHub authentication and public repository/tag/prerelease creation.
- Interactive-login tray startup, old-RC update/rollback, clean-VM onboarding and full-purge uninstall evidence.
- Native ARM64 runner artifacts and a physical ARM64 GUI smoke.
- Physical Windows 10 22H2 VM smoke.
- Windows code-signing certificate before stable `2.0.0`.
