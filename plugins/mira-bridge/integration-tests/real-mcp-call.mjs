import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [toolName, argumentsJson = "{}"] = process.argv.slice(2);
const configPath = process.env.MIRABRIDGE_CONFIG;
if (!toolName || !configPath) {
  throw new Error("Usage: MIRABRIDGE_CONFIG=/absolute/config.toml node integration-tests/real-mcp-call.mjs <tool> '<arguments-json>'");
}

const toolArguments = JSON.parse(argumentsJson);
const transport = new StdioClientTransport({
  command: "bash",
  args: [resolve("scripts/run-mcp.sh")],
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    MIRABRIDGE_NODE: process.execPath,
    MIRABRIDGE_CONFIG: configPath,
  },
  stderr: "pipe",
});
const client = new Client({ name: "mirabridge-real-mcp-call", version: "2.0.0-rc.1" });
try {
  await client.connect(transport);
  const response = await client.callTool(
    { name: toolName, arguments: toolArguments },
    undefined,
    {
      timeout: 30 * 60 * 1000,
      maxTotalTimeout: 30 * 60 * 1000,
      resetTimeoutOnProgress: true,
      onprogress: ({ progress, total }) => process.stderr.write(`MiraBridge progress: ${progress}/${total ?? "?"}\n`),
    },
  );
  process.stdout.write(`${JSON.stringify(response.structuredContent, null, 2)}\n`);
  if (response.isError) process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
