import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BridgeError,
  canonicalJson,
  createScopedId,
  sha256,
  summarizeArguments,
  terminalJobStatuses,
  type OutputEncoding,
  type WorkerConfig,
} from "../../protocol/src/index.js";
import { workerConfigPath, workerDataRoot, loadWorkerConfig, ensureWorkerDirectories } from "./config.js";
import { readOutputRange } from "./output-files.js";
import { executeProcess, processMatchesStart, terminateProcessTree, type ProcessSpec } from "./process-exec.js";
import { launchPersistentRunner } from "./persistent-runner.js";
import { createJobInputEndpoint, listenForJobInput, sendJobInput, sendJobResize, type JobInputChannel } from "./job-input.js";
import { ExecutionMaintenanceError, WorkerState, type JobRow, type WorkspaceRow } from "./state.js";
import { pruneStorage, storageMaintenanceDue } from "./storage.js";
import { readTerminalSnapshot, TerminalRecorder } from "./terminal-snapshot.js";

export interface JobSpec extends ProcessSpec {
  idempotencyKey?: string;
  label?: string;
  storageReservationId?: string;
}

function publicJob(job: JobRow): Record<string, unknown> {
  let argsSummary: unknown[] = [];
  if (job.args_summary_json) {
    try {
      const parsed = JSON.parse(job.args_summary_json) as unknown;
      if (Array.isArray(parsed)) argsSummary = parsed;
    } catch { /* Preserve Job discovery even when legacy metadata is corrupt. */ }
  }
  let persistedError: unknown = null;
  if (job.error_json) {
    try { persistedError = JSON.parse(job.error_json) as unknown; }
    catch {
      persistedError = { code: "INTERNAL_ERROR", message: "Persisted Job error metadata is invalid." };
    }
  }
  return {
    job_id: job.job_id,
    node_id: job.node_id,
    workspace_id: job.workspace_id,
    label: job.label,
    program: job.program,
    cwd: job.cwd,
    args_summary: argsSummary,
    executor_status: job.executor_status,
    stdin_mode: job.stdin_mode,
    output_encoding: job.output_encoding,
    stdout_encoding: job.stdout_encoding,
    stderr_encoding: job.stderr_encoding,
    terminal: job.stdin_mode === "conpty" ? { cols: job.terminal_cols, rows: job.terminal_rows } : null,
    exit_code: job.exit_code,
    started_at: job.started_at,
    finished_at: job.finished_at,
    created_at: job.created_at,
    stdout_bytes: job.stdout_bytes,
    stderr_bytes: job.stderr_bytes,
    stdout_stored_bytes: job.stdout_stored_bytes,
    stderr_stored_bytes: job.stderr_stored_bytes,
    stdout_storage_truncated: Boolean(job.stdout_storage_truncated),
    stderr_storage_truncated: Boolean(job.stderr_storage_truncated),
    logs_pruned_at: job.logs_pruned_at,
    logs_prune_reason: job.logs_prune_reason,
    artifacts: [],
    error: persistedError,
  };
}

