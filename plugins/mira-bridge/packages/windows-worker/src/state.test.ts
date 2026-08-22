import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ExecutionMaintenanceError, WorkerState, type JobRow } from "./state.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    job_id: "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000001",
    node_id: "windows-main",
    workspace_id: "ws_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000002",
    executor_status: "queued",
    spec_hash: "a".repeat(64),
    idempotency_key: "same-job",
    label: "test-job",
    program: "node.exe",
    cwd: "D:\\MiraBridgeRoot",
    args_summary_json: "[]",
    stdin_mode: "closed",
    stdin_pipe: null,
    output_encoding: "auto",
    stdout_encoding: null,
    stderr_encoding: null,
    terminal_cols: null,
    terminal_rows: null,
    terminal_snapshot_path: null,
    pid: null, pid_started_at: null, runner_pid: null, runner_started_at: null, runner_heartbeat_at: null, storage_reservation_id: null,
    exit_code: null, stdout_path: "stdout", stderr_path: "stderr", stdout_bytes: 0, stderr_bytes: 0,
    stdout_stored_bytes: 0, stderr_stored_bytes: 0, stdout_storage_truncated: 0, stderr_storage_truncated: 0,
    timeout_ms: 1000, cancel_requested: 0, created_at: new Date().toISOString(), started_at: null, finished_at: null, error_json: null,
    logs_pruned_at: null, logs_prune_reason: null,
    ...overrides,
  };
}

describe("job persistence", () => {
  it("waits for a concurrent SQLite writer instead of failing startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-busy-"));
    roots.push(root);
    const path = join(root, "state.sqlite3");
    new WorkerState(path).close();
    const blocker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.path);
      db.exec("BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
      }, 150);
    `, { eval: true, workerData: { path } });
    const locked = once(blocker, "message");
    const exited = once(blocker, "exit");
    await locked;

    const state = new WorkerState(path);
    try {
      state.putWorkspace({
        workspace_id: "ws_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000123",
        node_id: "windows-main",
        canonical_path: "D:\\MiraBridgeRoot",
        mode: "read-write",
        created_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
      });
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM workspaces").get()).toEqual({ count: 1 });
    } finally { state.close(); }
    await exited;
  });

  it("persists idempotency and atomically claims concurrency slots", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-state-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      const row = job();
      state.insertJob(row);
      expect(state.findIdempotentJob("windows-main", "same-job")?.job_id).toBe(row.job_id);
      const duplicate = job({ job_id: "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000099" });
      expect(state.insertJobIdempotent(duplicate)?.job_id).toBe(row.job_id);
      expect(state.listJobs()).toHaveLength(1);
      expect(state.tryClaimJob(row.job_id, 1)).toBe("claimed");
      expect(state.getJob(row.job_id)?.executor_status).toBe("starting");
      const second = job({ job_id: "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000003", idempotency_key: "second" });
      state.insertJob(second);
      expect(state.tryClaimJob(second.job_id, 1)).toBe("wait");
    } finally { state.close(); }
  });

  it("atomically blocks new Jobs during app maintenance while preserving idempotent retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-maintenance-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      const existing = job({ executor_status: "exited", exit_code: 0, finished_at: new Date().toISOString() });
      state.insertJob(existing);
      const now = Date.now();
      const admission = state.beginExecutionMaintenance("windows-app-update", "update", 120_000, now);
      expect(admission).toMatchObject({ acquired: true, lease: { owner: "windows-app-update", reason: "update" } });
      const duplicate = job({ job_id: "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000099" });
      expect(state.insertJobIdempotent(duplicate)?.job_id).toBe(existing.job_id);
      const blocked = job({ job_id: "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000088", idempotency_key: "new-during-update" });
      expect(() => state.insertJobIdempotent(blocked)).toThrow(ExecutionMaintenanceError);
      expect(state.beginExecutionMaintenance("windows-app-uninstall", "uninstall", 120_000, now + 500)).toMatchObject({ acquired: false, reason: "locked" });
      expect(state.endExecutionMaintenance("different-owner")).toBe(false);
      expect(state.endExecutionMaintenance("windows-app-update")).toBe(true);
      expect(state.insertJobIdempotent(blocked)).toBeUndefined();

      const active = job({ job_id: "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000077", idempotency_key: "active" });
      state.insertJob(active);
      expect(state.beginExecutionMaintenance("windows-app-update", "update", 120_000, now + 1_000)).toEqual({ acquired: false, reason: "active_jobs", active_jobs: 2 });
    } finally { state.close(); }
  });

  it("migrates a 0.1 transfer table in place and records schema user_version 5", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-migration-"));
    roots.push(root);
    const path = join(root, "state.sqlite3");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE outputs (
      output_ref TEXT PRIMARY KEY, node_id TEXT NOT NULL, stdout_path TEXT NOT NULL, stderr_path TEXT NOT NULL,
      stdout_bytes INTEGER NOT NULL, stderr_bytes INTEGER NOT NULL, stdout_stored_bytes INTEGER NOT NULL DEFAULT 0,
      stderr_stored_bytes INTEGER NOT NULL DEFAULT 0, stdout_storage_truncated INTEGER NOT NULL DEFAULT 0,
      stderr_storage_truncated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, pruned_at TEXT
    );
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, workspace_id TEXT NOT NULL, executor_status TEXT NOT NULL,
      spec_hash TEXT NOT NULL, idempotency_key TEXT, pid INTEGER, exit_code INTEGER, stdout_path TEXT NOT NULL,
      stderr_path TEXT NOT NULL, stdout_bytes INTEGER NOT NULL DEFAULT 0, stderr_bytes INTEGER NOT NULL DEFAULT 0,
      stdout_stored_bytes INTEGER NOT NULL DEFAULT 0, stderr_stored_bytes INTEGER NOT NULL DEFAULT 0,
      stdout_storage_truncated INTEGER NOT NULL DEFAULT 0, stderr_storage_truncated INTEGER NOT NULL DEFAULT 0,
      timeout_ms INTEGER NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT, error_json TEXT, logs_pruned_at TEXT, logs_prune_reason TEXT,
      UNIQUE(node_id, idempotency_key)
    );
    CREATE TABLE transfers (
      transfer_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, direction TEXT NOT NULL, source_path TEXT,
      destination_path TEXT, temporary_path TEXT, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      transferred INTEGER NOT NULL DEFAULT 0, overwrite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );`);
    legacy.close();
    const state = new WorkerState(path);
    try {
      const columns = state.db.prepare("PRAGMA table_info(transfers)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["kind", "manifest_json", "manifest_sha256", "phase", "staging_path", "backup_path", "updated_at"]));
      const jobColumns = state.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
      expect(jobColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["stdin_mode", "stdin_pipe", "label", "runner_pid", "runner_heartbeat_at", "storage_reservation_id"]));
      const transferColumns = state.db.prepare("PRAGMA table_info(transfers)").all() as Array<{ name: string }>;
      expect(transferColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["phase", "staging_path", "backup_path", "owner_id", "owner_pid", "owner_started_at"]));
      const outputColumns = state.db.prepare("PRAGMA table_info(outputs)").all() as Array<{ name: string }>;
      expect(outputColumns.map((column) => column.name)).toContain("prune_reason");
      expect(state.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_reservations'").get()).toBeDefined();
      expect((state.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
    } finally { state.close(); }
  });
});
