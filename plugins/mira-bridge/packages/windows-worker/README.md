# @mirabridge/windows-worker

Deterministic Windows executor for MiraBridge 2.0.0-rc.7 / RPC 2.0. It contains no LLM, Agent planner, dialogue memory, or semantic task-completion logic. The same package supports Windows x64 and ARM64 with the matching Node 24/.NET 10 runtimes; hardware GPU acceleration is optional.

```text
mirabridge-worker --version
mirabridge-worker doctor
mirabridge-worker serve --stdio
mirabridge-worker jobs list
mirabridge-worker jobs inspect <job_id>
```

Requires Node 24.19+ on Windows and `%LOCALAPPDATA%\MiraBridge\worker.toml` with explicit existing `allowed_roots`.
