import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyRecycleBin, type RecycleSnapshot } from "./recycle-bin.js";
import { WorkerState } from "./state.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function snapshot(hash = "a".repeat(64), count = 1): RecycleSnapshot {
  return {
    drives: ["C", "D"],
    items: count ? [{ drive: "C", physical_name: "$R1", original_path: "C:\\temp.txt", size_bytes: 7, deleted_at: null, modified_at: "2026-08-20T00:00:00.000Z", type: "file" }] : [],
    item_count: count,
    total_bytes: count ? 7 : 0,
    snapshot_hash: hash,
  };
}

async function stateWithReceipt(expiresAt: string): Promise<{ state: WorkerState; scanId: string }> {
  const root = await mkdtemp(join(tmpdir(), "mirabridge-recycle-"));
  roots.push(root);
  const state = new WorkerState(join(root, "state.sqlite3"));
  const scanId = "scan_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000001";
  state.putRecycleScan({
    scan_id: scanId, node_id: "windows-main", snapshot_hash: "a".repeat(64), drives_json: '["C","D"]',
    item_count: 1, total_bytes: 7, snapshot_json: JSON.stringify(snapshot().items), created_at: new Date().toISOString(), expires_at: expiresAt,
  });
  return { state, scanId };
}

describe("Recycle Bin confirmation receipts", () => {
  it("rejects expired receipts without invoking deletion", async () => {
    const { state, scanId } = await stateWithReceipt(new Date(Date.now() - 1000).toISOString());
    const clear = vi.fn();
    try {
      await expect(emptyRecycleBin(state, "windows-main", scanId, { snapshot: vi.fn(), clear })).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
      expect(clear).not.toHaveBeenCalled();
    } finally { state.close(); }
  });

  it("stops when the full snapshot changes after scanning", async () => {
    const { state, scanId } = await stateWithReceipt(new Date(Date.now() + 60_000).toISOString());
    const clear = vi.fn();
    try {
      await expect(emptyRecycleBin(state, "windows-main", scanId, { snapshot: vi.fn(async () => snapshot("b".repeat(64))), clear })).rejects.toMatchObject({ code: "RESOURCE_CHANGED" });
      expect(clear).not.toHaveBeenCalled();
      expect(state.getRecycleScan(scanId)).toBeUndefined();
    } finally { state.close(); }
  });

  it("clears once and verifies the selected drives are empty", async () => {
    const { state, scanId } = await stateWithReceipt(new Date(Date.now() + 60_000).toISOString());
    const scans = [snapshot(), snapshot("c".repeat(64), 0)];
    const clear = vi.fn(async () => [{ drive: "C", ok: true }, { drive: "D", ok: true }]);
    try {
      await expect(emptyRecycleBin(state, "windows-main", scanId, { snapshot: vi.fn(async () => scans.shift()!), clear })).resolves.toMatchObject({ cleared_item_count: 1, verification: { item_count: 0 } });
      expect(clear).toHaveBeenCalledWith(["C"]);
      expect(state.getRecycleScan(scanId)).toBeUndefined();
    } finally { state.close(); }
  });
});
