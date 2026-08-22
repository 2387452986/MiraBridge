import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { access, cp, lstat, opendir, open, readFile, readdir, rename, rm, stat, mkdir } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep, win32 } from "node:path";
import { BridgeError, MAX_READ_BYTES, canonicalJson, sha256 } from "../../protocol/src/index.js";

const MAX_SEARCH_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EDIT_TEXT_BYTES = 64 * 1024 * 1024;
const AUTO_STAT_HASH_BYTES = 256 * 1024 * 1024;
const MAX_WORKSPACE_TRAVERSAL_ENTRIES = 1_000_000;

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ListedEntry {
  name: string;
  type: "directory" | "file" | "link" | "other";
  size: number;
  modified_at: string;
  modified_at_ms: number;
}

async function listedEntry(path: string, entry: Dirent): Promise<ListedEntry> {
  const metadata = await lstat(resolve(path, entry.name));
  return {
    name: entry.name,
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other",
    size: metadata.size,
    modified_at: metadata.mtime.toISOString(),
    modified_at_ms: metadata.mtimeMs,
  };
}

interface DirectoryCursor {
  offset: number;
  directory_mtime_ms: number;
  sort_by: "name" | "modified_at" | "size";
  sort_order: "asc" | "desc";
  snapshot_hash?: string;
  directory_path_hash?: string;
}

function parseDirectoryCursor(cursor: unknown): DirectoryCursor | null {
  if (typeof cursor !== "string" || !cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<DirectoryCursor>;
    if (
      Number.isSafeInteger(parsed.offset) && Number(parsed.offset) >= 0
      && typeof parsed.directory_mtime_ms === "number" && Number.isFinite(parsed.directory_mtime_ms)
      && ["name", "modified_at", "size"].includes(String(parsed.sort_by))
      && ["asc", "desc"].includes(String(parsed.sort_order))
      && (parsed.snapshot_hash === undefined || /^[0-9a-f]{64}$/u.test(parsed.snapshot_hash))
      && (parsed.directory_path_hash === undefined || /^[0-9a-f]{64}$/u.test(parsed.directory_path_hash))
    ) return parsed as DirectoryCursor;
  } catch { /* handled below */ }
  throw new BridgeError("INVALID_ARGUMENT", "Invalid directory pagination cursor.");
}

function directoryCursor(value: DirectoryCursor, total: number): string | null {
  if (value.offset >= total) return null;
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export async function listDirectory(
  path: string,
  cursor: unknown,
  maxEntries: number,
  sortBy: "name" | "modified_at" | "size" = "name",
  sortOrder: "asc" | "desc" = "asc",
): Promise<Record<string, unknown>> {
  const directoryMetadata = await stat(path);
  const directoryPathHash = sha256(path.toLocaleLowerCase());
  const parsedCursor = parseDirectoryCursor(cursor);
  if (parsedCursor && (
    parsedCursor.directory_mtime_ms !== directoryMetadata.mtimeMs
    || parsedCursor.sort_by !== sortBy
    || parsedCursor.sort_order !== sortOrder
    || (parsedCursor.directory_path_hash !== undefined && parsedCursor.directory_path_hash !== directoryPathHash)
  )) {
    throw new BridgeError("RESOURCE_CHANGED", "Directory contents or pagination sort changed; restart listing without a cursor.", { retryable: true });
  }
  const dirents = await readdir(path, { withFileTypes: true });
  const nameCompare = (left: { name: string }, right: { name: string }): number => {
    const folded = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    return folded || left.name.localeCompare(right.name);
  };
  let entries: ListedEntry[];
  let snapshotHash: string;
  if (sortBy === "name") {
    dirents.sort(nameCompare);
    if (sortOrder === "desc") dirents.reverse();
    snapshotHash = sha256(canonicalJson(dirents.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other",
    }))));
    const offset = parsedCursor?.offset ?? 0;
    entries = await mapConcurrent(dirents.slice(offset, offset + maxEntries), 32, async (entry) => await listedEntry(path, entry));
  } else {
    entries = await mapConcurrent(dirents, 32, async (entry) => await listedEntry(path, entry));
    entries.sort((left, right) => {
      const primary = sortBy === "modified_at" ? left.modified_at_ms - right.modified_at_ms : left.size - right.size;
      const compared = primary || nameCompare(left, right);
      return sortOrder === "asc" ? compared : -compared;
    });
    snapshotHash = sha256(canonicalJson(entries.map(({ modified_at_ms: _modifiedAtMs, ...entry }) => entry)));
    const offset = parsedCursor?.offset ?? 0;
    entries = entries.slice(offset, offset + maxEntries);
  }
  if (parsedCursor?.snapshot_hash && parsedCursor.snapshot_hash !== snapshotHash) {
    throw new BridgeError("RESOURCE_CHANGED", "Directory contents changed; restart listing without a cursor.", { retryable: true });
  }
  const offset = parsedCursor?.offset ?? 0;
  const page: Array<Record<string, unknown>> = [];
  let pageBytes = 2;
  for (const { modified_at_ms: _modifiedAtMs, ...entry } of entries) {
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (page.length > 0 && pageBytes + bytes > MAX_READ_BYTES) break;
    page.push(entry);
    pageBytes += bytes;
  }
  return {
    entries: page,
    total_entries: dirents.length,
    cursor: directoryCursor({
      offset: offset + page.length,
      directory_mtime_ms: directoryMetadata.mtimeMs,
      sort_by: sortBy,
      sort_order: sortOrder,
      snapshot_hash: snapshotHash,
      directory_path_hash: directoryPathHash,
    }, dirents.length),
    sort_by: sortBy,
    sort_order: sortOrder,
    snapshot_modified_at: directoryMetadata.mtime.toISOString(),
    snapshot_hash: snapshotHash,
  };
}

