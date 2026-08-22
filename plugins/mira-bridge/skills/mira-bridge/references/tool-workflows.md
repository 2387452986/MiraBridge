# Tool workflows

## Selection map

| Need | Tool |
| --- | --- |
| List configuration without network access | `mira_bridge_list_nodes` |
| Verify real node capabilities and storage health | `mira_bridge_describe_node` |
| Establish a bounded project or authorized Desktop root | `mira_bridge_open_workspace` |
| Run a native executable or `.cmd`/`.bat` | `mira_bridge_exec` |
| Run an explicit PowerShell script | `mira_bridge_powershell` |
| List or inspect files | `mira_bridge_list_directory`, `mira_bridge_stat` |
| Read or create/replace text | `mira_bridge_read_text`, `mira_bridge_write_text` |
| Make an exact SHA-guarded text change | `mira_bridge_edit_text` |
| Create, copy, move, or delete an exact path | `mira_bridge_manage_path` |
| Find content or names | `mira_bridge_search_text`, `mira_bridge_glob` |
| Start durable work | `mira_bridge_start_job` |
| Write UTF-8 text, VT control keys, Ctrl-C, or EOF to a pipe/ConPTY Job | `mira_bridge_write_job_input` |
| Read or resize a ConPTY active screen | `mira_bridge_read_job_terminal`, `mira_bridge_resize_job_terminal` |
| Recover and inspect Jobs | `mira_bridge_list_jobs`, `mira_bridge_get_job`, `mira_bridge_wait_job`, `mira_bridge_read_job_logs` |
| Cancel a managed process tree | `mira_bridge_cancel_job` |
| Inspect retained synchronous output | `mira_bridge_read_output` |
| Transfer one explicit file or directory | `mira_bridge_push`, `mira_bridge_pull` |
| Scan/clear the current account's Recycle Bin | `mira_bridge_scan_recycle_bin`, `mira_bridge_empty_recycle_bin` |
| Render a loopback webpage in isolated Edge | `mira_bridge_web_snapshot` |

Directory transfer does not synchronize, merge, watch, or resolve conflicts. It verifies a manifest and archive, then installs one complete destination atomically.

`stat` defaults to `hash_mode=auto`: regular files up to 256 MiB receive a SHA-256; larger files return `sha256=null`, `sha256_computed=false`, and an omission reason. Choose `always` only for an acceptance digest and expect a long operation; choose `never` for metadata-only discovery. `read_text` defaults to a complete integrity scan. On a very large file, `include_integrity=false` may stop after the requested page and returns `scan_complete=false`, `sha256=null`, and a continuation line rather than pretending it scanned the whole file.

## Engineering loop

1. Describe the node once before depending on a capability.
2. Open the smallest suitable workspace and inspect existing state.
3. Perform one concrete Windows-native operation.
4. Read the structured result and inspect changed/generated evidence.
5. Decide the next instruction on the Mac.
6. Repeat until the acceptance criteria—not merely the executor—are satisfied.

For an output reference, start with the failing stream tail. `total_bytes` is what the program emitted; `stored_bytes` is the bounded retained representation. If `storage_truncated` is true, expect an explicit omission marker between the head and tail.

Directory, search, glob, and Job listing cursors bind the filter/sort plus a stable snapshot. Continue with the returned cursor unchanged. If the underlying set changes, retryable `RESOURCE_CHANGED` means restart from the first page; combining old and new pages would be incomplete or duplicated.

For a Job, retain both its Job ID and idempotency key. On lost context or transport restart, call `list_jobs` using status filters, inspect the candidate specification/evidence, and continue the same Job. Never duplicate a long task merely because an SSH connection closed.

For an input-driven Job, choose the smallest mode that matches the program:

- `pipe`: ordinary line input or EOF; no TTY, cursor, screen, resize, or control-key semantics.
- `conpty`: REPL, `isatty`, control keys, terminal sizing, ANSI screen state, or a full-screen TUI. Start with explicit dimensions when the defaults do not fit, read the persisted active screen, resize only within advertised bounds, and use VT sequences rather than shell-specific key names.

