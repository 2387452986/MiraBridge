# MiraBridge test report

Date: 2026-08-23

Status vocabulary is intentionally closed: `PASS_REAL`,
`PASS_SAFE_REJECTION`, `FAIL_PRODUCT`, `FAIL_ENVIRONMENT`, and `NOT_RUN`.
Mock, compile-only, CI-targeted, and real-LAN evidence are kept separate.

## 2.0.0-rc.5 current release candidate

| Contract | Observed |
|---|---|
| Product/packages | `2.0.0-rc.5` |
| RPC / MCP surface | `2.0` / exactly 28 tools (unchanged) |
| Worker database | SQLite `user_version=5` (unchanged) |
| Scope | installed Windows icon ownership, visible pairing commands, bilingual public onboarding; runtime execution contract unchanged |

### Error-before and repair

| Gate | Result | Evidence |
|---|---|---|
| Running application icon | FAIL_PRODUCT | the packaged executable contained the requested mascot, but the tray owner loaded `ExtractAssociatedIcon(Environment.ProcessPath)` and could continue to receive a stale shell-associated icon |
| Icon repair | PASS_REAL | the tray now clones the packaged `Assets/mirabridge.ico` resource directly, startup sends the documented shell association-change notification, and the ICO has optically tuned 16/20/24/32-pixel frames rather than relying on one automatic downscale |
| First physical Windows build | FAIL_PRODUCT | durable Job `job_d2luZG93cy1tYWlu_10f3432f-5b69-467d-b394-9be9622d1e84` failed because the WPF source used `Stream` without explicitly importing `System.IO` |
| Compile repair | PASS_REAL | the owner added the missing framework namespace; final durable Job `job_d2luZG93cy1tYWlu_086b6d3a-26d5-4fb2-91eb-fb387c179985` exited 0 and repeated the complete native release build |
| Pairing command visibility | FAIL_PRODUCT | the first installed capture exposed the correct command through UI Automation, but the custom read-only `TextBox` rendered its visible text blank; automation-only assertions would have missed the user-facing defect |
| Pairing visibility repair | PASS_REAL | copy-only commands use a plain bordered `TextBlock`; the second physical installed capture visibly shows `~/.local/bin/mirabridge pair create` beside the localized primary copy button |

### rc.5 Mac and real Windows gates

| Gate | Result | Evidence |
|---|---|---|
| Mac strict/type/unit/integration | PASS_REAL | managed Node 24.19.0; `npm ci` reported zero vulnerabilities, 26 Vitest files / 130 tests passed, strict typecheck, build, MCP/plugin and Skill validation passed |
| Native Windows release build | PASS_REAL | final durable Job `job_d2luZG93cy1tYWlu_086b6d3a-26d5-4fb2-91eb-fb387c179985`, exit 0; 109 cross-platform tests, Windows-native 102/102 and WPF client 8/8 passed |
| x64 Setup | PASS_REAL | 251,233,250 bytes; SHA-256 `34b9d2ed90593ea8d04f9431e75d2b47417002d13a43c12592cd784bde5da51f` |
| Installed replacement | PASS_REAL | receipt SHA-256 `450db4bbf3e00c86530105243ffbb429d38f3ff5cf6e781cac5dcb6c2fd427fb`; uninstall 0, install 0, Worker Ready, one real app process after five duplicate launches, immediate/settled activation true, zero crashes and durable data preserved |
| Installed version and handshake | PASS_REAL | live CLI handshake reports Worker `2.0.0-rc.5`, RPC `2.0`, x64, Edge, self-contained ConPTY, 28-tool capability owners and retained SQLite v5 history |
| Installed icon | PASS_REAL | icon extracted from the newly installed executable is the requested multicolour mascot; 2,672-byte PNG / SHA-256 `878773e73d7c210b35d29e598e25f20c712492736a75302bce18a3dd4075b649` |
| Installed pairing UI | PASS_REAL | real interactive 1180x780 capture is 65,688 bytes / SHA-256 `9b7634efe013872b2c93910ee351efa6671a7bb0123cda22b0f3bcc019d8c0dc`; it shows rc.5, the new mascot, consistent language control, the full Mac command and its copy action |
| English/Chinese public guide | PASS_REAL | `README.md` and `README.zh-CN.md` provide equivalent product positioning, real productivity cases and the explicit create → authorize → accept command flow |
| Acceptance cleanup | PASS_REAL | all three exact RC5 one-shot Scheduled Tasks were unregistered (`remaining=0`), and their remote scripts, receipts and screenshots were removed after local evidence was hash-verified |
| Public tag / prerelease / published-tag pickup | NOT_RUN | performed only after the final manifest, source hygiene and local package gates pass; local Windows bytes are not represented as future CI release bytes |

