# MiraBridge 2.0.0-rc.1 test report

Date: 2026-08-23

Status vocabulary is intentionally closed: `PASS_REAL`,
`PASS_SAFE_REJECTION`, `FAIL_PRODUCT`, `FAIL_ENVIRONMENT`, and `NOT_RUN`.
Mock, compile-only, CI-targeted, and real-LAN evidence are kept separate.

## Release identity

| Contract | Observed |
|---|---|
| Product/packages | `2.0.0-rc.1` |
| RPC | `2.0` |
| Public MCP tools | exactly 28 |
| Worker database | SQLite `user_version=5` |
| Codex selector | `mira-bridge@mirabridge` |
| Reasoning/execution boundary | `reasoning_host=Mac`; `tool_host=Windows` |

The 2.0 major changes source ownership, installation, pairing and update
ownership. It does not add a Windows Agent/LLM or break the existing RPC 2.0
tool contract.

## Mac native — Apple Silicon

Environment: macOS Apple Silicon; managed Node.js 24.19.0; system OpenSSH.

| Gate | Result | Evidence |
|---|---|---|
| Locked install | PASS_REAL | `npm ci`, exit 0, 0 vulnerabilities |
| Strict/type/unit/integration gate | PASS_REAL | `npm run check`: 26 Vitest files, 130 tests passed; typecheck/build/plugin/Skill validation all exit 0 |
| MCP stdio | PASS_REAL | `npm run smoke:stdio`: exactly 28 tools and zero nodes under isolated config |
| CLI/package smoke | PASS_REAL | init/list/doctor passed; packed CLI and Worker both reported `2.0.0-rc.1` |
| Package inspection | PASS_REAL | root, CLI and Worker `npm pack --dry-run` all passed |
| Production dependency audit | PASS_REAL | `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities |
| Local SBOM generation | PASS_REAL | `npm sbom --omit=dev --sbom-format cyclonedx` produced valid CycloneDX 1.5 metadata with 99 components; GitHub artifact attestation remains a publication gate |
| Source release manifest | PASS_REAL | final `release-manifest.json` recorded and re-verified 183 publishable source files; runtime artifacts/dependencies are excluded |
| Public-source hygiene | PASS_REAL | final path/credential inventory found no real node address/fingerprint, workstation path, private key or credential in publishable source |
| Official plugin validators | PASS_REAL | OpenAI plugin and Skill validators both passed in addition to the repository-native public-path validator |
| Managed install without Homebrew | PASS_REAL | default `~/Library/Application Support/MiraBridge` install, Node 24.19.0, CLI doctor and atomic `current` switch passed |
| Path-with-spaces installer regression | PASS_REAL | original unquoted managed-Node path failed; quoting fix has a regression test and the real default-path install passed |
| Local marketplace | PASS_REAL | installed/enabled `mira-bridge@mirabridge`; cached runtime returned exactly 28 tools |
| Public Git tag install | PASS_REAL | exact annotated tag cloned into a clean temporary checkout; all 183 files verified; isolated no-Homebrew install/doctor passed; live marketplace was switched to Git tag source and the installed cache returned exactly 28 tools plus a real Worker `2.0.0-rc.1` / RPC `2.0` handshake |
| Intel Mac | PASS_REAL | public CI run `32605195125`, `macos-15-intel`, completed the full runtime gate and isolated managed-runtime install |

The installed MCP starts from local configuration and does not connect to every
node. An isolated stdio smoke with no node configuration returned all 28 tools
without SSH. This is the installation-level evidence for ordinary Mac work
remaining independent; it does not claim a separate fresh-task Git install
before the public tag exists.

## Windows native — real Windows 11 x64

Environment: physical acceptance node (hostname/address redacted), Microsoft
Windows 11 Pro x64, Administrator, Node 24.19.0 bundle, .NET SDK 10.0.400 for build,
Edge, mixed NVIDIA/AMD/virtual adapters, LAN SSH.

### Build and package

| Gate | Result | Evidence |
|---|---|---|
| Windows full gate | PASS_REAL | final durable build Job `job_d2luZG93cy1tYWlu_a5a3c0e4-3e5c-4fc7-9e63-25b461b345ab`, exit 0 |
| TypeScript/Worker native tests | PASS_REAL | 109 passed and 21 environment-routed skips in the 130-case cross-platform suite; targeted Windows suite 102/102 passed |
| WPF/Host/Elevated/client tests | PASS_REAL | .NET build clean; client contract runner 8/8, including healthy-update completion and injected rollback state paths |
| GUI startup crash gate | PASS_REAL | package build launches `--tray`, waits eight seconds, requires a live process and rejects new Application/.NET crash events |
| Self-contained x64 Setup | PASS_REAL | 249,668,318 bytes; SHA-256 `87e954b08e00b03632feaace2aa15280f65c90b3d0c1fd0903edf29e521d3338` |
| Exact public x64 Setup | PASS_REAL | GitHub asset 249,669,078 bytes / SHA-256 `40e295b2d25a4d3b002fab2d374f999496b595f72daa155de0f5f1696e8402e9` transferred with MiraBridge's chunk/hash protocol, then installed on the physical node: uninstall 0, install 0, Worker Ready, one tray process, zero new crash events and durable data preserved |
| RID-specific Setup manifest | PASS_REAL | 1,324 bytes; SHA-256 `fbe002baa04d8123e36be86258da5dffb01b6d74e010b54e2b0e525d39a57747` |
| Unsigned warning | PASS_REAL | RC documentation/Help identify unknown publisher and require release SHA-256; no claim of SmartScreen reputation |

Two real WPF defects were found before the passing package: a language-change
event fired before ViewModel construction, and read-only text boxes used WPF's
default two-way binding. A third product defect was exposed when another client
started a Job after the app's active-Job precheck but before package mutation.
The first two were fixed at their UI owners. The TOCTOU gate was replaced by a
Worker-owned transactional execution-maintenance lease that atomically excludes
active/new Job admission during update or uninstall. All error-before evidence
was retained and each owner now has regression coverage.

### Existing 1.x takeover and operating state

| Gate | Result | Evidence |
|---|---|---|
| Pre-upgrade backup | PASS_REAL | `worker.toml`, SQLite `VACUUM INTO`, old Worker package and SSH baselines retained under the isolated upgrade backup |
| Durable data preservation | PASS_REAL | baseline 66 Jobs / 54 Workspaces / 1,876 Requests / 419 Outputs; post-public-Setup live snapshot 117 / 85 / 3,062 / 589 respectively; `windows-main` Job discovery stayed at 115 before/after the public replacement |
| Stable Host takeover | PASS_REAL | Mac node invokes quoted `MiraBridge.Host.exe worker serve --stdio`; Worker `2.0.0-rc.1`, RPC `2.0` |
| Old npm-global Worker removal | PASS_REAL | removed only after stable Host verification; `where.exe mirabridge-worker` returned not found while Host remained healthy |
| SSH preservation | PASS_REAL | original Host Fingerprint unchanged; service Running/Automatic; one unrelated administrator key preserved; one managed SSH block; LocalSubnet firewall rule preserved |
| App install/reinstall with data preserved | PASS_REAL | external acceptance task returned uninstall/install exit 0, Worker runtime Ready, one live GUI process, zero new crash events and data preserved; receipt SHA-256 `89d14e3d4120fdb81ecad6c2cc146fb19b4779e76c1e1e8ef062f76c7f87e407` |
| Published-asset replacement | PASS_REAL | exact GitHub Setup receipt SHA-256 `ac39606fcfd0ae33f085bbd4d31655d49fceecd1f044d56a3ce24195a6f993e6`; isolated scheduled task ran as the logged-in Administrator and was removed after success |
| Atomic active-Job maintenance gate | PASS_REAL | a held lease made real MCP `start_job` fail retryably with `NODE_MAINTENANCE`; release restored admission; a live Job made lease acquisition fail closed; the installed v8 Host repeated the block/release result and startup cleared its completed-update lease |
| Worker after Windows reboot | PASS_REAL | SSH and stable Host recovered; live `describe_node` succeeded with historical state intact |
| Tray process after an interactive login | NOT_RUN | reboot landed at the Windows login screen with no Explorer session; manual app launch remained alive with no crash, but that is not proof of Run-key behavior after an actual desktop login |
| Update recovery state machine | PASS_REAL | Windows client runner copied/hashed a known-good full package, completed a healthy target and exercised injected health failure → `rollback_started` → restored-version verification |
| Old-RC click update plus real package downgrade | NOT_RUN | external same-version reinstall/preservation passed and installed package source is retained; the first public WPF RC has no prior public update feed, so a complete GUI download/apply/downgrade drill is not claimed |
| Full data-purge uninstall | NOT_RUN | intentionally not run against the only live historical Worker data root; ownership is contract-tested but no production data was destroyed |

Current live `describe_node` after the exact public-asset reinstall on 2026-08-23 reported x64 native/process
architecture, CP936 fallback support, self-contained ConPTY, Edge/tar/curl,
Desktop/recycle/local-web capabilities, 330,914,851 bytes used of the 10 GiB
quota, 424,887,939,072 free bytes and 2 GiB minimum-free protection. The same
snapshot reported zero storage reservations and the installed Host reported no
remaining execution-maintenance lease.

### Real LAN Agent-to-Worker closure

| Scenario | Result | Evidence |
|---|---|---|
| Pairing trust | PASS_REAL | live `ssh-keyscan` matched the returned fingerprint before config/known_hosts commit; `node test` completed a real RPC handshake |
| Node/desktop discovery | PASS_REAL | true OS/CPU/memory/GPU/Edge/storage/roots returned; Desktop metadata read without changing unknown files |
| File engineering loop | PASS_REAL | workspace open, list/stat/read/write/exact edit/search/glob/path management, exec and PowerShell passed in an isolated D-drive project |
| Boundary refusal | PASS_SAFE_REJECTION | traversal, UNC, ADS, Junction escape and workspace-root delete were rejected by Worker code |
| Durable Job/reconnect | PASS_REAL | a 35-second Job survived SSH closure, was rediscovered by `list_jobs`, returned full tail and real exit code 0 |
| Web product loop | PASS_REAL | Vite install/start, Windows curl, desktop/mobile Edge snapshots, HTTP 200, expected title/body, zero console/page errors, production build |
| Directory transfer | PASS_REAL | 17 entries / 12 files pulled to Mac; Worker-generated source and destination manifests matched |
| Recycle Bin | PASS_SAFE_REJECTION | real scan ran read-only and reported zero items; no clear was issued without a reviewed current scan target |

The release acceptance project is retained at
`D:\MiraBridgeRoot\MiraBridge-Release-Acceptance-2.0.0-rc.1-final`; its Mac
copy is outside this source repository. Runtime validation exercised the
unchanged 28-tool surface through automation plus a representative real
engineering loop. It does not claim that every destructive tool was made to
succeed against personal data.

## Platforms and release infrastructure

| Gate | Result | Notes |
|---|---|---|
| GitHub Windows x64 artifact | PASS_REAL | public CI run `32605195125`, `windows-2025`, passed native tests/build/package smoke and uploaded `windows-win-x64-unpacked` (242,347,174 bytes) |
| Native GitHub Windows ARM64 runner | PASS_REAL | public CI run `32605195125`, native `windows-11-arm`, passed Worker/Node/ConPTY/SQLite/native package smoke and uploaded `windows-win-arm64-unpacked` (228,711,742 bytes) |
| Physical Windows ARM64 GUI | NOT_RUN | stable-release gate |
| Physical Windows 10 22H2 GUI/Optional Capability | NOT_RUN | stable-release gate |
| Clean Windows VM with no Node/.NET/OpenSSH | NOT_RUN | Setup is self-contained and helper paths are tested, but no fresh-VM execution evidence |
| Intel-only or GPU-less physical Windows | NOT_RUN | capability model/tests exist; no physical execution evidence |
| Windows code signing | NOT_RUN | unsigned RC by design; mandatory before stable `2.0.0` |
| SBOM and GitHub attestation | PASS_REAL | prerelease run `32605676616` published per-platform CycloneDX SBOMs and SLSA provenance; both Windows Setup and both Mac runtime downloads matched `SHA256SUMS`, and provenance verification was constrained to this repository, tag and release workflow |

The public prerelease contains 27 assets. Windows x64 Setup is 249,669,078
bytes with SHA-256 `40e295b2d25a4d3b002fab2d374f999496b595f72daa155de0f5f1696e8402e9`;
Windows ARM64 Setup is 235,596,023 bytes with SHA-256
`721ef7f555fa6037cd5859dd8083d3df3800536c9e0d031ecde0647c2d200151`.
The published Mac per-archive sidecars contain a build-relative filename, so
the aggregate `SHA256SUMS` is the canonical RC verification file. The next-tag
workflow now emits portable basename-only sidecars; artifact bytes and the
installer path were never affected.

## RC conclusion

The source, managed Mac install, real Windows x64 Setup, in-place data takeover,
stable SSH/Host chain, realistic file/Job/web/transfer loop and public four-platform
CI run `32605195125`, public Git install and prerelease run `32605676616` are
`PASS_REAL`. The explicitly unsigned x64/ARM64 RC is published at
`https://github.com/2387452986/MiraBridge/releases/tag/v2.0.0-rc.1`.

It is not a stable `2.0.0` release. Signing, physical Windows 10 and physical
ARM64 GUI acceptance remain mandatory. Clean-VM onboarding, interactive-login
tray startup, old-RC update rollback and destructive full-uninstall evidence
remain visible RC gaps rather than being inferred from unit tests.
