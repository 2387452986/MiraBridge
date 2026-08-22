#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_SSH_MODE === "host-key-mismatch") {
  process.stderr.write("REMOTE HOST IDENTIFICATION HAS CHANGED!\n");
  process.exit(255);
}
if (process.env.FAKE_SSH_MODE === "auth-failed") {
  process.stderr.write("Permission denied (publickey).\n");
  process.exit(255);
}
if (process.env.FAKE_SSH_MODE === "worker-not-found") {
  process.stderr.write("mirabridge-worker: command not found\n");
  process.exit(127);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (process.env.FAKE_SSH_REQUEST_LOG) appendFileSync(process.env.FAKE_SSH_REQUEST_LOG, `${request.params.request_id}\n`);
  if (process.env.FAKE_SSH_MODE === "disconnect-once" && process.env.FAKE_SSH_SENTINEL && !existsSync(process.env.FAKE_SSH_SENTINEL)) {
    writeFileSync(process.env.FAKE_SSH_SENTINEL, "disconnected");
    process.exit(255);
  }
  if (process.env.FAKE_SSH_MODE === "invalid-json") {
    process.stdout.write("not-json\n");
    continue;
  }
  if (process.env.FAKE_SSH_MODE === "oversized-response") {
    process.stdout.write(`${"x".repeat(2 * 1024 * 1024 + 1)}\n`);
    continue;
  }
  const operation = request.params.operation;
  const result = operation === "mira_bridge_describe_node"
    ? { node_id: request.params.node_id, os: "Windows 11", architecture: "x64", hostname: "FAKE-WINDOWS", allowed_roots: ["D:\\Projects"], capabilities: ["process", "filesystem"] }
    : { exit_code: 0, stdout: "测试通过", stderr: "", duration_ms: 1, timed_out: false, truncated: false, output_ref: null };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocol_version: "2.0", request_id: request.params.request_id, ok: true, result, duration_ms: 1 } })}\n`);
}
