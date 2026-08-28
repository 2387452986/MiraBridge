import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const temporary = await mkdtemp(join(tmpdir(), "mirabridge-mcp-stdio-"));
const config = join(temporary, "config.toml");
await writeFile(config, "[nodes]\n", "utf8");
const transport = new StdioClientTransport({
  command: "bash",
  args: [resolve("scripts/run-mcp.sh")],
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    MIRABRIDGE_NODE: process.execPath,
    MIRABRIDGE_CONFIG: config,
  },
  stderr: "pipe",
});
const client = new Client({ name: "mirabridge-stdio-smoke", version: "2.0.0-rc.7" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 28) throw new Error(`Expected 28 tools, received ${tools.tools.length}.`);
  const result = await client.callTool({ name: "mira_bridge_list_nodes", arguments: {} });
  if (result.isError) throw new Error("list_nodes failed during MCP stdio smoke.");
  const nodes = result.structuredContent?.result?.nodes;
  if (!Array.isArray(nodes) || nodes.length !== 0) throw new Error("Expected empty configured node list.");
  process.stdout.write(`${JSON.stringify({ ok: true, transport: "stdio", tools: tools.tools.length, nodes: nodes.length })}\n`);
} finally {
  await client.close().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
