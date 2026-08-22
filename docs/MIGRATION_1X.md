# MiraBridge 1.x in-place migration and rollback

Do not start migration while any unknown Job is `queued`, `starting` or `running`.

## Upgrade sequence

1. Record `mirabridge-worker --version`, `doctor`, `jobs list`, storage status and SQLite counts.
2. Back up `worker.toml`, the installed 1.x Worker package and SQLite using `VACUUM INTO`. Hash both backup files.
3. Install MiraBridge for Windows, but keep the 1.x global npm Worker and current Mac node command.
4. Point the new app at the existing `%LOCALAPPDATA%\MiraBridge` data root. RPC 2.0 and SQLite v5 are unchanged; verify Job, Workspace, request, output, log and audit counts.
5. Change the Mac node to the stable quoted `MiraBridge.Host worker serve --stdio` command and complete `describe_node`, file, exec, PowerShell, Job, directory-transfer and Edge-snapshot checks.
6. Only after those pass, remove the old global npm Worker. Preserve its tgz until the RC soak finishes.

## Rollback

1. Stop new MCP sessions; do not cancel user Jobs.
2. Restore the old Mac Worker command and 1.x package.
3. If the database was not changed, keep it. If migration changed it unexpectedly, stop all Workers and restore the `VACUUM INTO` snapshot plus `worker.toml` backup.
4. Run 1.x doctor and query the same historical Job IDs/logs.

Never describe a mock database copy or a fresh empty data root as a successful in-place takeover.
