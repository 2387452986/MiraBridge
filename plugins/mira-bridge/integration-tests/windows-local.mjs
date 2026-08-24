import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

if (process.platform !== "win32") throw new Error("windows-local.mjs must run on Windows.");

const root = await mkdtemp(join(tmpdir(), "mirabridge-windows-e2e-"));
const allowed = join(root, "allowed");
const outside = join(root, "outside");
const localAppData = join(root, "state-root");
const configPath = join(localAppData, "MiraBridge", "worker.toml");
const worker = resolve("packages/windows-worker/dist/index.cjs");
await Promise.all([mkdir(allowed), mkdir(outside), mkdir(dirname(configPath), { recursive: true })]);
await writeFile(join(outside, "secret.txt"), "outside");
await writeFile(configPath, `allowed_roots = [${JSON.stringify(allowed)}]\ndesktop_access = "disabled"\nrecycle_bin_enabled = false\nweb_snapshot_enabled = false\nweb_snapshot_allow_external = false\nmax_concurrent_jobs = 2\nmax_queued_jobs = 32\nmax_inline_output_bytes = 65536\ndefault_timeout_ms = 300000\nmax_sync_timeout_ms = 1800000\n\n[storage]\nmax_stream_bytes = 1048576\nmin_free_bytes = 0\n`);

const environment = { ...process.env, LOCALAPPDATA: localAppData, MIRABRIDGE_WORKER_CONFIG: configPath };

