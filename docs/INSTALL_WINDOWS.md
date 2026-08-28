# Windows installation

## Requirements handled by Setup

The x64 and ARM64 Setup packages are self-contained. A clean machine does not need Node.js, .NET or OpenSSH beforehand. Setup includes:

- self-contained .NET 10 WPF app, stable console host and elevated helper;
- Node.js 24.19.0 for the current architecture;
- MiraBridge Worker, Playwright Core and xterm headless;
- self-contained architecture-matched ConPTY helper.

32-bit x86 Windows is rejected with an actionable 64-bit requirement.

The x64 Velopack application lives under `%LOCALAPPDATA%\MiraBridge.Windows`; ARM64 uses the RID-distinct `%LOCALAPPDATA%\MiraBridge.Windows.ARM64` package root so both release feeds have unique GitHub asset identities. Durable Worker configuration, SQLite, Job logs and audit data remain under the separate `%LOCALAPPDATA%\MiraBridge` data root. Updates and app uninstall therefore cannot replace Worker state by owning the same directory.

## First run

1. Compare Setup against the matching `MiraBridge.Windows-<RID>-2.0.0-rc.7.sha256.json` from the same GitHub prerelease.
2. Expect an unsigned-publisher SmartScreen warning for this RC. Do not continue if the download source or digest differs.
3. Open MiraBridge and click **Install / Repair** once. The separate helper asks for UAC only for OpenSSH, firewall and ACL changes.
4. Existing OpenSSH is preserved. MiraBridge adds or replaces only the `# BEGIN MIRABRIDGE 2.0` block, preserves host keys/other public keys, validates `sshd_config`, and stops on `AllowUsers`/`DenyUsers` conflicts.
5. The owned firewall rule allows TCP 22 from `LocalSubnet` on private/domain profiles. No second SSH service or custom network listener is created.

The tray app may exit without interrupting the Worker or durable Jobs: SSH launches the stable `MiraBridge.Host worker serve --stdio` path on demand.

## Configuration ownership

The GUI never edits TOML itself. It calls Worker JSON commands:

```text
config show
config init [ROOT]
config add-root PATH
config remove-root PATH
config set-capability desktop|recycle-bin|web-snapshot|web-snapshot-external VALUE
```

Worker Schema validation, atomic replacement and `.bak` creation remain the single owner.

## Optional tools

The maintenance page installs Git, PowerShell 7, Python, Node SDK, .NET 10 SDK or FFmpeg only after a click. WinGet is preferred. If it is unavailable, local Help links to publishers' official installers. MiraBridge never installs or upgrades NVIDIA, AMD or Intel display drivers.

## Update and recovery

The app checks at most once per day and only displays availability. Clicking
update first asks the Worker for a bounded execution-maintenance lease. The
Worker transactionally refuses active Jobs and blocks new Job admission until
maintenance finishes or the lease expires. The app then backs up Worker
configuration/SQLite and copies the installed full application package into
the durable data root with its size and SHA-256. Velopack then
verifies/downloads/applies the selected RID package.

On the restarted version, MiraBridge runs bundled Worker doctor and checks the
OpenSSH service. Success removes the recovery receipt and old package. Failure
re-verifies the old package inside the managed backup root and launches the
external updater to restore it. An invalid receipt, unexpected version or
tampered/missing package stops automatic retry and surfaces Needs Attention.

## Uninstall choices

- **Preserve data:** remove the app and MiraBridge-owned SSH/firewall block while retaining Worker config, SQLite, logs and outputs.
- **Full removal:** additionally delete `%LOCALAPPDATA%\MiraBridge`, but only after an explicit destructive confirmation.
- Both paths revoke MiraBridge-marked paired keys and remove the startup entry. Existing OpenSSH, host keys, unrelated SSH config and unrelated authorized keys remain.
