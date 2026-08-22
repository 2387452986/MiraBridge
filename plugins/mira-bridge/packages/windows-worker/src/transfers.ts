import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, open, opendir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  BridgeError,
  MAX_DIRECTORY_TRANSFER_ENTRIES,
  MAX_INLINE_MANIFEST_BYTES,
  TRANSFER_CHUNK_BYTES,
  canonicalJson,
  createScopedId,
  sha256,
  type StorageConfig,
} from "../../protocol/src/index.js";
import { workerDataRoot } from "./config.js";
import type { PathPolicy } from "./path-policy.js";
import { WorkerState, type TransferRow } from "./state.js";
import { assertFreeSpace, ensureStorageCapacity } from "./storage.js";
import { processMatchesStart } from "./process-exec.js";
import { windowsCodePageLabel } from "./windows-codepage.js";

const execFileAsync = promisify(execFile);
let tarOutputCodePage: Promise<number> | undefined;

export interface TransferManifestEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  sha256: string | null;
}

interface ManifestSummary {
  entries: number;
  files: number;
  total_file_bytes: number;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function normalizeManifestPath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  const parts = path.split("/");
  const invalidWindowsName = parts.some((part) => /[<>:"|?*]/u.test(part) || /[ .]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part));
  if (!path || path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("\0") || invalidWindowsName || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new BridgeError("TRANSFER_FAILED", "Directory manifest or archive contains an unsafe path.", { details: { path: value } });
  }
  return path;
}

function comparePath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function validateManifest(value: TransferManifestEntry[], expectedHash?: string): TransferManifestEntry[] {
  if (value.length > MAX_DIRECTORY_TRANSFER_ENTRIES) {
    throw new BridgeError("TRANSFER_FAILED", `Directory transfer exceeds the ${MAX_DIRECTORY_TRANSFER_ENTRIES.toLocaleString("en-US")}-entry safety limit.`);
  }
  const normalized = value.map((entry) => ({
    path: normalizeManifestPath(entry.path), type: entry.type, size: entry.size, sha256: entry.sha256,
  })).sort(comparePath);
  const folded = new Set<string>();
  for (const entry of normalized) {
    const key = entry.path.toLowerCase();
    if (folded.has(key)) throw new BridgeError("TRANSFER_FAILED", "Directory manifest contains duplicate or case-colliding paths.", { details: { path: entry.path } });
    folded.add(key);
    if (entry.type === "directory" && (entry.size !== 0 || entry.sha256 !== null)) throw new BridgeError("TRANSFER_FAILED", "Directory manifest metadata is invalid.");
    if (entry.type === "file" && (!entry.sha256 || !/^[0-9a-f]{64}$/u.test(entry.sha256))) throw new BridgeError("TRANSFER_FAILED", "File manifest metadata is invalid.");
  }
  const digest = sha256(canonicalJson(normalized));
  if (expectedHash && digest !== expectedHash) throw new BridgeError("TRANSFER_FAILED", "Directory manifest SHA-256 does not match its declared digest.", { details: { expected_sha256: expectedHash, actual_sha256: digest } });
  return normalized;
}

function summarizeManifest(manifest: TransferManifestEntry[]): ManifestSummary {
  return {
    entries: manifest.length,
    files: manifest.filter((entry) => entry.type === "file").length,
    total_file_bytes: manifest.reduce((sum, entry) => sum + entry.size, 0),
  };
}

function validateManifestSummary(value: ManifestSummary): ManifestSummary {
  if (!Number.isSafeInteger(value.entries) || value.entries < 0 || value.entries > MAX_DIRECTORY_TRANSFER_ENTRIES) {
    throw new BridgeError("TRANSFER_FAILED", "Directory transfer manifest entry count is invalid.");
  }
  if (!Number.isSafeInteger(value.files) || value.files < 0 || value.files > value.entries) {
    throw new BridgeError("TRANSFER_FAILED", "Directory transfer manifest file count is invalid.");
  }
  if (!Number.isSafeInteger(value.total_file_bytes) || value.total_file_bytes < 0) {
    throw new BridgeError("TRANSFER_FAILED", "Directory transfer manifest byte count is invalid.");
  }
  return value;
}

function assertManifestMatches(actual: TransferManifestEntry[], expectedHash: string, expectedSummary: ManifestSummary): ManifestSummary {
  const actualHash = sha256(canonicalJson(actual));
  if (actualHash !== expectedHash) {
    throw new BridgeError("TRANSFER_FAILED", "Extracted directory failed manifest SHA-256 verification.", {
      details: { expected_sha256: expectedHash, actual_sha256: actualHash },
    });
  }
  const actualSummary = summarizeManifest(actual);
  if (
    actualSummary.entries !== expectedSummary.entries
    || actualSummary.files !== expectedSummary.files
    || actualSummary.total_file_bytes !== expectedSummary.total_file_bytes
  ) {
    throw new BridgeError("TRANSFER_FAILED", "Extracted directory failed manifest summary verification.", {
      details: { expected: expectedSummary, actual: actualSummary },
    });
  }
  return actualSummary;
}

export async function buildDirectoryManifest(root: string): Promise<TransferManifestEntry[]> {
  const entries: TransferManifestEntry[] = [];
  const queue = [root];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const directoryPath = queue[queueIndex];
    queueIndex += 1;
    if (!directoryPath) break;
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      const absolute = resolve(directoryPath, entry.name);
      const metadata = await lstat(absolute);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) throw new BridgeError("TRANSFER_FAILED", "Directory transfer refuses symbolic links and junctions.", { details: { path: absolute } });
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        entries.push({ path, type: "directory", size: 0, sha256: null });
        queue.push(absolute);
      } else if (entry.isFile()) entries.push({ path, type: "file", size: metadata.size, sha256: await hashFile(absolute) });
      else throw new BridgeError("TRANSFER_FAILED", "Directory transfer only supports regular files and directories.", { details: { path: absolute } });
      if (entries.length > MAX_DIRECTORY_TRANSFER_ENTRIES) {
        throw new BridgeError("TRANSFER_FAILED", `Directory transfer exceeds the ${MAX_DIRECTORY_TRANSFER_ENTRIES.toLocaleString("en-US")}-entry safety limit.`);
      }
    }
  }
  return validateManifest(entries);
}

