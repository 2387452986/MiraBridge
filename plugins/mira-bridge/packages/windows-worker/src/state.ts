import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { workerDataRoot } from "./config.js";

export interface WorkspaceRow {
  workspace_id: string;
  node_id: string;
  canonical_path: string;
  mode: "read-only" | "read-write";
  created_at: string;
  last_used_at: string;
}

export interface OutputRow {
  output_ref: string;
  node_id: string;
  stdout_path: string;
  stderr_path: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_stored_bytes: number;
  stderr_stored_bytes: number;
  stdout_storage_truncated: number;
  stderr_storage_truncated: number;
  created_at: string;
  pruned_at: string | null;
  prune_reason: string | null;
}

export interface JobRow {
  job_id: string;
  node_id: string;
  workspace_id: string;
  executor_status: "queued" | "starting" | "running" | "exited" | "failed_to_start" | "cancelled" | "timed_out" | "lost";
  spec_hash: string;
  idempotency_key: string | null;
  label: string | null;
  program: string | null;
  cwd: string | null;
  args_summary_json: string | null;
  stdin_mode: "closed" | "pipe" | "conpty";
  stdin_pipe: string | null;
  output_encoding: string;
  stdout_encoding: string | null;
  stderr_encoding: string | null;
  terminal_cols: number | null;
  terminal_rows: number | null;
  terminal_snapshot_path: string | null;
  pid: number | null;
  pid_started_at: string | null;
  runner_pid: number | null;
  runner_started_at: string | null;
  runner_heartbeat_at: string | null;
  storage_reservation_id: string | null;
  exit_code: number | null;
  stdout_path: string;
  stderr_path: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_stored_bytes: number;
  stderr_stored_bytes: number;
  stdout_storage_truncated: number;
  stderr_storage_truncated: number;
  timeout_ms: number;
  cancel_requested: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_json: string | null;
  logs_pruned_at: string | null;
  logs_prune_reason: string | null;
}

export interface TransferRow {
  transfer_id: string;
  node_id: string;
  direction: "push" | "pull";
  kind: "file" | "directory";
  source_path: string | null;
  destination_path: string | null;
  temporary_path: string | null;
  size: number;
  sha256: string;
  transferred: number;
  overwrite: number;
  manifest_json: string | null;
  manifest_sha256: string | null;
  phase: "receiving" | "extracting" | "validated" | "committing" | "backed_up" | "installed";
  staging_path: string | null;
  backup_path: string | null;
  owner_id: string | null;
  owner_pid: number | null;
  owner_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecycleScanRow {
  scan_id: string;
  node_id: string;
  snapshot_hash: string;
  drives_json: string;
  item_count: number;
  total_bytes: number;
  snapshot_json: string;
  created_at: string;
  expires_at: string;
}

export interface StorageReservationRow {
  reservation_id: string;
  operation: string;
  root_bytes: number;
  root_volume: string;
  target_bytes: number;
  target_volume: string | null;
  created_at: string;
  expires_at: string;
}

export interface ExecutionMaintenanceLease {
  owner: string;
  reason: string;
  created_at: string;
  expires_at: string;
  expires_at_ms: number;
}

export class ExecutionMaintenanceError extends Error {
  constructor(readonly lease: ExecutionMaintenanceLease) {
    super(`MiraBridge execution is paused for ${lease.reason}.`);
    this.name = "ExecutionMaintenanceError";
  }
}

export type ExecutionMaintenanceAdmission =
  | { acquired: true; lease: ExecutionMaintenanceLease }
  | { acquired: false; reason: "active_jobs"; active_jobs: number }
  | { acquired: false; reason: "locked"; lease: ExecutionMaintenanceLease };

export type RequestAdmission =
  | { state: "complete"; payload_hash: string; response_json: string }
  | { state: "reserved" }
  | { state: "existing"; payload_hash: string; operation: string; created_at: string };

export class WorkerState {
  readonly db: DatabaseSync;

