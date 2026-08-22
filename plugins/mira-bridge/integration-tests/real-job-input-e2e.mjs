import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "smol-toml";

const configPath = process.env.MIRABRIDGE_CONFIG;
if (!configPath) throw new Error("MIRABRIDGE_CONFIG is required.");
const nodeId = process.env.MIRABRIDGE_NODE_ID ?? "windows-main";
const workspacePath = process.env.MIRABRIDGE_WINDOWS_ROOT ?? "D:\\MiraBridgeRoot";
const { version: productVersion } = JSON.parse(await readFile(resolve("package.json"), "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function session() {
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
  const client = new Client({ name: "mirabridge-real-job-input-e2e", version: productVersion });
  await client.connect(transport);
  return { client, close: () => client.close().catch(() => undefined) };
}

async function call(client, name, args, allowError = false) {
  const response = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
    maxTotalTimeout: 120_000,
  });
  const structured = response.structuredContent;
  if (!structured || typeof structured !== "object") throw new Error(`${name} returned no structured content.`);
  if (response.isError && !allowError) throw new Error(`${name} failed: ${JSON.stringify(structured)}`);
  return { response, structured };
}

async function waitFor(client, jobId, statuses, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { structured } = await call(client, "mira_bridge_get_job", { job_id: jobId });
    const result = structured.result;
    if (statuses.includes(result.executor_status)) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Job ${jobId} did not reach ${statuses.join(",")}.`);
}

async function waitForLog(client, jobId, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { structured } = await call(client, "mira_bridge_read_job_logs", {
      job_id: jobId,
      stream: "stdout",
      offset: 0,
      max_bytes: 65536,
    }, true);
    if (structured.ok && structured.result.text.includes(expected)) return structured.result.text;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Job ${jobId} did not log ${expected}.`);
}

async function directRpc(node, knownHosts, operation, args, requestId) {
  const child = spawn("ssh", [
    "-T", "-p", String(node.port), "-i", node.identity_file,
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", `ConnectTimeout=${Math.max(1, Math.ceil(node.connect_timeout_ms / 1000))}`,
    "-l", node.user,
    node.host,
    node.worker_command,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  const request = {
    jsonrpc: "2.0",
    id: requestId,
    method: "mirabridge.invoke",
    params: {
      protocol_version: "2.0",
      request_id: requestId,
      node_id: nodeId,
      operation,
      arguments: args,
      timestamp: new Date().toISOString(),
    },
  };
  return await new Promise((resolveCall, rejectCall) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectCall(new Error(`Direct RPC timed out: ${stderr}`));
    }, 60_000);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.once("line", (line) => {
      clearTimeout(timer);
      child.kill();
      try { resolveCall(JSON.parse(line).result); }
      catch (error) { rejectCall(error); }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectCall(error);
    });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        rejectCall(new Error(`Direct RPC SSH exited ${code}: ${stderr}`));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}

let first = await session();
let workspaceId;
let pipeJobId;
const marker = `MiraBridge-stdin-${randomUUID()}`;
const firstData = `第一行:${marker}\n`;
const secondData = `第二行:${marker}\n`;
try {
  const tools = await first.client.listTools();
  assert(tools.tools.length === 28, `Expected 28 tools, received ${tools.tools.length}.`);
  assert(tools.tools.some((tool) => tool.name === "mira_bridge_write_job_input"), "Job input tool is not visible through MCP.");
  const described = (await call(first.client, "mira_bridge_describe_node", { node_id: nodeId })).structured.result;
  assert(described.worker_version === productVersion && described.protocol_version === "2.0", `Worker/version handshake is not ${productVersion} / RPC 2.0.`);
  assert(described.capabilities.includes("job_input"), "describe_node did not report job_input.");
  workspaceId = (await call(first.client, "mira_bridge_open_workspace", {
    node_id: nodeId,
    path: workspacePath,
    mode: "read-write",
  })).structured.result.workspace_id;

  const closed = (await call(first.client, "mira_bridge_start_job", {
    workspace_id: workspaceId,
    program: "node.exe",
    args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('DEFAULT_EOF'))"],
    cwd: ".",
    env: {},
    timeout_ms: 30_000,
    idempotency_key: `closed-stdin-${randomUUID()}`,
  })).structured.result;
  assert(closed.stdin_mode === "closed", "Default Job stdin mode changed from closed.");
  const closedDone = await waitFor(first.client, closed.job_id, ["exited"], 30_000);
  assert(closedDone.exit_code === 0, "Default closed-stdin Job did not exit cleanly.");
  assert((await waitForLog(first.client, closed.job_id, "DEFAULT_EOF")).includes("DEFAULT_EOF"), "Default closed stdin did not deliver EOF.");

  const script = "process.stdout.write('READY TTY=' + (process.stdin.isTTY === true) + '\\n'); let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => process.stdout.write('ACK:' + text))";
  const started = (await call(first.client, "mira_bridge_start_job", {
    workspace_id: workspaceId,
    program: "node.exe",
    args: ["-e", script],
    cwd: ".",
    env: {},
    timeout_ms: 120_000,
    idempotency_key: `pipe-stdin-${randomUUID()}`,
    stdin_mode: "pipe",
  })).structured.result;
  pipeJobId = started.job_id;
  assert(started.stdin_mode === "pipe", "Pipe-mode Job did not report its mode.");
  await waitFor(first.client, pipeJobId, ["running"]);
  const readiness = await waitForLog(first.client, pipeJobId, "READY");
  assert(readiness.includes("TTY=false"), "Pipe-mode Job unexpectedly reported TTY semantics.");
} finally {
  await first.close();
}