export async function statPath(path: string, hashMode: "auto" | "always" | "never" = "auto"): Promise<Record<string, unknown>> {
  const metadata = await stat(path);
  const hash = metadata.isFile() && hashMode !== "never" && (hashMode === "always" || metadata.size <= AUTO_STAT_HASH_BYTES)
    ? await hashFile(path)
    : null;
  return {
    path,
    type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
    size: metadata.size,
    created_at: metadata.birthtime.toISOString(),
    modified_at: metadata.mtime.toISOString(),
    sha256: hash,
    sha256_computed: hash !== null,
    hash_mode: hashMode,
    auto_hash_limit_bytes: AUTO_STAT_HASH_BYTES,
    ...(metadata.isFile() && hash === null ? { sha256_omitted_reason: hashMode === "never" ? "disabled" : "file_too_large" } : {}),
  };
}

function looksBinary(buffer: Buffer): boolean {
  const utf16Bom = (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff);
  if (utf16Bom) return false;
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let controls = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  return sample.length > 0 && controls / sample.length > 0.1;
}

export function decodeText(buffer: Buffer): { text: string; encoding: string } {
  if (looksBinary(buffer)) throw new BridgeError("PATH_IS_BINARY", "Requested file appears to be binary.");
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le", { fatal: true }).decode(buffer.subarray(2)), encoding: "utf-16le" };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const bytes = Buffer.from(buffer.subarray(2));
    for (let index = 0; index + 1 < bytes.length; index += 2) [bytes[index], bytes[index + 1]] = [bytes[index + 1] ?? 0, bytes[index] ?? 0];
    return { text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes), encoding: "utf-16be" };
  }
  const content = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(content), encoding: buffer.length !== content.length ? "utf-8-bom" : "utf-8" };
  } catch (error) {
    throw new BridgeError("UNSUPPORTED_ENCODING", "File is not valid UTF-8 or BOM-marked UTF-16 text.", { cause: error });
  }
}

