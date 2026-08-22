import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MIRABRIDGE_VERSION,
  publicResultSchema,
  toolDefinitions,
  toolNames,
  type PublicResult,
} from "../../protocol/src/index.js";
import { ToolDispatcher } from "./dispatcher.js";
import { defaultConfigPath } from "./config.js";
import { SshPool, type RemoteCaller } from "./ssh-rpc.js";

function mcpText(result: PublicResult): string {
  if (result.ok) {
    if (!result.result || typeof result.result !== "object") return "MiraBridge operation succeeded.";
    const value = result.result as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    for (const key of ["node_id", "hostname", "workspace_id", "job_id", "executor_status", "exit_code", "duration_ms", "timed_out", "truncated", "output_ref", "total_entries", "total_matches", "size", "sha256"]) {
      if (value[key] !== undefined) summary[key] = value[key];
    }
    if (Array.isArray(value.nodes)) summary.node_count = value.nodes.length;
    if (Array.isArray(value.entries)) summary.entry_count = value.entries.length;
    if (Array.isArray(value.matches)) summary.match_count = value.matches.length;
    return Object.keys(summary).length
      ? `MiraBridge operation succeeded: ${JSON.stringify(summary)}`
      : "MiraBridge operation succeeded.";
  }
  return `${result.error?.code ?? "INTERNAL_ERROR"}: ${result.error?.message ?? "MiraBridge failed."}`;
}

export function createServer(remote: RemoteCaller = new SshPool(), configPath = defaultConfigPath()): { server: Server; close: () => void } {
  const server = new Server(
    { name: "mirabridge-mcp", version: MIRABRIDGE_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: "MiraBridge exposes Windows as a deterministic remote tool runtime. It never runs an Agent or LLM.",
    },
  );
  const dispatcher = new ToolDispatcher(remote, configPath);
  const outputSchema = z.toJSONSchema(publicResultSchema) as { type: "object"; properties?: Record<string, object>; required?: string[] };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map((name) => {
      const definition = toolDefinitions[name];
      return {
        name,
        description: definition.description,
        inputSchema: z.toJSONSchema(definition.input) as { type: "object"; properties?: Record<string, object>; required?: string[] },
        outputSchema,
        annotations: definition.annotations,
      };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const progressToken = request.params._meta?.progressToken;
    const result = await dispatcher.call(
      request.params.name,
      request.params.arguments ?? {},
      progressToken === undefined
        ? undefined
        : async (progress, total) => {
            await server.notification({
              method: "notifications/progress",
              params: { progressToken, progress, total, message: `Transferred ${progress} of ${total} bytes` },
            });
          },
    );
    return {
      content: [{ type: "text", text: mcpText(result) }],
      structuredContent: result as Record<string, unknown>,
      isError: !result.ok,
    };
  });

  return { server, close: () => remote.close() };
}

export async function serveStdio(remote?: RemoteCaller): Promise<void> {
  const runtime = createServer(remote);
  const shutdown = async (): Promise<void> => {
    runtime.close();
    await runtime.server.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await runtime.server.connect(new StdioServerTransport());
}
