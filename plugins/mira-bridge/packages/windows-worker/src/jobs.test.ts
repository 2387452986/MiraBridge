import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cancelJob, listJobs, readJobLogs, reconcileJobs, waitJob } from "./jobs.js";
import { WorkerState, type JobRow } from "./state.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function terminalJob(status: JobRow["executor_status"]): JobRow {
  return {
    job_id: "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000001",
    node_id: "windows-main",
    workspace_id: "ws_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000002",
    executor_status: status,
    spec_hash: "a".repeat(64),
    idempotency_key: "cancel-retry",
    label: "test-job",
    program: "node.exe",
    cwd: "D:\\MiraBridgeRoot",
    args_summary_json: "[\"--safe\"]",
    stdin_mode: "closed",
    stdin_pipe: null,
    output_encoding: "auto",
    stdout_encoding: null,
    stderr_encoding: null,
    terminal_cols: null,
    terminal_rows: null,
    terminal_snapshot_path: null,
    pid: null,
    pid_started_at: null,
    runner_pid: null,
    runner_started_at: null,
    runner_heartbeat_at: null,
    storage_reservation_id: null,
    exit_code: status === "exited" ? 0 : 1,
    stdout_path: "stdout",
    stderr_path: "stderr",
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_stored_bytes: 0,
    stderr_stored_bytes: 0,
    stdout_storage_truncated: 0,
    stderr_storage_truncated: 0,
    timeout_ms: 1000,
    cancel_requested: status === "cancelled" ? 1 : 0,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    error_json: null,
    logs_pruned_at: null,
    logs_prune_reason: null,
  };
}

describe("Job cancellation", () => {
  it("returns an already-cancelled Job for an at-least-once transport retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-jobs-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      const job = terminalJob("cancelled");
      state.insertJob(job);
      await expect(cancelJob(state, job.job_id)).resolves.toMatchObject({
        job_id: job.job_id,
        executor_status: "cancelled",
      });
    } finally { state.close(); }
  });

  it("still rejects cancellation of a naturally finished Job", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-jobs-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      const job = terminalJob("exited");
      state.insertJob(job);
      await expect(cancelJob(state, job.job_id)).rejects.toMatchObject({ code: "JOB_ALREADY_FINISHED" });
    } finally { state.close(); }
  });

  it("finds Jobs after context loss with status filters and stable cursors", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-list-jobs-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      state.insertJob(terminalJob("exited"));
      state.insertJob({ ...terminalJob("cancelled"), job_id: "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000002", idempotency_key: "cancelled-2", created_at: new Date(Date.now() + 1000).toISOString() });
      state.insertJob({ ...terminalJob("exited"), node_id: "windows-other", job_id: "job_d2luZG93cy1vdGhlcg_00000000-0000-4000-8000-000000000003", idempotency_key: "other-3", created_at: new Date(Date.now() + 2000).toISOString() });
      const first = listJobs(state, undefined, undefined, 1, "windows-main") as { jobs: Array<Record<string, unknown>>; cursor: string; total_jobs: number };
      expect(first).toMatchObject({ total_jobs: 2 });
      expect(first.jobs).toHaveLength(1);
      expect(first.jobs[0]).toMatchObject({ label: "test-job", program: "node.exe", cwd: "D:\\MiraBridgeRoot", args_summary: ["--safe"] });
      state.insertJob({ ...terminalJob("exited"), job_id: "job_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000004", idempotency_key: "new-4", created_at: new Date(Date.now() + 3000).toISOString() });
      const second = listJobs(state, undefined, first.cursor, 1, "windows-main") as { jobs: Array<Record<string, unknown>>; cursor: string };
      expect(second.jobs).toHaveLength(1);
      expect(second.jobs[0]?.job_id).not.toBe(first.jobs[0]?.job_id);
      expect(listJobs(state, ["cancelled"], undefined, 10, "windows-main")).toMatchObject({ total_jobs: 1, jobs: [expect.objectContaining({ executor_status: "cancelled" })] });
      expect(() => listJobs(state, ["cancelled"], first.cursor, 10, "windows-main")).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    } finally { state.close(); }
  });

  it("marks an abandoned queued Job as failed_to_start instead of leaving it forever", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-abandoned-job-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      const job = { ...terminalJob("queued"), exit_code: null, started_at: null, finished_at: null, created_at: new Date(Date.now() - 60_000).toISOString() };
      state.insertJob(job);
      await reconcileJobs(state);
      expect(state.getJob(job.job_id)).toMatchObject({ executor_status: "failed_to_start", error_json: expect.stringContaining("runner") });
    } finally { state.close(); }
  });

  it("does not mark a Job lost while its runner heartbeat is current", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-live-runner-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      const now = new Date().toISOString();
      const job = { ...terminalJob("running"), exit_code: null, finished_at: null, runner_pid: process.pid, runner_started_at: now, runner_heartbeat_at: now };
      state.insertJob(job);
      await reconcileJobs(state);
      expect(state.getJob(job.job_id)?.executor_status).toBe("running");
    } finally { state.close(); }
  });

  it("reconciles a disappeared runner while waiting instead of reporting running forever", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-wait-reconcile-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      const old = new Date(Date.now() - 60_000).toISOString();
      const job = { ...terminalJob("running"), exit_code: null, finished_at: null, runner_pid: 2_147_483_647, runner_started_at: old, runner_heartbeat_at: old };
      state.insertJob(job);
      await expect(waitJob(state, job.job_id, 1_000)).resolves.toMatchObject({ executor_status: "lost", error: { code: "PROCESS_START_FAILED" } });
    } finally { state.close(); }
  });

  it("confirms process-tree termination before reporting a running Job cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-cancel-live-"));
    roots.push(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      const job = { ...terminalJob("running"), exit_code: null, finished_at: null, pid: child.pid ?? null, pid_started_at: new Date().toISOString() };
      state.insertJob(job);
      await expect(cancelJob(state, job.job_id)).resolves.toMatchObject({ executor_status: "cancelled" });
      expect(() => process.kill(child.pid ?? 0, 0)).toThrow();
    } finally {
      if (child.pid) try { process.kill(child.pid, "SIGKILL"); } catch { /* already terminated */ }
      state.close();
    }
  });

  it("reports current running log bytes and final terminal counters", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-running-logs-"));
    roots.push(root);
    const stdoutPath = join(root, "stdout.log");
    await writeFile(stdoutPath, "READY\n", "utf8");
    const state = new WorkerState(join(root, "state.sqlite3"));
    try {
      const job = {
        ...terminalJob("running"),
        exit_code: null,
        finished_at: null,
        stdout_path: stdoutPath,
        stderr_path: join(root, "stderr.log"),
      };
      state.insertJob(job);
      await expect(readJobLogs(state, job.job_id, "stdout", 0, 1024)).resolves.toMatchObject({
        text: "READY\n",
        total_bytes: 6,
        stored_bytes: 6,
        counts_final: false,
      });
      state.setJobStatus(job.job_id, "exited", {
        exitCode: 0,
        finishedAt: new Date().toISOString(),
        stdoutBytes: 100,
        stdoutStoredBytes: 6,
        stdoutStorageTruncated: 1,
      });
      await expect(readJobLogs(state, job.job_id, "stdout", 0, 1024)).resolves.toMatchObject({
        total_bytes: 100,
        stored_bytes: 6,
        storage_truncated: true,
        counts_final: true,
      });
    } finally { state.close(); }
  });
});
