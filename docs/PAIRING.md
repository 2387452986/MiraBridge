# Pairing and SSH trust

Pairing uses two clipboard codes and one live network verification. A code is versioned base64url JSON, no larger than 16 KiB and valid for at most 30 minutes.

## Request: Mac to Windows

The request contains the Mac Ed25519 **public** key, its SHA-256 fingerprint, a random nonce, node ID, creation/expiry time and basic Mac/version metadata. The private key stays in `~/.config/mirabridge/identities` with mode 0600. There is no password or token.

## Windows authorization and response

The elevated helper validates type, TTL, nonce, key format and key fingerprint; a used nonce is rejected. It appends exactly one marked line to `administrators_authorized_keys`, preserves all other keys, reapplies the required ACL, and records a revocable paired-Mac entry.

The response echoes the request nonce and public-key fingerprint and contains the Windows Host Fingerprint, LAN address candidates, port, native architecture, stable Worker commands, default root and capability summary.

## Mac acceptance

The Mac requires a matching pending request, scans each candidate address with system `ssh-keyscan`, fingerprints the returned host key and accepts only an exact match with the response. It then stages `known_hosts` and node config, performs a real `mira_bridge_describe_node` RPC, and commits the pairing record. A failed handshake restores both files.

The pairing code is not trusted as a password and does not replace SSH host-key verification. A clipboard attacker cannot make the Mac accept a different host key without also presenting that fingerprint live and passing public-key authentication/Worker handshake.

## Revocation

`mirabridge pair revoke NODE` first invokes the pinned node's Worker management command to remove the exact marked public-key fingerprint, then removes local node trust. If a legacy/manual node has no pairing record, `--local-only` removes Mac trust and instructs the operator to revoke the key in the Windows app.
