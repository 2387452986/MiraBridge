# MiraBridge 2.0.0-rc.7 security baseline

MiraBridge deliberately gives a Mac-hosted Agent the ability to execute approved operations as one Windows account. It secures transport, constrains Worker-owned paths/capabilities, bounds storage, and records evidence. It is not a sandbox for an untrusted Agent and cannot restrict a native child process beyond the Windows account/ACL boundary.

## Threat summary

Primary risks are a compromised Mac/Agent, incorrect host enrollment, stolen SSH key, overly broad Windows privileges, Junction/TOCTOU escape attempts, dangerous approved commands, malicious archives, logged secrets, browser network escape, replayed cleanup receipts, and compute/disk exhaustion. The repository-grounded abuse paths and mitigations are in [mira-bridge-threat-model.md](mira-bridge-threat-model.md).

## SSH trust

- Use a dedicated Ed25519 key; private key mode should be `0600` on Mac.
- Never put a password, private-key bytes, token, or API key in MiraBridge TOML.
- Treat `ssh-keyscan` as discovery only. Compare SHA-256 with `ssh-keygen -lf` on Windows through an independent channel before enrollment.
- Runtime uses `BatchMode=yes`, `IdentitiesOnly=yes`, `StrictHostKeyChecking=yes`, and a managed `known_hosts` file. Before starting SSH it recomputes every matching managed key fingerprint and requires the configured `host_fingerprint` to match one of them.
- Restrict port 22 to `LocalSubnet` or a trusted VPN. Do not expose a Worker, raw command API, or SSH account to the public internet.
- A host-key mismatch is a hard stop.

## Windows account and authority boundary

The supported product route uses a Windows Administrator account so an approved Mac Agent can perform the same native engineering and maintenance workflows the operator could perform locally. Keep UAC, Defender, firewall, endpoint controls, public-key-only SSH, and the `LocalSubnet`/trusted-VPN network boundary enabled. Do not run the Worker as `SYSTEM`, disable security controls, expose SSH publicly, or grant additional service identities.

Worker file/cwd APIs still enforce explicit roots and Known Folder capabilities. A native executable, `cmd.exe`, or PowerShell can nevertheless use absolute paths and any authority available to Administrator. MiraBridge is not a syscall sandbox or command allowlist. Treat every process/PowerShell/Job approval as administrator code execution; prefer exact structured argv, isolate work under configured roots, inspect unknown repositories before execution, and use Windows EDR/AppLocker/WDAC where the deployment requires stronger control.

The real 2026-08-20/21 acceptance and the broad 2026-08-21 product validation both used the supported Administrator route. They validate functionality and the documented Worker boundaries, not containment of arbitrary administrator processes.

## Filesystem and capability boundary

- `allowed_roots` must be existing absolute drive paths. Do not configure `C:\`, `C:\Users`, system directories, an entire user profile, or network shares.
- UNC, device paths, ADS, relative/traversal forms, wildcard path management, workspace root deletion/replacement, links, Junction escapes, and case-colliding archive names are rejected.
- Every target or nearest existing parent is canonicalized and rechecked before commit.
- Read-only workspaces reject process execution, PowerShell, writes, path management, and incoming transfer.
- Desktop is separately resolved as a Windows Known Folder and separately authorized as `disabled`, `read-only`, or `read-write`; enabling it does not authorize the full profile.
- Recycle Bin and web snapshot are separately disabled by default until configured.

## Processes and approvals

- Prefer structured `program` + `args`. Do not concatenate untrusted shell strings.
- PowerShell is separate, no-profile, non-interactive, encoded, UTF-8, and prompt-gated. The prelude suppresses progress chatter but not real stderr.
- High-impact MCP tools are prompt-gated: process execution, PowerShell, writes/edits/path management, Job start/input/terminal-resize/cancel, transfer, Recycle Bin clear, and Edge snapshot. Reading a terminal snapshot is read-only.
- Graphics-driver installation or replacement is an explicit administrator system change. MiraBridge capability discovery never downloads or installs NVIDIA, AMD, or Intel drivers automatically; use only a user-authorized package from the hardware/OEM vendor and verify its code signature and rollback path.
- Pipe/ConPTY Job control is separately prompt-gated. Only Jobs created with `stdin_mode=pipe|conpty` receive a random local named-pipe endpoint; each write is limited to 64 KiB, the pre-attach buffer is 1 MiB, and explicit EOF closes further input. The packaged ConPTY helper receives launch data over anonymous stdin, not argv, and opens no network listener.
- Timeout/cancel terminates the recorded process tree. Never infer semantic safety from exit code 0.
- System/registry/startup/security/firewall/account/software/volume/model-weight/unknown-download operations require exact user authorization and remain outside default acceptance.

## Transfer security

Files use sequential offsets, declared size, SHA-256, temporary file, flush, and atomic rename. Directories additionally use a controlled full manifest and system tar. Both endpoints reject:

- absolute, traversal, device, ADS, empty, or invalid Windows names;
- duplicate/case-colliding entries;
- symbolic and hard links/Junction sources;
- unknown or invalid UTF-8 tar escapes;
- archive entries not present in the manifest;
- post-extraction count/size/hash mismatch.

Overwrite is atomic exchange with rollback; merge/synchronization is absent. One SQLite owner claim plus PID/start identity prevents concurrent Worker processes from committing or recovering the same transfer. Dead-owner phases are recovered on startup; a live owner is not touched. Failed/unreferenced transfer artifacts are removed under the 24-hour temporary policy.

## Recycle Bin safety

Scanning uses a fixed Worker implementation over the current account's physical `$Recycle.Bin` items; callers cannot substitute a script. The receipt includes drive, physical item, original path, size, deletion/modified times, and SHA-256. It expires after 15 minutes.

Clear accepts only a scoped receipt, recomputes the full snapshot before deletion, consumes the receipt, limits clearing to represented drives, and scans again. A changed/expired receipt performs no delete. A partial clear returns `RECYCLE_BIN_NOT_EMPTY` with per-drive and remaining-item evidence.

Even with this protection, permanent clearing is destructive. Scan and obtain authorization first unless the user has already explicitly authorized that exact operation.

## Browser safety

`web_snapshot` launches a fresh headless Edge context through `playwright-core`; it never opens the user's profile, cookies, extensions, or logged-in session. It allows only HTTP(S), blocks `file:`, `data:`, and browser-internal URLs, performs no clicks/forms/download execution, and writes artifacts only inside the workspace.

Default `local-only` mode aborts external requests and rejects external redirects. `allow-external` requires both Worker configuration and tool approval. This feature is rendering evidence, not general Browser/Computer Use.

## Secrets, audit, and retention

The Worker has no LLM/API key. Job environment values travel through a one-time random local bootstrap pipe and are absent from runner argv, SQLite specs, and audit. Durable Job stdin/ConPTY control uses a separate random local pipe. Audit records only SHA-256, UTF-8 byte count, EOF/control metadata, and terminal dimensions—not input plaintext. Audit otherwise stores operation metadata, program, redacted/hashes-only argument summary, cwd, time, exit/result; environment values are not logged. Sensitive key names and common inline/argv secret forms include `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `AUTHORIZATION`, and `COOKIE`. Audit is appended before a replayable response is committed. If append fails, the result carries `AUDIT_WRITE_FAILED`; operators must stop further mutations because the first side effect may already be real.

