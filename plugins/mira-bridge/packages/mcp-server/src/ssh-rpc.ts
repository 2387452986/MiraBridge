import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  BridgeError,
  MAX_RPC_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  asBridgeError,
  rpcResponseSchema,
  type NodeConfig,
  type RpcPayload,
  type RpcRequest,
} from "../../protocol/src/index.js";
import { defaultConfigPath, knownHostsPath, requireNode } from "./config.js";

interface PendingCall {
  resolve: (value: RpcPayload) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

export function responseTimeoutMs(node: NodeConfig, operation: string, args: Record<string, unknown>): number {
  const supplied = typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms) ? args.timeout_ms : undefined;
  const requested = operation === "mira_bridge_exec" || operation === "mira_bridge_powershell"
    ? supplied ?? 300_000
    : operation === "mira_bridge_wait_job"
      ? supplied ?? 30_000
      : operation.startsWith("transfer_")
        ? 1_800_000
        : operation === "mira_bridge_web_snapshot"
          ? supplied ?? 120_000
          : operation === "mira_bridge_stat" && args.hash_mode === "always"
            ? 1_800_000
            : operation === "mira_bridge_scan_recycle_bin" || operation === "mira_bridge_empty_recycle_bin" || operation === "mira_bridge_manage_path"
              ? 600_000
              : 45_000;
  return Math.min(1_900_000, Math.max(node.connect_timeout_ms + 15_000, requested + 15_000));
}

function transportError(stderr: string, cause?: unknown): BridgeError {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) {
    return new BridgeError("HOST_KEY_MISMATCH", "The SSH host key does not match MiraBridge's pinned key.", { cause });
  }
  if (/Permission denied \(publickey/i.test(stderr)) {
    return new BridgeError("SSH_AUTH_FAILED", "SSH public-key authentication failed.", { cause });
  }
  if (/not recognized|not found|is not recognized as the name/i.test(stderr)) {
    return new BridgeError("WORKER_NOT_FOUND", "mirabridge-worker was not found on the Windows node.", { cause });
  }
  return new BridgeError("NODE_OFFLINE", "The Windows node is offline or the SSH transport closed.", {
    retryable: true,
    details: stderr ? { ssh_stderr: stderr.slice(-2048) } : {},
    cause,
  });
}

function normalizedFingerprint(value: string): string {
  return value.replace(/=+$/, "");
}

export function assertPinnedHostFingerprint(node: NodeConfig, knownHosts: string): void {
  let text: string;
  try { text = readFileSync(knownHosts, "utf8"); }
  catch (error) {
    throw new BridgeError("HOST_KEY_MISMATCH", "MiraBridge's managed known_hosts file could not be read.", { cause: error, details: { known_hosts: knownHosts } });
  }
  const acceptedHosts = new Set([node.host, `[${node.host}]:${node.port}`]);
  const fingerprints: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (!fields[0] || fields[0].startsWith("#") || fields[0].startsWith("@")) continue;
    if (!fields[0].split(",").some((host) => acceptedHosts.has(host))) continue;
    const key = fields[2];
    if (!key) continue;
    const bytes = Buffer.from(key, "base64");
    if (bytes.length === 0) continue;
    fingerprints.push(`SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`);
  }
  if (!fingerprints.some((value) => normalizedFingerprint(value) === normalizedFingerprint(node.host_fingerprint))) {
    throw new BridgeError("HOST_KEY_MISMATCH", "The configured host_fingerprint does not match this node's managed known_hosts entry.", {
      details: { host: node.host, port: node.port, expected: node.host_fingerprint, known_fingerprints: fingerprints },
    });
  }
}

