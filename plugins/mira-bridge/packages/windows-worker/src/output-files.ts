import { open, stat } from "node:fs/promises";
import { DEFAULT_INLINE_OUTPUT_BYTES } from "../../protocol/src/index.js";

async function readRange(path: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function trimIncompleteUtf8End(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  for (let removed = 0; removed <= Math.min(3, buffer.length); removed += 1) {
    const candidate = buffer.subarray(0, buffer.length - removed);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      return candidate;
    } catch { /* only a split trailing code point is expected in normalized logs */ }
  }
  return Buffer.alloc(0);
}

function trimSplitUtf8Start(buffer: Buffer): { buffer: Buffer; skipped: number } {
  let skipped = 0;
  while (skipped < Math.min(3, buffer.length) && isContinuation(buffer[skipped])) skipped += 1;
  return { buffer: buffer.subarray(skipped), skipped };
}

export async function previewFile(path: string, limit = DEFAULT_INLINE_OUTPUT_BYTES): Promise<{ truncated: boolean; total_bytes: number; text?: string; head?: string; tail?: string }> {
  const size = (await stat(path)).size;
  if (size <= limit) {
    return { truncated: false, total_bytes: size, text: (await readRange(path, 0, size)).toString("utf8") };
  }
  const headBytes = Math.floor(limit / 2);
  const tailBytes = limit - headBytes;
  const [head, tail] = await Promise.all([readRange(path, 0, headBytes), readRange(path, size - tailBytes, tailBytes)]);
  const safeHead = trimIncompleteUtf8End(head);
  const safeTail = trimSplitUtf8Start(tail).buffer;
  return { truncated: true, total_bytes: size, head: safeHead.toString("utf8"), tail: safeTail.toString("utf8") };
}

export async function readOutputRange(path: string, offset: number, maxBytes: number, tailLines?: number): Promise<Record<string, unknown>> {
  const size = (await stat(path)).size;
  if (tailLines !== undefined) {
    const scanBytes = Math.min(size, Math.max(maxBytes, 2 * 1024 * 1024));
    const start = size - scanBytes;
    const safeScan = trimSplitUtf8Start(await readRange(path, start, scanBytes));
    const scanned = trimIncompleteUtf8End(safeScan.buffer).toString("utf8");
    const lines = scanned.split(/\r?\n/);
    const text = lines.slice(Math.max(0, lines.length - tailLines - 1)).join("\n");
    const encoded = Buffer.from(text, "utf8");
    const bounded = trimSplitUtf8Start(encoded.subarray(Math.max(0, encoded.length - maxBytes))).buffer;
    return { text: bounded.toString("utf8"), offset: Math.max(0, size - bounded.length), bytes: bounded.length, total_bytes: size, eof: true };
  }
  const requestedOffset = Math.min(offset, size);
  const raw = await readRange(path, requestedOffset, Math.min(maxBytes, size - requestedOffset));
  const start = trimSplitUtf8Start(raw);
  const bytes = trimIncompleteUtf8End(start.buffer);
  const boundedOffset = requestedOffset + start.skipped;
  const consumed = bytes.length || raw.length;
  const nextOffset = bytes.length ? boundedOffset + bytes.length : requestedOffset + consumed;
  return {
    text: bytes.toString("utf8"),
    requested_offset: requestedOffset,
    offset: boundedOffset,
    bytes: consumed,
    next_offset: nextOffset,
    total_bytes: size,
    eof: nextOffset >= size,
  };
}
