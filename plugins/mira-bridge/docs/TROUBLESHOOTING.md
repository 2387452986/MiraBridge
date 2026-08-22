# MiraBridge 2.0.0-rc.1 troubleshooting

Start with `mirabridge doctor` on Mac and `mirabridge-worker doctor` plus `storage status` under the SSH account on Windows. Preserve exact error codes/details.

## Plugin or tools are absent

```bash
cd <MiraBridge-clone>/plugins/mira-bridge
npm run build
codex plugin marketplace list
codex plugin list --json
```

Confirm `mira-bridge@mirabridge` is installed/enabled and open a new Codex task after update. `npm run smoke:stdio` must list 28 tools. MCP diagnostics belong on stderr; stdout is stdio protocol.

## Node runtime rejected

The normal Mac installer and Windows Setup bundle Node 24.19.0. Check the
managed Mac runtime first:

```bash
"$HOME/Library/Application Support/MiraBridge/current/node/bin/node" --version
mirabridge doctor
```

On Windows, run the app's **Repair** action and inspect its redacted diagnostics.
For development builds only, verify the source-selected Node and Worker from the
actual non-interactive SSH account.

## `NODE_OFFLINE` / `SSH_AUTH_FAILED`

- Check host, port, sleep/VPN route, `Get-Service sshd`, and firewall scope.
- Confirm the matching public key and Windows OpenSSH ACLs.
- Confirm Mac private key mode `0600` and configured identity path.
- MiraBridge uses `BatchMode`; it will not display/fallback to a password prompt.
- One reconnect uses the same request ID. Repeated blind side-effect retries are intentionally absent.

## `HOST_KEY_MISMATCH`

Stop. Do not delete `known_hosts` reflexively. Compare the current Windows host key locally. Only explicit, independently verified re-enrollment can replace a legitimate rotated/reinstalled host key.

## `WORKER_NOT_FOUND`

```bash
mirabridge node test windows-main
```

The paired node command must target the stable quoted
`MiraBridge.Host.exe worker serve --stdio` path. Run Windows **Repair** if that
host is missing; do not fall back to an npm-global Worker or shell translation.

## `PROTOCOL_MISMATCH`

MiraBridge product/packages should both be 2.0.0-rc.1 and RPC must be 2.0. RPC 1.0 and 2.0 are intentionally incompatible; MiraBridge 1.0–1.4 share RPC 2.0, while older products may lack later Job input, encoding, ConPTY, complete hardware inventory, or reliability metadata. Implicit 1.4 defaults are omitted for unchanged rolling-upgrade calls, but an explicitly requested 1.4-only field can be rejected by an older strict Worker. Stop MCP sessions, back up Worker state, upgrade/rollback Mac plugin and Windows Worker together, then run `node test`/`describe_node`.

## `WORKSPACE_OUT_OF_BOUNDS` / `WORKSPACE_READ_ONLY`

The Worker rejects traversal, UNC/device/ADS, broad/outside roots, wildcards in path management, and link/Junction escapes. Use an existing absolute drive path for workspace open and relative paths thereafter. For Desktop, use the actual Known Folder returned by `describe_node`. Open read-write only when mutation is required.

## `FILE_CHANGED` / `RESOURCE_CHANGED`

Re-read the file/resource and its SHA/snapshot, review concurrent changes, and issue a new precise operation. A directory/glob/search/Job cursor is bound to its original filter/snapshot; discard it and restart the listing after retryable `RESOURCE_CHANGED`. Do not omit CAS or reuse a cleanup receipt just to force success.

## Slow `stat` or large text inspection

Use `hash_mode=auto` (default) or `never` for metadata discovery; auto does not hash files larger than 256 MiB. Choose `always` only when the digest is an acceptance requirement. `read_text` defaults to a complete integrity scan; for a quick page from a huge file set `include_integrity=false` and continue from `next_start_line`. A partial scan deliberately has no total-line count or SHA-256.

## `PROGRAM_NOT_FOUND`

Use `describe_node`, then a Windows-native program. npm scripts generally need `npm.cmd`; PowerShell is a separate tool. There is no Bash translator.

## Mojibake or `UNSUPPORTED_ENCODING`

Leave `output_encoding=auto` unless there is evidence to override it. The Worker probes stdout/stderr independently and reports each resolved encoding. `auto` keeps strict UTF-8 or falls back to the active console code page; `console` forces that page; `cpNNN` is for a documented legacy program encoding. Unsupported pages fail before ambiguous text is stored. ConPTY output is always UTF-8 VT and rejects legacy overrides.

## Job missing, `lost`, or logs expired

