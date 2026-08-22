import { createInterface } from "node:readline";
import { ZodError } from "zod";
import {
  BridgeError,
  MAX_RPC_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  asBridgeError,
  canonicalJson,
  rpcRequestSchema,
  sha256,
  type RpcPayload,
  type RpcRequest,
  type RpcResponse,
} from "../../protocol/src/index.js";
import { operationAuditArguments, writeAudit } from "./audit.js";
import { loadWorkerConfig } from "./config.js";
import { WorkerRuntime } from "./runtime.js";

function response(id: string, payload: RpcPayload): RpcResponse {
  return { jsonrpc: "2.0", id, result: payload };
}

function errorPayload(requestId: string, started: number, error: unknown): RpcPayload {
  const bridgeError = error instanceof ZodError
    ? new BridgeError("INVALID_ARGUMENT", "RPC or operation arguments are invalid.", {
        details: { issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
      })
    : asBridgeError(error);
  return {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    ok: false,
    error: bridgeError.toJSON(),
    duration_ms: Math.max(0, Date.now() - started),
  };
}

export class WorkerStdioServer {
  private readonly inFlight = new Map<string, { payloadHash: string; response: Promise<RpcResponse> }>();
  private writeChain = Promise.resolve();

  constructor(readonly runtime: WorkerRuntime) {}

  async handle(decoded: unknown): Promise<RpcResponse> {
    const started = Date.now();
    let request: RpcRequest;
    try {
      request = rpcRequestSchema.parse(decoded);
    } catch (error) {
      return response("invalid", errorPayload("invalid", started, error));
    }
    const payloadHash = this.payloadHash(request);
    const existingFlight = this.inFlight.get(request.params.request_id);
    if (existingFlight) {
      if (existingFlight.payloadHash !== payloadHash) {
        return response(request.id, errorPayload(request.params.request_id, started, new BridgeError("DUPLICATE_REQUEST_ID", "request_id was reused with a different payload.")));
      }
      const existing = await existingFlight.response;
      return response(request.id, existing.result);
    }
    const work = this.handleParsed(request, started, payloadHash);
    this.inFlight.set(request.params.request_id, { payloadHash, response: work });
    try { return await work; }
    finally { this.inFlight.delete(request.params.request_id); }
  }

  private payloadHash(request: RpcRequest): string {
    return sha256(canonicalJson({
      protocol_version: request.params.protocol_version,
      node_id: request.params.node_id,
      operation: request.params.operation,
      arguments: request.params.arguments,
    }));
  }

  private async handleParsed(request: RpcRequest, started: number, payloadHash: string): Promise<RpcResponse> {
    const replaySafeWithoutResponseCache = request.params.operation === "transfer_read_chunk";
    const admission = this.runtime.state.beginRequest(request.params.request_id, payloadHash, request.params.operation);
    if (admission.state === "complete") {
      if (admission.payload_hash !== payloadHash) {
        return response(request.id, errorPayload(request.params.request_id, started, new BridgeError("DUPLICATE_REQUEST_ID", "request_id was reused with a different payload.")));
      }
      const cached = JSON.parse(admission.response_json) as RpcResponse;
      return response(request.id, cached.result);
    }
    if (admission.state === "existing" && !(replaySafeWithoutResponseCache && admission.payload_hash === payloadHash && admission.operation === request.params.operation)) {
      const samePayload = admission.payload_hash === payloadHash;
      const message = samePayload
        ? "request_id was already admitted, but no replayable response is available; refusing to repeat a possibly completed operation."
        : "request_id was reused with a different payload.";
      return response(request.id, errorPayload(request.params.request_id, started, new BridgeError("DUPLICATE_REQUEST_ID", message, {
        details: { operation: admission.operation, original_created_at: admission.created_at, response_expired: true, execution_outcome_unknown: samePayload },
      })));
    }
    let payload: RpcPayload;
    try {
      if (request.params.protocol_version.split(".")[0] !== PROTOCOL_VERSION.split(".")[0]) {
        throw new BridgeError("PROTOCOL_MISMATCH", `Worker supports protocol ${PROTOCOL_VERSION}, not ${request.params.protocol_version}.`);
      }
      const result = await this.runtime.execute(request.params.operation, request.params.arguments, request.params.node_id);
      payload = {
        protocol_version: PROTOCOL_VERSION,
        request_id: request.params.request_id,
        ok: true,
        result: { request_id: request.params.request_id, ...result },
        duration_ms: Math.max(0, Date.now() - started),
      };
    } catch (error) {
      payload = errorPayload(request.params.request_id, started, error);
    }
    const args = request.params.arguments;
    const isPowerShell = request.params.operation === "mira_bridge_powershell";
    const auditArgs = operationAuditArguments(request.params.operation, args);
    const auditFailure = await writeAudit({
      request_id: request.params.request_id,
      node_id: request.params.node_id,
      ...(typeof args.workspace_id === "string" ? { workspace_id: args.workspace_id } : {}),
      operation: request.params.operation,
      ...(typeof args.program === "string" ? { program: args.program } : isPowerShell ? { program: "PowerShell" } : {}),
      ...(auditArgs.length > 0 ? { args: auditArgs } : {}),
      ...(args.env && typeof args.env === "object" ? { env: args.env as Record<string, string> } : {}),
      ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
      started_at: new Date(started).toISOString(),
      finished_at: new Date().toISOString(),
      ...(payload.ok && payload.result && typeof payload.result === "object" && typeof (payload.result as Record<string, unknown>).exit_code === "number" ? { exit_code: (payload.result as Record<string, unknown>).exit_code as number } : {}),
      ...(!payload.ok && payload.error ? { error_code: payload.error.code } : {}),
      ok: payload.ok,
    }).then(() => undefined, (error: unknown) => error);
    if (auditFailure) {
      process.stderr.write(`MiraBridge audit write failed: ${auditFailure instanceof Error ? auditFailure.message : String(auditFailure)}\n`);
      const warning = {
        code: "AUDIT_WRITE_FAILED",
        message: "The Windows operation completed, but its durable audit record could not be written. Run mirabridge-worker doctor before further mutations.",
      };
      if (payload.ok && payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)) {
        payload = { ...payload, result: { ...(payload.result as Record<string, unknown>), audit_warning: warning } };
      } else if (!payload.ok && payload.error) {
        payload = { ...payload, error: { ...payload.error, details: { ...payload.error.details, audit_warning: warning } } };
      }
    }
    const complete = response(request.id, payload);
    if (!replaySafeWithoutResponseCache) {
      this.runtime.state.putRequest(request.params.request_id, payloadHash, JSON.stringify(complete), request.params.operation);
    }
    return complete;
  }

  write(value: RpcResponse): void {
    const line = `${JSON.stringify(value)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await new Promise<void>((resolve, reject) => process.stdout.write(line, "utf8", (error) => error ? reject(error) : resolve()));
    });
  }
}

export async function serveWorkerStdio(): Promise<void> {
  const runtime = await WorkerRuntime.create(await loadWorkerConfig());
  const server = new WorkerStdioServer(runtime);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  input.on("line", (line) => {
    const task = (async () => {
      if (Buffer.byteLength(line) > MAX_RPC_MESSAGE_BYTES) {
        server.write(response("invalid", errorPayload("invalid", Date.now(), new BridgeError("INVALID_ARGUMENT", "RPC message exceeds 2 MiB."))));
        return;
      }
      let decoded: unknown;
      try { decoded = JSON.parse(line); }
      catch (error) {
        server.write(response("invalid", errorPayload("invalid", Date.now(), new BridgeError("INVALID_ARGUMENT", "RPC message is not valid JSON.", { cause: error }))));
        return;
      }
      server.write(await server.handle(decoded));
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await new Promise<void>((resolve) => input.once("close", resolve));
  await Promise.allSettled(pending);
  runtime.close();
}
