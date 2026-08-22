import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, link, lstat, mkdir, mkdtemp, open, opendir, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  BridgeError,
  MAX_DIRECTORY_TRANSFER_ENTRIES,
  MAX_INLINE_MANIFEST_BYTES,
  TRANSFER_CHUNK_BYTES,
  canonicalJson,
  sha256,
  type RpcPayload,
} from "../../protocol/src/index.js";
import type { RemoteCaller } from "./ssh-rpc.js";

const execFileAsync = promisify(execFile);
const MAC_TAR = "/usr/bin/tar";

export type ProgressCallback = (progress: number, total: number) => Promise<void> | void;

function progressReporter(callback: ProgressCallback | undefined, total: number): (progress: number) => Promise<void> {
  let lastReportedAt = 0;
  return async (progress: number): Promise<void> => {
    if (!callback) return;
    const now = Date.now();
    if (progress < total && now - lastReportedAt < 250) return;
    lastReportedAt = now;
    await callback(progress, total);
  };
}

interface ManifestEntry {
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

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function resultObject(payload: RpcPayload): Record<string, unknown> {
  if (!payload.ok) {
    if (!payload.error) throw new BridgeError("INTERNAL_ERROR", "Worker returned an error without details.");
    throw new BridgeError(payload.error.code, payload.error.message, { retryable: payload.error.retryable, details: payload.error.details });
  }
  if (!payload.result || typeof payload.result !== "object") throw new BridgeError("PROTOCOL_MISMATCH", "Worker transfer response is missing its result.");
  return payload.result as Record<string, unknown>;
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
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

function validateManifest(value: unknown, expectedHash: string): ManifestEntry[] {
  if (!Array.isArray(value) || value.length > MAX_DIRECTORY_TRANSFER_ENTRIES) throw new BridgeError("PROTOCOL_MISMATCH", "Worker directory manifest is invalid or too large.");
  const entries = value.map((item): ManifestEntry => {
    if (!item || typeof item !== "object") throw new BridgeError("PROTOCOL_MISMATCH", "Worker directory manifest entry is invalid.");
    const row = item as Record<string, unknown>;
    const entry: ManifestEntry = {
      path: normalizeManifestPath(String(row.path ?? "")),
      type: row.type === "directory" ? "directory" : row.type === "file" ? "file" : (() => { throw new BridgeError("PROTOCOL_MISMATCH", "Worker directory manifest entry type is invalid."); })(),
      size: Number(row.size),
      sha256: row.sha256 === null ? null : String(row.sha256 ?? ""),
    };
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new BridgeError("PROTOCOL_MISMATCH", "Worker directory manifest entry size is invalid.");
    if (entry.type === "directory" && (entry.size !== 0 || entry.sha256 !== null)) throw new BridgeError("PROTOCOL_MISMATCH", "Worker directory manifest directory metadata is invalid.");
    if (entry.type === "file" && !/^[0-9a-f]{64}$/u.test(entry.sha256 ?? "")) throw new BridgeError("PROTOCOL_MISMATCH", "Worker directory manifest file hash is invalid.");
    return entry;
  }).sort(comparePath);
  const folded = new Set(entries.map((entry) => entry.path.toLowerCase()));
  if (folded.size !== entries.length) throw new BridgeError("TRANSFER_FAILED", "Directory manifest contains case-colliding paths that Windows cannot represent safely.");
  const actualHash = sha256(canonicalJson(entries));
  if (actualHash !== expectedHash) throw new BridgeError("TRANSFER_FAILED", "Directory manifest SHA-256 verification failed.", { details: { expected_sha256: expectedHash, actual_sha256: actualHash } });
  return entries;
}

function summarizeManifest(manifest: ManifestEntry[]): ManifestSummary {
  return {
    entries: manifest.length,
    files: manifest.filter((entry) => entry.type === "file").length,
    total_file_bytes: manifest.reduce((sum, entry) => sum + entry.size, 0),
  };
}

function resultManifestSummary(value: Record<string, unknown>): ManifestSummary {
  const summary = {
    entries: Number(value.entries),
    files: Number(value.files),
    total_file_bytes: Number(value.total_file_bytes),
  };
  if (!Number.isSafeInteger(summary.entries) || summary.entries < 0 || summary.entries > MAX_DIRECTORY_TRANSFER_ENTRIES) {
    throw new BridgeError("PROTOCOL_MISMATCH", "Worker directory manifest entry count is invalid.");
  }
  if (!Number.isSafeInteger(summary.files) || summary.files < 0 || summary.files > summary.entries) {
    throw new BridgeError("PROTOCOL_MISMATCH", "Worker directory manifest file count is invalid.");
  }
  if (!Number.isSafeInteger(summary.total_file_bytes) || summary.total_file_bytes < 0) {
    throw new BridgeError("PROTOCOL_MISMATCH", "Worker directory manifest byte count is invalid.");
  }
  return summary;
}

function assertManifestMatches(actual: ManifestEntry[], expectedHash: string, expectedSummary: ManifestSummary): ManifestSummary {
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

async function buildManifest(root: string): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  const queue = [root];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (!current) break;
    const directory = await opendir(current);
    for await (const entry of directory) {
      const absolute = resolve(current, entry.name);
      const metadata = await lstat(absolute);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) throw new BridgeError("TRANSFER_FAILED", "Directory transfer refuses Mac symbolic links.", { details: { path: absolute } });
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        entries.push({ path, type: "directory", size: 0, sha256: null });
        queue.push(absolute);
      } else if (entry.isFile()) entries.push({ path, type: "file", size: metadata.size, sha256: await fileHash(absolute) });
      else throw new BridgeError("TRANSFER_FAILED", "Directory transfer only supports regular files and directories.", { details: { path: absolute } });
      if (entries.length > MAX_DIRECTORY_TRANSFER_ENTRIES) {
        throw new BridgeError("TRANSFER_FAILED", `Directory transfer exceeds the ${MAX_DIRECTORY_TRANSFER_ENTRIES.toLocaleString("en-US")}-entry safety limit.`);
      }
    }
  }
  entries.sort(comparePath);
  if (new Set(entries.map((entry) => entry.path.toLowerCase())).size !== entries.length) throw new BridgeError("TRANSFER_FAILED", "Mac source contains case-colliding paths that Windows cannot represent safely.");
  return entries;
}

