import { access, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storageConfigSchema } from "../../protocol/src/index.js";
import { ensureStorageCapacity, pruneStorage, storageStatus } from "./storage.js";
import { WorkerState, type JobRow } from "./state.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function job(root: string, id: string, status: JobRow["executor_status"], createdAt: string): JobRow {
  const directory = join(root, "jobs", id);
  return {
    job_id: id,
    node_id: "windows-main",
    workspace_id: "ws_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000099",
    executor_status: status,
    spec_hash: "a".repeat(64),
    idempotency_key: id,
    label: "storage-test",
    program: "node.exe",
    cwd: root,
    args_summary_json: "[]",
    stdin_mode: "closed",
    stdin_pipe: null,
    output_encoding: "auto",
    stdout_encoding: null,
    stderr_encoding: null,
    terminal_cols: null,
    terminal_rows: null,
    terminal_snapshot_path: null,
    pid: status === "running" ? process.pid : null,
    pid_started_at: status === "running" ? createdAt : null,
    runner_pid: null,
    runner_started_at: null,
    runner_heartbeat_at: null,
    storage_reservation_id: null,
    exit_code: status === "exited" ? 0 : null,
    stdout_path: join(directory, "stdout.log"),
    stderr_path: join(directory, "stderr.log"),
    stdout_bytes: 2048,
    stderr_bytes: 0,
    stdout_stored_bytes: 2048,
    stderr_stored_bytes: 0,
    stdout_storage_truncated: 0,
    stderr_storage_truncated: 0,
    timeout_ms: 60_000,
    cancel_requested: 0,
    created_at: createdAt,
    started_at: createdAt,
    finished_at: status === "running" ? null : createdAt,
    error_json: null,
    logs_pruned_at: null,
    logs_prune_reason: null,
  };
}