export class SshRpcClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingCall>();
  private stderr = "";

  constructor(
    readonly nodeId: string,
    readonly node: NodeConfig,
    private readonly knownHosts: string,
    private readonly sshExecutable = "ssh",
  ) {}

  private start(): void {
    if (this.child && !this.child.killed) return;
    assertPinnedHostFingerprint(this.node, this.knownHosts);
    this.stderr = "";
    const sshArgs = [
      "-T",
      "-p", String(this.node.port),
      "-i", this.node.identity_file,
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", `ConnectTimeout=${Math.max(1, Math.ceil(this.node.connect_timeout_ms / 1000))}`,
      "-l", this.node.user,
      this.node.host,
      this.node.worker_command,
    ];
    const child = spawn(this.sshExecutable, sshArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.on("error", (error) => this.failAll(transportError(this.stderr, error)));
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
      this.failAll(transportError(this.stderr));
    });
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line) > MAX_RPC_MESSAGE_BYTES) {
      this.failAll(new BridgeError("PROTOCOL_MISMATCH", "Worker response exceeded the maximum RPC message size."));
      this.close();
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (error) {
      this.failAll(new BridgeError("PROTOCOL_MISMATCH", "Worker returned invalid JSON.", { cause: error }));
      return;
    }
    const parsed = rpcResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      this.failAll(new BridgeError("PROTOCOL_MISMATCH", "Worker returned an invalid RPC response.", { details: { issues: parsed.error.issues } }));
      return;
    }
    const call = this.pending.get(parsed.data.id);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(parsed.data.id);
    call.resolve(parsed.data.result);
  }

  private failAll(error: BridgeError): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  async call(operation: string, args: Record<string, unknown>, requestId = `req_${randomUUID()}`): Promise<RpcPayload> {
    const request: RpcRequest = {
      jsonrpc: "2.0",
      id: requestId,
      method: "mirabridge.invoke",
      params: {
        protocol_version: PROTOCOL_VERSION,
        request_id: requestId,
        node_id: this.nodeId,
        operation,
        arguments: args,
        timestamp: new Date().toISOString(),
      },
    };
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line) > MAX_RPC_MESSAGE_BYTES) {
      throw new BridgeError("INVALID_ARGUMENT", "RPC request exceeds the maximum message size.");
    }
    this.start();
    const child = this.child;
    if (!child) throw new BridgeError("NODE_OFFLINE", "SSH transport could not be started.", { retryable: true });
    return await new Promise<RpcPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeError("NODE_OFFLINE", "Timed out waiting for the Windows worker.", { retryable: true }));
      }, responseTimeoutMs(this.node, operation, args));
      this.pending.set(requestId, { resolve, reject, timer });
      child.stdin.write(line, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(transportError(this.stderr, error));
      });
    });
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }
}

export interface RemoteCaller {
  call(nodeId: string, operation: string, args: Record<string, unknown>, requestId?: string): Promise<RpcPayload>;
  lastKnownStatus(nodeId: string): "online" | "offline" | "unknown";
  close(): void;
}

export class SshPool implements RemoteCaller {
  private readonly clients = new Map<string, SshRpcClient>();
  private readonly status = new Map<string, "online" | "offline">();

  constructor(
    private readonly configPath = defaultConfigPath(),
    private readonly sshExecutable = "ssh",
  ) {}

  async call(nodeId: string, operation: string, args: Record<string, unknown>, requestId?: string): Promise<RpcPayload> {
    const stableRequestId = requestId ?? `req_${randomUUID()}`;
    let client = this.clients.get(nodeId);
    if (!client) {
      client = new SshRpcClient(nodeId, await requireNode(nodeId, this.configPath), knownHostsPath(this.configPath), this.sshExecutable);
      this.clients.set(nodeId, client);
    }
    try {
      const response = await client.call(operation, args, stableRequestId);
      this.status.set(nodeId, "online");
      return response;
    } catch (error) {
      const bridgeError = asBridgeError(error);
      this.status.set(nodeId, "offline");
      if (bridgeError.retryable) {
        client.close();
        this.clients.delete(nodeId);
        const retry = new SshRpcClient(nodeId, await requireNode(nodeId, this.configPath), knownHostsPath(this.configPath), this.sshExecutable);
        this.clients.set(nodeId, retry);
        try {
          const response = await retry.call(operation, args, stableRequestId);
          this.status.set(nodeId, "online");
          return response;
        } catch (retryError) {
          this.status.set(nodeId, "offline");
          throw asBridgeError(retryError);
        }
      }
      throw bridgeError;
    }
  }

  lastKnownStatus(nodeId: string): "online" | "offline" | "unknown" {
    return this.status.get(nodeId) ?? "unknown";
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}
