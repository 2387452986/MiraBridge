# Pairing and SSH trust

Pairing uses two clipboard codes and one live network verification. A code is versioned base64url JSON, no larger than 16 KiB and valid for at most 30 minutes.

## Guided copy flow

The Windows app's **Connect Mac** page presents the complete commands, so the normal path does not require remembering CLI syntax:

1. Click **Copy command** and give `~/.local/bin/mirabridge pair create` to Codex on the Mac.
2. Paste the request code produced on the Mac into Windows and click **Authorize & create response**.
3. Click **Copy completion command** and give the complete `~/.local/bin/mirabridge pair accept …` command back to Codex on the Mac.

The Windows authorization click already installs the validated public key. It does not require a separate SSH command, private-key copy, password, or manually entered fingerprint.

## Request: Mac to Windows

The request contains the Mac Ed25519 **public** key, its SHA-256 fingerprint, a random nonce, node ID, creation/expiry time and basic Mac/version metadata. The private key stays in `~/.config/mirabridge/identities` with mode 0600. There is no password or token.

## Windows authorization and response

The elevated helper validates type, TTL, nonce, key format and key fingerprint; a used nonce is rejected. It appends exactly one marked line to `administrators_authorized_keys`, preserves all other keys, reapplies the required ACL, and records a revocable paired-Mac entry.

The response echoes the request nonce and public-key fingerprint and contains the Windows Host Fingerprint, LAN address candidates, port, native architecture, stable Worker commands, default root and capability summary.

## Mac acceptance

The Mac requires a matching pending request, scans each candidate address with system `ssh-keyscan`, fingerprints the returned host key and accepts only an exact match with the response. It then stages `known_hosts` and node config, performs a real `mira_bridge_describe_node` RPC, and commits the pairing record. A failed handshake restores both files.

The pairing code is not trusted as a password and does not replace SSH host-key verification. A clipboard attacker cannot make the Mac accept a different host key without also presenting that fingerprint live and passing public-key authentication/Worker handshake.

## DHCP address change / DHCP 地址变化

When a paired Windows computer receives a new LAN hostname or IP address, keep
the existing node identity and run this on the Mac:

```sh
mirabridge node reconnect windows-main --host <new-host-or-IP>
```

The command scans the candidate address and requires an exact match with the
node's already pinned SSH host fingerprint. It stages the new `known_hosts`
entry and node address, performs a real Worker handshake, and removes the old
address only after verification. Any mismatch or failed handshake restores both
files. Do not delete `known_hosts` or accept a replacement key as a DHCP change.

已配对的 Windows 电脑更换局域网主机名或 IP 后，请保留原节点身份，并在
Mac 上执行上面的命令。命令只接受与原固定 SSH 主机指纹完全一致的新地址，
随后执行真实 Worker 握手；任何指纹不一致或握手失败都会恢复配置与
`known_hosts`。不要把删除 `known_hosts` 或接受新密钥当成 DHCP 重连方式。

## Revocation

`mirabridge pair revoke NODE` first invokes the pinned node's Worker management command to remove the exact marked public-key fingerprint, then removes local node trust. If a legacy/manual node has no pairing record, `--local-only` removes Mac trust and instructs the operator to revoke the key in the Windows app.