## 2.0.0-rc.4 current release candidate

| Contract | Observed |
|---|---|
| Product/packages | `2.0.0-rc.4` |
| RPC / MCP surface | `2.0` / exactly 28 tools (unchanged) |
| Worker database | SQLite `user_version=5` (unchanged) |
| Scope | transient Windows process-identity probe recovery; rc.3 installation/UI behavior retained |

### Error-before and repair

| Gate | Result | Evidence |
|---|---|---|
| Post-release Windows x64 gate | FAIL_PRODUCT | GitHub Actions run `32630052562` failed `jobs.test.ts` after 10.637 seconds: a live Job cancellation was rejected as a PID identity mismatch |
| Root cause | PASS_REAL | the expected PID timestamp was created 10.321 seconds before the failure and the identity probe has a 10-second bound; under full parallel hosted-runner load, cold `powershell.exe` did not complete before that bound, returning “probe unavailable” rather than a real mismatch |
| Physical Windows baseline | PASS_REAL | the same targeted cancellation scenario passed 12/12 sequential runs on the physical x64 node, confirming the failure is load-sensitive rather than deterministic PID reuse |
| Repair | PASS_REAL | the identity owner retries exactly once only when the bounded probe is unavailable; a missing PID or parsed timestamp mismatch still fails closed without retry |

### rc.4 source and four-platform gate