async function runTar(args: string[], timeoutMs = 30 * 60 * 1000): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tar.exe", args, { encoding: "buffer", windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    tarOutputCodePage ??= execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage"],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    ).then(({ stdout: codePage }) => Number(codePage.trim()));
    return decodeWindowsTarOutput(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), await tarOutputCodePage);
  } catch (error) {
    throw new BridgeError("TRANSFER_FAILED", "Windows tar operation failed.", { cause: error, details: { args, stderr: String((error as { stderr?: unknown }).stderr ?? "").slice(-4096) } });
  }
}

export function decodeWindowsTarOutput(bytes: Uint8Array, codePage: number): string {
  const label = windowsCodePageLabel(codePage);
  if (!label) throw new BridgeError("TRANSFER_FAILED", "Windows tar output uses an unsupported system code page.", { details: { code_page: codePage } });
  try { return new TextDecoder(label, { fatal: true }).decode(bytes); }
  catch (error) {
    throw new BridgeError("TRANSFER_FAILED", "Windows tar output could not be decoded with the system code page.", { cause: error, details: { code_page: codePage } });
  }
}

export function decodeTarListingName(value: string): string {
  const chunks: Buffer[] = [];
  let literal = "";
  const flushLiteral = (): void => {
    if (literal) chunks.push(Buffer.from(literal, "utf8"));
    literal = "";
  };
  for (let index = 0; index < value.length;) {
    if (value[index] === "\\") {
      const octal = value.slice(index + 1, index + 4);
      if (!/^[0-7]{3}$/u.test(octal)) {
        throw new BridgeError("TRANSFER_FAILED", "Tar listed a filename with an unsupported escape sequence.", { details: { path: value } });
      }
      flushLiteral();
      chunks.push(Buffer.from([Number.parseInt(octal, 8)]));
      index += 4;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    literal += String.fromCodePoint(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  flushLiteral();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new BridgeError("TRANSFER_FAILED", "Tar listed a filename with invalid UTF-8 escapes.", { cause: error, details: { path: value } });
  }
}

async function preflightArchive(archive: string): Promise<void> {
  const [namesText, verboseText] = await Promise.all([runTar(["-tf", archive]), runTar(["-tvf", archive])]);
  const names = namesText.split(/\r?\n/u).filter(Boolean).flatMap((name) => {
    const normalized = decodeTarListingName(name).replace(/^\.\//u, "").replace(/\/$/u, "");
    return normalized ? [normalizeManifestPath(normalized)] : [];
  });
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new BridgeError("TRANSFER_FAILED", "Archive contains duplicate or case-colliding paths.");
  if (names.length > MAX_DIRECTORY_TRANSFER_ENTRIES) {
    throw new BridgeError("TRANSFER_FAILED", `Archive exceeds the ${MAX_DIRECTORY_TRANSFER_ENTRIES.toLocaleString("en-US")}-entry safety limit.`);
  }
  for (const line of verboseText.split(/\r?\n/u).filter(Boolean)) {
    const type = line.trimStart()[0];
    if (type !== "-" && type !== "d") throw new BridgeError("TRANSFER_FAILED", "Archive contains a link or unsupported special entry and was rejected before extraction.", { details: { entry_type: type ?? null } });
  }
}

interface InstallResult {
  backup_cleanup_pending: boolean;
  backup_path?: string;
}

async function installPath(
  staging: string,
  destination: string,
  overwrite: boolean,
  recursiveBackup: boolean,
  rollbackPhase: TransferRow["phase"],
  onPhase: (phase: TransferRow["phase"], stagingPath: string | null, backupPath: string | null) => void,
  beforeInstall?: () => Promise<void>,
): Promise<InstallResult> {
  const destinationExists = await exists(destination);
  if (destinationExists && !overwrite) throw new BridgeError("TRANSFER_FAILED", "Destination appeared during transfer and overwrite is false.");
  const backup = resolve(dirname(destination), `.${basename(destination)}.${randomUUID()}.mirabridge-backup`);
  let backedUp = false;
  try {
    await beforeInstall?.();
    onPhase("committing", staging, destinationExists ? backup : null);
    if (destinationExists) {
      await rename(destination, backup);
      backedUp = true;
      onPhase("backed_up", staging, backup);
    }
    await beforeInstall?.();
    if (!overwrite && await exists(destination)) {
      throw new BridgeError("TRANSFER_FAILED", "Destination appeared during atomic installation and overwrite is false.", { details: { destination_path: destination } });
    }
    await rename(staging, destination);
    onPhase("installed", null, backedUp ? backup : null);
  } catch (error) {
    if (backedUp && !await exists(destination)) {
      try {
        await rename(backup, destination);
        onPhase(rollbackPhase, staging, null);
      } catch (rollbackError) {
        throw new BridgeError("TRANSFER_FAILED", "Transfer install failed and the previous destination could not be restored automatically.", {
          cause: error,
          details: { destination_path: destination, backup_path: backup, rollback_error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) },
        });
      }
    }
    throw error;
  }
  if (!backedUp) return { backup_cleanup_pending: false };
  try {
    await rm(backup, { recursive: recursiveBackup, force: true });
    onPhase("installed", null, null);
    return { backup_cleanup_pending: false };
  } catch {
    return { backup_cleanup_pending: true, backup_path: backup };
  }
}

export class TransferStore {
  constructor(
    private readonly state: WorkerState,
    private readonly paths: PathPolicy,
    private readonly storage: StorageConfig,
    private readonly dataRoot = workerDataRoot(),
  ) {}

  async beginPush(nodeId: string, destinationPath: string, size: number, digest: string, overwrite: boolean): Promise<Record<string, unknown>> {
    const destination = await this.paths.resolveAbsolute(destinationPath, false);
    await this.paths.resolveAbsolute(dirname(destination), true);
    if (!overwrite && await exists(destination)) throw new BridgeError("TRANSFER_FAILED", "Destination exists and overwrite is false.", { details: { destination_path: destination } });
    const transferId = createScopedId("transfer", nodeId);
    await ensureStorageCapacity(this.state, this.storage, "transfer_begin_push", {
      targetPath: dirname(destination), targetRequiredBytes: size, reservationId: transferId, reservationTtlMs: 25 * 60 * 60 * 1000,
    });
    const temporary = resolve(dirname(destination), `.${basename(destination)}.${transferId}.part`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      await handle.close();
      const createdAt = new Date().toISOString();
      this.state.putTransfer({
        transfer_id: transferId, node_id: nodeId, direction: "push", kind: "file", source_path: null,
        destination_path: destination, temporary_path: temporary, size, sha256: digest, transferred: 0,
        overwrite: overwrite ? 1 : 0, manifest_json: null, manifest_sha256: null,
        phase: "receiving", staging_path: null, backup_path: null, owner_id: null, owner_pid: null, owner_started_at: null, created_at: createdAt, updated_at: createdAt,
      });
    } catch (error) {
      await rm(temporary, { force: true });
      this.state.releaseStorageReservation(transferId);
      throw error;
    }
    return { transfer_id: transferId, kind: "file" };
  }

  async beginDirectoryPush(
    nodeId: string,
    destinationPath: string,
    size: number,
    digest: string,
    manifestValue: TransferManifestEntry[] | undefined,
    manifestDigest: string,
    overwrite: boolean,
    declaredSummary?: ManifestSummary,
  ): Promise<Record<string, unknown>> {
    const destination = await this.paths.resolveAbsolute(destinationPath, false);
    await this.paths.resolveAbsolute(dirname(destination), true);
    if (!overwrite && await exists(destination)) throw new BridgeError("TRANSFER_FAILED", "Destination exists and overwrite is false.", { details: { destination_path: destination } });
    const inlineManifest = manifestValue ? validateManifest(manifestValue, manifestDigest) : undefined;
    const summary = validateManifestSummary(inlineManifest ? summarizeManifest(inlineManifest) : declaredSummary ?? { entries: -1, files: -1, total_file_bytes: -1 });
    const transferId = createScopedId("transfer", nodeId);
    await ensureStorageCapacity(this.state, this.storage, "transfer_begin_directory_push", {
      requiredBytes: size,
      targetPath: dirname(destination),
      targetRequiredBytes: summary.total_file_bytes,
      reservationId: transferId,
      reservationTtlMs: 25 * 60 * 60 * 1000,
    });
    const temporary = resolve(this.dataRoot, "transfers", `${transferId}.tar.part`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      await handle.close();
      const createdAt = new Date().toISOString();
      this.state.putTransfer({
        transfer_id: transferId, node_id: nodeId, direction: "push", kind: "directory", source_path: null,
        destination_path: destination, temporary_path: temporary, size, sha256: digest, transferred: 0,
        overwrite: overwrite ? 1 : 0, manifest_json: JSON.stringify(summary), manifest_sha256: manifestDigest,
        phase: "receiving", staging_path: null, backup_path: null, owner_id: null, owner_pid: null, owner_started_at: null, created_at: createdAt, updated_at: createdAt,
      });
    } catch (error) {
      await rm(temporary, { force: true });
      this.state.releaseStorageReservation(transferId);
      throw error;
    }
    return { transfer_id: transferId, kind: "directory", manifest_sha256: manifestDigest };
  }

  async writeChunk(transferId: string, offset: number, dataBase64: string): Promise<Record<string, unknown>> {
    const transfer = this.require(transferId, "push");
    if (!transfer.temporary_path) throw new BridgeError("TRANSFER_FAILED", "Transfer temporary path is missing.");
    if (offset !== transfer.transferred) throw new BridgeError("TRANSFER_FAILED", "Transfer chunk offset does not match the committed offset.", { details: { expected_offset: transfer.transferred, actual_offset: offset } });
    const bytes = Buffer.from(dataBase64, "base64");
    if (bytes.length > TRANSFER_CHUNK_BYTES || transfer.transferred + bytes.length > transfer.size) throw new BridgeError("TRANSFER_FAILED", "Transfer chunk exceeds the declared file size.");
    await assertFreeSpace(dirname(transfer.temporary_path), bytes.length, this.storage.min_free_bytes);
    const handle = await open(transfer.temporary_path, "r+");
    try { await handle.write(bytes, 0, bytes.length, offset); }
    finally { await handle.close(); }
    const transferred = offset + bytes.length;
    this.state.updateTransferred(transferId, transferred);
    return { transfer_id: transferId, transferred };
  }

  async commitPush(transferId: string): Promise<Record<string, unknown>> {
    const transfer = this.require(transferId, "push");
    const ownerId = randomUUID();
    if (!this.state.claimTransferOwner(transferId, ownerId, process.pid, new Date(Date.now() - process.uptime() * 1000).toISOString())) {
      throw new BridgeError("RESOURCE_CHANGED", "This transfer is already being committed by another Worker process.", {
        retryable: true,
        details: { transfer_id: transferId },
      });
    }
    try {
      if (!transfer.temporary_path || !transfer.destination_path) throw new BridgeError("TRANSFER_FAILED", "Transfer paths are incomplete.");
      if (transfer.transferred !== transfer.size) throw new BridgeError("TRANSFER_FAILED", "Transfer is incomplete.", { details: { expected_size: transfer.size, transferred: transfer.transferred } });
      const actualHash = await hashFile(transfer.temporary_path);
      if (actualHash !== transfer.sha256) throw new BridgeError("TRANSFER_FAILED", "Uploaded archive or file failed SHA-256 verification.", { details: { expected_sha256: transfer.sha256, actual_sha256: actualHash } });
      const destination = await this.paths.resolveAbsolute(transfer.destination_path, false);
      const assertDestinationMapping = async (): Promise<void> => {
        const current = await this.paths.resolveAbsolute(transfer.destination_path!, false);
        if (current.toLocaleLowerCase() !== destination.toLocaleLowerCase()) {
          throw new BridgeError("RESOURCE_CHANGED", "Transfer destination mapping changed before atomic installation.", {
            details: { destination_path: transfer.destination_path },
          });
        }
      };
      if (transfer.kind === "file") {
      if (!transfer.overwrite && await exists(destination)) throw new BridgeError("TRANSFER_FAILED", "Destination appeared during transfer and overwrite is false.");
      const handle = await open(transfer.temporary_path, "r+");
      await handle.sync();
      await handle.close();
      const install = await installPath(
        transfer.temporary_path,
        destination,
        Boolean(transfer.overwrite),
        false,
        "receiving",
        (phase, stagingPath, backupPath) => this.state.setTransferRecovery(transferId, phase, stagingPath, backupPath),
        assertDestinationMapping,
      );
      if (!install.backup_cleanup_pending) {
        this.state.removeTransfer(transferId);
        this.state.releaseStorageReservation(transferId);
      }
        return { kind: "file", destination_path: destination, size: transfer.size, sha256: actualHash, ...install };
      }
      if (!transfer.manifest_json || !transfer.manifest_sha256) throw new BridgeError("TRANSFER_FAILED", "Directory transfer manifest is missing.");
      const summary = validateManifestSummary(JSON.parse(transfer.manifest_json) as ManifestSummary);
      await preflightArchive(transfer.temporary_path);
      const staging = resolve(dirname(destination), `.${basename(destination)}.${randomUUID()}.mirabridge-stage`);
      await mkdir(staging, { recursive: false });
      this.state.setTransferRecovery(transferId, "extracting", staging, null);
      try {
        await runTar(["-xf", transfer.temporary_path, "-C", staging]);
        const actualManifest = await buildDirectoryManifest(staging);
        assertManifestMatches(actualManifest, transfer.manifest_sha256, summary);
        this.state.setTransferRecovery(transferId, "validated", staging, null);
        await this.paths.resolveAbsolute(dirname(destination), true);
        const install = await installPath(
          staging,
          destination,
          Boolean(transfer.overwrite),
          true,
          "validated",
          (phase, stagingPath, backupPath) => this.state.setTransferRecovery(transferId, phase, stagingPath, backupPath),
          assertDestinationMapping,
        );
        await rm(transfer.temporary_path, { force: true });
        if (!install.backup_cleanup_pending) {
          this.state.removeTransfer(transferId);
          this.state.releaseStorageReservation(transferId);
        }
        return {
          kind: "directory", destination_path: destination, archive_size: transfer.size, archive_sha256: actualHash,
          manifest_sha256: transfer.manifest_sha256, ...summary, ...install,
        };
      } catch (error) {
        const current = this.state.getTransfer(transferId);
        if (current?.phase !== "installed" && current?.phase !== "backed_up") await rm(staging, { recursive: true, force: true });
        throw error;
      }
    } finally {
      if (this.state.getTransfer(transferId)) this.state.clearTransferOwner(transferId, ownerId);
    }
  }

  async beginPull(nodeId: string, sourcePath: string, requestedKind: "auto" | "file" | "directory"): Promise<Record<string, unknown>> {
    const source = await this.paths.resolveAbsolute(sourcePath, true);
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink()) throw new BridgeError("TRANSFER_FAILED", "Transfer source cannot be a symbolic link or junction.");
    const kind = metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : null;
    if (!kind) throw new BridgeError("INVALID_ARGUMENT", "MiraBridge pull supports regular files or directories.");
    if (requestedKind !== "auto" && requestedKind !== kind) throw new BridgeError("INVALID_ARGUMENT", `Requested ${requestedKind} transfer, but the source is a ${kind}.`);
    const transferId = createScopedId("transfer", nodeId);
    if (kind === "file") {
      const digest = await hashFile(source);
      const createdAt = new Date().toISOString();
      this.state.putTransfer({
        transfer_id: transferId, node_id: nodeId, direction: "pull", kind, source_path: source, destination_path: null,
        temporary_path: null, size: metadata.size, sha256: digest, transferred: 0, overwrite: 0,
        manifest_json: null, manifest_sha256: null,
        phase: "receiving", staging_path: null, backup_path: null, owner_id: null, owner_pid: null, owner_started_at: null, created_at: createdAt, updated_at: createdAt,
      });
      return { transfer_id: transferId, kind, size: metadata.size, sha256: digest };
    }
    const manifest = await buildDirectoryManifest(source);
    const manifestDigest = sha256(canonicalJson(manifest));
    const summary = summarizeManifest(manifest);
    const expectedArchiveBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      summary.total_file_bytes + summary.entries * 8192 + 1024 * 1024,
    );
    await ensureStorageCapacity(this.state, this.storage, "transfer_begin_pull", {
      requiredBytes: expectedArchiveBytes, reservationId: transferId, reservationTtlMs: 25 * 60 * 60 * 1000,
    });
    const archive = resolve(this.dataRoot, "transfers", `${transferId}.tar`);
    let archiveStat;
    let digest;
    try {
      await runTar(["-cf", archive, "-C", source, "."]);
      archiveStat = await stat(archive);
      digest = await hashFile(archive);
      const createdAt = new Date().toISOString();
      this.state.putTransfer({
        transfer_id: transferId, node_id: nodeId, direction: "pull", kind, source_path: source, destination_path: null,
        temporary_path: archive, size: archiveStat.size, sha256: digest, transferred: 0, overwrite: 0,
        manifest_json: JSON.stringify(summary), manifest_sha256: manifestDigest,
        phase: "receiving", staging_path: null, backup_path: null, owner_id: null, owner_pid: null, owner_started_at: null, created_at: createdAt, updated_at: createdAt,
      });
    } catch (error) {
      await rm(archive, { force: true });
      this.state.releaseStorageReservation(transferId);
      throw error;
    }
    const inlineManifest = Buffer.byteLength(canonicalJson(manifest), "utf8") <= MAX_INLINE_MANIFEST_BYTES ? manifest : undefined;
    return {
      transfer_id: transferId, kind, size: archiveStat.size, sha256: digest,
      ...(inlineManifest ? { manifest: inlineManifest } : {}),
      manifest_sha256: manifestDigest, ...summary,
    };
  }

  async readChunk(transferId: string, offset: number, maxBytes: number): Promise<Record<string, unknown>> {
    const transfer = this.require(transferId, "pull");
    const source = transfer.kind === "directory" ? transfer.temporary_path : transfer.source_path;
    if (!source) throw new BridgeError("TRANSFER_FAILED", "Transfer source path is missing.");
    if (offset > transfer.size) throw new BridgeError("TRANSFER_FAILED", "Transfer offset exceeds file size.");
    const length = Math.min(maxBytes, TRANSFER_CHUNK_BYTES, transfer.size - offset);
    const buffer = Buffer.alloc(length);
    const handle = await open(source, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return { transfer_id: transferId, offset, data_base64: buffer.subarray(0, bytesRead).toString("base64"), bytes: bytesRead, eof: offset + bytesRead >= transfer.size };
    } finally { await handle.close(); }
  }

  async finish(transferId: string): Promise<Record<string, unknown>> {
    const transfer = this.state.getTransfer(transferId);
    if (!transfer) return { transfer_id: transferId, removed: false };
    if (transfer.owner_pid && await processMatchesStart(transfer.owner_pid, transfer.owner_started_at ?? undefined)) {
      throw new BridgeError("RESOURCE_CHANGED", "Transfer cleanup was deferred because another Worker process is still committing it.", {
        retryable: true,
        details: { transfer_id: transferId },
      });
    }
    if (transfer.owner_pid) this.state.abandonTransferOwner(transfer.transfer_id, transfer.owner_pid);
    await this.recoverOrRemove(transfer);
    return { transfer_id: transferId, removed: true };
  }

  async cleanupStale(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const transfer of this.state.allTransfers()) {
      if (transfer.owner_pid && await processMatchesStart(transfer.owner_pid, transfer.owner_started_at ?? undefined)) continue;
      if (transfer.owner_pid) this.state.abandonTransferOwner(transfer.transfer_id, transfer.owner_pid);
      if (transfer.phase === "receiving" && transfer.updated_at >= cutoff) continue;
      try {
        await this.recoverOrRemove(transfer);
      } catch (error) {
        process.stderr.write(`MiraBridge transfer recovery retained ${transfer.transfer_id}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    const referenced = new Set(this.state.allTransfers().flatMap((transfer) => [transfer.temporary_path, transfer.staging_path, transfer.backup_path])
      .filter((path): path is string => typeof path === "string")
      .map((path) => resolve(path).toLocaleLowerCase()));
    const transferDirectory = resolve(this.dataRoot, "transfers");
    try {
      const directory = await opendir(transferDirectory);
      for await (const entry of directory) {
        const path = resolve(transferDirectory, entry.name);
        if (referenced.has(path.toLocaleLowerCase())) continue;
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || metadata.mtime.toISOString() >= cutoff) continue;
        await rm(path, { recursive: metadata.isDirectory(), force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async recoverOrRemove(transfer: TransferRow): Promise<void> {
    const destinationExists = transfer.destination_path ? await exists(transfer.destination_path) : false;
    const backupExists = transfer.backup_path ? await exists(transfer.backup_path) : false;
    if (transfer.phase === "installed") {
      if (!destinationExists && backupExists && transfer.destination_path && transfer.backup_path) {
        await rename(transfer.backup_path, transfer.destination_path);
      } else if (!destinationExists && !backupExists) {
        throw new BridgeError("TRANSFER_FAILED", "Installed transfer recovery found neither the destination nor its backup.", {
          details: { transfer_id: transfer.transfer_id, destination_path: transfer.destination_path },
        });
      } else if (backupExists && transfer.backup_path) {
        await rm(transfer.backup_path, { recursive: true, force: true });
      }
    } else if (backupExists && transfer.destination_path && transfer.backup_path) {
      if (destinationExists) {
        throw new BridgeError("TRANSFER_FAILED", "Interrupted transfer recovery found both destination and backup in an ambiguous pre-commit phase.", {
          details: { transfer_id: transfer.transfer_id, destination_path: transfer.destination_path, backup_path: transfer.backup_path, phase: transfer.phase },
        });
      }
      await rename(transfer.backup_path, transfer.destination_path);
    }
    for (const path of [transfer.staging_path, transfer.temporary_path]) {
      if (path && path.toLocaleLowerCase() !== transfer.destination_path?.toLocaleLowerCase()) {
        await rm(path, { recursive: true, force: true });
      }
    }
    this.state.removeTransfer(transfer.transfer_id);
    this.state.releaseStorageReservation(transfer.transfer_id);
  }

  private require(transferId: string, direction: "push" | "pull"): TransferRow {
    const transfer = this.state.getTransfer(transferId);
    if (!transfer || transfer.direction !== direction) throw new BridgeError("TRANSFER_FAILED", "Transfer was not found or has the wrong direction.");
    return transfer;
  }
}
