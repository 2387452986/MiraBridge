# MiraBridge protocol 2.0

## Transport

The internal protocol is JSON-RPC 2.0, one UTF-8 JSON object per line (NDJSON), over `mirabridge-worker serve --stdio`. In the supported deployment the stdio pair is carried by authenticated OpenSSH. The Worker opens no custom TCP port.

Requests may execute concurrently and responses may arrive out of order. JSON-RPC `id` correlates transport responses; `request_id` owns idempotency. A line is limited to 2 MiB. Worker stdout is protocol-only; diagnostics use stderr.

## Request

```json
{
  "jsonrpc": "2.0",
  "id": "req_123",
  "method": "mirabridge.invoke",
  "params": {
    "protocol_version": "2.0",
    "request_id": "req_123",
    "node_id": "windows-main",
    "operation": "mira_bridge_exec",
    "arguments": {
      "workspace_id": "ws_...",
      "program": "npm.cmd",
      "args": ["run", "test"],
      "cwd": ".",
      "env": {},
      "output_encoding": "auto",
      "timeout_ms": 300000
    },
    "timestamp": "2026-08-21T00:00:00.000Z"
  }
}
```

## Response and errors

```json
{
  "jsonrpc": "2.0",
  "id": "req_123",
  "result": {
    "protocol_version": "2.0",
    "request_id": "req_123",
    "ok": true,
    "result": {
      "exit_code": 0,
      "stdout": "66 tests passed",
      "stderr": "",
      "duration_ms": 18452,
      "timed_out": false,
      "truncated": false,
      "output_ref": null,
      "stdout_encoding": "utf-8",
      "stderr_encoding": "utf-8"
    },
    "duration_ms": 18455
  }
}
```

Failure keeps the envelope and returns one stable error:

```json
{
  "protocol_version": "2.0",
  "request_id": "req_123",
  "ok": false,
  "error": {
    "code": "WORKSPACE_OUT_OF_BOUNDS",
    "message": "Requested path is outside the allowed workspace.",
    "retryable": false,
    "details": {}
  },
  "duration_ms": 2
}
```

## Idempotency

The Worker hashes protocol version, node, operation, and canonical arguments. It atomically admits a request tombstone before execution. Reusing a completed or in-flight `request_id` with the same hash returns the same response without a second operation. Reusing the ID with a changed hash returns `DUPLICATE_REQUEST_ID`. If execution may have happened but the response was never durably stored, replay fails closed with `execution_outcome_unknown=true`; the caller must inspect state rather than repeat a side effect. Transport reconnect retries at most once and retains the ID. After the full response TTL, a 90-day tombstone likewise prevents an expired side effect from being silently replayed. Read-only transfer chunks are the sole replayable operation that intentionally omits the full response cache.

`start_job` also accepts `idempotency_key`; the same key/spec hash returns the original Job. Changed specs are rejected. `cancel_job` returns an already-`cancelled` state idempotently; a naturally terminal Job returns `JOB_ALREADY_FINISHED`.

## Public MCP tools

MiraBridge 2.0.0-rc.4 over protocol 2.0 exposes exactly 28 public names:

```text
mira_bridge_list_nodes          mira_bridge_describe_node
mira_bridge_open_workspace      mira_bridge_list_directory
mira_bridge_stat                mira_bridge_read_text
mira_bridge_write_text          mira_bridge_edit_text
mira_bridge_manage_path         mira_bridge_search_text
mira_bridge_glob                mira_bridge_exec
mira_bridge_powershell          mira_bridge_start_job
mira_bridge_write_job_input     mira_bridge_read_job_terminal
mira_bridge_resize_job_terminal mira_bridge_get_job
mira_bridge_list_jobs
mira_bridge_read_job_logs       mira_bridge_wait_job
mira_bridge_cancel_job          mira_bridge_read_output
mira_bridge_push                mira_bridge_pull
mira_bridge_scan_recycle_bin    mira_bridge_empty_recycle_bin
mira_bridge_web_snapshot
```

