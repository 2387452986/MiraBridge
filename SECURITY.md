# Security policy

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use GitHub's private vulnerability reporting for `2387452986/MiraBridge`. Include the affected version, a minimal reproduction and impact; omit real private keys, tokens, pairing codes, command contents and personal files.

## Supported versions

Security fixes target the latest `2.x` release candidate and, after stable release, the latest `2.x` stable line. The unsigned `2.0.0-rc.1` is for evaluation and is not a stable security baseline.

## Product trust boundary

- The Agent, model, planning and completion judgment run on macOS.
- The Windows Worker is deterministic and accepts structured operations only over the user's OpenSSH connection.
- Pairing codes contain a public key and metadata, never a private key or password. Mac acceptance still performs a live host-key scan and exact fingerprint match.
- File APIs enforce configured roots. Administrator execution does not remove tool approval, recycle-scan confirmation, CAS or audit boundaries.
- MiraBridge creates no custom network listener and does not expose SSH beyond `LocalSubnet` by default.
- Diagnostics are local, previewed and redacted. There is no background telemetry.
- Windows update is user-initiated after at-most-daily notification, defers
  while Jobs are active, backs up Worker state and a SHA-256-verified previous
  full package, and performs post-update Worker/SSH health verification before
  completing or launching an external rollback.
- The unsigned RC requires Release SHA-256 and GitHub attestation verification;
  stable `2.0.0` is blocked on Windows code signing.

See [the detailed threat model](plugins/mira-bridge/docs/mira-bridge-threat-model.md).