| Gate | Result | Evidence |
|---|---|---|
| Strict/type/unit/integration | PASS_REAL | managed Node 24.19.0; 26 Vitest files / 130 tests, strict typecheck, build, MCP/plugin contract and Skill contract passed |
| Original failure environment | PASS_REAL | GitHub Actions run `32630720564` passed the exact repaired commit on macOS Apple Silicon/Intel, Windows x64 and native Windows ARM64; the Windows x64 job that reproduced the rc.3 failure completed successfully |
| Cancellation regression | PASS_REAL | physical Windows targeted regression passed, full Windows release build repeated the live cancellation test in 481 ms and the Windows-native suite repeated it in 353 ms |
| Production dependencies | PASS_REAL | `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities |
| Package inspection | PASS_REAL | root, `@mirabridge/cli` and `@mirabridge/windows-worker` dry-runs reported `2.0.0-rc.4` with valid payloads |

### rc.4 real Windows 11 x64 replacement

Environment: physical Administrator node; address, hostname and Host Fingerprint
are redacted from public evidence. The node uses Windows 11 Pro x64, bundled
Node 24.19.0, Edge, self-contained ConPTY and mixed NVIDIA/AMD/virtual display
adapters.

| Gate | Result | Evidence |
|---|---|---|
| Clean source delivery | PASS_REAL | MiraBridge transferred and hash-verified a 2,220,986-byte Git-archive, SHA-256 `56d3d88ae02bb864619548e4b98ad574e60d6dbcb757e6a7c27b0266b3e6c48a`, into the allowed D-drive root |
| Native release build | PASS_REAL | durable Job `job_d2luZG93cy1tYWlu_882ca39b-480f-4528-ba4a-5ef4c324adc3`, exit 0; cross-platform suite 109 passed / 21 environment-routed skips, Windows-native suite 102/102, Windows local integration checks and WPF client checks 8/8 passed |
| x64 Setup | PASS_REAL | 251,094,169 bytes; SHA-256 `3a4b72ae4371a1666eaeb626ca4abd986f85e880edcfd5c4917b7acce68fb7b6` |
| Upgrade backup | PASS_REAL | no active Job; `worker.toml` SHA-256 `6c68cce62a430ac387ff2f1abe80b8d40a5c3edb4b2aab4bdc9fb80d1db2c920`; SQLite `VACUUM INTO` snapshot 108,412,928 bytes / SHA-256 `69a1928ccd56a62c985459cd0dba86c8ed3edc40d19c5d2660c196dfed398fe2`; rc.3 rollback Setup retained |
| Installed replacement | PASS_REAL | receipt SHA-256 `2b5670cfa0c30c8e169675d515f7889673a1b2a5a213b703a48b79a4fce1f4ef`; uninstall 0, install 0, Worker Ready, one actual app process after five duplicate launches, immediate and settled activation true, zero new crashes, durable data root preserved |
| Installed version and state | PASS_REAL | installed app and Worker report `2.0.0-rc.4`; RPC remains `2.0`; pre-replacement SQLite v5 contained 130 Jobs, 100 Workspaces and 3,433 Requests, and the post-replacement live node retained 130 Jobs plus existing request/output/tombstone history |
| Current installed UI | PASS_REAL | interactive duplicate launch activated the existing tray owner and retained one process; the real 1180×780 rc.4 capture is 85,861 bytes / SHA-256 `7d9109a7da1a4db9ff4f4ebc261f5e7b0dd11b1c1a3e934cb053b94de8c8be3d`; it remains ignored locally because the status page contains LAN and Host Fingerprint data |
| Acceptance cleanup | PASS_REAL | one-shot install/UI Scheduled Tasks and capture script/receipt/remote screenshot were removed after evidence was read |

The physical Setup is a local exact-source build. It is not described as the
future GitHub Release byte stream because Velopack packages are not reproducible
byte-for-byte. Public-tag pickup and published hashes are recorded only after
the annotated tag and release workflow finish.

### rc.4 public distribution

| Gate | Result | Evidence |
|---|---|---|
| Annotated tag and prerelease | PASS_REAL | annotated `v2.0.0-rc.4` points to commit `2071440`; prerelease workflow `32631910741` passed Mac Apple Silicon/Intel, Windows x64/native ARM64, SBOM, provenance, collision checking and publish jobs |
| Release assets | PASS_REAL | 27 assets published; aggregate `SHA256SUMS` SHA-256 `7d874c7d94b5aab52dbf52b8e2439cebad691a1cf6bfb6e7d4da13cce5b429af`; x64 Setup `d9ac2234cd934a865fd59d32752f7ea613202e47b27418525f7b5f1049cade01`; ARM64 Setup `5ef0ba7c8baee31454e5761233896ccb389935b6c72b9690973d4048c346bbfd` |
| Public-tag Mac upgrade | PASS_REAL | updater downloaded `v2.0.0-rc.4`, verified all 180 manifest files, installed with zero dependency vulnerabilities, built and switched the managed `current` runtime plus CLI doctor to rc.4 |
| Marketplace/plugin pickup | PASS_REAL | live plugin cache reports `2.0.0-rc.4`; cached Figure-2 Logo SHA-256 is `40608748bbb8ebeedefb4a7dd06ce3493faff659f8ee3b4fa3f9c9d5c210e325` |
| Installed-plugin closure | PASS_REAL | MCP launched from the installed public-tag cache exposed exactly 28 tools and completed a real handshake with the physical Worker `2.0.0-rc.4`, RPC `2.0`, x64 |

Release: `https://github.com/2387452986/MiraBridge/releases/tag/v2.0.0-rc.4`.
The exact public Setup is CI-built from the tagged source and hash-published;
the physical x64 replacement used a separately produced build from the same
source state, so the report preserves their distinct byte identities.

## Historical baseline: 2.0.0-rc.3

| Contract | Observed |
|---|---|
| Product/packages | `2.0.0-rc.3` |
| RPC / MCP surface | `2.0` / exactly 28 tools (unchanged) |
| Worker database | SQLite `user_version=5` (unchanged) |
| Scope | Mac runtime and fixed-ref marketplace upgrade correctness; rc.2 Windows UI/single-instance behavior retained |

