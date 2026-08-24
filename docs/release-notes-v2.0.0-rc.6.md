# MiraBridge 2.0.0-rc.6

This release candidate fixes a durable Windows Job failure found during a real
MiniMax H3 quality-first render. It preserves the existing protocol and tool
surface while making output-decoding failures explicit and recoverable.

## What changed

- Observe stdout/stderr capture, decoder and storage failures immediately
  instead of waiting for the native process to exit.
- Map an explicit encoding mismatch to actionable `UNSUPPORTED_ENCODING` and
  recommend `output_encoding=auto` or the matching Windows code page.
- Terminate the exact process tree after a capture failure, preserve the real
  structured error and safe log prefix, and avoid misreporting a known stopped
  process as a semantically unexplained `lost` Job.
- Add deterministic and physical Windows regressions for delayed CP936 bytes,
  persistent Job recovery, ConPTY, cancellation, path boundaries and storage.
- Document the complete real MiniMax H3 installation, diagnosis, native
  20-step render, media verification and cross-host transfer loop in both
  English and Simplified Chinese.

## Real acceptance

- The repaired normal MiraBridge Job completed the full non-Turbo MiniMax H3
  workflow at 1344×768, 124 frames, 24 fps and 20 sampler steps.
- DynamicVRAM, native `convrot_w4a4`, AudioVAE and VideoVAE remained enabled;
  no fallback kernel, lower resolution, reduced step count or silent-output
  workaround was used.
- The resulting H.264/AAC artifact was verified with `ffprobe` and SHA-256 after
  transfer from Windows to macOS.
- Mac source gate: 26 Vitest files / 131 tests, strict typecheck, build,
  plugin/Skill validation, package inspection and zero production dependency
  vulnerabilities.
- Physical Windows-native integration: 34 checks including CP936/UTF-8,
  persistent Job restart, ConPTY, process-tree cancellation, Junction rejection
  and storage pruning.

## Compatibility

- Product/plugin/Worker: `2.0.0-rc.6`
- RPC: `2.0` (unchanged)
- MCP tools: 28 (unchanged)
- SQLite `user_version`: 5 (unchanged)
- Existing nodes, pairings, Jobs, logs, workspaces, configuration and audit
  state remain compatible.

## Release-candidate warning

The Windows installer remains unsigned. Windows SmartScreen may show
**Unknown publisher**. Download only from this GitHub Release and verify the
matching SHA-256 manifest. Stable `2.0.0` remains blocked on code signing and
the documented physical-platform acceptance gates.
