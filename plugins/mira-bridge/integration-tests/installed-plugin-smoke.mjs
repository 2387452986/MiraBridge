import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = process.env.MIRABRIDGE_PLUGIN_ROOT;
const configPath = process.env.MIRABRIDGE_CONFIG;
const nodeId = process.env.MIRABRIDGE_E2E_NODE ?? "windows-main";
const pullSource = process.env.MIRABRIDGE_E2E_PULL_SOURCE;
const pullDestination = process.env.MIRABRIDGE_E2E_PULL_DESTINATION;
if (!pluginRoot) throw new Error("MIRABRIDGE_PLUGIN_ROOT must identify the installed plugin cache directory.");
if (!configPath) throw new Error("MIRABRIDGE_CONFIG must identify the paired node configuration.");

const transport = new StdioClientTransport({
  command: "/bin/sh",
  args: [resolve(pluginRoot, "scripts/run-mcp.sh")],
  cwd: pluginRoot,
  env: {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    MIRABRIDGE_CONFIG: configPath,
  },
  stderr: "pipe",
});
const client = new Client({ name: "mirabridge-installed-plugin-smoke", version: "2.0.0-rc.2" });

function result(response) {
  const value = response.structuredContent;
  if (!value?.ok) throw new Error(JSON.stringify(value?.error ?? response.content));
  return value.result;
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 28) throw new Error(`Expected 28 tools, received ${tools.tools.length}.`);
  const nodes = result(await client.callTool({ name: "mira_bridge_list_nodes", arguments: {} }));
  if (!nodes.nodes.some((node) => node.node_id === nodeId)) throw new Error(`Configured node not visible: ${nodeId}`);
  const described = result(await client.callTool({ name: "mira_bridge_describe_node", arguments: { node_id: nodeId } }));
  if (described.worker_version !== "2.0.0-rc.2" || described.protocol_version !== "2.0") {
    throw new Error(`Unexpected stable Host handshake: ${JSON.stringify({ worker: described.worker_version, protocol: described.protocol_version })}`);
  }
  const transfer = pullSource && pullDestination
    ? result(await client.callTool({
        name: "mira_bridge_pull",
        arguments: { node_id: nodeId, source_path: pullSource, destination_path: pullDestination, kind: "file", overwrite: false },
      }, undefined, { timeout: 600_000, resetTimeoutOnProgress: true, maxTotalTimeout: 600_000 }))
    : undefined;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    tools: tools.tools.length,
    node_id: nodeId,
    worker_version: described.worker_version,
    protocol_version: described.protocol_version,
    architecture: described.architecture,
    host: described.hostname,
    transfer,
  }, null, 2)}\n`);
} finally {
  await client.close().catch(() => undefined);
}