### Error-before and repair

| Gate | Result | Evidence |
|---|---|---|
| rc.1 → rc.2 runtime switch | FAIL_PRODUCT | installer printed rc.2 success, but `current`, CLI doctor and managed runtime still resolved to rc.1 |
| Root cause: runtime link | PASS_REAL | macOS `mv -f` followed the destination directory symlink and moved the candidate link inside the rc.1 directory; `mv -fh` replaced the link itself |
| Root cause: marketplace ref | PASS_REAL | Codex marketplace metadata remained pinned to `v2.0.0-rc.1`; a snapshot upgrade correctly refreshed that same ref and therefore could not advance the plugin |
| Patched local upgrade | PASS_REAL | exact rc.2 repair moved `current` to rc.2, doctor returned rc.2, plugin cache returned rc.2 and the new public Logo SHA-256 `40608748bbb8ebeedefb4a7dd06ce3493faff659f8ee3b4fa3f9c9d5c210e325` |

The corrected installer removes only `mira-bridge@mirabridge` and its own
marketplace registration, re-adds the requested immutable tag, installs the
plugin, reasserts the selected runtime using `mv -fh`, and runs a final doctor.

### rc.3 Mac and public CI gate

| Gate | Result | Evidence |
|---|---|---|
| Strict/type/unit/integration | PASS_REAL | Node 24.19.0; 26 Vitest files / 130 tests, strict typecheck, build, MCP/plugin contract and Skill contract passed |
| Installer regression | PASS_REAL | the suite now asserts `mv -fh`, exact-ref marketplace replacement, final runtime reassertion and a user-visible doctor |
| Production dependencies | PASS_REAL | `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities |
| Package inspection | PASS_REAL | root, `@mirabridge/cli` and `@mirabridge/windows-worker` dry-runs reported `2.0.0-rc.3` with valid payloads |
| Release manifest | PASS_REAL | 179 public files were regenerated and byte-verified; local Agent/module summaries, checklists and artifacts remain excluded |
| Apple Silicon CI | PASS_REAL | GitHub Actions run `32628388011`, `macos-15`, completed the runtime gate and isolated managed-runtime install |
| Intel Mac CI | PASS_REAL | GitHub Actions run `32628388011`, `macos-15-intel`, completed the runtime gate and isolated managed-runtime install |
| Windows x64 CI | PASS_REAL | GitHub Actions run `32628388011`, `windows-2025`, completed native tests, build and package smoke |
| Windows ARM64 CI | PASS_REAL | GitHub Actions run `32628388011`, native `windows-11-arm`, completed Worker, Node, ConPTY, SQLite and package smoke; this is not physical ARM64 GUI evidence |

### rc.3 real Windows 11 x64 replacement

Environment: the same physical Administrator acceptance node used for rc.2,
with hostname, address and Host Fingerprint redacted from public evidence.

| Gate | Result | Evidence |
|---|---|---|
| Source delivery under network failure | PASS_REAL | Windows GitHub access reset/timed out; MiraBridge transferred a clean 2,218,327-byte source archive, SHA-256 `30fe28a71ba771486699003e9c366c9fdeca5f29ddb4f40690ee38fd7739353b`, then unpacked it inside the allowed D-drive root |
| Native release build | PASS_REAL | durable Job `job_d2luZG93cy1tYWlu_03c2ea65-3983-490d-8b92-9ca695d0a063`, exit 0; Windows Worker suite 102/102, WPF client checks 8/8, packaged Worker `2.0.0-rc.3` |
| x64 Setup | PASS_REAL | 251,094,107 bytes; SHA-256 `f1eda7b1582eab6fb60b739179490fade92f07040e36a55b84baa7be3cb10744` |
| Upgrade backup | PASS_REAL | no active Job; `worker.toml` SHA-256 `6c68cce62a430ac387ff2f1abe80b8d40a5c3edb4b2aab4bdc9fb80d1db2c920`; SQLite `VACUUM INTO` SHA-256 `afdc84fe4d1ac90d434b434731283affbef04c280e50644fecbea965781e2291` |
| Incorrect account refusal | PASS_SAFE_REJECTION | the first scheduled install used an unresolved account name and Windows rejected it before application mutation; the harness then used the identity returned by `WindowsIdentity` |
| Installed replacement | PASS_REAL | receipt SHA-256 `b3cfd8f9e768cd5516986ab1e40f72ab7c76b1f7a59e3989d4d6063481a243f9`; uninstall 0, install 0, Worker Ready, one app process after five duplicate launches, immediate and settled activation both true, zero new crashes |
| Current installed UI | PASS_REAL | the rc.3 interactive session reactivated the existing window through a duplicate launch, retained one `current` process and captured the current task-oriented UI; 85,833-byte PNG / SHA-256 `79a2bc4373e2bf210d4dcc0f9252b616c70d89126cba8abad67ab44b475aa2ad`; the capture remains ignored locally because it contains LAN and Host Fingerprint data |
| Durable state | PASS_REAL | live Worker reported rc.3 / RPC 2.0 and retained 129 Jobs, 95 Workspaces and the existing request/output/tombstone history in SQLite v5 |
| SSH and reconnect | PASS_REAL | SSH remained Running/Automatic; Mac `mirabridge node test windows-main` completed a real rc.3 handshake after replacement |

The Windows installer was built from the exact rc.3 source commit and exercised
as an in-place replacement. The Mac published-tag pickup is performed only
after the annotated tag and release exist; a local snapshot is not substituted
for that final distribution test.

### rc.3 public distribution

| Gate | Result | Evidence |
|---|---|---|
| Annotated tag and prerelease | PASS_REAL | `v2.0.0-rc.3` points to commit `af634a1`; prerelease workflow `32629076713` completed all four build jobs plus publishing and created 27 assets |
| Release integrity | PASS_REAL | aggregate `SHA256SUMS` SHA-256 `db8d6d70ff7798e4298d92a6964ff738a075b1ee4fb14d9ea06af61901a42d04`; x64 Setup `f8348b8c64fb45dbb63c0eea8ef5614efdb7302dbf085c5b22114b0be1df2246`; ARM64 Setup `10f710bec5705c55b28917c83126f7de4b411ae575d72a9fe8c33c19cae2ae66` |
| Public-tag Mac upgrade | PASS_REAL | updater downloaded `v2.0.0-rc.3`, verified all 179 files, installed dependencies with zero vulnerabilities, built, and changed both the `current` link and CLI doctor from rc.2 to rc.3 |
| Marketplace/plugin pickup | PASS_REAL | the live `mirabridge` marketplace and plugin cache report `2.0.0-rc.3`; cached Logo SHA-256 is `40608748bbb8ebeedefb4a7dd06ce3493faff659f8ee3b4fa3f9c9d5c210e325` |
| Installed-plugin closure | PASS_REAL | MCP launched from the installed plugin cache exposed exactly 28 tools and completed a real `windows-main` handshake with Worker `2.0.0-rc.3`, RPC `2.0`, x64 |

Release: `https://github.com/2387452986/MiraBridge/releases/tag/v2.0.0-rc.3`.
The exact public Setup is CI-built from the tagged source and hash-published;
the physical x64 replacement used a separately produced build from that exact
source commit, so this report does not misstate those two nondeterministic
package byte streams as identical.