function startWorker() {
  const child = spawn(process.execPath, [worker, "serve", "--stdio"], { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) { pending.delete(response.id); waiter.resolve(response.result); }
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`Worker exited: ${stderr}`));
    pending.clear();
  });
  return {
    child,
    call(operation, args, requestId = `req_${randomUUID()}`) {
      const id = requestId;
      const request = { jsonrpc: "2.0", id, method: "mirabridge.invoke", params: { protocol_version: "2.0", request_id: id, node_id: "windows-test", operation, arguments: args, timestamp: new Date().toISOString() } };
      return new Promise((resolveCall, rejectCall) => {
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function stopWorker(api) {
  if (api.child.exitCode !== null) return;
  api.child.kill();
  await once(api.child, "exit");
}

async function waitFor(api, jobId, expected, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api.call("mira_bridge_get_job", { job_id: jobId });
    if (expected.includes(response.result.executor_status)) return response.result;
    if (["exited", "failed_to_start", "cancelled", "timed_out", "lost"].includes(response.result.executor_status)) {
      throw new Error(`Job ${jobId} reached unexpected terminal state: ${JSON.stringify(response.result)}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Job ${jobId} did not reach ${expected.join(",")}`);
}

let api = startWorker();
try {
  const described = await api.call("mira_bridge_describe_node", { node_id: "windows-test" });
  assert(described.ok && described.result.os.startsWith("Microsoft Windows"), `describe_node failed: ${JSON.stringify(described)}`);
  assert(["x64", "arm64"].includes(described.result.architecture) && described.result.architecture_supported === true, `native architecture is unsupported: ${JSON.stringify(described.result)}`);
  assert(["x64", "arm64"].includes(described.result.process_architecture) && typeof described.result.architecture_emulated === "boolean", "process architecture metadata is missing");
  assert(Array.isArray(described.result.gpu) && described.result.gpu.every((gpu) => typeof gpu.vendor === "string" && typeof gpu.device_type === "string"), "complete GPU inventory metadata is missing");
  assert(described.result.native_tools.conpty.helper_path.endsWith("MiraBridge.ConPtyHost.exe") && described.result.native_tools.conpty.self_contained === true, "ConPTY helper is not the architecture-matched self-contained executable");
  const opened = await api.call("mira_bridge_open_workspace", { node_id: "windows-test", path: allowed, mode: "read-write" });
  assert(opened.ok, "open_workspace failed");
  const workspaceId = opened.result.workspace_id;

  const written = await api.call("mira_bridge_write_text", { workspace_id: workspaceId, path: "中文.txt", content: "你好，Windows", create_parents: false });
  assert(written.ok, "write_text failed");
  const read = await api.call("mira_bridge_read_text", { workspace_id: workspaceId, path: "中文.txt", start_line: 1, max_lines: 20 });
  assert(read.result.content === "你好，Windows", "UTF-8 round trip failed");
  const conflict = await api.call("mira_bridge_write_text", { workspace_id: workspaceId, path: "中文.txt", content: "wrong", expected_sha256: "0".repeat(64), create_parents: false });
  assert(!conflict.ok && conflict.error.code === "FILE_CHANGED", "expected_sha256 conflict was not rejected");
  const edited = await api.call("mira_bridge_edit_text", { workspace_id: workspaceId, path: "中文.txt", expected_sha256: written.result.sha256, edits: [{ old_text: "Windows", new_text: "Windows 11", replace_all: false }] });
  assert(edited.ok && edited.result.replacements[0].count === 1, "exact edit failed");
  const makeDirectory = await api.call("mira_bridge_manage_path", { workspace_id: workspaceId, action: "mkdir", path: "managed", recursive: false, overwrite: false });
  assert(makeDirectory.ok, "manage_path mkdir failed");
  const copied = await api.call("mira_bridge_manage_path", { workspace_id: workspaceId, action: "copy", path: "中文.txt", destination_path: "managed\\copy.txt", recursive: false, overwrite: false });
  assert(copied.ok, "manage_path copy failed");
  const moved = await api.call("mira_bridge_manage_path", { workspace_id: workspaceId, action: "move", path: "managed\\copy.txt", destination_path: "managed\\moved.txt", recursive: false, overwrite: false });
  assert(moved.ok, "manage_path move failed");
  const deleted = await api.call("mira_bridge_manage_path", { workspace_id: workspaceId, action: "delete", path: "managed", recursive: true, overwrite: false });
  assert(deleted.ok, "manage_path recursive delete failed");
  const rootDelete = await api.call("mira_bridge_manage_path", { workspace_id: workspaceId, action: "delete", path: ".", recursive: true, overwrite: false });
  assert(!rootDelete.ok && rootDelete.error.code === "PERMISSION_DENIED", "workspace root deletion was not rejected");

  const native = await api.call("mira_bridge_exec", { workspace_id: workspaceId, program: "cmd.exe", args: ["/d", "/s", "/c", "echo", "原生命令"], cwd: ".", env: {}, timeout_ms: 60000 });
  assert(native.ok && native.result.exit_code === 0, "structured exec failed");
  const commandFile = join(allowed, "argv-test.cmd");
  await writeFile(commandFile, "@echo off\r\nnode -e \"process.stdout.write(JSON.stringify(process.argv.slice(1)))\" %*\r\n");
  const commandArgs = ["two words", "a&b", "caret^value"];
  const commandResult = await api.call("mira_bridge_exec", { workspace_id: workspaceId, program: commandFile, args: commandArgs, cwd: ".", env: {}, timeout_ms: 60000 });
  assert(commandResult.ok && JSON.stringify(JSON.parse(commandResult.result.stdout)) === JSON.stringify(commandArgs), ".cmd argv adaptation failed");
  assert(commandResult.result.stdout_encoding === "utf-8", "valid UTF-8 output did not resolve as UTF-8");
  const cp936 = await api.call("mira_bridge_exec", {
    workspace_id: workspaceId,
    program: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4])); process.stderr.write(Buffer.from([0xbe,0xaf,0xb8,0xe6]))"],
    cwd: ".",
    env: {},
    timeout_ms: 60000,
    output_encoding: "cp936",
  });
  assert(cp936.ok && cp936.result.stdout === "中文" && cp936.result.stderr === "警告", "explicit CP936 output normalization failed");
  assert(cp936.result.stdout_encoding === "cp936" && cp936.result.stderr_encoding === "cp936", "resolved CP936 metadata is missing");
  const badEncoding = await api.call("mira_bridge_exec", { workspace_id: workspaceId, program: "where.exe", args: ["node.exe"], cwd: ".", env: {}, timeout_ms: 60000, output_encoding: "cp437" });
  assert(!badEncoding.ok && badEncoding.error.code === "UNSUPPORTED_ENCODING", "unsupported output encoding was not rejected");
  const mismatchedJob = await api.call("mira_bridge_start_job", {
    workspace_id: workspaceId,
    program: process.execPath,
    args: ["-e", "process.stderr.write('ASCII READY\\n'); setTimeout(() => process.stderr.write(Buffer.from([0xA8,0x84])), 100); setInterval(() => {}, 1000)"],
    cwd: ".",
    env: {},
    timeout_ms: 60000,
    output_encoding: "utf-8",
    idempotency_key: `invalid-output-${randomUUID()}`,
  });
  assert(mismatchedJob.ok, `mismatched-encoding Job did not start: ${JSON.stringify(mismatchedJob)}`);
  const mismatchedResult = await waitFor(api, mismatchedJob.result.job_id, ["exited"], 30000);
  assert(mismatchedResult.error?.code === "UNSUPPORTED_ENCODING", `mismatched-encoding Job lost its real error: ${JSON.stringify(mismatchedResult)}`);
  const mismatchedLogs = await api.call("mira_bridge_read_job_logs", { job_id: mismatchedJob.result.job_id, stream: "stderr", offset: 0, max_bytes: 65536 });
  assert(mismatchedLogs.ok && mismatchedLogs.result.text.includes("ASCII READY") && mismatchedLogs.result.counts_final, "mismatched-encoding Job did not finalize its safe log prefix");
  const missing = await api.call("mira_bridge_exec", { workspace_id: workspaceId, program: "definitely-missing.exe", args: [], cwd: ".", env: {}, timeout_ms: 60000 });
  assert(!missing.ok && missing.error.code === "PROGRAM_NOT_FOUND", "missing program error mapping failed");
  const powershell = await api.call("mira_bridge_powershell", { workspace_id: workspaceId, script: "Write-Output 'PowerShell-中文'", cwd: ".", timeout_ms: 60000 });
  assert(powershell.ok && powershell.result.stdout.includes("PowerShell-中文"), "PowerShell UTF-8 failed");

  const large = await api.call("mira_bridge_exec", { workspace_id: workspaceId, program: process.execPath, args: ["-e", "process.stdout.write('HEAD' + 'x'.repeat(2097152) + 'TAIL')"], cwd: ".", env: {}, timeout_ms: 60000 });
  assert(large.ok && large.result.truncated && large.result.output_ref, "large output was not referenced");
  assert(large.result.stdout_storage_truncated && large.result.stdout_bytes === 2097160 && large.result.stdout_stored_bytes <= 1048576, "single-stream storage cap failed");
  const output = await api.call("mira_bridge_read_output", { output_ref: large.result.output_ref, stream: "stdout", offset: 0, max_bytes: 65536, tail_lines: 20 });
  assert(output.ok && output.result.text.endsWith("TAIL") && output.result.storage_truncated, "read_output stored tail failed");

  const recycleDisabled = await api.call("mira_bridge_scan_recycle_bin", { node_id: "windows-test", drives: ["C"], max_items: 10 });
  assert(!recycleDisabled.ok && recycleDisabled.error.code === "CAPABILITY_NOT_ENABLED", "disabled Recycle Bin capability was not enforced");
  const browserDisabled = await api.call("mira_bridge_web_snapshot", { workspace_id: workspaceId, url: "http://127.0.0.1:9", screenshot_path: "disabled.png", viewport: { width: 800, height: 600 }, full_page: true, overwrite: false, wait_until: "load", network_policy: "local-only", timeout_ms: 1000 });
  assert(!browserDisabled.ok && browserDisabled.error.code === "CAPABILITY_NOT_ENABLED", "disabled Web Snapshot capability was not enforced");

  const traversal = await api.call("mira_bridge_read_text", { workspace_id: workspaceId, path: "..\\outside\\secret.txt", start_line: 1, max_lines: 10 });
  assert(!traversal.ok && traversal.error.code === "WORKSPACE_OUT_OF_BOUNDS", "path traversal was not rejected");
  const unc = await api.call("mira_bridge_open_workspace", { node_id: "windows-test", path: "\\\\server\\share", mode: "read-only" });
  assert(!unc.ok && unc.error.code === "WORKSPACE_OUT_OF_BOUNDS", "UNC path was not rejected");
  const outOfBounds = await api.call("mira_bridge_open_workspace", { node_id: "windows-test", path: outside, mode: "read-only" });
  assert(!outOfBounds.ok && outOfBounds.error.code === "WORKSPACE_OUT_OF_BOUNDS", "outside allowed root was not rejected");
  const junction = join(allowed, "escape");
  const linked = spawnSync("cmd.exe", ["/d", "/s", "/c", "mklink", "/J", junction, outside], { windowsHide: true });
  if (linked.status === 0) {
    const escaped = await api.call("mira_bridge_read_text", { workspace_id: workspaceId, path: "escape\\secret.txt", start_line: 1, max_lines: 10 });
    assert(!escaped.ok && escaped.error.code === "WORKSPACE_OUT_OF_BOUNDS", "junction escape was not rejected");
  }

  const started = await api.call("mira_bridge_start_job", { workspace_id: workspaceId, program: "powershell.exe", args: ["-NoProfile", "-Command", "1..7 | ForEach-Object { Write-Output $_; Start-Sleep -Seconds 5 }"], cwd: ".", env: {}, timeout_ms: 120000, idempotency_key: "disconnect-job" });
  const jobId = started.result.job_id;
  await waitFor(api, jobId, ["running"]);
  await stopWorker(api);
  api = startWorker();
  const completed = await waitFor(api, jobId, ["exited"], 60000);
  assert(completed.exit_code === 0, "Job did not survive worker stdio restart");
  const logs = await api.call("mira_bridge_read_job_logs", { job_id: jobId, stream: "stdout", offset: 0, max_bytes: 65536 });
  assert(logs.ok && logs.result.text.includes("7"), "persisted Job logs missing");
  const discovered = await api.call("mira_bridge_list_jobs", { node_id: "windows-test", statuses: ["exited"], max_results: 10 });
  assert(discovered.ok && discovered.result.jobs.some((job) => job.job_id === jobId), "list_jobs did not recover the disconnected Job");

  const inputMarker = `stdin-secret-${randomUUID()}`;
  const interactiveScript = "process.stdout.write('READY\\n'); let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => process.stdout.write('ACK:' + text))";
  const interactive = await api.call("mira_bridge_start_job", {
    workspace_id: workspaceId,
    program: process.execPath,
    args: ["-e", interactiveScript],
    cwd: ".",
    env: {},
    timeout_ms: 120000,
    idempotency_key: `stdin-restart-${randomUUID()}`,
    stdin_mode: "pipe",
  });
  assert(interactive.ok && interactive.result.stdin_mode === "pipe", "pipe-mode Job did not start");
  const interactiveJobId = interactive.result.job_id;
  await waitFor(api, interactiveJobId, ["running"]);
  await stopWorker(api);
  api = startWorker();
  const firstInput = await api.call("mira_bridge_write_job_input", { job_id: interactiveJobId, data: `第一行:${inputMarker}\n`, close: false });
  assert(firstInput.ok && firstInput.result.bytes_written > 0 && !firstInput.result.input_closed, "first Job input write failed");
  const eofRequestId = `req_${randomUUID()}`;
  const finalInput = await api.call("mira_bridge_write_job_input", { job_id: interactiveJobId, data: "第二行\n", close: true }, eofRequestId);
  assert(finalInput.ok && finalInput.result.input_closed, "final Job input write and EOF failed");
  const replayedInput = await api.call("mira_bridge_write_job_input", { job_id: interactiveJobId, data: "第二行\n", close: true }, eofRequestId);
  assert(replayedInput.ok && replayedInput.result.bytes_written === finalInput.result.bytes_written, "Job input request-id replay was not idempotent");
  const interactiveDone = await waitFor(api, interactiveJobId, ["exited"], 30000);
  assert(interactiveDone.exit_code === 0, "interactive Job did not exit after EOF");
  const interactiveLogs = await api.call("mira_bridge_read_job_logs", { job_id: interactiveJobId, stream: "stdout", offset: 0, max_bytes: 65536 });
  const expectedAck = `ACK:第一行:${inputMarker}\n第二行\n`;
  assert(interactiveLogs.ok && interactiveLogs.result.text.includes(expectedAck), "interactive Job input was not delivered in order");
  assert(interactiveLogs.result.text.indexOf("第二行") === interactiveLogs.result.text.lastIndexOf("第二行"), "replayed request duplicated Job input");
  const lateInput = await api.call("mira_bridge_write_job_input", { job_id: interactiveJobId, data: "late", close: false });
  assert(!lateInput.ok && lateInput.error.code === "JOB_ALREADY_FINISHED", "terminal Job accepted late stdin");
  const auditDirectory = join(localAppData, "MiraBridge", "audit");
  const auditText = (await Promise.all((await readdir(auditDirectory)).map((name) => readFile(join(auditDirectory, name), "utf8")))).join("\n");
  assert(!auditText.includes(inputMarker), "Job input plaintext leaked into audit logs");
  assert(auditText.includes("input_sha256="), "Job input audit hash is missing");

  const terminalMarker = `terminal-secret-${randomUUID()}`;
  const terminalScript = [
    "process.stdin.setRawMode(true)",
    "process.stdin.setEncoding('utf8')",
    "process.stdout.write('\\x1b]0;MiraBridge Terminal\\x07TTY:' + process.stdin.isTTY + ':' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\nREADY\\r\\n')",
    "let line=''",
    "process.on('SIGWINCH', () => process.stdout.write('RESIZED:' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n'))",
    "process.stdin.on('data', data => { for (const char of data) { if (char === '\\x03') { process.stdout.write('CTRL-C\\r\\n'); continue } if (char === '\\x1a') { process.stdout.write('EOF\\r\\n'); process.exit(0) } if (char === '\\r' || char === '\\n') { if (line) { process.stdout.write('ECHO:' + line + '\\r\\n'); line='' } continue } line += char } })",
    "setInterval(() => {}, 1000)",
  ].join(";");
  const terminalStart = await api.call("mira_bridge_start_job", {
    workspace_id: workspaceId,
    program: process.execPath,
    args: ["-e", terminalScript],
    cwd: ".",
    env: {},
    timeout_ms: 120000,
    idempotency_key: `conpty-restart-${randomUUID()}`,
    stdin_mode: "conpty",
    terminal_size: { cols: 80, rows: 24 },
  });
  assert(terminalStart.ok && terminalStart.result.stdin_mode === "conpty", `ConPTY Job did not start: ${JSON.stringify(terminalStart)}`);
  const terminalJobId = terminalStart.result.job_id;
  await waitFor(api, terminalJobId, ["running"]);
  await stopWorker(api);
  api = startWorker();
  let terminalScreen;
  const snapshotDeadline = Date.now() + 15000;
  while (Date.now() < snapshotDeadline) {
    terminalScreen = await api.call("mira_bridge_read_job_terminal", { job_id: terminalJobId });
    if (terminalScreen.ok && terminalScreen.result.lines.join("\n").includes("READY")) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  assert(terminalScreen?.ok && terminalScreen.result.lines.join("\n").includes("READY"), `ConPTY screen was not recovered after Worker restart: ${JSON.stringify(terminalScreen)}`);
  assert(terminalScreen.result.title === "MiraBridge Terminal", `ConPTY title is wrong: ${JSON.stringify(terminalScreen.result.title)}`);
  assert(terminalScreen.result.cols === 80 && terminalScreen.result.rows === 24, "initial ConPTY terminal size is wrong");
  const resizedTerminal = await api.call("mira_bridge_resize_job_terminal", { job_id: terminalJobId, cols: 120, rows: 40 });
  assert(resizedTerminal.ok && resizedTerminal.result.cols === 120 && resizedTerminal.result.rows === 40, "ConPTY resize failed");
  await api.call("mira_bridge_write_job_input", { job_id: terminalJobId, data: `中文:${terminalMarker}\r`, close: false });
  await api.call("mira_bridge_write_job_input", { job_id: terminalJobId, data: "\u001b[B\r\u0003", close: false });
  await api.call("mira_bridge_write_job_input", { job_id: terminalJobId, data: "", close: true });
  const terminalDone = await waitFor(api, terminalJobId, ["exited"], 30000);
  assert(terminalDone.exit_code === 0 && terminalDone.stdout_encoding === "utf-8", "ConPTY Job did not exit with UTF-8 VT evidence");
  const terminalLogs = await api.call("mira_bridge_read_job_logs", { job_id: terminalJobId, stream: "stdout", offset: 0, max_bytes: 65536 });
  assert(terminalLogs.ok && terminalLogs.result.text.includes(`ECHO:中文:${terminalMarker}`), "ConPTY Unicode input/output failed");
  assert(terminalLogs.result.text.includes("CTRL-C"), "ConPTY Ctrl-C was not delivered");
  assert(terminalLogs.result.text.includes("EOF"), "ConPTY close did not deliver Windows console EOF");
  assert(terminalLogs.result.text.includes("RESIZED:120x40"), "ConPTY child did not observe resize");
  const finalScreen = await api.call("mira_bridge_read_job_terminal", { job_id: terminalJobId });
  assert(finalScreen.ok && finalScreen.result.final && finalScreen.result.cols === 120 && finalScreen.result.rows === 40, "final ConPTY snapshot is incomplete");
  const invalidSize = await api.call("mira_bridge_resize_job_terminal", { job_id: terminalJobId, cols: 10, rows: 2 });
  assert(!invalidSize.ok && invalidSize.error.code === "INVALID_ARGUMENT", "invalid ConPTY size was not rejected");
  const nonTerminalScreen = await api.call("mira_bridge_read_job_terminal", { job_id: interactiveJobId });
  assert(!nonTerminalScreen.ok && nonTerminalScreen.error.code === "TERMINAL_UNAVAILABLE", "pipe Job incorrectly exposed a terminal screen");
  const terminalAuditText = (await Promise.all((await readdir(auditDirectory)).map((name) => readFile(join(auditDirectory, name), "utf8")))).join("\n");
  assert(!terminalAuditText.includes(terminalMarker), "ConPTY input plaintext leaked into audit logs");

  const childPidFile = join(allowed, "cancel-child.pid");
  const cancelScript = `$child=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120' -PassThru; Set-Content -LiteralPath '${childPidFile.replaceAll("'", "''")}' -Value $child.Id; Wait-Process -Id $child.Id`;
  const cancelStart = await api.call("mira_bridge_start_job", { workspace_id: workspaceId, program: "powershell.exe", args: ["-NoProfile", "-Command", cancelScript], cwd: ".", env: {}, timeout_ms: 120000, idempotency_key: "cancel-job" });
  await waitFor(api, cancelStart.result.job_id, ["running"]);
  const pidDeadline = Date.now() + 10000;
  while (Date.now() < pidDeadline) {
    try { await readFile(childPidFile, "utf8"); break; } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 100)); }
  }
  const childPid = Number((await readFile(childPidFile, "utf8")).trim());
  const cancelled = await api.call("mira_bridge_cancel_job", { job_id: cancelStart.result.job_id });
  assert(cancelled.ok && cancelled.result.executor_status === "cancelled", "Job cancellation failed");
  const childAlive = spawnSync("powershell.exe", ["-NoProfile", "-Command", `if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { exit 1 }`], { windowsHide: true });
  assert(childAlive.status === 0, "Job cancellation left a child process alive");

  const storage = spawnSync(process.execPath, [worker, "storage", "status"], { env: environment, encoding: "utf8", windowsHide: true });
  assert(storage.status === 0 && JSON.parse(storage.stdout).quota_bytes === 10737418240, `storage status failed: ${storage.stderr}`);
  const dryRun = spawnSync(process.execPath, [worker, "storage", "prune", "--dry-run"], { env: environment, encoding: "utf8", windowsHide: true });
  assert(dryRun.status === 0 && JSON.parse(dryRun.stdout).dry_run === true, `storage dry-run failed: ${dryRun.stderr}`);
  const executePrune = spawnSync(process.execPath, [worker, "storage", "prune", "--execute"], { env: environment, encoding: "utf8", windowsHide: true });
  assert(executePrune.status === 0 && JSON.parse(executePrune.stdout).dry_run === false, `storage execute failed: ${executePrune.stderr}`);

  process.stdout.write(`${JSON.stringify({ ok: true, root, checks: ["describe", "architecture", "gpu-inventory", "portable-conpty", "utf8", "cp936", "encoding-rejection", "cas", "exact-edit", "manage-path", "root-delete", "exec", "cmd-argv", "powershell", "bounded-large-output", "capability-disabled", "traversal", "unc", "allowed-root", "junction-if-supported", "job-restart", "list-jobs", "job-stdin-restart", "job-stdin-idempotency", "job-stdin-audit-redaction", "conpty-restart", "conpty-screen", "conpty-unicode", "conpty-ctrl-c", "conpty-resize", "conpty-audit-redaction", "process-tree-cancel", "storage-cli-dry-run", "storage-cli-execute"] }, null, 2)}\n`);
} finally {
  await stopWorker(api);
  await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}
