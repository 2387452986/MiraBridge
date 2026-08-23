# MiraBridge 2.0.0-rc.2 tool parity

## Measured Codex surface

The callable registry captured in the implementing Codex task on 2026-08-21 contained 224 tools. It is runtime/plugin dependent and can change between tasks:

| Owner | Count | Windows-task behavior |
| --- | ---: | --- |
| Core Codex primitives | 12 | Four host-bound primitives map through MiraBridge; control/goal/resource primitives remain on the Mac Agent. |
| Codex app/task control | 18 | Remains on Mac; Windows is not a second task or Agent. |
| Connected apps | 158 | Remain Mac-hosted service calls: document control 3, Figma 33, GitHub 89, hotline 1, plugin management 4, safety settings 5, Sites 23. |
| Node REPL | 3 | Remains Mac-hosted; use Windows `node.exe` through `exec`/Jobs when execution locality matters. |
| OpenAI developer docs | 5 | Remains Mac-hosted and can be used while working on Windows files. |
| Image generation | 1 | Remains Mac-hosted; push generated assets to Windows explicitly. |
| Standalone plugin management | 1 | Remains Mac-hosted. |
| Web research | 1 | Remains Mac-hosted. |
| Installed MiraBridge 1.0 registry | 25 | Current long-lived task snapshot; it cannot hot-add a tool. |

The 2.0.0-rc.2 source exposes 28 MiraBridge tools. A new Codex task after plugin reinstall is the pickup boundary. Verification must inspect the new task rather than infer a total from older task-local registries.

## Host-bound primitive mapping

| Codex behavior | MiraBridge composition | Contract |
| --- | --- | --- |
| `exec_command` | `mira_bridge_exec` for bounded synchronous work; `start_job/get_job/list_jobs/wait_job/read_job_logs/cancel_job` for persistent work | Windows-native `program` plus `args`; no Bash translation. |
| `write_stdin` | Use `stdin_mode=pipe` for lines/EOF or `conpty` for TTY/control keys; call `write_job_input`, `read_job_terminal`, and `resize_job_terminal` as needed | Survives MCP/SSH restart because the runner owns one durable local control endpoint. |
| `apply_patch` | `read_text` + observed SHA-256 + `edit_text`; use `write_text` for deliberate creation/replacement and `manage_path` for exact path effects | Atomic, compare-and-swap guarded; no custom diff parser. |
| `view_image` | `pull` the explicit Windows image to a task-scoped Mac staging path, then use local vision | Webpages should first use Windows Edge `web_snapshot`; the screenshot can then be pulled and visually inspected. |

File search/list/stat/glob, output paging, PowerShell, Desktop, Recycle Bin, file/directory transfer, browser rendering, storage diagnostics, and durable process recovery have direct namespaced tools rather than relying on shell emulation.

## Composing the rest of Codex

MiraBridge does not clone every Mac-hosted connector into the Worker. The Mac Agent keeps its full tool registry while it routes only Windows file/process effects through MiraBridge:

1. Pull an explicit Windows input file or directory to a task-scoped Mac staging path.
2. Call the normal Mac-hosted file processor, image generator, document/spreadsheet/presentation skill, GitHub/Figma/Sites connector, web research tool, or other service.
3. Inspect the result on the Mac.
4. Push only the requested artifact back to the explicit Windows destination.

This is a bounded workflow composition, not a hidden sync engine. Service-side tools such as GitHub or Figma need no Windows mirror because they are neither Mac filesystem nor Windows filesystem operations.

## Explicit gaps

- Computer Use, remote desktop, mouse/keyboard/screen control, Chrome extensions, and an existing logged-in browser profile remain non-goals.
- ConPTY covers console REPL/TUI semantics, not arbitrary Windows GUI applications, hidden password harvesting, or attachment to an existing user console. Prompts still require explicit approved input.
- Mac-only app UI state cannot be transplanted to Windows. File-based Office/media workflows are supported by pull/process/push; live control of a Windows GUI application is not.
- Tool registries are dynamic. This document records the measured surface and routing rule; it does not promise that unknown future plugins automatically acquire a Windows implementation.

The parity claim for 2.0.0-rc.2 is therefore: ordinary non-GUI engineering, file-based workflows, native CLI networking, and interactive console/TUI work can close over a Windows x64 or ARM64 execution environment with NVIDIA, AMD, Intel, mixed, virtual, or no hardware GPU, while the Agent and its service connectors remain on macOS. Hardware-specific acceleration still requires a real runtime probe. It is not a claim that a headless Worker is a Windows desktop session.
