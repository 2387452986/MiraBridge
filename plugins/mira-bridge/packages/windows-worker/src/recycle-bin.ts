import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BridgeError,
  MAX_READ_BYTES,
  RECYCLE_SCAN_TTL_MS,
  canonicalJson,
  createScopedId,
  sha256,
} from "../../protocol/src/index.js";
import { encodePowerShell, findPowerShell } from "./process-exec.js";
import { WorkerState, type RecycleScanRow } from "./state.js";

const execFileAsync = promisify(execFile);

export interface RecycleItem {
  drive: string;
  physical_name: string;
  original_path: string | null;
  size_bytes: number;
  deleted_at: string | null;
  modified_at: string;
  type: "file" | "directory";
}

export interface RecycleSnapshot {
  drives: string[];
  items: RecycleItem[];
  item_count: number;
  total_bytes: number;
  snapshot_hash: string;
}

function scanScript(drives: string[]): string {
  const driveLiteral = drives.length > 0 ? drives.map((drive) => `'${drive}'`).join(",") : "";
  return `
$requested = @(${driveLiteral})
if ($requested.Count -eq 0) {
  $requested = @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -match '^[A-Za-z]:\\\\$' } | ForEach-Object { $_.Name.ToUpperInvariant() })
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rows = New-Object System.Collections.Generic.List[object]
foreach ($drive in ($requested | Sort-Object -Unique)) {
  $root = ($drive + ':\\$Recycle.Bin\\' + $sid)
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($entry in @(Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '${"$"}R*' })) {
    [int64]$size = 0
    if ($entry.PSIsContainer) {
      $size = [int64]((Get-ChildItem -LiteralPath $entry.FullName -Force -File -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum)
    } else { $size = [int64]$entry.Length }
    $original = $null
    $deleted = $null
    $info = Join-Path $root ('${"$"}I' + $entry.Name.Substring(2))
    if (Test-Path -LiteralPath $info) {
      try {
        [byte[]]$bytes = [IO.File]::ReadAllBytes($info)
        if ($bytes.Length -ge 24) {
          [int64]$fileTime = [BitConverter]::ToInt64($bytes, 16)
          if ($fileTime -gt 0) { $deleted = [DateTime]::FromFileTimeUtc($fileTime).ToString('o') }
          [int64]$version = [BitConverter]::ToInt64($bytes, 0)
          if ($version -ge 2 -and $bytes.Length -ge 28) {
            [int]$characters = [BitConverter]::ToInt32($bytes, 24)
            [int]$available = [Math]::Max(0, $bytes.Length - 28)
            [int]$count = [Math]::Min($available, [Math]::Max(0, $characters * 2))
            $original = [Text.Encoding]::Unicode.GetString($bytes, 28, $count).TrimEnd([char]0)
          } else {
            $original = [Text.Encoding]::Unicode.GetString($bytes, 24, $bytes.Length - 24).TrimEnd([char]0)
          }
        }
      } catch { $original = $null; $deleted = $null }
    }
    $rows.Add([pscustomobject]@{
      drive = $drive
      physical_name = $entry.Name
      original_path = $original
      size_bytes = $size
      deleted_at = $deleted
      modified_at = $entry.LastWriteTimeUtc.ToString('o')
      type = $(if ($entry.PSIsContainer) { 'directory' } else { 'file' })
    })
  }
}
@($rows | Sort-Object drive,physical_name) | ConvertTo-Json -Compress -Depth 4
`;
}

async function fixedPowerShell(script: string, timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      await findPowerShell(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch (error) {
    throw new BridgeError("INTERNAL_ERROR", "The fixed Windows Recycle Bin operation failed.", {
      cause: error,
      details: { stderr: String((error as { stderr?: unknown }).stderr ?? "").slice(-4096) },
    });
  }
}

function normalizedDrives(drives?: string[]): string[] {
  const values = (drives ?? []).map((drive) => drive.toUpperCase());
  if (values.some((drive) => !/^[A-Z]$/u.test(drive))) throw new BridgeError("INVALID_ARGUMENT", "Recycle Bin drives must be uppercase drive letters without a colon.");
  return [...new Set(values)].sort();
}

export async function snapshotRecycleBin(drives?: string[]): Promise<RecycleSnapshot> {
  const requested = normalizedDrives(drives);
  const raw = await fixedPowerShell(scanScript(requested), 5 * 60 * 1000);
  let decoded: unknown = [];
  if (raw) {
    try { decoded = JSON.parse(raw); }
    catch (error) { throw new BridgeError("INTERNAL_ERROR", "Recycle Bin scan returned invalid JSON.", { cause: error }); }
  }
  const rows = (Array.isArray(decoded) ? decoded : decoded ? [decoded] : []).map((value): RecycleItem => {
    const row = value as Record<string, unknown>;
    return {
      drive: String(row.drive ?? "").toUpperCase(),
      physical_name: String(row.physical_name ?? ""),
      original_path: typeof row.original_path === "string" && row.original_path.length > 0 ? row.original_path : null,
      size_bytes: Number(row.size_bytes ?? 0),
      deleted_at: typeof row.deleted_at === "string" ? row.deleted_at : null,
      modified_at: String(row.modified_at ?? ""),
      type: row.type === "directory" ? "directory" : "file",
    };
  }).sort((left, right) => `${left.drive}:${left.physical_name}`.localeCompare(`${right.drive}:${right.physical_name}`));
  if (rows.some((row) => !/^[A-Z]$/u.test(row.drive) || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0)) {
    throw new BridgeError("INTERNAL_ERROR", "Recycle Bin scan returned invalid item metadata.");
  }
  const actualDrives = requested.length > 0 ? requested : [...new Set(rows.map((row) => row.drive))].sort();
  const snapshot = { drives: actualDrives, items: rows };
  return {
    ...snapshot,
    item_count: rows.length,
    total_bytes: rows.reduce((sum, row) => sum + row.size_bytes, 0),
    snapshot_hash: sha256(canonicalJson(snapshot)),
  };
}

function publicSnapshot(snapshot: RecycleSnapshot, maxItems: number): Record<string, unknown> {
  const items: RecycleItem[] = [];
  let bytes = 2;
  for (const item of snapshot.items.slice(0, maxItems)) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (items.length > 0 && bytes + itemBytes > MAX_READ_BYTES) break;
    items.push(item);
    bytes += itemBytes;
  }
  return {
    drives: snapshot.drives,
    item_count: snapshot.item_count,
    total_bytes: snapshot.total_bytes,
    items,
    sample_truncated: snapshot.items.length > items.length,
    snapshot_hash: snapshot.snapshot_hash,
  };
}