export async function readText(path: string, startLine: number, maxLines: number, includeIntegrity = true): Promise<Record<string, unknown>> {
  const handle = await open(path, "r");
  const sample = Buffer.alloc(8192);
  const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
  await handle.close();
  const header = sample.subarray(0, bytesRead);
  if (looksBinary(header)) throw new BridgeError("PATH_IS_BINARY", "Requested file appears to be binary.");
  const utf16le = header[0] === 0xff && header[1] === 0xfe;
  const utf16be = header[0] === 0xfe && header[1] === 0xff;
  const utf8Bom = header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf;
  const encoding = utf16le ? "utf-16le" : utf16be ? "utf-16be" : utf8Bom ? "utf-8-bom" : "utf-8";
  const decoder = new TextDecoder(utf16le ? "utf-16le" : utf16be ? "utf-16be" : "utf-8", { fatal: true });
  const bomBytes = utf16le || utf16be ? 2 : utf8Bom ? 3 : 0;
  const digest = createHash("sha256");
  const selected: string[] = [];
  let selectedBytes = 0;
  let selectedLine: string | undefined;
  let lineNumber = 1;
  let firstChunk = true;
  let contentTruncated = false;
  let stoppedEarly = false;

  const append = (value: string): void => {
    if (lineNumber < startLine || lineNumber >= startLine + maxLines || contentTruncated) return;
    selectedLine ??= "";
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const available = MAX_READ_BYTES - selectedBytes - separatorBytes;
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length <= available) {
      selectedLine += value;
      selectedBytes += bytes.length;
      return;
    }
    if (available > 0) {
      let end = Math.min(available, bytes.length);
      while (end > 0) {
        try {
          selectedLine += new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
          selectedBytes += end;
          break;
        } catch { end -= 1; }
      }
    }
    contentTruncated = true;
    if (!includeIntegrity) stoppedEarly = true;
  };
  const finishLine = (): void => {
    if (selectedLine !== undefined) {
      selected.push(selectedLine.endsWith("\r") ? selectedLine.slice(0, -1) : selectedLine);
      selectedLine = undefined;
      if (selected.length > 1) selectedBytes += 1;
    }
    lineNumber += 1;
  };
  const consume = (text: string): void => {
    let offset = 0;
    while (true) {
      const newline = text.indexOf("\n", offset);
      if (newline < 0) {
        append(text.slice(offset));
        break;
      }
      append(text.slice(offset, newline));
      finishLine();
      if (!includeIntegrity && lineNumber >= startLine + maxLines) {
        stoppedEarly = true;
        break;
      }
      offset = newline + 1;
    }
  };

  try {
    for await (const value of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      const chunk = value as Buffer;
      digest.update(chunk);
      const content = firstChunk ? chunk.subarray(Math.min(bomBytes, chunk.length)) : chunk;
      firstChunk = false;
      consume(decoder.decode(content, { stream: true }));
      if (stoppedEarly) break;
    }
    if (!stoppedEarly) consume(decoder.decode());
  } catch (error) {
    if (error instanceof TypeError) throw new BridgeError("UNSUPPORTED_ENCODING", "File is not valid UTF-8 or BOM-marked UTF-16 text.", { cause: error });
    throw error;
  }
  if (lineNumber >= startLine && lineNumber < startLine + maxLines && !contentTruncated) selectedLine ??= "";
  if (selectedLine !== undefined) selected.push(selectedLine.endsWith("\r") ? selectedLine.slice(0, -1) : selectedLine);
  const totalLines = stoppedEarly ? null : lineNumber;
  const firstSelectedLine = selected.length ? startLine : null;
  return {
    path,
    encoding,
    total_lines: totalLines,
    start_line: firstSelectedLine,
    end_line: selected.length ? startLine + selected.length - 1 : null,
    content: selected.join("\n"),
    content_truncated: contentTruncated,
    scan_complete: !stoppedEarly,
    sha256: stoppedEarly ? null : digest.digest("hex"),
    next_start_line: !contentTruncated && stoppedEarly ? startLine + selected.length : null,
  };
}

export async function writeText(
  path: string,
  content: string,
  expectedSha256: string | undefined,
  createParents: boolean,
  beforeCommit?: () => Promise<void>,
): Promise<Record<string, unknown>> {
  if (createParents) await mkdir(dirname(path), { recursive: true });
  await beforeCommit?.();
  if (expectedSha256) {
    let current: string;
    try { current = await hashFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BridgeError("FILE_CHANGED", "File no longer exists for expected_sha256 validation.");
      }
      throw error;
    }
    if (current !== expectedSha256) {
      throw new BridgeError("FILE_CHANGED", "File changed since it was read.", { details: { expected_sha256: expectedSha256, actual_sha256: current } });
    }
  }
  const bytes = Buffer.from(content, "utf8");
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.mirabridge-tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (expectedSha256) {
      const current = await hashFile(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BridgeError("FILE_CHANGED", "File disappeared before atomic replacement.");
        throw error;
      });
      if (current !== expectedSha256) throw new BridgeError("FILE_CHANGED", "File changed before atomic replacement.", { details: { expected_sha256: expectedSha256, actual_sha256: current } });
    }
    await beforeCommit?.();
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { path, bytes: bytes.length, sha256: sha256(bytes), encoding: "utf-8" };
}

