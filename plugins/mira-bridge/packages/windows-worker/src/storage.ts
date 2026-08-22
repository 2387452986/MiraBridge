import { randomUUID } from "node:crypto";
import { lstat, opendir, rm, stat, statfs } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { BridgeError, type StorageConfig } from "../../protocol/src/index.js";
import { workerDataRoot } from "./config.js";
import { WorkerState, type JobRow, type OutputRow } from "./state.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const GC_LEASE_MS = 5 * 60 * 1000;

export interface StorageStatus {
  data_root: string;
  used_bytes: number;
  quota_bytes: number;
  quota_target_bytes: number;
  free_bytes: number | null;
  minimum_free_bytes: number;
  quota_available: boolean;
  last_gc_at: string | null;
  last_gc_reason: string | null;
  retention: {
    request_days: number;
    output_days: number;
    job_log_days: number;
    metadata_days: number;
    audit_days: number;
    transfer_hours: number;
  };
  max_stream_bytes: number;
  reserved_root_bytes: number;
  reservations: number;
  records: Record<string, number>;
}

export interface PruneAction {
  kind: "request" | "request_tombstone" | "output" | "output_metadata" | "job_logs" | "job_metadata" | "workspace" | "recycle_scan" | "storage_reservation" | "audit";
  id: string;
  reason: "retention" | "quota";
  bytes: number;
}

export interface PruneResult {
  dry_run: boolean;
  skipped_lease: boolean;
  started_at: string;
  finished_at: string;
  reason: string;
  actions: PruneAction[];
  reclaimed_bytes: number;
  before: StorageStatus;
  after: StorageStatus;
}

export function storageMaintenanceDue(state: WorkerState, intervalMinutes: number, nowMs = Date.now()): boolean {
  const lastRaw = state.maintenanceValue("last_gc");
  if (!lastRaw) return true;
  try {
    const last = JSON.parse(lastRaw) as { at?: unknown };
    const lastMs = typeof last.at === "string" ? Date.parse(last.at) : Number.NaN;
    return !Number.isFinite(lastMs) || nowMs - lastMs >= intervalMinutes * 60 * 1000;
  } catch {
    return true;
  }
}

function cutoff(days: number, nowMs: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

export async function pathSize(path: string): Promise<number> {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (metadata.isSymbolicLink()) return 0;
  if (!metadata.isDirectory()) return metadata.size;
  let total = 0;
  const queue = [path];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (!current) continue;
    const directory = await opendir(current);
    for await (const entry of directory) {
      const child = resolve(current, entry.name);
      const childMetadata = await lstat(child);
      if (entry.isSymbolicLink() || childMetadata.isSymbolicLink()) continue;
      if (childMetadata.isDirectory()) queue.push(child);
      else total += childMetadata.size;
    }
  }
  return total;
}

