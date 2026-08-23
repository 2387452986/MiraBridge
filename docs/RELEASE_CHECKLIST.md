# 2.0.0-rc.1 release checklist

`[x]` means current-turn evidence exists. Unchecked items remain visible
publication or stable-release gates; a nearby unit test does not close them.

## Source and contracts

- [x] `2.0.0-rc.1` in plugin/all packages and Windows app; RPC `2.0`;
  SQLite v5; exactly 28 tools.
- [x] MIT license, notices, support matrix, security, contribution, installation,
  pairing, migration and release documents.
- [x] Standalone `mirabridge` marketplace and selector
  `mira-bridge@mirabridge`.
- [x] Public-path validator contains no workstation-absolute validator path.
- [x] Regenerate and verify `release-manifest.json` after the final source diff
  (183 files).
- [x] Run the final credential/path/secrets inventory before the first commit;
  no real host address/fingerprint, workstation path, private key or credential
  is present in publishable source.

## Mac — Apple Silicon

- [x] Node 24.19.0 `npm ci`, strict typecheck, 26 files/130 Vitest, build,
  stdio/CLI/package smoke, plugin/Skill validators, three pack dry-runs and
  production dependency audit.
- [x] Real default-path install under `Application Support`, with no Homebrew,
  global npm, TOML edit or system Node replacement.
- [x] Local marketplace install/enabled; cached MCP reports exactly 28 tools.
- [x] Pair acceptance live-scans and pins the real Host Fingerprint before the
  stable Host handshake.
- [x] Public Git tag installation in a clean checkout; Manifest, isolated
  managed runtime, Git marketplace cache, 28 tools and live Worker handshake
  passed.
- [x] Intel macOS public CI completed the full gate and isolated managed-runtime
  install in run `32605195125`.

## Windows 11 x64 — physical `windows-main`

- [x] Clean self-contained publish, Windows native/Worker suites, .NET build,
  8/8 WPF client contract runner and eight-second GUI crash gate.
- [x] Unsigned Setup install/reinstall with durable data preserved; exact
  artifact and manifest SHA-256 recorded.
- [x] Exact public GitHub x64 Setup transferred by MiraBridge, hash-matched,
  installed on the physical node and reconnected; uninstall/install/doctor/tray
  passed, no new crash event appeared, durable state counts did not decrease and
  the one-shot scheduled acceptance task was removed.
- [x] Update recovery owns previous-package copy/hash, persistent receipt,
  post-update Worker/SSH health, external rollback launch and recursion stop;
  healthy/injected-failure states passed Windows tests.
- [x] Update/uninstall and durable Job admission share one transactional Worker
  maintenance lease; real Windows tests proved held-lease rejection,
  active-Job refusal, release/recovery and installed-Host behavior.
- [x] Existing OpenSSH Host Key, unrelated administrator key, managed block,
  LocalSubnet firewall rule and Automatic service preserved.
- [x] 1.x state backup/takeover: Job/Workspace/Request/Output counts retained
  and increased after real work.
- [x] Stable Host switch, old npm-global Worker removal and post-reboot Worker
  handshake.
- [x] Real describe, file/edit/path, exec, PowerShell, durable Job reconnect,
  directory transfer, curl and Edge desktop/mobile rendering loop.
- [ ] Tray Run-key execution after a real interactive desktop login; reboot
  reached only the login screen, while manual launch passed.
- [ ] Old-public-RC click update through GitHub feed and real package downgrade
  (no earlier public WPF RC feed exists yet).
- [ ] Full data-purge uninstall against a disposable clone of production state.

## Clean/alternate Windows environments

- [ ] Fresh Windows VM with no Node, .NET or OpenSSH: Setup-to-Ready without a
  terminal.
- [x] Native GitHub Windows ARM64 build/test/package job in public run
  `32605195125`; x64 and ARM64 unpacked artifacts were uploaded.
- [ ] Physical Windows ARM64 GUI.
- [ ] Physical Windows 10 22H2 GUI and Optional Capability workflow.
- [ ] Physical Intel-only/GPU-less node capability smoke.

## Publication

- [x] `gh auth status`; repository-scoped author derived from authenticated
  GitHub identity.
- [x] Public `2387452986/MiraBridge` and green `main` CI.
- [x] Annotated tag `v2.0.0-rc.1` and tag workflow `32605676616`.
- [x] GitHub x64/ARM64 Setup and macOS arm64/x64 runtime assets.
- [x] Aggregate SHA-256 manifest, SBOM, dependency notices and artifact
  attestations.
- [x] Prerelease notes identify the unsigned installer and all `NOT_RUN`
  evidence.

Stable `2.0.0` additionally requires Windows code signing plus physical
Windows 10 22H2 and ARM64 GUI acceptance.
