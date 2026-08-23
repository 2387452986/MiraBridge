# Support matrix — 2.0.0-rc.4

| Host | Supported | Release evidence |
|---|---|---|
| macOS 14+ Apple Silicon | Yes | Real local managed-runtime gate; public CI pending tag |
| macOS 14+ Intel | RC target | Workflow defined; completed CI/physical evidence pending |
| Windows 11 x64 | Yes | Real-LAN x64 build and acceptance |
| Windows 11 ARM64 | RC target | Native GitHub runner job defined; completed CI and physical GUI pending |
| Windows 10 22H2 x64 | RC target | No real VM evidence yet |
| Windows 32-bit x86 | No | Installer gives an actionable 64-bit requirement |
| NVIDIA / AMD / Intel GPU | Capability-detected | No driver is installed or upgraded |
| No discrete GPU | Yes | Process, file, job, transfer and local Edge features remain available |

Core operation requires a Mac running Codex and a Windows computer reachable on the same trusted LAN or an existing secure SSH network. `2.0.0-rc.4` is unsigned; stable `2.0.0` is blocked on code signing plus physical Windows 10 and ARM64 GUI acceptance.