function encodeText(text: string, encoding: string): Buffer {
  if (encoding === "utf-16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  if (encoding === "utf-16be") {
    const bytes = Buffer.from(text, "utf16le");
    for (let index = 0; index + 1 < bytes.length; index += 2) [bytes[index], bytes[index + 1]] = [bytes[index + 1] ?? 0, bytes[index] ?? 0];
    return Buffer.concat([Buffer.from([0xfe, 0xff]), bytes]);
  }
  if (encoding === "utf-8-bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  return Buffer.from(text, "utf8");
}

async function atomicWriteBytes(path: string, bytes: Buffer, expectedSha256: string, beforeCommit?: () => Promise<void>): Promise<void> {
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.mirabridge-tmp`);
  const current = await hashFile(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BridgeError("FILE_CHANGED", "File no longer exists for expected_sha256 validation.");
    throw error;
  });
  if (current !== expectedSha256) throw new BridgeError("FILE_CHANGED", "File changed since it was read.", { details: { expected_sha256: expectedSha256, actual_sha256: current } });
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    const before = await hashFile(path);
    if (before !== expectedSha256) throw new BridgeError("FILE_CHANGED", "File changed before atomic replacement.", { details: { expected_sha256: expectedSha256, actual_sha256: before } });
    await beforeCommit?.();
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export interface ExactTextEdit {
  old_text: string;
  new_text: string;
  replace_all: boolean;
}

export async function editText(
  path: string,
  expectedSha256: string,
  edits: ExactTextEdit[],
  beforeCommit?: () => Promise<void>,
): Promise<Record<string, unknown>> {
  const metadata = await stat(path);
  if (metadata.size > MAX_EDIT_TEXT_BYTES) {
    throw new BridgeError("INVALID_ARGUMENT", `Exact text editing is limited to ${MAX_EDIT_TEXT_BYTES} bytes; use a structured process for larger files.`, {
      details: { path, size: metadata.size, max_bytes: MAX_EDIT_TEXT_BYTES },
    });
  }
  const bytes = await readFile(path);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new BridgeError("FILE_CHANGED", "File changed since it was read.", { details: { expected_sha256: expectedSha256, actual_sha256: actualSha256 } });
  }
  const decoded = decodeText(bytes);
  let content = decoded.text;
  let contentBytes = Buffer.byteLength(content, "utf8");
  const replacements: Array<{ edit_index: number; count: number }> = [];
  for (const [index, edit] of edits.entries()) {
    const count = content.split(edit.old_text).length - 1;
    if (count === 0) {
      throw new BridgeError("FILE_CHANGED", "Exact edit text was not found in the current file.", { details: { edit_index: index, occurrences: 0 } });
    }
    if (!edit.replace_all && count !== 1) {
      throw new BridgeError("INVALID_ARGUMENT", "Exact edit text is ambiguous; set replace_all only when every occurrence should change.", { details: { edit_index: index, occurrences: count } });
    }
    const replacementCount = edit.replace_all ? count : 1;
    const projectedBytes = contentBytes + replacementCount * (Buffer.byteLength(edit.new_text, "utf8") - Buffer.byteLength(edit.old_text, "utf8"));
    if (!Number.isSafeInteger(projectedBytes) || projectedBytes > MAX_EDIT_TEXT_BYTES) {
      throw new BridgeError("INVALID_ARGUMENT", `Exact text editing output is limited to ${MAX_EDIT_TEXT_BYTES} bytes.`, {
        details: { edit_index: index, projected_bytes: projectedBytes, max_bytes: MAX_EDIT_TEXT_BYTES },
      });
    }
    content = edit.replace_all ? content.split(edit.old_text).join(edit.new_text) : content.replace(edit.old_text, edit.new_text);
    contentBytes = projectedBytes;
    replacements.push({ edit_index: index, count: replacementCount });
  }
  const output = encodeText(content, decoded.encoding);
  await atomicWriteBytes(path, output, expectedSha256, beforeCommit);
  return {
    path,
    bytes: output.length,
    sha256: sha256(output),
    previous_sha256: expectedSha256,
    encoding: decoded.encoding,
    replacements,
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function assertTreeHasNoLinks(root: string): Promise<void> {
  const queue = [root];
  let queueIndex = 0;
  let seen = 0;
  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    queueIndex += 1;
    if (!current) break;
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "Path management refuses symbolic links and junctions.", { details: { path: current } });
    if (!metadata.isDirectory()) continue;
    const directory = await opendir(current);
    for await (const entry of directory) {
      const child = resolve(current, entry.name);
      const childMetadata = await lstat(child);
      if (entry.isSymbolicLink() || childMetadata.isSymbolicLink()) {
        throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "Path management refuses symbolic links and junctions.", { details: { path: child } });
      }
      if (entry.isDirectory()) queue.push(child);
      seen += 1;
      if (seen > MAX_WORKSPACE_TRAVERSAL_ENTRIES) throw new BridgeError("INVALID_ARGUMENT", `Path operation exceeds the ${MAX_WORKSPACE_TRAVERSAL_ENTRIES.toLocaleString("en-US")}-entry safety limit.`);
    }
  }
}

export interface ManagePathOptions {
  action: "mkdir" | "copy" | "move" | "delete";
  source: string;
  destination?: string;
  recursive: boolean;
  overwrite: boolean;
  expectedSha256?: string;
  beforeCommit?: () => Promise<void>;
}

export async function managePath(options: ManagePathOptions): Promise<Record<string, unknown>> {
  if (options.expectedSha256) {
    const metadata = await stat(options.source);
    if (!metadata.isFile()) throw new BridgeError("INVALID_ARGUMENT", "expected_sha256 is only valid for a file source.");
    const actual = await hashFile(options.source);
    if (actual !== options.expectedSha256) throw new BridgeError("FILE_CHANGED", "Source changed since it was inspected.", { details: { expected_sha256: options.expectedSha256, actual_sha256: actual } });
  }
  if (options.action === "mkdir") {
    if (await exists(options.source)) throw new BridgeError("FILE_CHANGED", "Directory target already exists.", { details: { path: options.source } });
    await mkdir(options.source, { recursive: options.recursive });
    await options.beforeCommit?.();
    return { action: "mkdir", path: options.source, created: true };
  }

  const metadata = await lstat(options.source);
  if (metadata.isSymbolicLink() && options.action !== "delete") {
    throw new BridgeError("WORKSPACE_OUT_OF_BOUNDS", "Path management refuses to copy or move symbolic links and junctions.");
  }
  if (metadata.isDirectory()) await assertTreeHasNoLinks(options.source);
  if (options.action === "delete") {
    if (metadata.isDirectory() && !options.recursive) throw new BridgeError("INVALID_ARGUMENT", "Deleting a directory requires recursive=true.");
    await options.beforeCommit?.();
    const current = await lstat(options.source);
    if (current.dev !== metadata.dev || current.ino !== metadata.ino || current.isSymbolicLink() !== metadata.isSymbolicLink()) {
      throw new BridgeError("RESOURCE_CHANGED", "The path changed before deletion.");
    }
    if (metadata.isSymbolicLink()) await rm(options.source, { recursive: false, force: false });
    else await rm(options.source, { recursive: metadata.isDirectory(), force: false });
    return { action: "delete", path: options.source, deleted: true, type: metadata.isSymbolicLink() ? "link" : metadata.isDirectory() ? "directory" : "file", followed: false };
  }
  if (!options.destination) throw new BridgeError("INVALID_ARGUMENT", `${options.action} requires destination_path.`);
  const destinationExists = await exists(options.destination);
  if (destinationExists && !options.overwrite) throw new BridgeError("FILE_CHANGED", "Destination already exists and overwrite is false.", { details: { destination_path: options.destination } });
  if (metadata.isDirectory() && !options.recursive) throw new BridgeError("INVALID_ARGUMENT", `${options.action} of a directory requires recursive=true.`);
  const temporary = resolve(dirname(options.destination), `.${basename(options.destination)}.${randomUUID()}.mirabridge-stage`);
  const backup = resolve(dirname(options.destination), `.${basename(options.destination)}.${randomUUID()}.mirabridge-backup`);
  let backedUp = false;
  try {
    if (options.action === "copy") await cp(options.source, temporary, { recursive: metadata.isDirectory(), errorOnExist: true, force: false, verbatimSymlinks: true });
    if (destinationExists) {
      await rename(options.destination, backup);
      backedUp = true;
    }
    await options.beforeCommit?.();
    if (options.action === "copy") await rename(temporary, options.destination);
    else await rename(options.source, options.destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (backedUp && !await exists(options.destination)) await rename(backup, options.destination).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      throw new BridgeError("INVALID_ARGUMENT", "move cannot cross Windows volumes; copy the path first, verify it, then delete the source.", {
        cause: error,
        details: { source_path: options.source, destination_path: options.destination },
      });
    }
    throw error;
  }
  let backupCleanupPending = false;
  if (backedUp) {
    try { await rm(backup, { recursive: true, force: true }); }
    catch { backupCleanupPending = true; }
  }
  return {
    action: options.action,
    source_path: options.source,
    destination_path: options.destination,
    overwritten: destinationExists,
    type: metadata.isDirectory() ? "directory" : "file",
    backup_cleanup_pending: backupCleanupPending,
    ...(backupCleanupPending ? { backup_path: backup } : {}),
  };
}

function globMatcher(pattern: string): (path: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/");
  try { win32.matchesGlob("mirabridge-probe.txt", normalized); }
  catch (error) { throw new BridgeError("INVALID_ARGUMENT", "Glob pattern is invalid.", { cause: error, details: { pattern } }); }
  return (path: string) => win32.matchesGlob(path, normalized);
}

interface CollectionCursor {
  version: 1;
  kind: "glob" | "search";
  after_key: string;
  snapshot_hash: string;
  signature: string;
}

function decodeCollectionCursor(cursor: unknown, kind: CollectionCursor["kind"], signature: string): CollectionCursor | number | undefined {
  if (typeof cursor !== "string" || !cursor) return undefined;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const legacyOffset = Number(decoded);
  if (Number.isSafeInteger(legacyOffset) && legacyOffset >= 0) return legacyOffset;
  try {
    const value = JSON.parse(decoded) as Partial<CollectionCursor>;
    if (
      value.version !== 1 || value.kind !== kind || value.signature !== signature
      || typeof value.after_key !== "string" || typeof value.snapshot_hash !== "string"
      || !/^[0-9a-f]{64}$/u.test(value.snapshot_hash)
    ) throw new Error("invalid");
    return value as CollectionCursor;
  } catch {
    throw new BridgeError("INVALID_ARGUMENT", `Invalid ${kind} pagination cursor.`);
  }
}

function encodeCollectionCursor(value: CollectionCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

interface WalkEntry { absolute: string; relative: string; type: "file" | "directory" }

async function walk(root: string): Promise<WalkEntry[]> {
  // ponytail: bounded O(n) walk; switch to ripgrep only if measured large-tree latency requires it.
  const entries: WalkEntry[] = [];
  const queue = [root];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const directoryPath = queue[queueIndex];
    queueIndex += 1;
    if (!directoryPath) break;
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(directoryPath, entry.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        entries.push({ absolute, relative: relativePath, type: "directory" });
        queue.push(absolute);
      } else if (entry.isFile()) entries.push({ absolute, relative: relativePath, type: "file" });
      if (entries.length > MAX_WORKSPACE_TRAVERSAL_ENTRIES) throw new BridgeError("INVALID_ARGUMENT", `Workspace traversal exceeded ${MAX_WORKSPACE_TRAVERSAL_ENTRIES.toLocaleString("en-US")} entries; narrow the path or pattern.`);
    }
  }
  return entries.sort((left, right) => {
    const folded = left.relative.localeCompare(right.relative, undefined, { sensitivity: "base" });
    return folded || left.relative.localeCompare(right.relative);
  });
}

export async function globPaths(
  root: string,
  pattern: string,
  cursor: unknown,
  maxResults: number,
  sortBy: "path" | "modified_at" | "size" = "path",
  sortOrder: "asc" | "desc" = "asc",
): Promise<Record<string, unknown>> {
  const matcher = globMatcher(pattern);
  const matches = (await walk(root)).filter((entry) => matcher(entry.relative));
  const signature = sha256(canonicalJson({ root: root.toLocaleLowerCase(), pattern, sort_by: sortBy, sort_order: sortOrder }));
  const decodedCursor = decodeCollectionCursor(cursor, "glob", signature);
  let hydrated: Array<WalkEntry & { size: number; modified_at: string; modified_at_ms: number }>;
  let snapshotHash: string;
  let offset = typeof decodedCursor === "number" ? decodedCursor : 0;
  let totalMatches: number;
  if (sortBy === "path") {
    matches.sort((left, right) => left.relative.localeCompare(right.relative));
    if (sortOrder === "desc") matches.reverse();
    snapshotHash = sha256(canonicalJson(matches.map((entry) => ({ path: entry.relative, type: entry.type }))));
    if (decodedCursor && typeof decodedCursor !== "number") {
      if (decodedCursor.snapshot_hash !== snapshotHash) {
        throw new BridgeError("RESOURCE_CHANGED", "Glob results changed; restart matching without a cursor.", { retryable: true });
      }
      const marker = matches.findIndex((entry) => `${entry.type}:${entry.relative}` === decodedCursor.after_key);
      if (marker < 0) throw new BridgeError("RESOURCE_CHANGED", "Glob cursor marker no longer exists; restart matching.", { retryable: true });
      offset = marker + 1;
    }
    totalMatches = matches.length;
    hydrated = await mapConcurrent(matches.slice(offset, offset + maxResults), 32, async (entry) => {
      const metadata = await lstat(entry.absolute);
      return { ...entry, size: metadata.size, modified_at: metadata.mtime.toISOString(), modified_at_ms: metadata.mtimeMs };
    });
  } else {
    hydrated = await mapConcurrent(matches, 32, async (entry) => {
      const metadata = await lstat(entry.absolute);
      return { ...entry, size: metadata.size, modified_at: metadata.mtime.toISOString(), modified_at_ms: metadata.mtimeMs };
    });
    hydrated.sort((left, right) => {
      const primary = sortBy === "modified_at" ? left.modified_at_ms - right.modified_at_ms : left.size - right.size;
      const compared = primary || left.relative.localeCompare(right.relative);
      return sortOrder === "asc" ? compared : -compared;
    });
    snapshotHash = sha256(canonicalJson(hydrated.map((entry) => ({ path: entry.relative, type: entry.type, size: entry.size, modified_at: entry.modified_at }))));
    if (decodedCursor && typeof decodedCursor !== "number") {
      if (decodedCursor.snapshot_hash !== snapshotHash) {
        throw new BridgeError("RESOURCE_CHANGED", "Glob results changed; restart matching without a cursor.", { retryable: true });
      }
      const marker = hydrated.findIndex((entry) => `${entry.type}:${entry.relative}` === decodedCursor.after_key);
      if (marker < 0) throw new BridgeError("RESOURCE_CHANGED", "Glob cursor marker no longer exists; restart matching.", { retryable: true });
      offset = marker + 1;
    }
    totalMatches = hydrated.length;
    hydrated = hydrated.slice(offset, offset + maxResults);
  }
  const page: Array<{ path: string; type: "file" | "directory"; size: number; modified_at: string }> = [];
  let pageBytes = 2;
  for (const { relative: path, type, size, modified_at } of hydrated) {
    const item = { path, type, size, modified_at };
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (page.length > 0 && pageBytes + bytes > MAX_READ_BYTES) break;
    page.push(item);
    pageBytes += bytes;
  }
  const next = offset + page.length < totalMatches && page.length > 0
    ? encodeCollectionCursor({
        version: 1,
        kind: "glob",
        after_key: `${page.at(-1)!.type}:${page.at(-1)!.path}`,
        snapshot_hash: snapshotHash,
        signature,
      })
    : null;
  return { matches: page, total_matches: totalMatches, cursor: next, sort_by: sortBy, sort_order: sortOrder, snapshot_hash: snapshotHash };
}

export async function searchText(
  root: string,
  query: string,
  fileGlob: string,
  caseSensitive: boolean,
  cursor: unknown,
  maxResults: number,
): Promise<Record<string, unknown>> {
  const matcher = globMatcher(fileGlob);
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const signature = sha256(canonicalJson({ root: root.toLocaleLowerCase(), query, file_glob: fileGlob, case_sensitive: caseSensitive }));
  const decodedCursor = decodeCollectionCursor(cursor, "search", signature);
  const legacyOffset = typeof decodedCursor === "number" ? decodedCursor : 0;
  const page: Array<Record<string, unknown>> = [];
  const skippedLargeFiles: string[] = [];
  let pageBytes = 2;
  let totalMatches = 0;
  let markerSeen = decodedCursor === undefined || typeof decodedCursor === "number";
  let lastReturnedKey: string | undefined;
  let lastReturnedOrdinal: number | undefined;
  const snapshot = createHash("sha256");
  for (const entry of await walk(root)) {
    if (entry.type !== "file" || !matcher(entry.relative)) continue;
    const metadata = await stat(entry.absolute);
    if (metadata.size > MAX_SEARCH_FILE_BYTES) {
      if (skippedLargeFiles.length < 100) skippedLargeFiles.push(entry.relative);
      continue;
    }
    let decoded;
    try { decoded = decodeText(await readFile(entry.absolute)); }
    catch (error) {
      if (error instanceof BridgeError && ["PATH_IS_BINARY", "UNSUPPORTED_ENCODING"].includes(error.code)) continue;
      throw error;
    }
    for (const [index, line] of decoded.text.split(/\r?\n/).entries()) {
      const haystack = caseSensitive ? line : line.toLocaleLowerCase();
      if (!haystack.includes(needle)) continue;
      const lineHash = sha256(line);
      const key = `${entry.relative}:${index + 1}:${lineHash}`;
      snapshot.update(`${canonicalJson({ path: entry.relative, line: index + 1, line_sha256: lineHash })}\n`);
      if (decodedCursor && typeof decodedCursor !== "number" && !markerSeen && key === decodedCursor.after_key) {
        markerSeen = true;
        totalMatches += 1;
        continue;
      }
      if (markerSeen && totalMatches >= legacyOffset && page.length < maxResults) {
        const item = { path: entry.relative, line: index + 1, snippet: line.slice(0, 500) };
        const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (page.length === 0 || pageBytes + bytes <= MAX_READ_BYTES) {
          page.push(item);
          lastReturnedKey = key;
          lastReturnedOrdinal = totalMatches;
          pageBytes += bytes;
        }
      }
      totalMatches += 1;
      if (totalMatches > 100_000) throw new BridgeError("INVALID_ARGUMENT", "Search exceeded 100,000 matches; narrow the query.");
    }
  }
  const snapshotHash = snapshot.digest("hex");
  if (decodedCursor && typeof decodedCursor !== "number") {
    if (!markerSeen || decodedCursor.snapshot_hash !== snapshotHash) {
      throw new BridgeError("RESOURCE_CHANGED", "Search results changed; restart searching without a cursor.", { retryable: true });
    }
  }
  const hasMore = lastReturnedOrdinal !== undefined && lastReturnedOrdinal + 1 < totalMatches;
  return {
    matches: page,
    total_matches: totalMatches,
    cursor: hasMore && lastReturnedKey ? encodeCollectionCursor({ version: 1, kind: "search", after_key: lastReturnedKey, snapshot_hash: snapshotHash, signature }) : null,
    skipped_large_files: skippedLargeFiles,
    search_file_size_limit_bytes: MAX_SEARCH_FILE_BYTES,
    snapshot_hash: snapshotHash,
  };
}
