# Contributing to MiraBridge

Thank you for helping make Windows a dependable native tool runtime for Mac-hosted Agents.

1. Keep `reasoning_host = Mac` and `tool_host = Windows`. Do not add an LLM, planner, Agent loop, semantic memory, remote desktop, command translator, public listener, or sync engine to the Worker.
2. Start from an issue for public-contract, protocol, persistence, security, installer, or dependency changes.
3. Use Node.js 24.19.0 and .NET SDK 10.0.400. Keep TypeScript strict and C# warnings as errors.
4. Add an `error_before` and `verify_after` for fixes. Separate Mac/mock, Windows-native and real-LAN evidence.
5. Run the commands in `docs/RELEASE_CHECKLIST.md`. Never report mock coverage as a physical Windows acceptance.
6. Do not commit credentials, private keys, pairing codes, machine names, personal paths, command bodies, file contents or unredacted diagnostics.

By contributing, you agree that your contribution is licensed under the MIT License.