Programs can still echo stdin, print secrets, or write them into files. Avoid argv secrets, do not assume stdin is a secret store, use narrowly scoped environment values, and treat Worker data as sensitive.

Retention/quota enforcement is automatic:

| Data | Retention |
| --- | --- |
| Full request responses and normal outputs | 7 days |
| Job logs | 14 days |
| Job metadata/idempotency, request tombstones, audit | 90 days |
| Transfer temporary files | 24 hours |
| Recycle receipt | 15 minutes |

Total Worker storage defaults to 10 GiB with a 2 GiB free-space reserve and 256 MiB per stream. Due-time GC uses a persisted exclusive lease, and disk-producing operations first acquire cross-process capacity reservations. Active/queued Jobs, configuration, SQLite, current operations, and unexpired reservations are protected. Operators can inspect/dry-run/execute pruning with the Worker CLI.

## Incident response

1. Disable the plugin MCP and remove/restrict SSH access for the Windows account.
2. Revoke the user key; rotate host/user keys as appropriate.
3. Preserve audit JSONL, SQLite/WAL, Job/output files, Windows event logs, and relevant Codex records.
4. Inspect live processes and terminate only verified MiraBridge process trees.
5. Review roots, Desktop/Recycle/Edge capabilities, ACLs, recent transfers, and storage/tombstones.
6. Re-enroll only after independent host-fingerprint verification.

## Installation and update trust

- `2.0.0-rc.7` is unsigned. Verify the Setup SHA-256 and GitHub artifact
  attestation from the same Release; SmartScreen reputation is not evidence of
  a hash match.
- Windows update checks run at most daily, only notify automatically, and apply
  only after a user click. Update and uninstall acquire a bounded Worker-owned
  execution-maintenance lease. Lease acquisition checks active Jobs and writes
  the lock transactionally; new Job admission checks that lock in its own
  insertion transaction and returns retryable `NODE_MAINTENANCE`. This prevents
  a new Job from entering after a precheck but before package mutation.
- Before apply, MiraBridge backs up Worker state and copies the exact currently
  installed full package into its durable data root with byte count and
  SHA-256. The new app must pass bundled Worker doctor and SSH-service health.
  Failure launches Velopack's external updater with the re-verified old package;
  an unexpected version or tampered/missing package becomes
  `rollback_failed`/Needs Attention instead of a blind retry loop.
- Diagnostics do not upload automatically. The GitHub Issue action remains
  disabled until a local redacted preview has been generated for the user to
  inspect.

## Non-goals

No multi-tenant isolation, command allowlist, malware scanner, tamper-evident remote audit, public relay/NAT traversal, remote desktop, general GUI/Computer Use, Chrome profile, or arbitrary untrusted-code sandbox is provided. ConPTY is a terminal-only capability and does not control desktop applications.
