# MiraBridge 2.0.0-rc.1 implementation checklist

## Product boundary

- [x] `reasoning_host = Mac`, `tool_host = Windows` enforced by ownership.
- [x] Worker has no LLM, Agent loop, dialogue semantics, planner, memory, or goal-completion state.
- [x] Plugin startup and `list_nodes` create no Windows connection.
- [x] Existing PAF/Mira runtime interfaces and unrelated dirty files remain untouched.
- [x] GUI/remote desktop, Chrome profile/extensions, command translation, sync/merge, relay/NAT, and auto-scheduling excluded; ConPTY remains terminal-only.

## Plugin, Skill, and MCP

- [x] Manifest, `.mcp.json`, marketplace entry, Mira-derived logo, Skill, and references present.
- [x] Exactly 28 prefixed tools return MCP text plus `structuredContent`/`isError`.
- [x] Mutating/high-impact tools prompt-gated; read-only discovery/status annotated.
- [x] Lazy reusable strict-host-key OpenSSH stdio; one same-ID reconnect retry.
- [x] Skill routes ordinary Mac work locally and requires real node discovery for Windows.
- [x] Installed-cache MCP smoke sees exactly 28 tools; `list_nodes` leaves the pre-existing system SSH process count unchanged.
- [x] Fresh ephemeral Codex task `01a02a76-9318-7ac0-8c12-0df7419c35a2` loaded final cache `2.0.0-rc.1+codex.20260822171050`, called only `list_nodes`, returned `windows-main`, and kept SSH at 0 before / 0 after. The current older task registry remains task-local and is not release evidence.

## Protocol and migration

- [x] JSON-RPC 2.0/NDJSON, RPC `2.0`, concurrent out-of-order responses, 2 MiB line cap.
- [x] Atomic pre-execution request admission, same-ID/same-payload replay, changed-payload/unknown-outcome rejection, and 90-day tombstone.
- [x] RPC 1→2 breaking upgrade documented; no hidden compatibility bridge.
- [x] Transactional SQLite `user_version=5` migration retains Jobs/workspaces/requests/outputs and adds transfer commit ownership plus process/storage reconciliation metadata.
- [x] Consistent `VACUUM INTO` backup script and rollback procedure supplied.
- [x] Full error model includes capability/resource/storage/browser/retention and retryable `NODE_MAINTENANCE` failures.

## Files, paths, and transfer

- [x] Drive workspace and explicit Known Folder capability; traversal/UNC/device/ADS/outside paths rejected.
- [x] Canonical roots/workspaces, nearest-parent and pre-commit link/Junction rechecks.
- [x] Read-only workspaces reject all mutation/process tools.
- [x] Bounded text encodings/search/glob/read; binary/unsupported encoding explicit.
- [x] Snapshot/keyset pagination prevents directory/glob/search/Job page drift; live mutation returns retryable `RESOURCE_CHANGED`.
- [x] `stat` auto/always/never avoids default hashing above 256 MiB; `read_text` can return an honest partial page without whole-file integrity fields.
- [x] Atomic write plus SHA CAS and exact `edit_text` replacements.
- [x] Structured exact `mkdir/copy/move/delete`, explicit recurse/overwrite, root deletion refused.
- [x] File and directory push/pull; bounded manifest summary, Unicode, tar traversal/link/special-file/collision rejection, one live commit owner, staging/recovery/rollback, no sync.
- [x] macOS AppleDouble suppression and Windows tar octal UTF-8 decode verified on real transfer.

## Processes, output, and Jobs

- [x] Structured argv, native `.exe/.cmd/.bat`, separate encoded no-profile PowerShell, UTF-8/console-code-page auto detection and explicit overrides.
- [x] Sync timeout cap, real exit code, stderr independence, full process-tree termination.
- [x] Every stream drained; inline/range bounds and 256 MiB stored head/omission/tail cap.
- [x] SQLite WAL Job metadata/idempotency/leases, CIM runner, named-pipe bootstrap, persisted logs.
- [x] Runner/child PID start identities and heartbeat reconcile restart/cancel without trusting a reused PID or leaving an unmanaged recorded child.
- [x] Executor-only states, `list_jobs`, bounded wait, restart/SSH-disconnect recovery.
- [x] Worker-owned transactional maintenance lease atomically refuses active Jobs and prevents new Job admission during update/uninstall; existing idempotent Job recovery remains available.
- [x] Pipe-mode durable Job stdin, explicit EOF, 64 KiB call bound, 1 MiB pre-attach bound, request replay protection, and hashed audit metadata.
- [x] ConPTY reuses durable Jobs/input/cancellation; packaged .NET 10 helper, UTF-8 VT, persisted active screen, cursor/title/sequence, resize, control keys, and plaintext-free audit.
- [x] Real Windows process-tree cancellation and 35.241-second forced-disconnect Job passed.

