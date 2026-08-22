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
4. Updates check at most daily, notify first and apply only after a click. Update/uninstall must first acquire the Worker's transactional execution-maintenance lease: the same SQLite transaction rejects an existing active Job or prevents any new Job admission until maintenance finishes or the bounded lease expires. Config and SQLite are backed up before Velopack applies an update.
5. Core dependencies are bundled. Optional developer/media tools use explicit WinGet actions and documented official-source fallback. GPU drivers are never managed.
6. RC is unsigned and must show SmartScreen/SHA-256 guidance. Stable `2.0.0` is blocked on signing and physical Windows 10/ARM64 GUI acceptance.

## Verification evidence

- Mac TypeScript strict typecheck: PASS.
- Mac Vitest: PASS, 26 files / 130 tests after pairing, config, installer-path, public-validator and atomic maintenance-admission additions.
- Isolated Mac managed runtime: PASS with verified Node 24.19.0, build, CLI version and doctor; no Homebrew dependency.
- Real Windows 11 x64 `.NET 10.0.400` solution build: PASS, 0 warnings / 0 errors.
- Real Windows client contract runner: PASS, 8/8 (TTL/fingerprint, replay, SSH preservation, authorized keys, redaction, update success/rollback states, ViewModel).
- Real self-contained x64 Setup: PASS, installed/reinstalled on the physical node; 249,668,318 bytes, SHA-256 `87e954b08e00b03632feaace2aa15280f65c90b3d0c1fd0903edf29e521d3338`.
- In-place takeover: PASS; baseline 66 Jobs/54 Workspaces/1,876 Requests/419 Outputs and the final acceptance snapshot 99/84/2,344/498 show retained and increasing durable state.
- Atomic maintenance admission: PASS on the physical node. An acquired lease rejected a real MCP `start_job` with retryable `NODE_MAINTENANCE`, release allowed the Job, an active Job made lease acquisition fail closed, and the installed v8 Host repeated the block/release result.
- Stable Host, old global-Worker removal, SSH preservation, reboot Worker recovery, real file/Job/Edge/directory-transfer loop: PASS.
- ARM64, Windows 10, clean VM, signing, login-triggered tray and injected update rollback remain `NOT_RUN` in `docs/TEST_REPORT.md`.

## Reusable lessons

- Names shared with framework enums (for example `Architecture`) must be fully qualified in cross-platform host code.
- Exact TTL tests must derive start and expiry from one clock sample; weakening a security boundary to accommodate fixture jitter is incorrect.
- WPF plus WinForms tray support introduces type-name ambiguity; qualify `Application`, `Clipboard` and controls at the owner.
- A self-contained executable should be declared at publish time when a test project references its assembly.
- Shell variables that contain the managed `Application Support` path must be quoted at invocation, not only assignment; the real default install caught this.
- WPF XAML events can fire during `InitializeComponent`; attach handlers only after the ViewModel/DataContext exists, and make bindings to read-only controls explicitly one-way.
- A stable console host must pump child stdin, stdout and stderr. Launching the child is insufficient for an SSH stdio protocol.
- Replacing the binary that owns an active RPC connection can make a successful side effect outcome-unknown. Do not blindly replay self-update; use an external updater/receipt boundary.
- Velopack verifies/applies packages but does not know MiraBridge health. Product rollback therefore owns a durable receipt, previous full-package byte/hash check, Worker/SSH probe and external old-package apply.
- Cross-architecture release artifacts need RID-qualified manifest/SBOM names and collision-checked flattening before GitHub Release upload.
- A check-then-update active-Job gate is racy: another client can start a Job between the count and installer mutation. Serialize Job admission and upgrade/uninstall with one transactional Worker-owned lease; do not duplicate this authority in the GUI.

## Open release gates

- GitHub authentication and public repository/tag/prerelease creation.
- Interactive-login tray startup, old-public-RC click update/real package downgrade and full data-purge uninstall evidence.
- Clean Windows VM onboarding with no Node/.NET/OpenSSH.
- Native ARM64 runner artifacts and a physical ARM64 GUI smoke.
- Physical Windows 10 22H2 VM smoke.
- Windows code-signing certificate before stable `2.0.0`.
