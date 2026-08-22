---
name: mira-bridge
description: Use MiraBridge when the user asks Codex to inspect, edit, run, test, render, build, scan, transfer, or manage files and processes on a paired Windows computer from a Mac-hosted Agent. Also use it for a Windows GPU, Windows-only toolchain, Desktop, Recycle Bin, or an explicitly named Windows project or path. Do not use it for ordinary Mac-local work unless the user explicitly targets Windows.
---

# MiraBridge

MiraBridge exposes Windows as a deterministic remote native tool runtime. Keep reasoning, planning, acceptance judgment, and the Agent loop on macOS. The Windows Worker executes concrete operations and returns evidence; it is not an Agent and never runs Codex or another LLM.

## Route deliberately

1. Keep ordinary Mac reads, edits, commands, and tests local when the user has not targeted Windows.
2. Use `mira_bridge_list_nodes` only when node discovery is needed; it does not connect.
3. Before the first remote operation, call `mira_bridge_describe_node`. Use its real paths, native/process architecture, capability access, shells, complete display-adapter inventory, Edge, native tools, and storage status instead of guessing.
4. Open the smallest Windows workspace before project file or process work. Use `read-only` when inspection is sufficient.
5. For a wholly Windows-targeted task, route its project file and process operations through MiraBridge. This is tool routing, not session migration.

Never probe Windows at plugin startup, reroute unrelated Mac work, or let an offline node block local tools.

The product defaults to a Windows Administrator account. This enables local-equivalent work but does not broaden user authorization: treat exec, PowerShell, and Jobs as administrator code execution, keep operations exact, and never silently change system/security state. Worker roots constrain file tools and cwd, not a native process's own system access.

## Operate natively and close the loop

- Generate Windows-native commands. Prefer structured `mira_bridge_exec` with separate `program` and `args`, such as `npm.cmd` plus `["run", "test"]`. Never send Bash for translation.
- Treat `gpu` as an inventory, not a single preferred device. A node can expose NVIDIA, AMD, Intel, virtual adapters, or no hardware GPU. Select CUDA/NVENC, AMF, or QSV only after the matching adapter and runtime probe both succeed; keep a CPU path when acceleration is optional. An encoder name in a tool listing is not proof that its driver path works—run a short real probe before a long Job.
- Use `architecture` for the native Windows architecture and `process_architecture` to detect emulation. Prefer native x64 or ARM64 binaries when available; do not assume every Windows download is x64.
- Keep `output_encoding=auto` for normal execution. MiraBridge first accepts strict UTF-8 and otherwise decodes the active Windows console code page. If evidence is still wrong because a program uses a non-console legacy encoding, rerun only that operation with an explicit `console` or `cpNNN` override and report the resolved stdout/stderr encodings. Do not repair mojibake with program-name exceptions.
- Reserve `mira_bridge_powershell` for a real scripting need. It is higher risk and approval-gated.
- Read before editing. Prefer `mira_bridge_edit_text` with the observed SHA-256 for exact existing-file changes; use `write_text` for deliberate creation or whole-file replacement.
- Use `mira_bridge_stat` with its default `hash_mode=auto` for normal metadata: files up to 256 MiB are hashed, while larger files return explicit hash-omission metadata instead of blocking the task. Request `always` only when a full digest is genuinely required, or `never` for metadata-only inspection.
- Keep `include_integrity=true` when `read_text` must provide a complete line count and SHA-256. For a quick page from a very large file, use `include_integrity=false`, retain `next_start_line`, and do not claim whole-file integrity from that partial scan.
- Use `mira_bridge_manage_path` for exact `mkdir/copy/move/delete`. Do not emulate these with wildcard shell strings.
- Use durable Jobs for servers, renders, builds, scans, inference, and long tests. Supply an idempotency key. If context or MCP restarts, recover with `mira_bridge_list_jobs`; do not resubmit blindly.
- Use `stdin_mode=pipe` for a managed process that reads ordinary lines or EOF without terminal semantics. Use `stdin_mode=conpty` only for a REPL, control keys, terminal-size-aware program, or full-screen TUI. For ConPTY, read the active screen with `mira_bridge_read_job_terminal`, resize with `mira_bridge_resize_job_terminal`, and send text, VT direction-key sequences, Ctrl-C (`\u0003`), or EOF through `mira_bridge_write_job_input`. ConPTY Job output is UTF-8 VT by contract; do not request a legacy encoding override.
- Page files, searches, outputs, and logs. For large failures, read stderr or the log tail first, then only relevant ranges. A storage omission marker means the Worker drained the full stream but retained a bounded head and tail.
- Directory, glob, search, and Job cursors are snapshot/keyset cursors. If a page returns retryable `RESOURCE_CHANGED`, discard that cursor and restart the listing; never splice pages from two different snapshots.
- Transfer an explicit file or directory with `push`/`pull`. Directory transfer is one verified archive and atomic replacement, not synchronization or merge.
- Treat `backup_cleanup_pending=true` as a completed install with deferred cleanup evidence, not as an automatic retry signal. Inspect the destination and Worker storage state; retrying the original transfer can duplicate work.
- To use a Mac-hosted Codex file processor or connected service on a Windows artifact, pull only the explicit input to a task-scoped Mac staging path, call the normal tool, inspect its output, and push back only the requested result. Keep the reasoning/tool call on Mac and do not describe this composition as Windows running that connector.
- For a webpage, start its server as a Job, verify HTTP with a Windows-native client, then use `mira_bridge_web_snapshot` for isolated Edge rendering. Inspect status, final URL, title, body summary, console errors, page errors, and screenshot; pull artifacts to the Mac when requested.
- Use the Desktop path returned by `describe_node`; do not assume `C:\Users\...\Desktop` because Known Folders can be redirected.
- Scan the Recycle Bin first. `empty_recycle_bin` requires the unexpired scan receipt and will stop if contents changed. Unless the user already authorized the exact clearing action, present the scan and obtain confirmation before emptying.

