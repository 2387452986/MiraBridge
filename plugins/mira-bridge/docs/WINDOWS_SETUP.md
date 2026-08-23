# MiraBridge 2.0.0-rc.4 Windows setup

The supported public installation path is maintained once, at
[`../../../docs/INSTALL_WINDOWS.md`](../../../docs/INSTALL_WINDOWS.md).

Download the x64 or ARM64 `MiraBridge.Windows-*-Setup.exe` and the SHA-256
manifest from the same GitHub prerelease. This unsigned RC may show a Windows
SmartScreen unknown-publisher warning; stop if the download source or digest
does not match.

Setup bundles Node.js 24.19.0, the deterministic Worker, Playwright Core, the
ConPTY helper and the self-contained .NET 10 WPF client. A normal user does not
install Node, .NET or an npm-global Worker and does not edit TOML. The setup
wizard installs or repairs Windows OpenSSH through one UAC-approved helper,
then completes the two-code pairing flow.

The supported product route is an Administrator account. Structured file tools
remain bounded by Worker roots, while approved native processes have that
account's native authority. MiraBridge never disables UAC, Defender, firewall
or EDR, never enables password SSH, and never installs display drivers.

Developers building on Windows can run:

```powershell
npm ci
npm run typecheck
npm run build:windows
npm run test:windows
```

Those commands build/test source; they are not the end-user installation path.