async function runTar(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(MAC_TAR, args, {
      encoding: "utf8",
      timeout: 30 * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return stdout;
  } catch (error) {
    throw new BridgeError("TRANSFER_FAILED", "Mac tar operation failed.", { cause: error, details: { args, stderr: String((error as { stderr?: unknown }).stderr ?? "").slice(-4096) } });
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
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new BridgeError("TRANSFER_FAILED", "Downloaded archive contains duplicate or case-colliding paths.");
  if (names.length > MAX_DIRECTORY_TRANSFER_ENTRIES) {
    throw new BridgeError("TRANSFER_FAILED", `Downloaded archive exceeds the ${MAX_DIRECTORY_TRANSFER_ENTRIES.toLocaleString("en-US")}-entry safety limit.`);
  }
  for (const line of verboseText.split(/\r?\n/u).filter(Boolean)) {
    const type = line.trimStart()[0];
    if (type !== "-" && type !== "d") throw new BridgeError("TRANSFER_FAILED", "Downloaded archive contains a link or unsupported special entry.", { details: { entry_type: type ?? null } });
  }
}

async function uploadStream(remote: RemoteCaller, nodeId: string, sourcePath: string, beginOperation: string, beginArguments: Record<string, unknown>, onProgress?: ProgressCallback): Promise<Record<string, unknown>> {
  const source = await stat(sourcePath);
  const reportProgress = progressReporter(onProgress, source.size);
  const begin = resultObject(await remote.call(nodeId, beginOperation, beginArguments));
  const transferId = String(begin.transfer_id);
  let offset = 0;
  try {
    for await (const chunk of createReadStream(sourcePath, { highWaterMark: TRANSFER_CHUNK_BYTES })) {
      const bytes = chunk as Buffer;
      resultObject(await remote.call(nodeId, "transfer_write_chunk", { transfer_id: transferId, offset, data_base64: bytes.toString("base64") }));
      offset += bytes.byteLength;
      await reportProgress(offset);
    }
    return resultObject(await remote.call(nodeId, "transfer_commit_push", { transfer_id: transferId }));
  } catch (error) {
    await remote.call(nodeId, "transfer_finish", { transfer_id: transferId }).catch(() => undefined);
    throw error;
  }
}

export async function pushPath(remote: RemoteCaller, nodeId: string, sourcePath: string, destinationPath: string, requestedKind: "auto" | "file" | "directory", overwrite: boolean, onProgress?: ProgressCallback): Promise<Record<string, unknown>> {
  if (!isAbsolute(sourcePath)) throw new BridgeError("INVALID_ARGUMENT", "source_path must be an absolute Mac path.");
  const source = await lstat(sourcePath);
  if (source.isSymbolicLink()) throw new BridgeError("TRANSFER_FAILED", "Transfer source cannot be a symbolic link.");
  const kind = source.isDirectory() ? "directory" : source.isFile() ? "file" : null;
  if (!kind) throw new BridgeError("INVALID_ARGUMENT", "MiraBridge push supports a regular file or directory.");
  if (requestedKind !== "auto" && requestedKind !== kind) throw new BridgeError("INVALID_ARGUMENT", `Requested ${requestedKind} transfer, but the source is a ${kind}.`);
  if (kind === "file") {
    const digest = await fileHash(sourcePath);
    const committed = await uploadStream(remote, nodeId, sourcePath, "transfer_begin_push", { destination_path: destinationPath, size: source.size, sha256: digest, overwrite }, onProgress);
    return { ...committed, kind, source_path: sourcePath };
  }
  const manifest = await buildManifest(sourcePath);
  const manifestDigest = sha256(canonicalJson(manifest));
  const summary = summarizeManifest(manifest);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mirabridge-push-"));
  const archive = join(temporaryRoot, "payload.tar");
  try {
    await runTar(["-cf", archive, "-C", sourcePath, "."]);
    const archiveStat = await stat(archive);
    const digest = await fileHash(archive);
    const inlineManifest = Buffer.byteLength(canonicalJson(manifest), "utf8") <= MAX_INLINE_MANIFEST_BYTES ? manifest : undefined;
    const beginArguments = inlineManifest
      ? { destination_path: destinationPath, size: archiveStat.size, sha256: digest, manifest: inlineManifest, manifest_sha256: manifestDigest, overwrite }
      : {
          destination_path: destinationPath,
          size: archiveStat.size,
          sha256: digest,
          manifest_sha256: manifestDigest,
          manifest_entries: summary.entries,
          manifest_files: summary.files,
          total_file_bytes: summary.total_file_bytes,
          overwrite,
        };
    const committed = await uploadStream(remote, nodeId, archive, "transfer_begin_directory_push", beginArguments, onProgress);
    return { ...committed, kind, source_path: sourcePath, manifest_sha256: manifestDigest };
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
}

async function downloadArchive(remote: RemoteCaller, nodeId: string, transferId: string, expectedSize: number, expectedHash: string, temporary: string, onProgress?: ProgressCallback): Promise<void> {
  const hash = createHash("sha256");
  let offset = 0;
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const reportProgress = progressReporter(onProgress, expectedSize);
  try {
    while (offset < expectedSize) {
      const part = resultObject(await remote.call(nodeId, "transfer_read_chunk", { transfer_id: transferId, offset, max_bytes: Math.min(TRANSFER_CHUNK_BYTES, expectedSize - offset) }));
      const bytes = Buffer.from(String(part.data_base64), "base64");
      if (bytes.length === 0 && offset < expectedSize) throw new BridgeError("TRANSFER_FAILED", "Worker returned an empty transfer chunk.");
      await new Promise<void>((resolveWrite, reject) => output.write(bytes, (error) => error ? reject(error) : resolveWrite()));
      hash.update(bytes);
      offset += bytes.length;
      await reportProgress(offset);
    }
    await new Promise<void>((resolveEnd, reject) => output.end((error?: Error | null) => error ? reject(error) : resolveEnd()));
    const actualHash = hash.digest("hex");
    if (offset !== expectedSize || actualHash !== expectedHash) throw new BridgeError("TRANSFER_FAILED", "Downloaded archive or file failed size or SHA-256 verification.", { details: { expected_size: expectedSize, actual_size: offset, expected_sha256: expectedHash, actual_sha256: actualHash } });
    const handle = await open(temporary, "r+");
    await handle.sync();
    await handle.close();
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}

async function installFile(temporary: string, destinationPath: string, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    await link(temporary, destinationPath);
    await unlink(temporary);
  } else await rename(temporary, destinationPath);
}

async function installDirectory(staging: string, destinationPath: string, overwrite: boolean): Promise<{ backup_cleanup_pending: boolean; backup_path?: string }> {
  const destinationExists = await pathExists(destinationPath);
  if (destinationExists && !overwrite) throw new BridgeError("TRANSFER_FAILED", "Destination already exists and overwrite is false.");
  const backup = resolve(dirname(destinationPath), `.${basename(destinationPath)}.${randomUUID()}.mirabridge-backup`);
  let backedUp = false;
  try {
    if (destinationExists) { await rename(destinationPath, backup); backedUp = true; }
    await rename(staging, destinationPath);
  } catch (error) {
    if (backedUp && !await pathExists(destinationPath)) await rename(backup, destinationPath).catch(() => undefined);
    throw error;
  }
  if (!backedUp) return { backup_cleanup_pending: false };
  try {
    await rm(backup, { recursive: true, force: true });
    return { backup_cleanup_pending: false };
  } catch {
    return { backup_cleanup_pending: true, backup_path: backup };
  }
}

export async function pullPath(remote: RemoteCaller, nodeId: string, sourcePath: string, destinationPath: string, requestedKind: "auto" | "file" | "directory", overwrite: boolean, onProgress?: ProgressCallback): Promise<Record<string, unknown>> {
  if (!isAbsolute(destinationPath)) throw new BridgeError("INVALID_ARGUMENT", "destination_path must be an absolute Mac path.");
  if (!overwrite && await pathExists(destinationPath)) throw new BridgeError("TRANSFER_FAILED", "Destination already exists and overwrite is false.", { details: { destination_path: destinationPath } });
  const parent = dirname(destinationPath);
  await mkdir(parent, { recursive: false }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const begin = resultObject(await remote.call(nodeId, "transfer_begin_pull", { source_path: sourcePath, kind: requestedKind }));
  const transferId = String(begin.transfer_id);
  const kind = begin.kind === "directory" ? "directory" : "file";
  const expectedSize = Number(begin.size);
  const expectedHash = String(begin.sha256);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "mirabridge-pull-"));
  const downloaded = join(temporaryRoot, kind === "directory" ? "payload.tar" : "payload.bin");
  try {
    await downloadArchive(remote, nodeId, transferId, expectedSize, expectedHash, downloaded, onProgress);
    if (kind === "file") {
      const staged = join(parent, `.${basename(destinationPath)}.${randomUUID()}.mirabridge-part`);
      await rename(downloaded, staged);
      try { await installFile(staged, destinationPath, overwrite); }
      catch (error) { await rm(staged, { force: true }); throw error; }
      const remoteCleanupPending = !await remote.call(nodeId, "transfer_finish", { transfer_id: transferId }).then(() => true).catch(() => false);
      return { kind, source_path: sourcePath, destination_path: destinationPath, size: expectedSize, sha256: expectedHash, remote_cleanup_pending: remoteCleanupPending };
    }
    const manifestDigest = String(begin.manifest_sha256 ?? "");
    const inlineManifest = begin.manifest === undefined ? undefined : validateManifest(begin.manifest, manifestDigest);
    const summary = inlineManifest ? summarizeManifest(inlineManifest) : resultManifestSummary(begin);
    await preflightArchive(downloaded);
    const staging = join(parent, `.${basename(destinationPath)}.${randomUUID()}.mirabridge-stage`);
    await mkdir(staging, { recursive: false });
    try {
      await runTar(["-xf", downloaded, "-C", staging]);
      const actualManifest = await buildManifest(staging);
      assertManifestMatches(actualManifest, manifestDigest, summary);
      const install = await installDirectory(staging, destinationPath, overwrite);
      const remoteCleanupPending = !await remote.call(nodeId, "transfer_finish", { transfer_id: transferId }).then(() => true).catch(() => false);
      return {
        kind, source_path: sourcePath, destination_path: destinationPath, archive_size: expectedSize, archive_sha256: expectedHash,
        manifest_sha256: manifestDigest, ...summary, ...install, remote_cleanup_pending: remoteCleanupPending,
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    await remote.call(nodeId, "transfer_finish", { transfer_id: transferId }).catch(() => undefined);
    throw error;
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
}

export async function pushFile(remote: RemoteCaller, nodeId: string, sourcePath: string, destinationPath: string, overwrite: boolean, onProgress?: ProgressCallback): Promise<Record<string, unknown>> {
  return await pushPath(remote, nodeId, sourcePath, destinationPath, "file", overwrite, onProgress);
}

export async function pullFile(remote: RemoteCaller, nodeId: string, sourcePath: string, destinationPath: string, overwrite: boolean, onProgress?: ProgressCallback): Promise<Record<string, unknown>> {
  return await pullPath(remote, nodeId, sourcePath, destinationPath, "file", overwrite, onProgress);
}
