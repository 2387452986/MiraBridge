import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageConfig } from "../../protocol/src/index.js";
import { WorkerState, type TransferRow } from "./state.js";
import { decodeWindowsTarOutput, TransferStore } from "./transfers.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))));

function transferRow(overrides: Partial<TransferRow>): TransferRow {
  const now = new Date().toISOString();
  return {
    transfer_id: "transfer_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000099",
    node_id: "windows-main",
    direction: "push",
    kind: "directory",
    source_path: null,
    destination_path: null,
    temporary_path: null,
    size: 0,
    sha256: "0".repeat(64),
    transferred: 0,
    overwrite: 1,
    manifest_json: null,
    manifest_sha256: null,
    phase: "receiving",
    staging_path: null,
    backup_path: null,
    owner_id: null,
    owner_pid: null,
    owner_started_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("Windows tar output", () => {
  it("decodes CP936 filenames before manifest comparison", () => {
    const bytes = Buffer.from("2e2f0d0a2e2fcafdbedd2f0d0a2e2fcbb5c3f72e6d640d0a2e2fcafdbedd2fbfcdbba7c7e5b5a52e6373760d0a", "hex");
    expect(decodeWindowsTarOutput(bytes, 936)).toBe("./\r\n./数据/\r\n./说明.md\r\n./数据/客户清单.csv\r\n");
  });

  it("rejects an unsupported code page instead of corrupting paths", () => {
    expect(() => decodeWindowsTarOutput(Buffer.from("./file.txt\n"), 437)).toThrowError(/unsupported system code page/u);
  });
});

describe("transfer crash recovery", () => {
  it("restores a previous destination after a crash between backup and install", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-transfer-recovery-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    const destination = join(root, "destination");
    const backup = join(root, ".destination.backup");
    const staging = join(root, ".destination.stage");
    const archive = join(root, "payload.tar.part");
    await mkdir(backup);
    await mkdir(staging);
    await writeFile(join(backup, "value.txt"), "old", "utf8");
    await writeFile(join(staging, "value.txt"), "new", "utf8");
    await writeFile(archive, "archive", "utf8");
    state.putTransfer(transferRow({ destination_path: destination, temporary_path: archive, staging_path: staging, backup_path: backup, phase: "backed_up" }));
    const transfers = new TransferStore(state, {} as never, {} as StorageConfig, root);
    try {
      await transfers.cleanupStale();
      await expect(readFile(join(destination, "value.txt"), "utf8")).resolves.toBe("old");
      expect(state.getTransfer("transfer_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000099")).toBeUndefined();
    } finally { state.close(); }
  });

  it("keeps the installed destination and removes its stale backup after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-transfer-installed-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    const destination = join(root, "destination");
    const backup = join(root, ".destination.backup");
    await mkdir(destination);
    await mkdir(backup);
    await writeFile(join(destination, "value.txt"), "new", "utf8");
    await writeFile(join(backup, "value.txt"), "old", "utf8");
    state.putTransfer(transferRow({ destination_path: destination, backup_path: backup, phase: "installed" }));
    const transfers = new TransferStore(state, {} as never, {} as StorageConfig, root);
    try {
      await transfers.cleanupStale();
      await expect(readFile(join(destination, "value.txt"), "utf8")).resolves.toBe("new");
      await expect(readFile(join(backup, "value.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally { state.close(); }
  });

  it("does not recover a committing transfer owned by a live Worker process", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-transfer-owner-"));
    roots.push(root);
    const state = new WorkerState(join(root, "state.sqlite3"));
    const destination = join(root, "destination");
    const backup = join(root, ".destination.backup");
    await mkdir(backup);
    await writeFile(join(backup, "value.txt"), "old", "utf8");
    state.putTransfer(transferRow({
      destination_path: destination,
      backup_path: backup,
      phase: "backed_up",
      owner_id: "live-owner",
      owner_pid: process.pid,
      owner_started_at: new Date().toISOString(),
    }));
    const transfers = new TransferStore(state, {} as never, {} as StorageConfig, root);
    try {
      await transfers.cleanupStale();
      expect(state.getTransfer("transfer_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000099")).toBeDefined();
      await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(transfers.finish("transfer_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000099")).rejects.toMatchObject({ code: "RESOURCE_CHANGED", retryable: true });
      state.clearTransferOwner("transfer_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000099", "live-owner");
      await transfers.cleanupStale();
      await expect(readFile(join(destination, "value.txt"), "utf8")).resolves.toBe("old");
    } finally { state.close(); }
  }, 50_000);

  it("removes only unreferenced transfer temporaries after 24 hours", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-transfer-orphan-"));
    roots.push(root);
    const transferDirectory = join(root, "transfers");
    await mkdir(transferDirectory);
    const orphan = join(transferDirectory, "orphan.tar");
    await writeFile(orphan, "stale", "utf8");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(orphan, old, old);
    const state = new WorkerState(join(root, "state.sqlite3"));
    const transfers = new TransferStore(state, {} as never, {} as StorageConfig, root);
    try {
      await transfers.cleanupStale();
      await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { state.close(); }
  });
});