`list_nodes` is Mac-local and never enters Worker RPC. File/directory transfer uses private scoped `transfer_*` operations; they are not MCP tools.

## Important 2.0 contracts

- `edit_text`: existing file, required observed SHA-256, 1–64 exact replacements, atomic commit. Missing/ambiguous text fails rather than guessing.
- `manage_path`: exact `mkdir/copy/move/delete`; wildcards forbidden; recursive/overwrite explicit; workspace root cannot be managed.
- `list_jobs`: node, optional executor statuses, stable cursor, maximum 500 results.
- `list_directory`, `glob`, `search_text`, and `list_jobs`: snapshot/keyset cursors bind path/filter/sort; a changed collection returns retryable `RESOURCE_CHANGED` instead of mixing pages.
- `stat`: `hash_mode=auto|always|never`; auto hashes regular files up to 256 MiB and explicitly reports when a larger digest is omitted.
- `read_text`: `include_integrity=true` preserves full line-count/SHA behavior; false may stop after the requested page and returns `scan_complete=false`, no SHA, and a continuation line.
- `exec`/`start_job` output: `output_encoding=auto|utf-8|console|cpNNN`, default `auto`. stdout/stderr are detected independently and stored as UTF-8; results expose resolved encodings.
- `start_job` stdin: `stdin_mode=closed|pipe|conpty`, default `closed`. Pipe/ConPTY modes create one random local runner endpoint that survives MCP/SSH restart. ConPTY defaults to 120×30 and is fixed to UTF-8 VT.
- `start_job` admission and Windows app update/uninstall share one Worker-owned transactional execution-maintenance lease. Existing idempotent retries remain readable, while a genuinely new Job returns retryable `NODE_MAINTENANCE` until maintenance ends or its bounded lease expires.
- `write_job_input`: active pipe/ConPTY Job only; maximum 64 KiB UTF-8 per call; data/VT control bytes and optional EOF are one request-idempotent effect. Audit stores input hash/size/EOF, never plaintext.
- `read_job_terminal`: returns the persisted active ConPTY screen, title, cursor, size, sequence, update time, and final/executor state.
- `resize_job_terminal`: active ConPTY Job only; 20–500 columns and 5–200 rows.
- `push/pull`: `kind=auto|file|directory`; directories are verified archives, not sync/merge.
- `scan_recycle_bin`: optional uppercase drive letters, bounded sample, full snapshot hash, scoped 15-minute receipt.
- `empty_recycle_bin`: accepts only `scan_id`; expired or changed state causes no delete; postcondition requires zero captured-drive items.
- `web_snapshot`: HTTP(S) only, local-only by default, isolated Edge, workspace screenshot, bounded browser evidence.
- `describe_node`: reports native/process architecture plus emulation and a complete display-adapter inventory. Adapter rows add optional vendor/device/driver fields; zero rows is a valid CPU-only node.

## Limits

| Item | Limit/default |
| --- | --- |
| RPC line | 2 MiB |
| Process args | 256 arguments; 32,767 characters each |
| Environment | 128 entries |
| Text write/script | 1 MiB |
| Text read | default 500, maximum 2,000 lines, bounded to 256 KiB |
| Search/Glob page | maximum 256 KiB; stable cursor |
| Search source file | 16 MiB; larger files reported as skipped |
| Inline stdout/stderr | 64 KiB each by default |
| Stored stdout/stderr | 256 MiB each by default; then head + omission marker + 64 KiB tail |
| Output/Job range | 256 KiB |
| Transfer chunk | 512 KiB |
| Directory manifest | 10,000 entries |
| Synchronous timeout | default 5 minutes, maximum 30 minutes |
| Job timeout | maximum 24 hours |
| Job input write | 64 KiB UTF-8 per call; 1 MiB pre-attach buffer |
| ConPTY terminal | default 120×30; 20–500 columns; 5–200 rows; UTF-8 VT |
| `wait_job` | maximum 60 seconds per call |
| Recycle receipt | 15 minutes |

