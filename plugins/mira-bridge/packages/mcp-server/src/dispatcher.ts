import { ZodError } from "zod";
import {
  BridgeError,
  asBridgeError,
  isToolName,
  parseScopedId,
  parseToolInput,
  type PublicResult,
  type RpcPayload,
  type ToolName,
} from "../../protocol/src/index.js";
import { defaultConfigPath, loadMacConfig } from "./config.js";
import type { RemoteCaller } from "./ssh-rpc.js";
import { pullPath, pushPath, type ProgressCallback } from "./transfers.js";

function fromPayload(payload: RpcPayload): PublicResult {
  if (payload.ok) return { ok: true, result: payload.result };
  return {
    ok: false,
    error: payload.error ?? {
      code: "INTERNAL_ERROR",
      message: "Worker returned an unsuccessful response without an error object.",
      retryable: false,
      details: {},
    },
  };
}

function nodeForTool(name: ToolName, args: Record<string, unknown>): string {
  if (typeof args.node_id === "string") return args.node_id;
  if (typeof args.workspace_id === "string") return parseScopedId(args.workspace_id, "ws").nodeId;
  if (typeof args.job_id === "string") return parseScopedId(args.job_id, "job").nodeId;
  if (typeof args.output_ref === "string") return parseScopedId(args.output_ref, "output").nodeId;
  if (typeof args.scan_id === "string") return parseScopedId(args.scan_id, "scan").nodeId;
  throw new BridgeError("INVALID_ARGUMENT", `Cannot determine a Windows node for ${name}.`);
}

const wireDefaultFields: Partial<Record<ToolName, readonly string[]>> = {
  mira_bridge_list_directory: ["sort_by", "sort_order"],
  mira_bridge_stat: ["hash_mode"],
  mira_bridge_read_text: ["include_integrity"],
  mira_bridge_glob: ["sort_by", "sort_order"],
};

function remoteArguments(name: ToolName, parsed: Record<string, unknown>, raw: unknown): Record<string, unknown> {
  const fields = wireDefaultFields[name];
  if (!fields) return parsed;
  const supplied = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const result = { ...parsed };
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(supplied, field)) delete result[field];
  }
  return result;
}

export class ToolDispatcher {
  constructor(
    private readonly remote: RemoteCaller,
    private readonly configPath = defaultConfigPath(),
  ) {}

  async call(nameValue: string, rawArgs: unknown, onProgress?: ProgressCallback): Promise<PublicResult> {
    try {
      if (!isToolName(nameValue)) throw new BridgeError("INVALID_ARGUMENT", `Unknown MiraBridge tool: ${nameValue}`);
      const args = parseToolInput(nameValue, rawArgs ?? {});
      if (nameValue === "mira_bridge_list_nodes") {
        const config = await loadMacConfig(this.configPath);
        return {
          ok: true,
          result: {
            nodes: Object.keys(config.nodes).sort().map((nodeId) => ({
              node_id: nodeId,
              configured: true,
              last_known_status: this.remote.lastKnownStatus(nodeId),
            })),
          },
        };
      }
      if (nameValue === "mira_bridge_push") {
        return {
          ok: true,
          result: await pushPath(
            this.remote,
            String(args.node_id),
            String(args.source_path),
            String(args.destination_path),
            args.kind as "auto" | "file" | "directory",
            Boolean(args.overwrite),
            onProgress,
          ),
        };
      }
      if (nameValue === "mira_bridge_pull") {
        return {
          ok: true,
          result: await pullPath(
            this.remote,
            String(args.node_id),
            String(args.source_path),
            String(args.destination_path),
            args.kind as "auto" | "file" | "directory",
            Boolean(args.overwrite),
            onProgress,
          ),
        };
      }
      return fromPayload(await this.remote.call(nodeForTool(nameValue, args), nameValue, remoteArguments(nameValue, args, rawArgs)));
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          ok: false,
          error: {
            code: "INVALID_ARGUMENT",
            message: "MiraBridge tool arguments are invalid.",
            retryable: false,
            details: { issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
          },
        };
      }
      return { ok: false, error: asBridgeError(error).toJSON() };
    }
  }
}