After every operation, inspect the structured result, exit code, stdout, stderr, changed/generated files, and the user's acceptance target. Non-empty stderr is not automatically failure. Exit code `0` or Job state `exited` reports executor state only; neither proves the user goal is complete.

If a successful result contains `audit_warning.code=AUDIT_WRITE_FAILED`, stop further mutations and run Worker doctor/storage diagnostics. The requested Windows side effect may already have occurred; do not blindly retry it.

Read [tool-workflows.md](references/tool-workflows.md) for tool selection, encoding, pipe/ConPTY Jobs, transfer, Edge, and recovery. Read [safety-rules.md](references/safety-rules.md) before deletion, cleanup, Desktop writes, Recycle Bin clearing, system changes, or unknown downloads.

## Report a Windows branch

Return completed work, modified files, native commands, verification evidence, generated artifacts, and unresolved issues. State executor status and exit code exactly. Never claim Windows was thinking, planning, or autonomously deciding completion.

## Examples

### A. Remote test and repair

User: “把这个测试任务交给 Windows 电脑执行。”

Describe the node, open the project workspace, run the native test command, inspect failures, read the affected files, apply SHA-guarded exact edits, rerun tests, inspect artifacts, judge the acceptance target on the Mac, and report evidence. If the runtime disconnects, use `list_jobs` to recover the existing Job.

### B. Independent Windows webpage

User: “在 Windows 的 `D:\Projects\Website` 中制作一个网页。”

Describe the node, open the workspace, inspect or create the project, install with `npm.cmd`, start the server as a Job, verify its loopback HTTP response, render desktop and mobile screenshots with Edge, inspect browser errors, build production output, verify it, and pull the requested source/build/screenshots to the Mac.

### C. Windows cleanup scan

User: “检查一下 Windows 哪些垃圾可以清理。”

Run read-only size and Recycle Bin scans. Analyze the evidence on the Mac and separate safe caches, unknown user data, and high-risk locations. Present exact candidates. After authorization, use the precise structured delete or the matching Recycle Bin scan receipt, then rescan and report actual reclaimed space. Never delete from a broad category or process exit code alone.