Text supports UTF-8, UTF-8 BOM, UTF-16LE BOM, and UTF-16BE BOM. Binary/unsupported encodings fail explicitly.

## Output lifecycle

`truncated` means the inline MCP preview is incomplete. `output_ref` permits bounded reads while the output remains retained. `storage_truncated` means the Windows file itself contains a bounded head/omission/tail representation; `total_bytes` reports the full drained byte count and `stored_bytes` reports retained bytes after a Job reaches a terminal state. While a Job is running, `read_job_logs` reports the currently readable file size for both counters and sets `counts_final=false`; terminal results set `counts_final=true`.

Expired normal output returns `OUTPUT_EXPIRED`. Pruned Job logs return `JOB_LOGS_EXPIRED`; Job metadata can remain discoverable until its later 90-day retention deadline.

A successful result may contain `audit_warning.code=AUDIT_WRITE_FAILED`. The concrete operation may already have changed Windows, but its JSONL audit append failed. This warning is cached with the request result; clients must stop further mutations and diagnose the Worker rather than retrying the side effect.

## Job states

| State | Executor meaning |
| --- | --- |
| `queued` | Persisted, waiting for a concurrency lease |
| `starting` | Runner claimed a lease and is launching |
| `running` | Process-tree PID recorded |
| `exited` | Process exited; inspect exit code |
| `failed_to_start` | Runner could not launch |
| `cancelled` | Cancellation recorded and tree termination completed/requested |
| `timed_out` | Timeout elapsed and tree termination completed/requested |
| `lost` | Active state cannot reconcile to a live PID |

There is no `task_completed`, `user_goal_achieved`, or equivalent semantic status.

## Error codes

```text
NODE_NOT_FOUND              NODE_OFFLINE
NODE_MAINTENANCE
SSH_AUTH_FAILED             HOST_KEY_MISMATCH
WORKER_NOT_FOUND            PROTOCOL_MISMATCH
INVALID_ARGUMENT            DUPLICATE_REQUEST_ID
WORKSPACE_NOT_FOUND         WORKSPACE_READ_ONLY
WORKSPACE_OUT_OF_BOUNDS     PATH_NOT_FOUND
PATH_IS_BINARY              UNSUPPORTED_ENCODING
FILE_CHANGED                RESOURCE_CHANGED
PROGRAM_NOT_FOUND           PROCESS_START_FAILED
PROCESS_TIMEOUT             JOB_NOT_FOUND
JOB_ALREADY_FINISHED        JOB_INPUT_UNAVAILABLE
TERMINAL_UNAVAILABLE        TERMINAL_SNAPSHOT_UNAVAILABLE
TRANSFER_FAILED
OUTPUT_NOT_FOUND            OUTPUT_EXPIRED
JOB_LOGS_EXPIRED            PERMISSION_DENIED
CAPABILITY_NOT_ENABLED      CONFIRMATION_EXPIRED
RECYCLE_BIN_NOT_EMPTY       BROWSER_UNAVAILABLE
STORAGE_QUOTA_EXCEEDED      INTERNAL_ERROR
```

Only genuine transport/offline conditions are normally retryable. Side-effect retries must retain the request ID or Job idempotency key.

## Compatibility

Versions are `major.minor`. RPC 2.0 intentionally breaks RPC 1.0; matching plugin and Worker generations should still be deployed together. MiraBridge 2.0.0-rc.4 keeps the same 28 tools and Job states while restructuring installation, pairing, update and source ownership. Existing RPC 2.0 consumers remain wire-compatible and ignore new optional result fields; retained state migrates transactionally to SQLite v5. A protocol-major mismatch returns `PROTOCOL_MISMATCH` and is never auto-bridged. Removing required fields, changing types/semantics, renaming tools, or changing Job states requires a new protocol major.
