# @mirabridge/cli

Mac configuration and diagnostics CLI for MiraBridge 2.0.0-rc.6. It manages node TOML and a dedicated `known_hosts`; it does not contain the Agent loop or Windows execution logic.

```text
mirabridge init
mirabridge node add --id ID --host HOST --user USER --identity-file PATH
mirabridge node list
mirabridge node test ID
mirabridge doctor
mirabridge worker check ID
```