describe("worker storage lifecycle", () => {
  it("expires cached responses and terminal logs while protecting active Jobs and tombstones", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-storage-"));
    roots.push(root);
    await Promise.all([mkdir(join(root, "outputs")), mkdir(join(root, "jobs")), mkdir(join(root, "audit"))]);
    const state = new WorkerState(join(root, "state.sqlite3"));
    const now = Date.now();
    const old = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString();
    try {
      state.putRequest("req-old", "a".repeat(64), "{}", "mira_bridge_exec");
      state.db.prepare("UPDATE requests SET created_at=? WHERE request_id='req-old'").run(old);
      state.db.prepare("UPDATE request_tombstones SET created_at=? WHERE request_id='req-old'").run(old);
      const outputDirectory = join(root, "outputs", "output-old");
      await mkdir(outputDirectory);
      await writeFile(join(outputDirectory, "stdout.log"), "old output");
      await writeFile(join(outputDirectory, "stderr.log"), "");
      state.putOutput({
        output_ref: "output_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000001", node_id: "windows-main",
        stdout_path: join(outputDirectory, "stdout.log"), stderr_path: join(outputDirectory, "stderr.log"),
        stdout_bytes: 10, stderr_bytes: 0, stdout_stored_bytes: 10, stderr_stored_bytes: 0,
        stdout_storage_truncated: 0, stderr_storage_truncated: 0, created_at: old, pruned_at: null, prune_reason: null,
      });
      const terminal = job(root, "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000001", "exited", old);
      const active = job(root, "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000002", "running", old);
      for (const row of [terminal, active]) {
        await mkdir(join(root, "jobs", row.job_id));
        await writeFile(row.stdout_path, "x".repeat(2048));
        await writeFile(row.stderr_path, "");
        state.insertJob(row);
      }
      const config = storageConfigSchema.parse({ min_free_bytes: 0 });
      const result = await pruneStorage(state, config, { dryRun: false, reason: "test", root, nowMs: now });
      expect(result.actions.map((action) => action.kind)).toEqual(expect.arrayContaining(["request", "output", "job_logs"]));
      expect(state.getRequest("req-old")).toBeUndefined();
      expect(state.getRequestTombstone("req-old")).toBeDefined();
      expect(state.getOutput("output_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000001")?.pruned_at).not.toBeNull();
      expect(state.getJob(terminal.job_id)?.logs_pruned_at).not.toBeNull();
      await expect(access(active.stdout_path)).resolves.toBeUndefined();
      expect((await storageStatus(state, config, root)).last_gc_reason).toBe("test");
    } finally { state.close(); }
  });

  it("prunes oldest eligible data for quota and refuses new output when only active data exceeds it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-quota-"));
    roots.push(root);
    await Promise.all([mkdir(join(root, "outputs")), mkdir(join(root, "jobs")), mkdir(join(root, "audit"))]);
    const state = new WorkerState(join(root, "state.sqlite3"));
    const active = job(root, "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000003", "running", new Date().toISOString());
    try {
      await mkdir(join(root, "jobs", active.job_id));
      await writeFile(active.stdout_path, "");
      await truncate(active.stdout_path, 70 * 1024 * 1024);
      await writeFile(active.stderr_path, "");
      active.stdout_bytes = 70 * 1024 * 1024;
      active.stdout_stored_bytes = active.stdout_bytes;
      state.insertJob(active);
      const config = storageConfigSchema.parse({ max_bytes: 64 * 1024 * 1024, min_free_bytes: 0 });
      await expect(ensureStorageCapacity(state, config, "start_job", { root })).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED" });
      await expect(access(active.stdout_path)).resolves.toBeUndefined();
    } finally { state.close(); }
  });

  it("rejects a declared operation before it can exceed the configured quota", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-reservation-"));
    roots.push(root);
    await Promise.all([mkdir(join(root, "outputs")), mkdir(join(root, "jobs")), mkdir(join(root, "audit"))]);
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      const config = storageConfigSchema.parse({ max_bytes: 64 * 1024 * 1024, min_free_bytes: 0 });
      await expect(ensureStorageCapacity(state, config, "transfer_begin_push", { root, requiredBytes: 64 * 1024 * 1024 }))
        .rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", details: { required_bytes: 64 * 1024 * 1024 } });
    } finally { state.close(); }
  });

  it("serializes capacity reservations across independent Worker connections", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-capacity-race-"));
    roots.push(root);
    await Promise.all([mkdir(join(root, "outputs")), mkdir(join(root, "jobs")), mkdir(join(root, "audit"))]);
    const database = join(root, "state.sqlite3");
    const first = new WorkerState(database);
    const second = new WorkerState(database);
    const config = storageConfigSchema.parse({ max_bytes: 64 * 1024 * 1024, min_free_bytes: 0 });
    try {
      await ensureStorageCapacity(first, config, "first-output", {
        root,
        requiredBytes: 40 * 1024 * 1024,
        reservationId: "reservation-first",
      });
      await expect(ensureStorageCapacity(second, config, "second-output", {
        root,
        requiredBytes: 40 * 1024 * 1024,
        reservationId: "reservation-second",
      })).rejects.toMatchObject({ code: "STORAGE_QUOTA_EXCEEDED", details: { reservation_rejection: "quota" } });
      expect((await storageStatus(second, config, root)).reservations).toBe(1);
      first.releaseStorageReservation("reservation-first");
      await expect(ensureStorageCapacity(second, config, "second-output", {
        root,
        requiredBytes: 40 * 1024 * 1024,
        reservationId: "reservation-second",
      })).resolves.toBeDefined();
    } finally {
      second.releaseStorageReservation("reservation-second");
      second.close();
      first.close();
    }
  });

  it("uses an exclusive persisted GC lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-lease-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      expect(state.tryAcquireMaintenanceLease("gc_lease", "owner-a", 1000, 5000)).toBe(true);
      expect(state.tryAcquireMaintenanceLease("gc_lease", "owner-b", 2000, 5000)).toBe(false);
      state.releaseMaintenanceLease("gc_lease", "owner-a");
      expect(state.tryAcquireMaintenanceLease("gc_lease", "owner-b", 2000, 5000)).toBe(true);
    } finally { state.close(); }
  });
});