- Use `mira_bridge_list_jobs` after MCP/context restart before resubmitting.
- Inspect `jobs inspect`, stderr/log tail, audit, Event Viewer, WMI service, and recorded PID.
- Normal SSH loss should not kill a CIM-created runner. `lost` is not success.
- `JOB_LOGS_EXPIRED` means the 14-day log TTL elapsed while metadata may still exist. Recover required artifacts before retention expiry.

## Output truncation or expiry

Inline previews truncate above 64 KiB. Read stderr tail first, then narrow ranges through `read_output`/`read_job_logs`. `storage_truncated` means the Worker retained bounded head/omission/tail after draining the full stream. `OUTPUT_EXPIRED` means the 7-day output TTL elapsed.

## `STORAGE_QUOTA_EXCEEDED`

```powershell
mirabridge-worker storage status
mirabridge-worker storage prune --dry-run
mirabridge-worker storage prune --execute
```

Check `used_bytes`, 10 GiB quota, 90% target, free space, 2 GiB reserve, active Jobs, and last GC. GC never removes active/queued Jobs. Cancel only verified Jobs or expand storage policy intentionally; do not delete `%LOCALAPPDATA%\MiraBridge` manually.

## Directory transfer fails

Inspect error details for traversal/link/case collision/invalid name/manifest hash. Mac packing disables AppleDouble metadata. Windows tar may list UTF-8 names as octal escapes; MiraBridge decodes only valid UTF-8 sequences. Do not weaken archive equality or enable link extraction. Ensure destination parent is on the same volume for atomic exchange. If a completed call reports `backup_cleanup_pending=true`, verify the installed destination and let startup recovery remove the stale backup; do not resubmit the already-installed transfer.

## `AUDIT_WRITE_FAILED` warning

This is a warning on an otherwise successful operation, not proof that the operation failed. The Windows side effect may already exist, while the durable JSONL append did not. Stop further mutations, run `mirabridge-worker doctor` and storage checks, preserve stderr/disk evidence, and repair the data-root permission/capacity problem before continuing. Replaying the original side effect can duplicate or reverse real work.

## `JOB_INPUT_UNAVAILABLE`

Confirm the Job was created with `stdin_mode=pipe|conpty`, is not terminal, and has not already received EOF. Recover the Job with `list_jobs` after reconnecting; do not create a duplicate. Each call is at most 64 KiB UTF-8. Use pipe for ordinary line input and ConPTY only for TTY/control-key/screen semantics.

## `TERMINAL_UNAVAILABLE` / snapshot unavailable

Run Windows **Repair**, Worker doctor and `describe_node`. A complete Setup
contains the architecture-matched, self-contained ConPTY helper; users do not
install a separate .NET runtime. Source developers must build it with
`npm run build:windows`. If `architecture_supported=false`, use a supported
64-bit x64 or ARM64 Windows installation; 32-bit Windows is unsupported.
`read_job_terminal` works only for a ConPTY Job and while its 14-day Job-log
evidence is retained. Resize accepts 20–500 columns and 5–200 rows.

## Missing, duplicated, or unusable GPU acceleration

`describe_node.gpu` is a complete display-adapter inventory, so mixed NVIDIA/AMD/Intel/virtual rows are normal and an empty hardware list is valid for CPU-only operation. Choose a hardware path only after a short real runtime probe; FFmpeg listing `h264_nvenc`, `h264_amf`, or `h264_qsv` does not prove the corresponding driver session can start. A graphics-driver update is an explicit system operation, not an automatic MiraBridge repair. If hardware acceleration is optional, use a verified CPU path and report the hardware result separately.

## `BROWSER_UNAVAILABLE` or snapshot failure

- Confirm installed Edge path in `describe_node` and update Edge.
- Use HTTP(S), normally a loopback URL; `file:`, `data:`, browser-internal schemes, external redirects/requests, and existing profiles are refused.
- Keep a server running as a Job and verify it with `curl.exe` before Edge.
- Review status/final URL/title/body, blocked requests, console/page errors, and screenshot path.

## Recycle Bin errors

- `CAPABILITY_NOT_ENABLED`: enable only after reviewing account/capability scope.
- `CONFIRMATION_EXPIRED`: scan again; receipts live 15 minutes.
- `RESOURCE_CHANGED`: contents changed; nothing was deleted by that call. Scan/review again.
- `RECYCLE_BIN_NOT_EMPTY`: inspect per-drive failures and remaining count/bytes; do not claim success.

## Real acceptance versus simulation

Fake SSH proves MCP/RPC orchestration only. Run protocol/Worker tests and `integration-tests\windows-local.mjs` on Windows, then LAN E2E. Record account type and raw results. Administrator is the supported route; a passing boundary test proves Worker path/capability enforcement, not that an approved native administrator process is sandboxed.