export async function scanRecycleBin(
  state: WorkerState,
  nodeId: string,
  drives: string[] | undefined,
  maxItems: number,
): Promise<Record<string, unknown>> {
  const snapshot = await snapshotRecycleBin(drives);
  const created = new Date();
  const row: RecycleScanRow = {
    scan_id: createScopedId("scan", nodeId),
    node_id: nodeId,
    snapshot_hash: snapshot.snapshot_hash,
    drives_json: JSON.stringify(snapshot.drives),
    item_count: snapshot.item_count,
    total_bytes: snapshot.total_bytes,
    snapshot_json: JSON.stringify(snapshot.items),
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + RECYCLE_SCAN_TTL_MS).toISOString(),
  };
  state.putRecycleScan(row);
  return { scan_id: row.scan_id, created_at: row.created_at, expires_at: row.expires_at, ...publicSnapshot(snapshot, maxItems) };
}

export async function clearRecycleBinDrives(drives: string[]): Promise<Array<{ drive: string; ok: boolean; error?: string }>> {
  const literal = drives.map((drive) => `'${drive}'`).join(",");
  const script = `
$results = @()
foreach ($drive in @(${literal})) {
  try {
    Clear-RecycleBin -DriveLetter $drive -Force -Confirm:$false -ErrorAction Stop
    $results += [pscustomobject]@{ drive=$drive; ok=$true; error=$null }
  } catch {
    $results += [pscustomobject]@{ drive=$drive; ok=$false; error=$_.Exception.Message }
  }
}
@($results) | ConvertTo-Json -Compress -Depth 3
`;
  const raw = await fixedPowerShell(script, 10 * 60 * 1000);
  const decoded = raw ? JSON.parse(raw) as unknown : [];
  return (Array.isArray(decoded) ? decoded : [decoded]).map((value) => {
    const row = value as Record<string, unknown>;
    return { drive: String(row.drive), ok: row.ok === true, ...(typeof row.error === "string" && row.error ? { error: row.error } : {}) };
  });
}

export interface RecycleBinOperations {
  snapshot: (drives?: string[]) => Promise<RecycleSnapshot>;
  clear: (drives: string[]) => Promise<Array<{ drive: string; ok: boolean; error?: string }>>;
}

export async function emptyRecycleBin(
  state: WorkerState,
  nodeId: string,
  scanId: string,
  operations: RecycleBinOperations = { snapshot: snapshotRecycleBin, clear: clearRecycleBinDrives },
): Promise<Record<string, unknown>> {
  const scan = state.getRecycleScan(scanId);
  if (!scan || scan.node_id !== nodeId) throw new BridgeError("CONFIRMATION_EXPIRED", "Recycle Bin scan receipt was not found.");
  if (Date.parse(scan.expires_at) <= Date.now()) {
    state.removeRecycleScan(scanId);
    throw new BridgeError("CONFIRMATION_EXPIRED", "Recycle Bin scan receipt expired; scan again before clearing.", { details: { expired_at: scan.expires_at } });
  }
  const drives = JSON.parse(scan.drives_json) as string[];
  const current = await operations.snapshot(drives);
  if (current.snapshot_hash !== scan.snapshot_hash || current.item_count !== scan.item_count || current.total_bytes !== scan.total_bytes) {
    state.removeRecycleScan(scanId);
    throw new BridgeError("RESOURCE_CHANGED", "Recycle Bin contents changed after the scan; nothing was deleted.", {
      details: {
        scanned: { item_count: scan.item_count, total_bytes: scan.total_bytes, snapshot_hash: scan.snapshot_hash },
        current: { item_count: current.item_count, total_bytes: current.total_bytes, snapshot_hash: current.snapshot_hash },
      },
    });
  }
  state.removeRecycleScan(scanId);
  const scannedItems = JSON.parse(scan.snapshot_json) as RecycleItem[];
  const drivesToClear = [...new Set(scannedItems.map((item) => item.drive).filter((drive) => drives.includes(drive)))].sort();
  const perDrive = drivesToClear.length > 0 ? await operations.clear(drivesToClear) : [];
  const after = await operations.snapshot(drives);
  if (after.item_count !== 0 || perDrive.some((result) => !result.ok)) {
    throw new BridgeError("RECYCLE_BIN_NOT_EMPTY", "Recycle Bin clearing was incomplete; the post-operation scan still found items or a drive failed.", {
      details: { per_drive: perDrive, remaining_item_count: after.item_count, remaining_bytes: after.total_bytes, snapshot_hash: after.snapshot_hash },
    });
  }
  return {
    scan_id: scanId,
    cleared_item_count: scan.item_count,
    cleared_bytes: scan.total_bytes,
    drives,
    cleared_drives: drivesToClear,
    per_drive: perDrive,
    verification: publicSnapshot(after, 0),
  };
}