Read logs until the expected prompt or readiness marker appears, write the smallest exact input, and use `close=true` when the program needs EOF. Each write is bounded to 64 KiB and must retain the same MCP request ID if transport retry occurs. Input plaintext is not written to MiraBridge audit, but the target process may echo it to its own retained stdout/VT log; never send a secret unless that exact program requires it and the user authorized the operation. Both modes survive MCP/SSH restart through the existing durable Job runner; recover the Job with `list_jobs` rather than creating a second terminal session.

## Output encoding

`exec` and non-ConPTY Jobs default to `output_encoding=auto`. stdout and stderr are detected independently: valid UTF-8 remains UTF-8; otherwise MiraBridge decodes the active Windows console code page and stores normalized UTF-8 logs. Inspect `stdout_encoding` and `stderr_encoding` when text matters. Use `console` to force the detected console code page or `cpNNN` only when program documentation/evidence identifies a different Windows code page. An unsupported code page is a stable `UNSUPPORTED_ENCODING` error. ConPTY is always UTF-8 VT and rejects legacy overrides.

## Hardware and architecture

`describe_node.gpu` returns every discovered display adapter. Inspect `vendor`, `device_type`, `driver_version`, status, and vendor runtime evidence instead of taking the first row. Virtual adapters are useful display devices but are not evidence of hardware compute or media acceleration. An empty hardware inventory is a valid CPU-only node and must not block filesystem, process, Job, transfer, or Edge work.

For media or compute work, probe the requested runtime with a short operation: NVIDIA commonly exposes CUDA/NVENC, AMD commonly exposes AMF, and Intel commonly exposes Quick Sync. Do not install or replace a driver merely because an adapter brand is present. If acceleration is optional, preserve the user-visible result with a CPU path and report that the hardware path was not verified; if acceleration is the acceptance target, a CPU fallback does not turn that target green.

Use native `architecture` to choose Windows artifacts. `process_architecture` and `architecture_emulated` disclose whether Node is running under emulation. MiraBridge Worker packages support the Node 24 Windows x64 and ARM64 distributions; 32-bit Windows/x86 is not a supported Node 24 host.

## Mac tool composition

When a document, spreadsheet, presentation, image, archive, or other Windows file must be processed by a Mac-hosted Codex tool, use an explicit pull → local tool → inspect → explicit push sequence. Use a task-scoped Mac staging path and never turn this into an automatic mirror. GitHub, Figma, Sites, web research, and other service connectors continue to run from the Mac Agent and can be used normally alongside Windows project operations.

## Web acceptance

1. Run the server as a durable Job and wait for readiness in its logs.
2. Verify HTTP with `curl.exe` or another installed Windows-native client.
3. Snapshot only an HTTP(S) URL. The default `local-only` policy permits loopback; external mode must be both configured and approved.
4. Treat console errors, page exceptions, bad status, wrong final URL, missing body text, or missing screenshot as failed evidence even if navigation returned.
5. Run the production build and inspect the actual output tree.
6. Pull the explicit source/build/screenshot directory when the user wants it on Mac.

## Recovery and storage

The Worker persists Job metadata and logs independently of SSH stdio. `describe_node` reports current usage, quota, free-space reserve, retention windows, and last GC. If a new disk-producing operation returns `STORAGE_QUOTA_EXCEEDED`, keep status/log reads and cancellation available, inspect `mirabridge-worker storage status`, and prune according to policy instead of deleting active Job evidence.

An atomic transfer may return `backup_cleanup_pending=true` after the new destination is already installed. Verify the destination and let Worker recovery remove the stale backup; do not resend the transfer as though installation failed. If any successful operation returns `audit_warning.code=AUDIT_WRITE_FAILED`, its side effect may be real but the durable audit append failed. Stop additional mutations and run `mirabridge-worker doctor` before continuing.

## Branch handoff

```text
Completed:
Modified files:
Commands:
Verification:
Artifacts:
Unresolved:
```