  constructor(path = join(workerDataRoot(), "state.sqlite3")) {
    this.db = new DatabaseSync(path, { timeout: 30_000 });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('read-only', 'read-write')),
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outputs (
        output_ref TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        stdout_path TEXT NOT NULL,
        stderr_path TEXT NOT NULL,
        stdout_bytes INTEGER NOT NULL,
        stderr_bytes INTEGER NOT NULL,
        stdout_stored_bytes INTEGER NOT NULL DEFAULT 0,
        stderr_stored_bytes INTEGER NOT NULL DEFAULT 0,
        stdout_storage_truncated INTEGER NOT NULL DEFAULT 0,
        stderr_storage_truncated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        pruned_at TEXT,
        prune_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        executor_status TEXT NOT NULL,
        spec_hash TEXT NOT NULL,
        idempotency_key TEXT,
        label TEXT,
        program TEXT,
        cwd TEXT,
        args_summary_json TEXT,
        stdin_mode TEXT NOT NULL DEFAULT 'closed',
        stdin_pipe TEXT,
        output_encoding TEXT NOT NULL DEFAULT 'auto',
        stdout_encoding TEXT,
        stderr_encoding TEXT,
        terminal_cols INTEGER,
        terminal_rows INTEGER,
        terminal_snapshot_path TEXT,
        pid INTEGER,
        pid_started_at TEXT,
        runner_pid INTEGER,
        runner_started_at TEXT,
        runner_heartbeat_at TEXT,
        storage_reservation_id TEXT,
        exit_code INTEGER,
        stdout_path TEXT NOT NULL,
        stderr_path TEXT NOT NULL,
        stdout_bytes INTEGER NOT NULL DEFAULT 0,
        stderr_bytes INTEGER NOT NULL DEFAULT 0,
        stdout_stored_bytes INTEGER NOT NULL DEFAULT 0,
        stderr_stored_bytes INTEGER NOT NULL DEFAULT 0,
        stdout_storage_truncated INTEGER NOT NULL DEFAULT 0,
        stderr_storage_truncated INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error_json TEXT,
        logs_pruned_at TEXT,
        logs_prune_reason TEXT,
        UNIQUE(node_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(executor_status);
      CREATE TABLE IF NOT EXISTS transfers (
        transfer_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'file',
        source_path TEXT,
        destination_path TEXT,
        temporary_path TEXT,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        transferred INTEGER NOT NULL DEFAULT 0,
        overwrite INTEGER NOT NULL DEFAULT 0,
        manifest_json TEXT,
        manifest_sha256 TEXT,
        phase TEXT NOT NULL DEFAULT 'receiving',
        staging_path TEXT,
        backup_path TEXT,
        owner_id TEXT,
        owner_pid INTEGER,
        owner_started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_tombstones (
        request_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        operation TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recycle_scans (
        scan_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        drives_json TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recycle_scans_expiry_idx ON recycle_scans(expires_at);
      CREATE TABLE IF NOT EXISTS storage_reservations (
        reservation_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        root_bytes INTEGER NOT NULL,
        root_volume TEXT NOT NULL,
        target_bytes INTEGER NOT NULL,
        target_volume TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS storage_reservations_expiry_idx ON storage_reservations(expires_at);
      CREATE TABLE IF NOT EXISTS maintenance (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.migrateExistingDatabase();
  }

  private migrateExistingDatabase(): void {
    const addColumn = (table: string, name: string, definition: string): boolean => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (columns.some((column) => column.name === name)) return false;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      return true;
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentVersion = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (currentVersion >= 5) {
        this.db.exec("COMMIT");
        return;
      }
      const workspaceLastUsedAdded = addColumn("workspaces", "last_used_at", "TEXT");
      if (workspaceLastUsedAdded) this.db.exec("UPDATE workspaces SET last_used_at=created_at WHERE last_used_at IS NULL");
      for (const table of ["outputs", "jobs"] as const) {
        const stdoutStoredAdded = addColumn(table, "stdout_stored_bytes", "INTEGER NOT NULL DEFAULT 0");
        const stderrStoredAdded = addColumn(table, "stderr_stored_bytes", "INTEGER NOT NULL DEFAULT 0");
        addColumn(table, "stdout_storage_truncated", "INTEGER NOT NULL DEFAULT 0");
        addColumn(table, "stderr_storage_truncated", "INTEGER NOT NULL DEFAULT 0");
        if (stdoutStoredAdded) this.db.exec(`UPDATE ${table} SET stdout_stored_bytes=stdout_bytes`);
        if (stderrStoredAdded) this.db.exec(`UPDATE ${table} SET stderr_stored_bytes=stderr_bytes`);
      }
      addColumn("outputs", "pruned_at", "TEXT");
      addColumn("outputs", "prune_reason", "TEXT");
      addColumn("jobs", "logs_pruned_at", "TEXT");
      addColumn("jobs", "logs_prune_reason", "TEXT");
      addColumn("jobs", "stdin_mode", "TEXT NOT NULL DEFAULT 'closed'");
      addColumn("jobs", "stdin_pipe", "TEXT");
      addColumn("jobs", "output_encoding", "TEXT NOT NULL DEFAULT 'auto'");
      addColumn("jobs", "stdout_encoding", "TEXT");
      addColumn("jobs", "stderr_encoding", "TEXT");
      addColumn("jobs", "terminal_cols", "INTEGER");
      addColumn("jobs", "terminal_rows", "INTEGER");
      addColumn("jobs", "terminal_snapshot_path", "TEXT");
      addColumn("jobs", "label", "TEXT");
      addColumn("jobs", "program", "TEXT");
      addColumn("jobs", "cwd", "TEXT");
      addColumn("jobs", "args_summary_json", "TEXT");
      addColumn("jobs", "pid_started_at", "TEXT");
      addColumn("jobs", "runner_pid", "INTEGER");
      addColumn("jobs", "runner_started_at", "TEXT");
      addColumn("jobs", "runner_heartbeat_at", "TEXT");
      addColumn("jobs", "storage_reservation_id", "TEXT");
      addColumn("transfers", "kind", "TEXT NOT NULL DEFAULT 'file'");
      addColumn("transfers", "manifest_json", "TEXT");
      addColumn("transfers", "manifest_sha256", "TEXT");
      addColumn("transfers", "phase", "TEXT NOT NULL DEFAULT 'receiving'");
      addColumn("transfers", "staging_path", "TEXT");
      addColumn("transfers", "backup_path", "TEXT");
      addColumn("transfers", "owner_id", "TEXT");
      addColumn("transfers", "owner_pid", "INTEGER");
      addColumn("transfers", "owner_started_at", "TEXT");
      addColumn("transfers", "updated_at", "TEXT");
      this.db.exec("UPDATE transfers SET updated_at = created_at WHERE updated_at IS NULL");
      this.db.exec("PRAGMA user_version=5");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  getRequest(requestId: string): { payload_hash: string; response_json: string } | undefined {
    return this.db.prepare("SELECT payload_hash, response_json FROM requests WHERE request_id = ?").get(requestId) as { payload_hash: string; response_json: string } | undefined;
  }

  beginRequest(requestId: string, payloadHash: string, operation: string): RequestAdmission {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const complete = this.getRequest(requestId);
      if (complete) {
        this.db.exec("COMMIT");
        return { state: "complete", ...complete };
      }
      const existing = this.getRequestTombstone(requestId);
      if (existing) {
        this.db.exec("COMMIT");
        return { state: "existing", ...existing };
      }
      this.db.prepare("INSERT INTO request_tombstones(request_id, payload_hash, operation, created_at) VALUES(?, ?, ?, ?)")
        .run(requestId, payloadHash, operation, new Date().toISOString());
      this.db.exec("COMMIT");
      return { state: "reserved" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  putRequest(requestId: string, payloadHash: string, responseJson: string, operation: string): void {
    const createdAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR REPLACE INTO requests(request_id, payload_hash, response_json, created_at) VALUES(?, ?, ?, ?)")
        .run(requestId, payloadHash, responseJson, createdAt);
      this.db.prepare("INSERT OR REPLACE INTO request_tombstones(request_id, payload_hash, operation, created_at) VALUES(?, ?, ?, ?)")
        .run(requestId, payloadHash, operation, createdAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRequestTombstone(requestId: string): { payload_hash: string; operation: string; created_at: string } | undefined {
    return this.db.prepare("SELECT payload_hash, operation, created_at FROM request_tombstones WHERE request_id = ?").get(requestId) as { payload_hash: string; operation: string; created_at: string } | undefined;
  }

  putWorkspace(workspace: WorkspaceRow): void {
    this.db.prepare("INSERT INTO workspaces(workspace_id, node_id, canonical_path, mode, created_at, last_used_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(workspace.workspace_id, workspace.node_id, workspace.canonical_path, workspace.mode, workspace.created_at, workspace.last_used_at);
  }

  getWorkspace(workspaceId: string): WorkspaceRow | undefined {
    const workspace = this.db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId) as unknown as WorkspaceRow | undefined;
    if (workspace) this.db.prepare("UPDATE workspaces SET last_used_at=? WHERE workspace_id=?").run(new Date().toISOString(), workspaceId);
    return workspace;
  }

  putOutput(output: OutputRow): void {
    this.db.prepare(`INSERT INTO outputs(
      output_ref,node_id,stdout_path,stderr_path,stdout_bytes,stderr_bytes,stdout_stored_bytes,stderr_stored_bytes,
      stdout_storage_truncated,stderr_storage_truncated,created_at,pruned_at,prune_reason
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      output.output_ref, output.node_id, output.stdout_path, output.stderr_path, output.stdout_bytes, output.stderr_bytes,
      output.stdout_stored_bytes, output.stderr_stored_bytes, output.stdout_storage_truncated, output.stderr_storage_truncated,
      output.created_at, output.pruned_at, output.prune_reason,
    );
  }

  getOutput(outputRef: string): OutputRow | undefined {
    return this.db.prepare("SELECT * FROM outputs WHERE output_ref = ?").get(outputRef) as unknown as OutputRow | undefined;
  }

  insertJob(job: JobRow): void {
    const placeholders = Array.from({ length: 41 }, () => "?").join(",");
    this.db.prepare(`INSERT INTO jobs(
      job_id,node_id,workspace_id,executor_status,spec_hash,idempotency_key,label,program,cwd,args_summary_json,stdin_mode,stdin_pipe,output_encoding,stdout_encoding,stderr_encoding,
      terminal_cols,terminal_rows,terminal_snapshot_path,pid,pid_started_at,runner_pid,runner_started_at,runner_heartbeat_at,storage_reservation_id,exit_code,stdout_path,stderr_path,
      stdout_bytes,stderr_bytes,stdout_stored_bytes,stderr_stored_bytes,stdout_storage_truncated,stderr_storage_truncated,
      timeout_ms,cancel_requested,created_at,started_at,finished_at,error_json,logs_pruned_at,logs_prune_reason
    ) VALUES(${placeholders})`).run(
      job.job_id, job.node_id, job.workspace_id, job.executor_status, job.spec_hash, job.idempotency_key,
      job.label, job.program, job.cwd, job.args_summary_json,
      job.stdin_mode, job.stdin_pipe, job.output_encoding, job.stdout_encoding, job.stderr_encoding,
      job.terminal_cols, job.terminal_rows, job.terminal_snapshot_path,
      job.pid, job.pid_started_at, job.runner_pid, job.runner_started_at, job.runner_heartbeat_at, job.storage_reservation_id,
      job.exit_code, job.stdout_path, job.stderr_path, job.stdout_bytes, job.stderr_bytes,
      job.stdout_stored_bytes, job.stderr_stored_bytes, job.stdout_storage_truncated, job.stderr_storage_truncated,
      job.timeout_ms, job.cancel_requested, job.created_at, job.started_at, job.finished_at, job.error_json,
      job.logs_pruned_at, job.logs_prune_reason,
    );
  }

  insertJobIdempotent(job: JobRow): JobRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = job.idempotency_key ? this.findIdempotentJob(job.node_id, job.idempotency_key) : undefined;
      if (!existing) {
        const maintenance = this.executionMaintenance();
        if (maintenance) throw new ExecutionMaintenanceError(maintenance);
        this.insertJob(job);
      }
      this.db.exec("COMMIT");
      return existing;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getJob(jobId: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as unknown as JobRow | undefined;
  }

  findIdempotentJob(nodeId: string, key: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE node_id = ? AND idempotency_key = ?").get(nodeId, key) as unknown as JobRow | undefined;
  }

  listJobs(statuses?: JobRow["executor_status"][], nodeId?: string): JobRow[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (statuses?.length) {
      clauses.push(`executor_status IN (${statuses.map(() => "?").join(",")})`);
      parameters.push(...statuses);
    }
    if (nodeId) {
      clauses.push("node_id = ?");
      parameters.push(nodeId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM jobs${where} ORDER BY created_at DESC, job_id DESC`).all(...parameters) as unknown as JobRow[];
  }

  requestCancel(jobId: string): void {
    this.db.prepare("UPDATE jobs SET cancel_requested = 1 WHERE job_id = ?").run(jobId);
  }

  setJobStatus(jobId: string, status: JobRow["executor_status"], fields: { pid?: number | null; pidStartedAt?: string | null; exitCode?: number | null; errorJson?: string | null; startedAt?: string | null; finishedAt?: string | null; stdoutBytes?: number; stderrBytes?: number; stdoutStoredBytes?: number; stderrStoredBytes?: number; stdoutStorageTruncated?: number; stderrStorageTruncated?: number; stdoutEncoding?: string | null; stderrEncoding?: string | null } = {}): void {
    const current = this.getJob(jobId);
    if (!current) return;
    this.db.prepare(`UPDATE jobs SET executor_status=?, pid=?, pid_started_at=?, exit_code=?, error_json=?, started_at=?, finished_at=?, stdout_bytes=?, stderr_bytes=?, stdout_stored_bytes=?, stderr_stored_bytes=?, stdout_storage_truncated=?, stderr_storage_truncated=?, stdout_encoding=?, stderr_encoding=? WHERE job_id=?`).run(
      status,
      fields.pid === undefined ? current.pid : fields.pid,
      fields.pidStartedAt === undefined ? current.pid_started_at : fields.pidStartedAt,
      fields.exitCode === undefined ? current.exit_code : fields.exitCode,
      fields.errorJson === undefined ? current.error_json : fields.errorJson,
      fields.startedAt === undefined ? current.started_at : fields.startedAt,
      fields.finishedAt === undefined ? current.finished_at : fields.finishedAt,
      fields.stdoutBytes === undefined ? current.stdout_bytes : fields.stdoutBytes,
      fields.stderrBytes === undefined ? current.stderr_bytes : fields.stderrBytes,
      fields.stdoutStoredBytes === undefined ? current.stdout_stored_bytes : fields.stdoutStoredBytes,
      fields.stderrStoredBytes === undefined ? current.stderr_stored_bytes : fields.stderrStoredBytes,
      fields.stdoutStorageTruncated === undefined ? current.stdout_storage_truncated : fields.stdoutStorageTruncated,
      fields.stderrStorageTruncated === undefined ? current.stderr_storage_truncated : fields.stderrStorageTruncated,
      fields.stdoutEncoding === undefined ? current.stdout_encoding : fields.stdoutEncoding,
      fields.stderrEncoding === undefined ? current.stderr_encoding : fields.stderrEncoding,
      jobId,
    );
  }

  setJobRunner(jobId: string, pid: number, at = new Date().toISOString()): void {
    this.db.prepare("UPDATE jobs SET runner_pid=?, runner_started_at=COALESCE(runner_started_at, ?), runner_heartbeat_at=? WHERE job_id=? AND executor_status IN ('queued','starting','running')")
      .run(pid, at, at, jobId);
  }

  touchJobRunner(jobId: string, pid: number, at = new Date().toISOString()): void {
    this.db.prepare("UPDATE jobs SET runner_heartbeat_at=? WHERE job_id=? AND runner_pid=?").run(at, jobId, pid);
  }

  clearJobRunner(jobId: string, pid: number): void {
    this.db.prepare("UPDATE jobs SET runner_pid=NULL WHERE job_id=? AND runner_pid=?").run(jobId, pid);
  }

  setJobTerminalSize(jobId: string, cols: number, rows: number): void {
    this.db.prepare("UPDATE jobs SET terminal_cols=?, terminal_rows=? WHERE job_id=?").run(cols, rows, jobId);
  }

  tryClaimJob(jobId: string, maxConcurrent: number): "claimed" | "wait" | "cancelled" | "missing" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.getJob(jobId);
      if (!job) {
        this.db.exec("COMMIT");
        return "missing";
      }
      if (job.cancel_requested) {
        this.setJobStatus(jobId, "cancelled", { finishedAt: new Date().toISOString() });
        this.db.exec("COMMIT");
        return "cancelled";
      }
      const row = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE executor_status IN ('starting','running')").get() as { count: number };
      if (row.count >= maxConcurrent) {
        this.db.exec("COMMIT");
        return "wait";
      }
      this.setJobStatus(jobId, "starting", { startedAt: new Date().toISOString() });
      this.db.exec("COMMIT");
      return "claimed";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  putTransfer(transfer: TransferRow): void {
    this.db.prepare("INSERT INTO transfers(transfer_id,node_id,direction,kind,source_path,destination_path,temporary_path,size,sha256,transferred,overwrite,manifest_json,manifest_sha256,phase,staging_path,backup_path,owner_id,owner_pid,owner_started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(transfer.transfer_id, transfer.node_id, transfer.direction, transfer.kind, transfer.source_path, transfer.destination_path, transfer.temporary_path, transfer.size, transfer.sha256, transfer.transferred, transfer.overwrite, transfer.manifest_json, transfer.manifest_sha256, transfer.phase, transfer.staging_path, transfer.backup_path, transfer.owner_id, transfer.owner_pid, transfer.owner_started_at, transfer.created_at, transfer.updated_at);
  }

  getTransfer(transferId: string): TransferRow | undefined {
    return this.db.prepare("SELECT * FROM transfers WHERE transfer_id = ?").get(transferId) as unknown as TransferRow | undefined;
  }

  updateTransferred(transferId: string, transferred: number): void {
    this.db.prepare("UPDATE transfers SET transferred = ?, updated_at = ? WHERE transfer_id = ?").run(transferred, new Date().toISOString(), transferId);
  }

  setTransferRecovery(
    transferId: string,
    phase: TransferRow["phase"],
    stagingPath: string | null,
    backupPath: string | null,
  ): void {
    this.db.prepare("UPDATE transfers SET phase = ?, staging_path = ?, backup_path = ?, updated_at = ? WHERE transfer_id = ?")
      .run(phase, stagingPath, backupPath, new Date().toISOString(), transferId);
  }

  claimTransferOwner(transferId: string, ownerId: string, pid: number, startedAt: string): boolean {
    const result = this.db.prepare("UPDATE transfers SET owner_id=?, owner_pid=?, owner_started_at=?, updated_at=? WHERE transfer_id=? AND owner_id IS NULL AND owner_pid IS NULL")
      .run(ownerId, pid, startedAt, new Date().toISOString(), transferId);
    return Number(result.changes) === 1;
  }

  clearTransferOwner(transferId: string, ownerId: string): void {
    this.db.prepare("UPDATE transfers SET owner_id=NULL, owner_pid=NULL, owner_started_at=NULL, updated_at=? WHERE transfer_id=? AND owner_id=?")
      .run(new Date().toISOString(), transferId, ownerId);
  }

  abandonTransferOwner(transferId: string, pid: number): void {
    this.db.prepare("UPDATE transfers SET owner_id=NULL, owner_pid=NULL, owner_started_at=NULL, updated_at=? WHERE transfer_id=? AND owner_pid=?")
      .run(new Date().toISOString(), transferId, pid);
  }

  removeTransfer(transferId: string): void {
    this.db.prepare("DELETE FROM transfers WHERE transfer_id = ?").run(transferId);
  }

  staleTransfers(cutoff: string): TransferRow[] {
    return this.db.prepare("SELECT * FROM transfers WHERE COALESCE(updated_at, created_at) < ?").all(cutoff) as unknown as TransferRow[];
  }

  allTransfers(): TransferRow[] {
    return this.db.prepare("SELECT * FROM transfers ORDER BY created_at ASC").all() as unknown as TransferRow[];
  }

  tryReserveStorage(
    reservation: StorageReservationRow,
    capacity: {
      current_used_bytes: number;
      quota_bytes: number;
      minimum_free_bytes: number;
      free_bytes_by_volume: Record<string, number | null>;
    },
  ): { accepted: boolean; reserved_root_bytes: number; reserved_bytes_by_volume: Record<string, number>; reason?: "quota" | "free_space" | "duplicate" } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM storage_reservations WHERE expires_at <= ?").run(reservation.created_at);
      const existing = this.db.prepare("SELECT * FROM storage_reservations WHERE reservation_id=?").get(reservation.reservation_id) as unknown as StorageReservationRow | undefined;
      if (existing) {
        const same = existing.operation === reservation.operation
          && existing.root_bytes === reservation.root_bytes
          && existing.root_volume === reservation.root_volume
          && existing.target_bytes === reservation.target_bytes
          && existing.target_volume === reservation.target_volume;
        this.db.exec("COMMIT");
        return { accepted: same, reserved_root_bytes: 0, reserved_bytes_by_volume: {}, ...(same ? {} : { reason: "duplicate" as const }) };
      }
      const rows = this.db.prepare("SELECT * FROM storage_reservations").all() as unknown as StorageReservationRow[];
      const reservedRootBytes = rows.reduce((sum, row) => sum + row.root_bytes, 0);
      const byVolume: Record<string, number> = {};
      const add = (volume: string | null, bytes: number): void => {
        if (!volume || bytes <= 0) return;
        byVolume[volume] = (byVolume[volume] ?? 0) + bytes;
      };
      for (const row of rows) {
        add(row.root_volume, row.root_bytes);
        add(row.target_volume, row.target_bytes);
      }
      if (capacity.current_used_bytes + reservedRootBytes + reservation.root_bytes > capacity.quota_bytes) {
        this.db.exec("COMMIT");
        return { accepted: false, reserved_root_bytes: reservedRootBytes, reserved_bytes_by_volume: byVolume, reason: "quota" };
      }
      const requestedByVolume: Record<string, number> = {};
      const addRequested = (volume: string | null, bytes: number): void => {
        if (!volume) return;
        requestedByVolume[volume] = (requestedByVolume[volume] ?? 0) + bytes;
      };
      addRequested(reservation.root_volume, reservation.root_bytes);
      addRequested(reservation.target_volume, reservation.target_bytes);
      for (const [volume, requested] of Object.entries(requestedByVolume)) {
        const free = capacity.free_bytes_by_volume[volume];
        if (free === null || free === undefined || free - (byVolume[volume] ?? 0) - requested < capacity.minimum_free_bytes) {
          this.db.exec("COMMIT");
          return { accepted: false, reserved_root_bytes: reservedRootBytes, reserved_bytes_by_volume: byVolume, reason: "free_space" };
        }
      }
      this.db.prepare("INSERT INTO storage_reservations(reservation_id,operation,root_bytes,root_volume,target_bytes,target_volume,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(reservation.reservation_id, reservation.operation, reservation.root_bytes, reservation.root_volume, reservation.target_bytes, reservation.target_volume, reservation.created_at, reservation.expires_at);
      this.db.exec("COMMIT");
      for (const [volume, bytes] of Object.entries(requestedByVolume)) byVolume[volume] = (byVolume[volume] ?? 0) + bytes;
      return { accepted: true, reserved_root_bytes: reservedRootBytes + reservation.root_bytes, reserved_bytes_by_volume: byVolume };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseStorageReservation(reservationId: string): void {
    this.db.prepare("DELETE FROM storage_reservations WHERE reservation_id=?").run(reservationId);
  }

  storageReservations(): StorageReservationRow[] {
    return this.db.prepare("SELECT * FROM storage_reservations ORDER BY created_at").all() as unknown as StorageReservationRow[];
  }

  deleteExpiredStorageReservations(now: string): number {
    return Number(this.db.prepare("DELETE FROM storage_reservations WHERE expires_at <= ?").run(now).changes);
  }

  countNonTerminalJobs(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE executor_status IN ('queued','starting','running')").get() as { count: number };
    return row.count;
  }

  putRecycleScan(scan: RecycleScanRow): void {
    this.db.prepare(`INSERT INTO recycle_scans(
      scan_id,node_id,snapshot_hash,drives_json,item_count,total_bytes,snapshot_json,created_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      scan.scan_id, scan.node_id, scan.snapshot_hash, scan.drives_json, scan.item_count, scan.total_bytes,
      scan.snapshot_json, scan.created_at, scan.expires_at,
    );
  }

  getRecycleScan(scanId: string): RecycleScanRow | undefined {
    return this.db.prepare("SELECT * FROM recycle_scans WHERE scan_id=?").get(scanId) as unknown as RecycleScanRow | undefined;
  }

  removeRecycleScan(scanId: string): void {
    this.db.prepare("DELETE FROM recycle_scans WHERE scan_id=?").run(scanId);
  }

  maintenanceValue(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM maintenance WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }

  setMaintenanceValue(key: string, value: string): void {
    this.db.prepare("INSERT INTO maintenance(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  executionMaintenance(nowMs = Date.now()): ExecutionMaintenanceLease | undefined {
    const current = this.maintenanceValue("execution_maintenance");
    if (!current) return undefined;
    try {
      const decoded = JSON.parse(current) as Partial<ExecutionMaintenanceLease>;
      if (typeof decoded.owner !== "string" || typeof decoded.reason !== "string"
        || typeof decoded.created_at !== "string" || typeof decoded.expires_at !== "string"
        || typeof decoded.expires_at_ms !== "number" || decoded.expires_at_ms <= nowMs) return undefined;
      return decoded as ExecutionMaintenanceLease;
    } catch { return undefined; }
  }

  beginExecutionMaintenance(owner: string, reason: string, leaseMs: number, nowMs = Date.now()): ExecutionMaintenanceAdmission {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.executionMaintenance(nowMs);
      if (existing && existing.owner !== owner) {
        this.db.exec("COMMIT");
        return { acquired: false, reason: "locked", lease: existing };
      }
      const activeJobs = this.countNonTerminalJobs();
      if (activeJobs > 0) {
        this.db.exec("COMMIT");
        return { acquired: false, reason: "active_jobs", active_jobs: activeJobs };
      }
      const lease: ExecutionMaintenanceLease = {
        owner,
        reason,
        created_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + leaseMs).toISOString(),
        expires_at_ms: nowMs + leaseMs,
      };
      this.setMaintenanceValue("execution_maintenance", JSON.stringify(lease));
      this.db.exec("COMMIT");
      return { acquired: true, lease };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  endExecutionMaintenance(owner: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lease = this.executionMaintenance();
      if (!lease || lease.owner !== owner) {
        this.db.exec("COMMIT");
        return false;
      }
      this.db.prepare("DELETE FROM maintenance WHERE key='execution_maintenance'").run();
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tryAcquireMaintenanceLease(key: string, owner: string, nowMs: number, leaseMs: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.maintenanceValue(key);
      if (current) {
        try {
          const decoded = JSON.parse(current) as { owner?: unknown; expires_at_ms?: unknown };
          if (typeof decoded.expires_at_ms === "number" && decoded.expires_at_ms > nowMs && decoded.owner !== owner) {
            this.db.exec("COMMIT");
            return false;
          }
        } catch { /* Invalid legacy maintenance state is safely replaced. */ }
      }
      this.setMaintenanceValue(key, JSON.stringify({ owner, expires_at_ms: nowMs + leaseMs }));
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseMaintenanceLease(key: string, owner: string): void {
    const current = this.maintenanceValue(key);
    if (!current) return;
    try {
      const decoded = JSON.parse(current) as { owner?: unknown };
      if (decoded.owner === owner) this.db.prepare("DELETE FROM maintenance WHERE key=?").run(key);
    } catch { this.db.prepare("DELETE FROM maintenance WHERE key=?").run(key); }
  }

  expiredRequests(cutoff: string): Array<{ request_id: string }> {
    return this.db.prepare("SELECT request_id FROM requests WHERE created_at < ? ORDER BY created_at").all(cutoff) as Array<{ request_id: string }>;
  }

  deleteRequest(requestId: string): void {
    this.db.prepare("DELETE FROM requests WHERE request_id=?").run(requestId);
  }

  expiredRequestTombstones(cutoff: string): Array<{ request_id: string }> {
    return this.db.prepare("SELECT request_id FROM request_tombstones WHERE created_at < ? ORDER BY created_at").all(cutoff) as Array<{ request_id: string }>;
  }

  deleteRequestTombstone(requestId: string): void {
    this.db.prepare("DELETE FROM request_tombstones WHERE request_id=?").run(requestId);
  }

  unprunedOutputs(cutoff?: string): OutputRow[] {
    const sql = cutoff
      ? "SELECT * FROM outputs WHERE pruned_at IS NULL AND created_at < ? ORDER BY created_at"
      : "SELECT * FROM outputs WHERE pruned_at IS NULL ORDER BY created_at";
    return (cutoff ? this.db.prepare(sql).all(cutoff) : this.db.prepare(sql).all()) as unknown as OutputRow[];
  }

  markOutputPruned(outputRef: string, at: string, reason: string): void {
    this.db.prepare("UPDATE outputs SET pruned_at=?, prune_reason=? WHERE output_ref=? AND pruned_at IS NULL").run(at, reason, outputRef);
  }

  expiredOutputMetadata(cutoff: string): OutputRow[] {
    return this.db.prepare("SELECT * FROM outputs WHERE created_at < ? ORDER BY created_at").all(cutoff) as unknown as OutputRow[];
  }

  deleteOutput(outputRef: string): void {
    this.db.prepare("DELETE FROM outputs WHERE output_ref=?").run(outputRef);
  }

  unprunedTerminalJobLogs(cutoff?: string): JobRow[] {
    const terminal = "('exited','failed_to_start','cancelled','timed_out','lost')";
    const sql = cutoff
      ? `SELECT * FROM jobs WHERE logs_pruned_at IS NULL AND executor_status IN ${terminal} AND COALESCE(finished_at,created_at) < ? ORDER BY COALESCE(finished_at,created_at)`
      : `SELECT * FROM jobs WHERE logs_pruned_at IS NULL AND executor_status IN ${terminal} ORDER BY COALESCE(finished_at,created_at)`;
    return (cutoff ? this.db.prepare(sql).all(cutoff) : this.db.prepare(sql).all()) as unknown as JobRow[];
  }

  markJobLogsPruned(jobId: string, at: string, reason: string): void {
    this.db.prepare("UPDATE jobs SET logs_pruned_at=?, logs_prune_reason=? WHERE job_id=? AND logs_pruned_at IS NULL").run(at, reason, jobId);
  }

  expiredJobMetadata(cutoff: string): JobRow[] {
    return this.db.prepare(`SELECT * FROM jobs
      WHERE executor_status IN ('exited','failed_to_start','cancelled','timed_out','lost')
        AND COALESCE(finished_at,created_at) < ? ORDER BY COALESCE(finished_at,created_at)`).all(cutoff) as unknown as JobRow[];
  }

  deleteJob(jobId: string): void {
    this.db.prepare("DELETE FROM jobs WHERE job_id=?").run(jobId);
  }

  expiredWorkspaces(cutoff: string): WorkspaceRow[] {
    return this.db.prepare(`SELECT * FROM workspaces
      WHERE last_used_at < ? AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.workspace_id=workspaces.workspace_id)
      ORDER BY last_used_at`).all(cutoff) as unknown as WorkspaceRow[];
  }

  deleteWorkspace(workspaceId: string): void {
    this.db.prepare("DELETE FROM workspaces WHERE workspace_id=?").run(workspaceId);
  }

  expiredRecycleScans(cutoff: string): RecycleScanRow[] {
    return this.db.prepare("SELECT * FROM recycle_scans WHERE expires_at < ? ORDER BY expires_at").all(cutoff) as unknown as RecycleScanRow[];
  }

  counts(): Record<string, number> {
    const tables = ["requests", "request_tombstones", "workspaces", "outputs", "jobs", "transfers", "recycle_scans", "storage_reservations"] as const;
    return Object.fromEntries(tables.map((table) => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return [table, row.count];
    }));
  }
}
