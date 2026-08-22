# Safety rules

The product route defaults to a Windows Administrator account so approved operations can cover local-equivalent Windows work. Treat exec, PowerShell, and Jobs as administrator code execution: `allowed_roots` constrain Worker file APIs and cwd, but cannot sandbox a native program's own absolute-path or system access.

Never request or store a Windows password, SSH private-key contents, API key, or authentication token. Do not weaken host-key pinning, configured roots, the LocalSubnet/trusted-VPN firewall rule, UAC, Defender, EDR, or other security software to make a task pass.

## Capability boundaries

- `allowed_roots` protects file APIs and command working directories. Native programs remain constrained by the Windows account and NTFS ACLs; MiraBridge does not pretend to sandbox arbitrary program internals.
- Desktop is a separately resolved Known Folder with `disabled`, `read-only`, or `read-write` access. Do not authorize all of `C:\Users` as a shortcut.
- Recycle Bin operations are fixed Worker implementations. Emptying requires an unexpired receipt whose complete physical snapshot is unchanged.
- Web Snapshot uses a new headless Edge context without an existing profile, cookies, extensions, clicks, `file:`, `data:` targets, or browser-internal pages.
- A read-only workspace rejects writes, process execution, PowerShell, Job start, and transfer writes.
- Pipe/ConPTY Job control is reachable only through a random local Worker/runner endpoint and remains approval-gated at MCP. MiraBridge audits the input hash, byte count, EOF/control metadata, and terminal dimensions, never input plaintext. The target program can still echo or persist input in its own UTF-8/VT logs and screen snapshot, so do not treat stdin as a secret vault.
- ConPTY uses one packaged self-contained helper and the existing durable Job runner. It does not create a second Agent/session runtime, does not attach an existing Windows console, and does not expose a network listener.

## Approval boundary

Obtain explicit approval before precise destructive or system-changing operations, including:

- deleting user data or emptying the Recycle Bin;
- clearing a disk, broad directory, Downloads, unknown Docker volumes, model weights, or a workspace root;
- registry, startup, firewall, security software, account, administrator, or system-directory changes;
- formatting disks or uninstalling software;
- downloading and executing an unknown binary.

Plugin approval does not remove Worker path checks, receipt checks, or Windows account permissions. A prior broad goal does not silently authorize a materially different destructive target.

## Cleanup workflow

1. Scan read-only and record exact paths, sizes, ownership clues, recency, or a Recycle Bin receipt.
2. Classify safe cache, unknown/user data, and high-risk locations on the Mac.
3. Present exact candidates and impact unless the user has already authorized those exact targets.
4. Delete only precise confirmed paths; never wildcard-expand a parent or delete a workspace root.
5. Rescan and report actual remaining items and reclaimed space.

If the Recycle Bin receipt expires or the snapshot changes, stop and scan again. Do not bypass `RESOURCE_CHANGED` with an arbitrary PowerShell clear command.