## Product capabilities

- [x] Desktop resolved through current-account Known Folder and separately authorized.
- [x] Recycle scan uses fixed physical implementation, 15-minute receipt, change check, one-time clear, postscan.
- [x] Isolated Edge through `playwright-core`, local-only default, no profile/extensions/interactions, browser evidence and atomic artifacts.
- [x] Vite install/server/curl/desktop+mobile Edge/build/directory pull real LAN flow passed.

## Hardware and architecture portability

- [x] `describe_node` reports native architecture, Node process architecture, emulation state, and a stable support decision.
- [x] Windows x64 and ARM64 are supported; 32-bit `ia32` is explicitly unsupported because Node 24 has no official Windows x86 distribution.
- [x] Portable framework-dependent AnyCPU ConPTY DLL replaces the `win-x64` apphost and is launched through native `dotnet.exe`.
- [x] Complete WMI display-adapter inventory is authoritative; NVIDIA telemetry enriches matching rows without hiding AMD, Intel, Microsoft, virtual, or unknown adapters.
- [x] GPU vendor/device classification and no-GPU behavior are unit-tested; acceleration selection requires a real NVENC/AMF/QSV probe and permits CPU fallback only when the task permits it.
- [x] Physical mixed NVIDIA + AMD + virtual inventory passed; NVENC, AMF, and CPU libx264 probes exited 0 after the authorized NVIDIA 610.88 upgrade.
- [ ] Physical ARM64, Intel GPU, and GPU-less hosts remain environment coverage gaps and are not claimed as real passes.

## Storage lifecycle

- [x] Requests/outputs 7d, Job logs 14d, metadata/tombstones/audit 90d, transfer temp 24h.
- [x] 10 GiB quota, 90% reduction target, 2 GiB reserve, 256 MiB per stream.
- [x] Cross-process capacity reservations plus due-time/pre-write GC with one persisted exclusive lease.
- [x] Active/queued Jobs/config/SQLite/current operation protected.
- [x] Status and prune dry-run/execute CLI implemented and Windows-verified.
- [x] Irrecoverable pressure rejects new disk-producing work while status/read/cancel remain available.

## Verification

- [x] Node 24.19 clean install and Strict TypeScript.
- [x] Mac final gate: 26 files/130 tests, Strict typecheck, build, plugin and Skill validation all pass for `2.0.0-rc.1`.
- [x] Build, Plugin/Skill validators, MCP stdio 28 tools, CLI smoke, and isolated CLI/Worker install pass for 2.0.0-rc.1.
- [x] Three pack dry-runs and production audit with zero vulnerabilities.
- [x] Windows 11 final cross-platform suite: 109 pass / 21 environment-routed skips; targeted Windows suite: 102/102 pass.
- [x] Native Windows suite covers architecture/GPU inventory/portable ConPTY plus CP936, Job stdin/ConPTY across Worker restart, request-id replay, EOF/control keys/resize, plaintext-free audit, and maintenance lease admission.
- [x] Real Desktop, Vite/Edge, directory transfer, Job disconnect, storage, cleanup, and boundary E2E performed.
- [x] Current 1.2 acceptance scanned C/D Recycle Bin without clearing and verified invalid-receipt safe rejection; historical clears are not counted as current evidence.
- [x] Supported Administrator account route exercised through real Desktop, project, browser, Job, storage, Recycle Bin, transfer, and boundary workflows.
- [x] Physical 1.3→1.4 upgrade retained 52 historical Jobs, migrated SQLite to v5, and left zero active storage reservations after real operations.
- [x] 1.4 real LAN regression passed Chinese CAS/search, 300 MiB metadata stat, partial 200,000-line read, split-UTF-8 output paging, 35-second detached Job recovery, ConPTY, process-tree cancel, audit redaction, Edge screenshot, directory conflict/overwrite, and traversal/UNC/ADS/root-delete rejection.
- [x] Final Windows acceptance source used a clean 183-file snapshot without dependencies, build output or embedded package artifacts; the transfer archive/manifest matched before build.
- [x] Final self-contained v8 Setup installed/reinstalled on the physical node with data preserved; real MCP proved maintenance lease block/release and active-Job refusal at the installed Host.

Administrator operation is the product baseline. Worker path enforcement remains verified, but arbitrary administrator processes are intentionally not claimed to be sandboxed.
