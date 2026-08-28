# @mirabridge/cli

Mac configuration and diagnostics CLI for MiraBridge 2.0.0-rc.7. It manages node TOML and a dedicated `known_hosts`; it does not contain the Agent loop or Windows execution logic.

```text
mirabridge init
mirabridge node add --id ID --host HOST --user USER --identity-file PATH
mirabridge node reconnect ID --host NEW_HOST
mirabridge node list
mirabridge node test ID
mirabridge doctor
mirabridge worker check ID
```

`node reconnect` is for a paired Windows computer whose DHCP hostname or IP
changed. It reuses the existing pinned fingerprint, performs a Worker handshake,
and rolls back on failure. It never accepts a different host key as a network
move.

`node reconnect` 用于已配对 Windows 电脑的 DHCP 主机名或 IP 变化。它沿用
原固定指纹、执行 Worker 握手并在失败时回滚；不会把不同主机密钥当成普通
网络迁移接受。
