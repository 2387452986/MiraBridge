#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${MIRABRIDGE_NODE:-}" ]; then
  node_bin="$MIRABRIDGE_NODE"
  mcp_entry="${MIRABRIDGE_MCP_ENTRY:-$script_dir/../packages/mcp-server/dist/index.mjs}"
else
  runtime_root="${MIRABRIDGE_INSTALL_ROOT:-$HOME/Library/Application Support/MiraBridge}"
  node_bin="$runtime_root/current/node/bin/node"
  mcp_entry="$runtime_root/current/mcp/index.mjs"
fi

if [ ! -x "$node_bin" ] || [ ! -f "$mcp_entry" ]; then
  echo "MiraBridge managed runtime is not installed. Run plugins/mira-bridge/scripts/install-mac.sh from the fixed release tag." >&2
  exit 69
fi

exec "$node_bin" "$mcp_entry" --stdio