export async function startJob(
  state: WorkerState,
  nodeId: string,
  workspace: WorkspaceRow,
  spec: JobSpec,
): Promise<Record<string, unknown>> {
  const stdinMode = spec.stdinMode ?? "closed";
  const outputEncoding = spec.outputEncoding ?? "auto";
  const terminal = stdinMode === "conpty" ? (spec.terminal ?? { cols: 120, rows: 30 }) : undefined;
  const specHash = sha256(canonicalJson({
    workspace_id: workspace.workspace_id,
    program: spec.program,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    timeout_ms: spec.timeoutMs,
    stdin_mode: stdinMode,
    output_encoding: outputEncoding,
    terminal_size: terminal,
    label: spec.label ?? null,
  }));
  const jobId = createScopedId("job", nodeId);
  const directory = join(workerDataRoot(), "jobs", jobId);
  await mkdir(directory, { recursive: false });
  const job: JobRow = {
    job_id: jobId,
    node_id: nodeId,
    workspace_id: workspace.workspace_id,
    executor_status: "queued",
    spec_hash: specHash,
    idempotency_key: spec.idempotencyKey ?? null,
    label: spec.label ?? null,
    program: spec.program,
    cwd: spec.cwd,
    args_summary_json: JSON.stringify(summarizeArguments(spec.args)),
    stdin_mode: stdinMode,
    stdin_pipe: stdinMode === "pipe" || stdinMode === "conpty" ? createJobInputEndpoint() : null,
    output_encoding: outputEncoding,
    stdout_encoding: null,
    stderr_encoding: null,
    terminal_cols: terminal?.cols ?? null,
    terminal_rows: terminal?.rows ?? null,
    terminal_snapshot_path: terminal ? join(directory, "terminal.json") : null,
    pid: null,
    pid_started_at: null,
    runner_pid: null,
    runner_started_at: null,
    runner_heartbeat_at: null,
    storage_reservation_id: spec.storageReservationId ?? null,
    exit_code: null,
    stdout_path: join(directory, "stdout.log"),
    stderr_path: join(directory, "stderr.log"),
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_stored_bytes: 0,
    stderr_stored_bytes: 0,
    stdout_storage_truncated: 0,
    stderr_storage_truncated: 0,
    timeout_ms: spec.timeoutMs,
    cancel_requested: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error_json: null,
    logs_pruned_at: null,
    logs_prune_reason: null,
  };
  let existing: JobRow | undefined;
  try {
    existing = state.insertJobIdempotent(job);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (spec.storageReservationId) state.releaseStorageReservation(spec.storageReservationId);
    if (error instanceof ExecutionMaintenanceError) {
      throw new BridgeError("NODE_MAINTENANCE", "MiraBridge is temporarily refusing new Jobs while Windows app maintenance is in progress.", {
        retryable: true,
        details: { owner: error.lease.owner, reason: error.lease.reason, expires_at: error.lease.expires_at },
      });
    }
    throw error;
  }
  if (existing) {
    await rm(directory, { recursive: true, force: true });
    if (spec.storageReservationId) state.releaseStorageReservation(spec.storageReservationId);
    if (existing.spec_hash !== specHash) {
      throw new BridgeError("INVALID_ARGUMENT", "idempotency_key was already used with a different Job specification.", { details: { job_id: existing.job_id } });
    }
    return publicJob(existing);
  }

  try {
    const entry = process.argv[1];
    if (!entry) throw new BridgeError("PROCESS_START_FAILED", "Worker executable path is unavailable for Job runner startup.");
    const runnerPid = await launchPersistentRunner(entry, {
      job_id: jobId,
      spec: { ...spec, stdinMode, outputEncoding, ...(terminal ? { terminal } : {}), baseEnv: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")) },
      config_path: workerConfigPath(),
      data_root: workerDataRoot(),
    });
    state.setJobRunner(jobId, runnerPid);
  } catch (error) {
    const bridgeError = error instanceof BridgeError ? error : new BridgeError("PROCESS_START_FAILED", "Persistent Job runner could not start.", { cause: error });
    state.setJobStatus(jobId, "failed_to_start", {
      errorJson: JSON.stringify(bridgeError.toJSON()),
      finishedAt: new Date().toISOString(),
    });
    if (spec.storageReservationId) state.releaseStorageReservation(spec.storageReservationId);
    throw bridgeError;
  }
  return { job_id: jobId, executor_status: "queued", stdin_mode: stdinMode, output_encoding: outputEncoding, terminal: terminal ?? null };
}

export async function runJob(serializedBootstrap: string): Promise<void> {
  const bootstrap = JSON.parse(serializedBootstrap) as { job_id?: unknown; spec?: unknown; config_path?: unknown; data_root?: unknown };
  if (typeof bootstrap.job_id !== "string" || typeof bootstrap.config_path !== "string" || typeof bootstrap.data_root !== "string" || !bootstrap.spec || typeof bootstrap.spec !== "object") {
    throw new BridgeError("INVALID_ARGUMENT", "Persistent Job bootstrap is invalid.");
  }
  const jobId = bootstrap.job_id;
  const spec = bootstrap.spec as JobSpec;
  const config = await loadWorkerConfig(bootstrap.config_path);
  await ensureWorkerDirectories(bootstrap.data_root, bootstrap.config_path);
  const state = new WorkerState(join(bootstrap.data_root, "state.sqlite3"));
  state.setJobRunner(jobId, process.pid);
  const heartbeat = setInterval(() => state.touchJobRunner(jobId, process.pid), 2_000);
  heartbeat.unref();
  let inputChannel: JobInputChannel | undefined;
  let terminalRecorder: TerminalRecorder | undefined;
  try {
    const persisted = state.getJob(jobId);
    if (persisted?.stdin_mode === "pipe" || persisted?.stdin_mode === "conpty") {
      if (!persisted.stdin_pipe) throw new BridgeError("JOB_INPUT_UNAVAILABLE", "Durable Job stdin metadata is missing.");
      inputChannel = await listenForJobInput(persisted.stdin_pipe, persisted.stdin_mode);
    }
    if (persisted?.stdin_mode === "conpty") {
      if (!persisted.terminal_snapshot_path || !persisted.terminal_cols || !persisted.terminal_rows) {
        throw new BridgeError("TERMINAL_UNAVAILABLE", "Durable ConPTY metadata is missing.");
      }
      terminalRecorder = new TerminalRecorder(persisted.terminal_snapshot_path, persisted.terminal_cols, persisted.terminal_rows);
      await terminalRecorder.resize(persisted.terminal_cols, persisted.terminal_rows);
    }
    while (true) {
      const claim = state.tryClaimJob(jobId, config.max_concurrent_jobs);
      if (claim === "claimed") break;
      if (claim === "missing" || claim === "cancelled") return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const job = state.getJob(jobId);
    if (!job) return;
    const outcome = await executeProcess(
      {
        ...spec,
        stdinMode: job.stdin_mode,
        outputEncoding: job.output_encoding as OutputEncoding,
        ...(job.stdin_mode === "conpty" && job.terminal_cols && job.terminal_rows ? { terminal: { cols: job.terminal_cols, rows: job.terminal_rows } } : {}),
      },
      job.stdout_path,
      job.stderr_path,
      (pid) => state.setJobStatus(jobId, "running", { pid, pidStartedAt: new Date().toISOString() }),
      config.storage.max_stream_bytes,
      inputChannel && job.stdin_mode === "pipe" ? (input) => inputChannel?.attach(input) : undefined,
      inputChannel && terminalRecorder && job.stdin_mode === "conpty" ? (control) => inputChannel?.attachTerminal(control, async (cols, rows) => {
        state.setJobTerminalSize(jobId, cols, rows);
        await terminalRecorder?.resize(cols, rows);
      }) : undefined,
      terminalRecorder ? async (chunk) => await terminalRecorder?.write(chunk) : undefined,
    );
    await terminalRecorder?.finish();
    const current = state.getJob(jobId);
    const [stdoutBytes, stderrBytes] = await Promise.all([
      stat(job.stdout_path).then((value) => value.size).catch(() => 0),
      stat(job.stderr_path).then((value) => value.size).catch(() => 0),
    ]);
    const status = current?.cancel_requested
      ? "cancelled"
      : outcome.timedOut
        ? "timed_out"
        : "exited";
    state.setJobStatus(jobId, status, {
      exitCode: outcome.exitCode,
      finishedAt: new Date().toISOString(),
      stdoutBytes: outcome.stdout.totalBytes,
      stderrBytes: outcome.stderr.totalBytes,
      stdoutStoredBytes: stdoutBytes,
      stderrStoredBytes: stderrBytes,
      stdoutStorageTruncated: outcome.stdout.storageTruncated ? 1 : 0,
      stderrStorageTruncated: outcome.stderr.storageTruncated ? 1 : 0,
      stdoutEncoding: outcome.stdoutEncoding,
      stderrEncoding: outcome.stderrEncoding,
    });
    if (job.storage_reservation_id) state.releaseStorageReservation(job.storage_reservation_id);
    if (storageMaintenanceDue(state, config.storage.maintenance_interval_minutes)) {
      await pruneStorage(state, config.storage, { dryRun: false, reason: "job-complete", root: bootstrap.data_root })
        .catch((error) => process.stderr.write(`MiraBridge Job-completion GC failed: ${error instanceof Error ? error.message : String(error)}\n`));
    }
  } catch (error) {
    await terminalRecorder?.finish().catch(() => undefined);
    const current = state.getJob(jobId);
    if (current && !terminalJobStatuses.has(current.executor_status)) {
      state.setJobStatus(jobId, current.pid ? "lost" : "failed_to_start", {
        errorJson: JSON.stringify({ code: "PROCESS_START_FAILED", message: error instanceof Error ? error.message : "Job runner failed." }),
        finishedAt: new Date().toISOString(),
      });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    state.clearJobRunner(jobId, process.pid);
    const current = state.getJob(jobId);
    if (current?.storage_reservation_id) state.releaseStorageReservation(current.storage_reservation_id);
    await inputChannel?.close().catch(() => undefined);
    state.close();
  }
}

export async function writeJobInput(
  state: WorkerState,
  jobId: string,
  data: string,
  close: boolean,
): Promise<Record<string, unknown>> {
  const job = state.getJob(jobId);
  if (!job) throw new BridgeError("JOB_NOT_FOUND", `Job was not found: ${jobId}`);
  if (terminalJobStatuses.has(job.executor_status)) {
    throw new BridgeError("JOB_ALREADY_FINISHED", "Job is already in a terminal executor state.", { details: { executor_status: job.executor_status } });
  }
  if ((job.stdin_mode !== "pipe" && job.stdin_mode !== "conpty") || !job.stdin_pipe) {
    throw new BridgeError("JOB_INPUT_UNAVAILABLE", "Job was not started with durable input enabled.");
  }
  const result = await sendJobInput(job.stdin_pipe, Buffer.from(data, "utf8"), close);
  return { job_id: jobId, bytes_written: result.bytes_written, input_closed: result.input_closed };
}

export async function resizeJobTerminal(
  state: WorkerState,
  jobId: string,
  cols: number,
  rows: number,
): Promise<Record<string, unknown>> {
  const job = state.getJob(jobId);
  if (!job) throw new BridgeError("JOB_NOT_FOUND", `Job was not found: ${jobId}`);
  if (terminalJobStatuses.has(job.executor_status)) {
    throw new BridgeError("JOB_ALREADY_FINISHED", "Job is already in a terminal executor state.", { details: { executor_status: job.executor_status } });
  }
  if (job.stdin_mode !== "conpty" || !job.stdin_pipe) throw new BridgeError("TERMINAL_UNAVAILABLE", "Job was not started with stdin_mode=conpty.");
  const resized = await sendJobResize(job.stdin_pipe, cols, rows);
  state.setJobTerminalSize(jobId, resized.cols, resized.rows);
  return { job_id: jobId, ...resized };
}

export async function readJobTerminal(state: WorkerState, jobId: string): Promise<Record<string, unknown>> {
  const job = state.getJob(jobId);
  if (!job) throw new BridgeError("JOB_NOT_FOUND", `Job was not found: ${jobId}`);
  if (job.stdin_mode !== "conpty" || !job.terminal_snapshot_path) throw new BridgeError("TERMINAL_UNAVAILABLE", "Job was not started with stdin_mode=conpty.");
  if (job.logs_pruned_at) {
    throw new BridgeError("TERMINAL_SNAPSHOT_UNAVAILABLE", "The ConPTY terminal snapshot expired with the Job logs.", {
      details: { job_id: jobId, pruned_at: job.logs_pruned_at, reason: job.logs_prune_reason },
    });
  }
  return { job_id: jobId, executor_status: job.executor_status, ...(await readTerminalSnapshot(job.terminal_snapshot_path)) };
}

export function getJob(state: WorkerState, jobId: string): Record<string, unknown> {
  const job = state.getJob(jobId);
  if (!job) throw new BridgeError("JOB_NOT_FOUND", `Job was not found: ${jobId}`);
  return publicJob(job);
}

export async function waitJob(state: WorkerState, jobId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  await reconcileJobs(state);
  const initial = state.getJob(jobId);
  if (!initial) throw new BridgeError("JOB_NOT_FOUND", `Job was not found: ${jobId}`);
  const deadline = Date.now() + timeoutMs;
  let nextReconcileAt = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (Date.now() >= nextReconcileAt) {
      await reconcileJobs(state);
      nextReconcileAt = Date.now() + 1_000;
    }
    const current = state.getJob(jobId);
    if (!current) throw new BridgeError("JOB_NOT_FOUND", `Job was not found: ${jobId}`);
    if (current.executor_status !== initial.executor_status || terminalJobStatuses.has(current.executor_status)) return publicJob(current);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return publicJob(state.getJob(jobId) ?? initial);
}

export async function cancelJob(state: WorkerState, jobId: string): Promise<Record<string, unknown>> {
  const job = state.getJob(jobId);
  if (!job) throw new BridgeError("JOB_NOT_FOUND", `Job was not found: ${jobId}`);
  // Cancellation may have completed just before an SSH transport retry. Treat an
  // already-cancelled Job as the successful result of the same desired action.
  if (job.executor_status === "cancelled") {
    if (job.storage_reservation_id) state.releaseStorageReservation(job.storage_reservation_id);
    return publicJob(job);
  }
  if (terminalJobStatuses.has(job.executor_status)) {
    if (job.storage_reservation_id) state.releaseStorageReservation(job.storage_reservation_id);
    throw new BridgeError("JOB_ALREADY_FINISHED", "Job is already in a terminal executor state.", { details: { executor_status: job.executor_status } });
  }
  state.requestCancel(jobId);
  if (job.pid) await terminateProcessTree(job.pid, job.pid_started_at ?? undefined);
  else if (job.runner_pid) await terminateProcessTree(job.runner_pid, job.runner_started_at ?? undefined);
  state.setJobStatus(jobId, "cancelled", { finishedAt: new Date().toISOString() });
  if (job.storage_reservation_id) state.releaseStorageReservation(job.storage_reservation_id);
  return getJob(state, jobId);
}

export async function readJobLogs(state: WorkerState, jobId: string, stream: "stdout" | "stderr", offset: number, maxBytes: number, tailLines?: number): Promise<Record<string, unknown>> {
  const job = state.getJob(jobId);
  if (!job) throw new BridgeError("JOB_NOT_FOUND", `Job was not found: ${jobId}`);
  if (job.logs_pruned_at) {
    throw new BridgeError("JOB_LOGS_EXPIRED", "Job logs expired under the configured retention policy.", {
      details: { job_id: jobId, pruned_at: job.logs_pruned_at, reason: job.logs_prune_reason },
    });
  }
  const range = await readOutputRange(stream === "stdout" ? job.stdout_path : job.stderr_path, offset, maxBytes, tailLines);
  const stdout = stream === "stdout";
  const countsFinal = terminalJobStatuses.has(job.executor_status);
  const currentStoredBytes = Number(range.total_bytes);
  return {
    job_id: jobId,
    stream,
    ...range,
    total_bytes: countsFinal ? (stdout ? job.stdout_bytes : job.stderr_bytes) : currentStoredBytes,
    stored_bytes: countsFinal ? (stdout ? job.stdout_stored_bytes : job.stderr_stored_bytes) : currentStoredBytes,
    storage_truncated: countsFinal ? Boolean(stdout ? job.stdout_storage_truncated : job.stderr_storage_truncated) : false,
    counts_final: countsFinal,
    encoding: stdout ? job.stdout_encoding : job.stderr_encoding,
  };
}

interface JobCursor {
  version: 1;
  after_job_id: string;
  node_id: string | null;
  statuses: JobRow["executor_status"][];
}

function normalizedStatuses(statuses?: JobRow["executor_status"][]): JobRow["executor_status"][] {
  return [...new Set(statuses ?? [])].sort();
}

function decodeJobCursor(cursor: unknown): JobCursor | number | undefined {
  if (typeof cursor !== "string" || cursor.length === 0) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid Job cursor.");
  }

  // Accept the 1.3 offset cursor for RPC 2.0 compatibility. New cursors are
  // keyset markers so Jobs inserted between pages cannot shift the result.
  const legacyOffset = Number(decoded);
  if (Number.isSafeInteger(legacyOffset) && legacyOffset >= 0) return legacyOffset;

  try {
    const parsed = JSON.parse(decoded) as Partial<JobCursor>;
    if (
      parsed.version !== 1
      || typeof parsed.after_job_id !== "string"
      || !(parsed.node_id === null || typeof parsed.node_id === "string")
      || !Array.isArray(parsed.statuses)
      || !parsed.statuses.every((status) => typeof status === "string")
    ) throw new Error("invalid");
    return parsed as JobCursor;
  } catch {
    throw new BridgeError("INVALID_ARGUMENT", "Invalid Job cursor.");
  }
}

function encodeJobCursor(job: JobRow, statuses: JobRow["executor_status"][], nodeId?: string): string {
  const marker: JobCursor = {
    version: 1,
    after_job_id: job.job_id,
    node_id: nodeId ?? null,
    statuses: normalizedStatuses(statuses),
  };
  return Buffer.from(JSON.stringify(marker), "utf8").toString("base64url");
}

export function listJobs(
  state: WorkerState,
  statuses?: JobRow["executor_status"][],
  cursor?: unknown,
  maxResults = 100,
  nodeId?: string,
): Record<string, unknown> {
  const all = state.listJobs(statuses, nodeId);
  const decodedCursor = decodeJobCursor(cursor);
  let offset = 0;
  if (typeof decodedCursor === "number") {
    offset = decodedCursor;
  } else if (decodedCursor) {
    if (
      decodedCursor.node_id !== (nodeId ?? null)
      || JSON.stringify(decodedCursor.statuses) !== JSON.stringify(normalizedStatuses(statuses))
    ) {
      throw new BridgeError("INVALID_ARGUMENT", "The Job cursor does not match the requested node or status filters.");
    }
    const markerIndex = all.findIndex((job) => job.job_id === decodedCursor.after_job_id);
    if (markerIndex < 0) {
      throw new BridgeError("RESOURCE_CHANGED", "The Job list changed and the cursor can no longer be resumed.", {
        retryable: true,
        details: { after_job_id: decodedCursor.after_job_id },
      });
    }
    offset = markerIndex + 1;
  }
  const page: JobRow[] = [];
  let pageBytes = 2;
  for (const job of all.slice(offset, offset + maxResults)) {
    const bytes = Buffer.byteLength(JSON.stringify(publicJob(job))) + 1;
    if (page.length > 0 && pageBytes + bytes > 256 * 1024) break;
    page.push(job);
    pageBytes += bytes;
  }
  const next = offset + page.length < all.length && page.length > 0
    ? encodeJobCursor(page.at(-1)!, statuses ?? [], nodeId)
    : null;
  return { jobs: page.map(publicJob), total_jobs: all.length, cursor: next };
}

export async function reconcileJobs(state: WorkerState): Promise<void> {
  const now = Date.now();
  for (const job of state.listJobs()) {
    if (!(["queued", "starting", "running"] as const).includes(job.executor_status as "queued" | "starting" | "running")) {
      if (job.storage_reservation_id) state.releaseStorageReservation(job.storage_reservation_id);
      continue;
    }
    if (!job.runner_pid) {
      if (now - Date.parse(job.created_at) < 30_000) continue;
      state.setJobStatus(job.job_id, job.executor_status === "queued" ? "failed_to_start" : "lost", {
        errorJson: JSON.stringify({ code: "PROCESS_START_FAILED", message: "The durable Job runner did not start or disappeared." }),
        finishedAt: new Date().toISOString(),
      });
      if (job.storage_reservation_id) state.releaseStorageReservation(job.storage_reservation_id);
      continue;
    }
    const heartbeatAge = job.runner_heartbeat_at ? now - Date.parse(job.runner_heartbeat_at) : Number.POSITIVE_INFINITY;
    if (heartbeatAge <= 15_000) continue;
    if (await processMatchesStart(job.runner_pid, job.runner_started_at ?? undefined)) continue;
    if (job.pid && await processMatchesStart(job.pid, job.pid_started_at ?? undefined)) {
      await terminateProcessTree(job.pid, job.pid_started_at ?? undefined).catch(() => undefined);
    }
    state.setJobStatus(job.job_id, job.executor_status === "queued" ? "failed_to_start" : "lost", {
      errorJson: JSON.stringify({ code: "PROCESS_START_FAILED", message: "The durable Job runner was lost." }),
      finishedAt: new Date().toISOString(),
    });
    if (job.storage_reservation_id) state.releaseStorageReservation(job.storage_reservation_id);
  }
}
