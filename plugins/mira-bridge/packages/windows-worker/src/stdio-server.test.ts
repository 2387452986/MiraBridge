import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type RpcRequest } from "../../protocol/src/index.js";
import { jobInputAuditArguments, operationAuditArguments, powerShellAuditArguments, terminalResizeAuditArguments } from "./audit.js";
import type { WorkerRuntime } from "./runtime.js";
import { WorkerState } from "./state.js";
import { WorkerStdioServer } from "./stdio-server.js";

const roots: string[] = [];
const originalLocalAppData = process.env.LOCALAPPDATA;

afterEach(async () => {
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(id: string, requestId: string, argumentsValue: Record<string, unknown> = {}, operation = "mira_bridge_describe_node"): RpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "mirabridge.invoke",
    params: {
      protocol_version: PROTOCOL_VERSION,
      request_id: requestId,
      node_id: "windows-main",
      operation,
      arguments: argumentsValue,
      timestamp: new Date().toISOString(),
    },
  };
}

describe("worker request idempotency", () => {
  it("summarizes PowerShell scripts without logging their contents", () => {
    const script = "Write-Output 'super-secret-value'\nGet-Date";
    const summary = powerShellAuditArguments(script);
    expect(summary).toHaveLength(2);
    expect(summary[0]).toMatch(/^script_sha256=[0-9a-f]{64}$/u);
    expect(summary[1]).toBe(`script_summary=chars:${script.length},lines:2`);
    expect(summary.join(" ")).not.toContain("super-secret-value");
  });

  it("hashes Job input audit metadata without logging input contents", () => {
    const summary = jobInputAuditArguments("super-secret-stdin\n", true);
    expect(summary).toEqual([
      expect.stringMatching(/^input_sha256=[0-9a-f]{64}$/u),
      "input_bytes=19",
      "close=true",
    ]);
    expect(summary.join(" ")).not.toContain("super-secret-stdin");
  });

  it("records terminal dimensions without terminal input contents", () => {
    expect(terminalResizeAuditArguments(120, 40)).toEqual(["terminal_cols=120", "terminal_rows=40"]);
  });

  it("records path mutations and hashes write bodies instead of logging plaintext", () => {
    const marker = "unique-secret-file-body";
    const write = operationAuditArguments("mira_bridge_write_text", {
      workspace_id: "ws_1234567890",
      path: "reports\\result.txt",
      content: marker,
      create_parents: true,
    });
    expect(write).toEqual(expect.arrayContaining([
      "path=reports\\result.txt",
      "create_parents=true",
      expect.stringMatching(/^content_sha256=[0-9a-f]{64}$/u),
      `content_bytes=${Buffer.byteLength(marker, "utf8")}`,
    ]));
    expect(write.join(" ")).not.toContain(marker);

    expect(operationAuditArguments("mira_bridge_manage_path", {
      action: "move",
      path: "from",
      destination_path: "to",
      overwrite: false,
    })).toEqual(expect.arrayContaining(["action=move", "path=from", "destination_path=to", "overwrite=false"]));
  });

  it("rejects malformed RPC without invoking runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-invalid-rpc-"));
    roots.push(root);
    process.env.LOCALAPPDATA = root;
    await mkdir(join(root, "MiraBridge"));
    const state = new WorkerState(join(root, "state.sqlite3"));
    const execute = vi.fn();
    const server = new WorkerStdioServer({ state, execute } as unknown as WorkerRuntime);
    try {
      expect(await server.handle({ jsonrpc: "2.0", method: "exec" })).toMatchObject({ id: "invalid", result: { ok: false, error: { code: "INVALID_ARGUMENT" } } });
      expect(execute).not.toHaveBeenCalled();
    } finally { state.close(); }
  });

  it("caches identical IDs but rejects changed payloads, including while in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-stdio-"));
    roots.push(root);
    process.env.LOCALAPPDATA = root;
    await mkdir(join(root, "MiraBridge"));
    const state = new WorkerState(join(root, "state.sqlite3"));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { hostname: "WIN" };
    });
    const runtime = { state, execute } as unknown as WorkerRuntime;
    const server = new WorkerStdioServer(runtime);
    try {
      const firstPromise = server.handle(request("rpc-1", "req-same"));
      const changed = await server.handle(request("rpc-2", "req-same", { changed: true }));
      expect(changed).toMatchObject({ id: "rpc-2", result: { ok: false, error: { code: "DUPLICATE_REQUEST_ID" } } });
      release?.();
      const first = await firstPromise;
      expect(first).toMatchObject({ id: "rpc-1", result: { ok: true, result: { hostname: "WIN" } } });
      const replay = await server.handle(request("rpc-3", "req-same"));
      expect(replay).toMatchObject({ id: "rpc-3", result: { ok: true, result: { hostname: "WIN" } } });
      state.deleteRequest("req-same");
      const expiredReplay = await server.handle(request("rpc-4", "req-same"));
      expect(expiredReplay).toMatchObject({ id: "rpc-4", result: { ok: false, error: { code: "DUPLICATE_REQUEST_ID", details: { response_expired: true } } } });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      state.close();
    }
  });

  it("returns a precise protocol-major error", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-protocol-"));
    roots.push(root);
    process.env.LOCALAPPDATA = root;
    await mkdir(join(root, "MiraBridge"));
    const state = new WorkerState(join(root, "state.sqlite3"));
    const runtime = { state, execute: vi.fn() } as unknown as WorkerRuntime;
    const server = new WorkerStdioServer(runtime);
    const incompatible = request("rpc-version", "req-version");
    incompatible.params.protocol_version = "3.0";
    try {
      expect(await server.handle(incompatible)).toMatchObject({ result: { ok: false, error: { code: "PROTOCOL_MISMATCH" } } });
    } finally { state.close(); }
  });

  it("surfaces and caches an audit failure instead of silently claiming a healthy mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-audit-failure-"));
    roots.push(root);
    const invalidLocalAppData = join(root, "not-a-directory");
    await writeFile(invalidLocalAppData, "file", "utf8");
    process.env.LOCALAPPDATA = invalidLocalAppData;
    const state = new WorkerState(join(root, "state.sqlite3"));
    const execute = vi.fn(async () => ({ changed: true }));
    const server = new WorkerStdioServer({ state, execute } as unknown as WorkerRuntime);
    try {
      const operation = request("rpc-audit", "req-audit", { path: "target" }, "mira_bridge_manage_path");
      const first = await server.handle(operation);
      expect(first).toMatchObject({
        result: {
          ok: true,
          result: {
            changed: true,
            audit_warning: { code: "AUDIT_WRITE_FAILED" },
          },
        },
      });
      const replay = await server.handle({ ...operation, id: "rpc-audit-replay" });
      expect(replay).toMatchObject({ result: { result: { audit_warning: { code: "AUDIT_WRITE_FAILED" } } } });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { state.close(); }
  });

  it("reserves a mutating request before execution so a crash cannot repeat its side effect", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-request-reservation-"));
    roots.push(root);
    process.env.LOCALAPPDATA = root;
    await mkdir(join(root, "MiraBridge"));
    const state = new WorkerState(join(root, "state.sqlite3"));
    const execute = vi.fn(async () => ({ changed: true }));
    const server = new WorkerStdioServer({ state, execute } as unknown as WorkerRuntime);
    const putRequest = vi.spyOn(state, "putRequest").mockImplementationOnce(() => { throw new Error("simulated crash after side effect"); });
    try {
      await expect(server.handle(request("rpc-crash", "req-crash", { path: "target" }, "mira_bridge_manage_path"))).rejects.toThrow("simulated crash");
      putRequest.mockRestore();
      const replay = await server.handle(request("rpc-replay", "req-crash", { path: "target" }, "mira_bridge_manage_path"));
      expect(replay).toMatchObject({ result: { ok: false, error: { code: "DUPLICATE_REQUEST_ID", details: { execution_outcome_unknown: true } } } });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { state.close(); }
  });

  it("keeps transfer read chunks out of the full response cache while preserving payload identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-transfer-read-cache-"));
    roots.push(root);
    process.env.LOCALAPPDATA = root;
    await mkdir(join(root, "MiraBridge"));
    const state = new WorkerState(join(root, "state.sqlite3"));
    const execute = vi.fn(async () => ({ data_base64: "eA==", bytes: 1 }));
    const server = new WorkerStdioServer({ state, execute } as unknown as WorkerRuntime);
    try {
      const first = request("rpc-chunk-1", "req-chunk", { transfer_id: "transfer", offset: 0, max_bytes: 1 }, "transfer_read_chunk");
      expect(await server.handle(first)).toMatchObject({ result: { ok: true, result: { data_base64: "eA==" } } });
      expect(state.getRequest("req-chunk")).toBeUndefined();
      expect(state.getRequestTombstone("req-chunk")).toBeDefined();
      expect(await server.handle({ ...first, id: "rpc-chunk-2" })).toMatchObject({ result: { ok: true } });
      expect(await server.handle(request("rpc-chunk-3", "req-chunk", { transfer_id: "transfer", offset: 1, max_bytes: 1 }, "transfer_read_chunk"))).toMatchObject({ result: { ok: false, error: { code: "DUPLICATE_REQUEST_ID" } } });
      expect(execute).toHaveBeenCalledTimes(2);
    } finally { state.close(); }
  });
});