## Historical UI/product baseline: 2.0.0-rc.2

| Contract | Observed |
|---|---|
| Product/packages | `2.0.0-rc.2` |
| RPC / MCP surface | `2.0` / exactly 28 tools (unchanged) |
| Worker database | SQLite `user_version=5` (unchanged) |
| Windows default | Administrator-first; Worker path and approval boundaries remain enforced |

### Mac native gate

| Gate | Result | Evidence |
|---|---|---|
| Strict/type/unit/integration | PASS_REAL | managed Node 24.19.0; 26 Vitest files / 130 tests, typecheck, build, plugin contract and Skill contract all passed |
| Official validators | PASS_REAL | OpenAI plugin validator and Skill quick validator passed against the public plugin root |
| Production dependencies | PASS_REAL | `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities |
| Package inspection | PASS_REAL | root, `@mirabridge/cli` and `@mirabridge/windows-worker` dry-runs reported `2.0.0-rc.2` and valid payloads |
| Public-source hygiene | PASS_REAL | no private-key marker, GitHub credential, real LAN address, workstation-absolute path or pinned node fingerprint in publishable files; internal Agent/module summaries and development checklists are excluded from the public tree |

### Real Windows 11 x64 gate

Environment: physical Administrator node (hostname/address redacted), Windows
11 Pro x64, Node 24.19.0 bundle, .NET SDK 10.0.400 for build, Edge, SSH and
mixed NVIDIA/AMD/virtual display adapters.

| Gate | Result | Evidence |
|---|---|---|
| Final native release build | PASS_REAL | durable Job `job_d2luZG93cy1tYWlu_8c0edfb9-d8cf-4113-a127-618967bc030f`, exit 0; Windows Worker suite 102/102, WPF client checks 8/8, packaged Worker `2.0.0-rc.2` |
| x64 Setup | PASS_REAL | 251,094,116 bytes; SHA-256 `b9e2a863af8c4d565a9de79b856ff0f1d7271d2eb6f34395b72a0511bcf37669` |
| Upgrade protection | PASS_REAL | no active Job; `worker.toml`, SQLite `VACUUM INTO` and the rc.1 full package were backed up and hashed before replacement |
| Real rc.1 → rc.2 replacement | PASS_REAL | uninstall 0, install 0, Worker doctor Ready, current Worker/App `2.0.0-rc.2`, durable data present, ED25519 Host Key unchanged, SSH Running/Automatic |
| Single instance / tray owner | PASS_REAL | rc.1 error-before reproduced three true app processes; rc.2 headless gate and interactive installed acceptance each launched five duplicates and retained exactly one `current` app process |
| Cold-start activation race | PASS_REAL | an immediate second launch during tray startup activated the original window; the final window handle was nonzero and no Application/.NET crash event appeared |
| Installed UI | PASS_REAL | installed rc.2 window captured at 1180×780, current process count 1; capture 85,746 bytes / SHA-256 `c959121cbd53e661276b23c58db82640793ccd6eb0004945bcc66820ef6638d3` |
| Installed icon | PASS_REAL | icon extracted from the installed executable is the new transparent Figure-2 mascot; 2,454-byte PNG / SHA-256 `2c900f12ba458f84423d3ad0dc8e5c442196dc3355edfb3562936f4bfc37924f` |
| Durable state preservation | PASS_REAL | before: 128 Jobs / 92 Workspaces / 3,318 Requests / 646 Outputs; after: 128 / 93 / 3,340 / 655, with SQLite v5 and no count decrease |
| Acceptance-task cleanup | PASS_REAL | one-shot install and UI-capture Scheduled Tasks were removed after their receipts were read |

The first installed-package rerun counted three same-named processes and failed.
Path-level evidence showed one real `current` tray application plus transient
Velopack root launchers; seconds later only the `current` process remained. The
acceptance owner was fixed to count the package's actual executable path and
wait for launcher convergence. The unchanged product binary then passed the
same reinstall and five-click scenario. This harness correction is not used to
erase the original failure receipt.

The real UI screenshots contain local addresses and a Host Fingerprint. They
remain only under the ignored local `artifacts/` tree and are intentionally not
part of the public README or release assets.

### rc.2 publication state

| Gate | Result | Notes |
|---|---|---|
| Public main/tag/prerelease | PASS_REAL | commit `e19f6fe`, annotated `v2.0.0-rc.2`, prerelease and 27 assets published; GitHub release workflow run `32627470315` passed |
| Windows ARM64 native CI | PASS_REAL | GitHub native `windows-11-arm` CI and prerelease build both passed; this remains build/smoke evidence, not physical GUI evidence |
| Physical Windows 10 / ARM64 GUI | NOT_RUN | stable `2.0.0` gate |
| Windows code signing | NOT_RUN | rc.2 remains explicitly unsigned |

## Historical baseline: 2.0.0-rc.1

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