let second = await session();
try {
  const jobs = (await call(second.client, "mira_bridge_list_jobs", { node_id: nodeId, max_results: 100 })).structured.result.jobs;
  assert(jobs.some((job) => job.job_id === pipeJobId && job.stdin_mode === "pipe"), "list_jobs did not recover the pipe-mode Job after SSH/MCP restart.");
  const written = (await call(second.client, "mira_bridge_write_job_input", {
    job_id: pipeJobId,
    data: firstData,
    close: false,
  })).structured.result;
  assert(written.bytes_written === Buffer.byteLength(firstData) && written.input_closed === false, "First MCP Job input write failed.");
} finally {
  await second.close();
}

const config = parse(await readFile(configPath, "utf8"));
const node = config.nodes?.[nodeId];
if (!node) throw new Error(`Node ${nodeId} is not configured.`);
const knownHosts = join(dirname(configPath), "known_hosts");
const fixedRequestId = `req_${randomUUID()}`;
const firstFinal = await directRpc(node, knownHosts, "mira_bridge_write_job_input", { job_id: pipeJobId, data: secondData, close: true }, fixedRequestId);
assert(firstFinal.ok && firstFinal.result.input_closed === true, "Final Job input/EOF failed.");
const replayedFinal = await directRpc(node, knownHosts, "mira_bridge_write_job_input", { job_id: pipeJobId, data: secondData, close: true }, fixedRequestId);
assert(replayedFinal.ok && replayedFinal.result.bytes_written === firstFinal.result.bytes_written, "Same-ID input replay did not return the cached response.");

const third = await session();
try {
  const completed = await waitFor(third.client, pipeJobId, ["exited"], 30_000);
  assert(completed.exit_code === 0, "Pipe-mode Job did not exit after EOF.");
  const logs = (await call(third.client, "mira_bridge_read_job_logs", {
    job_id: pipeJobId,
    stream: "stdout",
    offset: 0,
    max_bytes: 65536,
  })).structured.result.text;
  assert(logs.includes(`ACK:${firstData}${secondData}`), "Job stdin was not delivered in order.");
  assert(logs.indexOf("第二行") === logs.lastIndexOf("第二行"), "Same request ID duplicated Job input.");
  const late = await call(third.client, "mira_bridge_write_job_input", { job_id: pipeJobId, data: "late", close: false }, true);
  assert(late.response.isError && late.structured.error.code === "JOB_ALREADY_FINISHED", "Terminal Job accepted late input.");

  const auditScript = "$records=Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'MiraBridge\\audit') -Filter 'audit-*.jsonl' | ForEach-Object { Get-Content -LiteralPath $_.FullName -Encoding UTF8 } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object operation -eq 'mira_bridge_write_job_input' | Select-Object -Last 20; $records | ConvertTo-Json -Depth 8 -Compress";
  const audit = (await call(third.client, "mira_bridge_powershell", {
    workspace_id: workspaceId,
    script: auditScript,
    cwd: ".",
    timeout_ms: 60_000,
  })).structured.result.stdout.trim();
  const firstHash = createHash("sha256").update(firstData).digest("hex");
  const secondHash = createHash("sha256").update(secondData).digest("hex");
  assert(!audit.includes(marker), "Job input plaintext leaked into MiraBridge audit.");
  assert(audit.includes(`input_sha256=${firstHash}`), "First input audit hash is missing.");
  assert(audit.includes(`input_sha256=${secondHash}`), "Final input audit hash is missing.");
  assert(audit.split(`input_sha256=${secondHash}`).length - 1 === 1, "Cached input replay created a second audit effect.");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    tools: 28,
    worker_version: productVersion,
    protocol_version: "2.0",
    workspace_id: workspaceId,
    job_id: pipeJobId,
    executor_status: completed.executor_status,
    exit_code: completed.exit_code,
    ssh_mcp_restarts: 2,
    stdin_tty: false,
    input_bytes: Buffer.byteLength(firstData) + Buffer.byteLength(secondData),
    duplicate_request_effects: 0,
    audit_plaintext_leaks: 0,
  }, null, 2)}\n`);
} finally {
  await third.close();
}
