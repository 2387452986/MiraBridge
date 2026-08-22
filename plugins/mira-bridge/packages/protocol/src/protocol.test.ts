import { describe, expect, it } from "vitest";
import {
  BridgeError,
  createScopedId,
  parseScopedId,
  parseToolInput,
  previewOutput,
  redactRecord,
  rpcRequestSchema,
    summarizeArguments,
    toolDefinitions,
    toolNames,
  internalTransferSchemas,
  nodeConfigSchema,
  workerConfigSchema,
} from "./index.js";

describe("protocol contract", () => {
  it("publishes exactly the 28 MiraBridge tools", () => {
    expect(toolNames).toHaveLength(28);
    expect(new Set(toolNames).size).toBe(28);
    expect(toolNames.every((name) => name.startsWith("mira_bridge_"))).toBe(true);
    expect(toolNames).toEqual(expect.arrayContaining([
      "mira_bridge_edit_text",
      "mira_bridge_manage_path",
      "mira_bridge_list_jobs",
      "mira_bridge_write_job_input",
      "mira_bridge_read_job_terminal",
      "mira_bridge_resize_job_terminal",
      "mira_bridge_scan_recycle_bin",
      "mira_bridge_empty_recycle_bin",
      "mira_bridge_web_snapshot",
    ]));
  });

  it("round-trips node-scoped opaque identifiers", () => {
    const id = createScopedId("job", "windows-main");
    expect(parseScopedId(id, "job")).toEqual({ kind: "job", nodeId: "windows-main" });
    expect(() => parseScopedId(id, "ws")).toThrow(BridgeError);
  });

  it("rejects oversized and unstructured process arguments", () => {
    expect(() => parseToolInput("mira_bridge_exec", { workspace_id: "ws_short", program: "npm.cmd", args: "run test" })).toThrow();
    expect(() => parseToolInput("mira_bridge_exec", { workspace_id: "ws_short", program: "x", args: Array(257).fill("x") })).toThrow();
  });

  it("bounds Job stdin by UTF-8 bytes and requires an effect", () => {
    expect(parseToolInput("mira_bridge_start_job", {
      workspace_id: "ws_long-enough",
      program: "node.exe",
    })).toMatchObject({ stdin_mode: "closed" });
    expect(parseToolInput("mira_bridge_write_job_input", {
      job_id: "job_long-enough",
      data: "中文\r\n",
    })).toMatchObject({ data: "中文\r\n", close: false });
    expect(() => parseToolInput("mira_bridge_write_job_input", { job_id: "job_long-enough" })).toThrow();
    expect(() => parseToolInput("mira_bridge_write_job_input", {
      job_id: "job_long-enough",
      data: "中".repeat(22_000),
    })).toThrow();
  });

  it("validates output encodings and ConPTY-only terminal dimensions", () => {
    expect(parseToolInput("mira_bridge_exec", {
      workspace_id: "ws_long-enough",
      program: "where.exe",
      output_encoding: "cp936",
    })).toMatchObject({ output_encoding: "cp936" });
    expect(parseToolInput("mira_bridge_start_job", {
      workspace_id: "ws_long-enough",
      program: "python.exe",
      stdin_mode: "conpty",
      terminal_size: { cols: 80, rows: 24 },
      label: "interactive diagnosis",
    })).toMatchObject({ stdin_mode: "conpty", output_encoding: "auto", terminal_size: { cols: 80, rows: 24 }, label: "interactive diagnosis" });
    expect(() => parseToolInput("mira_bridge_exec", {
      workspace_id: "ws_long-enough", program: "where.exe", output_encoding: "gbk",
    })).toThrow();
    expect(() => parseToolInput("mira_bridge_start_job", {
      workspace_id: "ws_long-enough", program: "python.exe", stdin_mode: "pipe", terminal_size: { cols: 80, rows: 24 },
    })).toThrow();
    expect(() => parseToolInput("mira_bridge_start_job", {
      workspace_id: "ws_long-enough", program: "python.exe", stdin_mode: "conpty", output_encoding: "cp936",
    })).toThrow();
    expect(() => parseToolInput("mira_bridge_resize_job_terminal", {
      job_id: "job_long-enough", cols: 19, rows: 24,
    })).toThrow();
  });

  it("validates the RPC envelope", () => {
    const parsed = rpcRequestSchema.parse({
      jsonrpc: "2.0",
      id: "req_1",
      method: "mirabridge.invoke",
      params: { protocol_version: "2.0", request_id: "req_1", node_id: "windows-main", operation: "mira_bridge_describe_node", arguments: {}, timestamp: new Date().toISOString() },
    });
    expect(parsed.params.node_id).toBe("windows-main");
    expect(() => rpcRequestSchema.parse({ ...parsed, method: "exec" })).toThrow();
  });

  it("rejects malformed transfer base64", () => {
    expect(() => internalTransferSchemas.transfer_write_chunk.parse({ transfer_id: "transfer_long-enough", offset: 0, data_base64: "***" })).toThrow();
  });

  it("accepts hash-only directory manifests for large transfers and rejects incomplete summaries", () => {
    expect(internalTransferSchemas.transfer_begin_directory_push.parse({
      destination_path: "D:\\MiraBridgeRoot\\large",
      size: 1234,
      sha256: "1".repeat(64),
      manifest_sha256: "2".repeat(64),
      manifest_entries: 30_000,
      manifest_files: 29_000,
      total_file_bytes: 987_654,
      overwrite: false,
    })).toMatchObject({ manifest_entries: 30_000, manifest_files: 29_000 });
    expect(() => internalTransferSchemas.transfer_begin_directory_push.parse({
      destination_path: "D:\\MiraBridgeRoot\\large",
      size: 1234,
      sha256: "1".repeat(64),
      manifest_sha256: "2".repeat(64),
      manifest_entries: 30_000,
      overwrite: false,
    })).toThrow();
  });

  it("requires the Worker default timeout to fit its synchronous cap", () => {
    expect(() => workerConfigSchema.parse({
      allowed_roots: ["D:\\Projects"],
      default_timeout_ms: 10_000,
      max_sync_timeout_ms: 1_000,
    })).toThrow();
  });

  it("rejects SSH hosts that could be parsed as options or known_hosts lists", () => {
    const base = {
      port: 22,
      user: "Administrator",
      identity_file: "/tmp/key",
      host_fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      worker_command: "mirabridge-worker serve --stdio",
      connect_timeout_ms: 10_000,
    };
    expect(() => nodeConfigSchema.parse({ ...base, host: "-oProxyCommand=bad" })).toThrow();
    expect(() => nodeConfigSchema.parse({ ...base, host: "host-a,host-b" })).toThrow();
    expect(nodeConfigSchema.parse({ ...base, host: "fe80::1", user: "AzureAD\\User" })).toMatchObject({ host: "fe80::1" });
  });

  it("applies product retention defaults and explicit capability defaults", () => {
    const parsed = workerConfigSchema.parse({ allowed_roots: ["D:\\MiraBridgeRoot"] });
    expect(parsed).toMatchObject({
      desktop_access: "disabled",
      recycle_bin_enabled: false,
      web_snapshot_enabled: false,
      max_queued_jobs: 32,
      storage: {
        request_retention_days: 7,
        output_retention_days: 7,
        job_log_retention_days: 14,
        metadata_retention_days: 90,
        max_bytes: 10 * 1024 * 1024 * 1024,
        min_free_bytes: 2 * 1024 * 1024 * 1024,
        max_stream_bytes: 256 * 1024 * 1024,
      },
    });
  });

  it("marks every mutating product tool for approval metadata", () => {
    for (const name of [
      "mira_bridge_exec", "mira_bridge_powershell", "mira_bridge_write_text", "mira_bridge_edit_text",
      "mira_bridge_manage_path", "mira_bridge_start_job", "mira_bridge_cancel_job", "mira_bridge_push",
      "mira_bridge_write_job_input", "mira_bridge_resize_job_terminal", "mira_bridge_pull", "mira_bridge_empty_recycle_bin", "mira_bridge_web_snapshot",
    ] as const) expect(toolDefinitions[name].annotations.readOnlyHint).toBe(false);
    expect(toolDefinitions.mira_bridge_scan_recycle_bin.annotations.readOnlyHint).toBe(true);
    expect(toolDefinitions.mira_bridge_list_jobs.annotations.readOnlyHint).toBe(true);
    expect(toolDefinitions.mira_bridge_read_job_terminal.annotations.readOnlyHint).toBe(true);
  });

  it("truncates output to bounded head and tail", () => {
    const preview = previewOutput(Buffer.from("0123456789"), 6);
    expect(preview).toMatchObject({ truncated: true, total_bytes: 10, head: "012", tail: "789" });
  });

  it("redacts sensitive environment keys and inline arguments", () => {
    expect(redactRecord({ API_TOKEN: "secret", NORMAL: "visible", AUTHORIZATION: "bearer" })).toEqual({ API_TOKEN: "[REDACTED]", NORMAL: "visible", AUTHORIZATION: "[REDACTED]" });
    expect(summarizeArguments(["--token=secret", "--password", "very-secret", "--name=mira"])).toEqual([
      "--token=[REDACTED]",
      "--password",
      "[REDACTED]",
      "--name=mira",
    ]);
    expect(summarizeArguments([
      "--api-token", "token-value",
      "--client-secret", "secret-value",
      "--db-password", "password-value",
      "Authorization: Bearer credential",
      "https://example.test/?access_token=query-value&safe=yes",
    ])).toEqual([
      "--api-token", "[REDACTED]",
      "--client-secret", "[REDACTED]",
      "--db-password", "[REDACTED]",
      "Authorization:[REDACTED]",
      "https://example.test/?access_token=[REDACTED]&safe=yes",
    ]);
  });
});