async function freeBytes(path: string): Promise<number | null> {
  let current = resolve(path);
  while (true) {
    try {
      const value = await statfs(current, { bigint: true });
      return Number(value.bavail * value.bsize);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

function volumeKey(path: string): string {
  return (parse(resolve(path)).root || resolve(path)).toLocaleLowerCase();
}

export async function assertFreeSpace(path: string, requiredBytes: number, minimumFreeBytes: number): Promise<void> {
  const available = await freeBytes(path);
  if (available === null || available - requiredBytes < minimumFreeBytes) {
    throw new BridgeError("STORAGE_QUOTA_EXCEEDED", "The destination volume cannot preserve MiraBridge's minimum free-space reserve.", {
      details: { path, required_bytes: requiredBytes, free_bytes: available, minimum_free_bytes: minimumFreeBytes },
    });
  }
}

export async function storageStatus(state: WorkerState, config: StorageConfig, root = workerDataRoot()): Promise<StorageStatus> {
  const [usedBytes, availableBytes] = await Promise.all([pathSize(root), freeBytes(root)]);
  const reservations = state.storageReservations();
  const reservedRootBytes = reservations.reduce((sum, reservation) => sum + reservation.root_bytes, 0);
  const rootVolume = volumeKey(root);
  const reservedOnRootVolume = reservations.reduce((sum, reservation) => {
    const root = reservation.root_volume === rootVolume ? reservation.root_bytes : 0;
    const target = reservation.target_volume === rootVolume ? reservation.target_bytes : 0;
    return sum + root + target;
  }, 0);
  const lastRaw = state.maintenanceValue("last_gc");
  let last: { at?: string; reason?: string } = {};
  if (lastRaw) {
    try { last = JSON.parse(lastRaw) as { at?: string; reason?: string }; }
    catch { last = {}; }
  }
  return {
    data_root: root,
    used_bytes: usedBytes,
    quota_bytes: config.max_bytes,
    quota_target_bytes: Math.floor(config.max_bytes * 0.9),
    free_bytes: availableBytes,
    minimum_free_bytes: config.min_free_bytes,
    quota_available: usedBytes + reservedRootBytes < config.max_bytes && availableBytes !== null && availableBytes - reservedOnRootVolume >= config.min_free_bytes,
    last_gc_at: last.at ?? null,
    last_gc_reason: last.reason ?? null,
    retention: {
      request_days: config.request_retention_days,
      output_days: config.output_retention_days,
      job_log_days: config.job_log_retention_days,
      metadata_days: config.metadata_retention_days,
      audit_days: config.audit_retention_days,
      transfer_hours: 24,
    },
    max_stream_bytes: config.max_stream_bytes,
    reserved_root_bytes: reservedRootBytes,
    reservations: reservations.length,
    records: state.counts(),
  };
}

async function removePath(path: string, dryRun: boolean): Promise<number> {
  const bytes = await pathSize(path);
  if (!dryRun) await rm(path, { recursive: true, force: true });
  return bytes;
}

function outputDirectory(output: OutputRow): string {
  return dirname(output.stdout_path);
}

function jobDirectory(job: JobRow): string {
  return dirname(job.stdout_path);
}

async function auditFiles(root: string): Promise<Array<{ path: string; name: string; modified: number; bytes: number }>> {
  const candidates = [join(root, "audit.jsonl"), join(root, "audit")];
  const files: Array<{ path: string; name: string; modified: number; bytes: number }> = [];
  for (const candidate of candidates) {
    let metadata;
    try { metadata = await stat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isFile()) files.push({ path: candidate, name: candidate, modified: metadata.mtimeMs, bytes: metadata.size });
    else if (metadata.isDirectory()) {
      const directory = await opendir(candidate);
      for await (const entry of directory) {
        if (!entry.isFile()) continue;
        const path = join(candidate, entry.name);
        const file = await stat(path);
        files.push({ path, name: entry.name, modified: file.mtimeMs, bytes: file.size });
      }
    }
  }
  return files.sort((left, right) => left.modified - right.modified);
}

export async function pruneStorage(
  state: WorkerState,
  config: StorageConfig,
  options: { dryRun: boolean; reason: string; root?: string; nowMs?: number } = { dryRun: false, reason: "manual" },
): Promise<PruneResult> {
  const root = options.root ?? workerDataRoot();
  const nowMs = options.nowMs ?? Date.now();
  const startedAt = new Date(nowMs).toISOString();
  const owner = randomUUID();
  if (!options.dryRun && !state.tryAcquireMaintenanceLease("gc_lease", owner, nowMs, GC_LEASE_MS)) {
    const before = await storageStatus(state, config, root);
    return { dry_run: false, skipped_lease: true, started_at: startedAt, finished_at: new Date().toISOString(), reason: options.reason, actions: [], reclaimed_bytes: 0, before, after: before };
  }
  try {
    const before = await storageStatus(state, config, root);
    const actions: PruneAction[] = [];
    const record = (action: PruneAction): void => { actions.push(action); };
    for (const row of state.expiredRequests(cutoff(config.request_retention_days, nowMs))) {
      record({ kind: "request", id: row.request_id, reason: "retention", bytes: 0 });
      if (!options.dryRun) state.deleteRequest(row.request_id);
    }
    for (const output of state.unprunedOutputs(cutoff(config.output_retention_days, nowMs))) {
      const bytes = await removePath(outputDirectory(output), options.dryRun);
      record({ kind: "output", id: output.output_ref, reason: "retention", bytes });
      if (!options.dryRun) state.markOutputPruned(output.output_ref, new Date().toISOString(), "retention");
    }
    for (const job of state.unprunedTerminalJobLogs(cutoff(config.job_log_retention_days, nowMs))) {
      const bytes = await removePath(jobDirectory(job), options.dryRun);
      record({ kind: "job_logs", id: job.job_id, reason: "retention", bytes });
      if (!options.dryRun) state.markJobLogsPruned(job.job_id, new Date().toISOString(), "retention");
    }
    for (const output of state.expiredOutputMetadata(cutoff(config.metadata_retention_days, nowMs))) {
      record({ kind: "output_metadata", id: output.output_ref, reason: "retention", bytes: 0 });
      if (!options.dryRun) state.deleteOutput(output.output_ref);
    }
    for (const job of state.expiredJobMetadata(cutoff(config.metadata_retention_days, nowMs))) {
      const bytes = await removePath(jobDirectory(job), options.dryRun);
      record({ kind: "job_metadata", id: job.job_id, reason: "retention", bytes });
      if (!options.dryRun) state.deleteJob(job.job_id);
    }
    for (const workspace of state.expiredWorkspaces(cutoff(config.metadata_retention_days, nowMs))) {
      record({ kind: "workspace", id: workspace.workspace_id, reason: "retention", bytes: 0 });
      if (!options.dryRun) state.deleteWorkspace(workspace.workspace_id);
    }
    for (const row of state.expiredRequestTombstones(cutoff(config.metadata_retention_days, nowMs))) {
      record({ kind: "request_tombstone", id: row.request_id, reason: "retention", bytes: 0 });
      if (!options.dryRun) state.deleteRequestTombstone(row.request_id);
    }
    for (const scan of state.expiredRecycleScans(new Date(nowMs).toISOString())) {
      record({ kind: "recycle_scan", id: scan.scan_id, reason: "retention", bytes: 0 });
      if (!options.dryRun) state.removeRecycleScan(scan.scan_id);
    }
    for (const reservation of state.storageReservations()) {
      if (Date.parse(reservation.expires_at) > nowMs) continue;
      record({ kind: "storage_reservation", id: reservation.reservation_id, reason: "retention", bytes: 0 });
      if (!options.dryRun) state.releaseStorageReservation(reservation.reservation_id);
    }
    const auditCutoff = nowMs - config.audit_retention_days * DAY_MS;
    for (const file of await auditFiles(root)) {
      if (file.modified >= auditCutoff) continue;
      const bytes = await removePath(file.path, options.dryRun);
      record({ kind: "audit", id: file.name, reason: "retention", bytes });
    }

    let estimatedUsed = Math.max(0, before.used_bytes - actions.reduce((sum, action) => sum + action.bytes, 0));
    const target = Math.floor(config.max_bytes * 0.9);
    if (estimatedUsed > config.max_bytes) {
      const alreadyPrunedOutputs = new Set(actions.filter((action) => action.kind === "output").map((action) => action.id));
      const alreadyPrunedJobs = new Set(actions.filter((action) => action.kind === "job_logs").map((action) => action.id));
      const alreadyPrunedAudits = new Set(actions.filter((action) => action.kind === "audit").map((action) => action.id));
      for (const output of state.unprunedOutputs().filter((row) => !alreadyPrunedOutputs.has(row.output_ref))) {
        if (estimatedUsed <= target) break;
        const bytes = await removePath(outputDirectory(output), options.dryRun);
        record({ kind: "output", id: output.output_ref, reason: "quota", bytes });
        estimatedUsed = Math.max(0, estimatedUsed - bytes);
        if (!options.dryRun) state.markOutputPruned(output.output_ref, new Date().toISOString(), "quota");
      }
      for (const job of state.unprunedTerminalJobLogs().filter((row) => !alreadyPrunedJobs.has(row.job_id))) {
        if (estimatedUsed <= target) break;
        const bytes = await removePath(jobDirectory(job), options.dryRun);
        record({ kind: "job_logs", id: job.job_id, reason: "quota", bytes });
        estimatedUsed = Math.max(0, estimatedUsed - bytes);
        if (!options.dryRun) state.markJobLogsPruned(job.job_id, new Date().toISOString(), "quota");
      }
      for (const file of await auditFiles(root)) {
        if (estimatedUsed <= target) break;
        if (alreadyPrunedAudits.has(file.name)) continue;
        if (file.name === `audit-${new Date(nowMs).toISOString().slice(0, 10)}.jsonl`) continue;
        const bytes = await removePath(file.path, options.dryRun);
        record({ kind: "audit", id: file.name, reason: "quota", bytes });
        estimatedUsed = Math.max(0, estimatedUsed - bytes);
      }
    }
    if (!options.dryRun) state.setMaintenanceValue("last_gc", JSON.stringify({ at: new Date().toISOString(), reason: options.reason, actions: actions.length }));
    const after = options.dryRun || actions.length === 0 ? before : await storageStatus(state, config, root);
    return {
      dry_run: options.dryRun,
      skipped_lease: false,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      reason: options.reason,
      actions,
      reclaimed_bytes: actions.reduce((sum, action) => sum + action.bytes, 0),
      before,
      after,
    };
  } finally {
    if (!options.dryRun) state.releaseMaintenanceLease("gc_lease", owner);
  }
}

export async function ensureStorageCapacity(
  state: WorkerState,
  config: StorageConfig,
  operation: string,
  options: {
    root?: string;
    requiredBytes?: number;
    targetPath?: string;
    targetRequiredBytes?: number;
    reservationId?: string;
    reservationTtlMs?: number;
  } = {},
): Promise<StorageStatus> {
  const root = options.root ?? workerDataRoot();
  const requiredBytes = options.requiredBytes ?? 0;
  const pruned = await pruneStorage(state, config, { dryRun: false, reason: `before:${operation}`, root });
  const current = pruned.after;
  let targetFreeBytes: number | null = null;
  const targetRequiredBytes = options.targetRequiredBytes ?? 0;
  if (options.targetPath) targetFreeBytes = await freeBytes(options.targetPath);
  const rootVolume = volumeKey(root);
  const targetVolume = options.targetPath ? volumeKey(options.targetPath) : null;
  const reservationId = options.reservationId ?? `capacity-check-${randomUUID()}`;
  const now = new Date();
  const admission = state.tryReserveStorage({
    reservation_id: reservationId,
    operation,
    root_bytes: requiredBytes,
    root_volume: rootVolume,
    target_bytes: targetRequiredBytes,
    target_volume: targetVolume,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (options.reservationTtlMs ?? 60 * 60 * 1000)).toISOString(),
  }, {
    current_used_bytes: current.used_bytes,
    quota_bytes: current.quota_bytes,
    minimum_free_bytes: current.minimum_free_bytes,
    free_bytes_by_volume: {
      [rootVolume]: current.free_bytes,
      ...(targetVolume ? { [targetVolume]: targetFreeBytes } : {}),
    },
  });
  if (!options.reservationId) state.releaseStorageReservation(reservationId);
  if (!admission.accepted) {
    throw new BridgeError("STORAGE_QUOTA_EXCEEDED", "Worker storage quota or minimum free-space reserve prevents a new disk-producing operation.", {
      retryable: false,
      details: {
        operation,
        required_bytes: requiredBytes,
        used_bytes: current.used_bytes,
        quota_bytes: current.quota_bytes,
        free_bytes: current.free_bytes,
        minimum_free_bytes: current.minimum_free_bytes,
        target_path: options.targetPath ?? null,
        target_required_bytes: targetRequiredBytes,
        target_free_bytes: targetFreeBytes,
        reserved_root_bytes: admission.reserved_root_bytes,
        reserved_bytes_by_volume: admission.reserved_bytes_by_volume,
        reservation_rejection: admission.reason,
      },
    });
  }
  return current;
}
