import { spawn } from "node:child_process";
import { Transform, type Readable } from "node:stream";
import { BridgeError, type OutputEncoding } from "../../protocol/src/index.js";

const AUTO_SAMPLE_BYTES = 8 * 1024;
const AUTO_SAMPLE_DELAY_MS = 100;

export function windowsCodePageLabel(codePage: number): string | null {
  return codePage === 65001 ? "utf-8"
    : codePage === 936 ? "gbk"
      : codePage === 950 ? "big5"
        : codePage === 932 ? "shift_jis"
          : codePage === 949 ? "euc-kr"
            : codePage === 54936 ? "gb18030"
              : codePage === 874 ? "windows-874"
                : codePage >= 1250 && codePage <= 1258 ? `windows-${codePage}`
                  : null;
}

let activeConsoleCodePage: Promise<number> | undefined;

export async function detectActiveConsoleCodePage(): Promise<number> {
  activeConsoleCodePage ??= new Promise<number>((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/c", "chcp"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? 65001);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("cmd.exe code-page detection timed out."));
    }, 5_000);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 4096) chunks.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      const match = Buffer.concat(chunks).toString("ascii").match(/\b(\d{3,5})\b/u);
      if (code === 0 && bytes <= 4096 && match?.[1]) finish(undefined, Number(match[1]));
      else finish(new Error("cmd.exe did not report an active output code page."));
    });
  });
  try { return await activeConsoleCodePage; }
  catch (error) {
    activeConsoleCodePage = undefined;
    throw error;
  }
}

function codePageFromRequest(requested: OutputEncoding, consoleCodePage: number): number | null {
  if (requested === "utf-8") return 65001;
  if (requested === "console" || requested === "auto") return consoleCodePage;
  return Number(requested.slice(2));
}

function decoderForCodePage(codePage: number): TextDecoder {
  const label = windowsCodePageLabel(codePage);
  if (!label) {
    throw new BridgeError("UNSUPPORTED_ENCODING", `Windows output code page ${codePage} is not supported.`, {
      details: { code_page: codePage },
    });
  }
  try { return new TextDecoder(label, { fatal: true }); }
  catch (error) {
    throw new BridgeError("UNSUPPORTED_ENCODING", `This Node.js runtime cannot decode Windows code page ${codePage}.`, {
      cause: error,
      details: { code_page: codePage, label },
    });
  }
}

function invalidEncodedData(codePage: number, error: unknown): BridgeError {
  const encoding = codePage === 65001 ? "utf-8" : `cp${codePage}`;
  return new BridgeError("UNSUPPORTED_ENCODING", `Process output is not valid ${encoding}; use output_encoding=auto or select the matching Windows code page.`, {
    cause: error,
    details: { requested_encoding: encoding },
  });
}

export function isWindowsCodePageSupported(codePage: number): boolean {
  try { decoderForCodePage(codePage); return true; }
  catch { return false; }
}

export function assertOutputEncodingSupported(requested: OutputEncoding, consoleCodePage: number): void {
  if (requested === "auto") return;
  const codePage = codePageFromRequest(requested, consoleCodePage);
  if (codePage === null) throw new BridgeError("UNSUPPORTED_ENCODING", `Unsupported output encoding: ${requested}`);
  decoderForCodePage(codePage);
}

function decodeTransform(codePage: number): Transform {
  const decoder = decoderForCodePage(codePage);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      try { callback(null, Buffer.from(decoder.decode(chunk, { stream: true }), "utf8")); }
      catch (error) { callback(invalidEncodedData(codePage, error)); }
    },
    flush(callback): void {
      try { callback(null, Buffer.from(decoder.decode(), "utf8")); }
      catch (error) { callback(invalidEncodedData(codePage, error)); }
    },
  });
}

function isPotentialUtf8(value: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value, { stream: true });
    return true;
  } catch {
    return false;
  }
}

class AutoDecodeTransform extends Transform {
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private decoder: TextDecoder | undefined;
  private selectedCodePage: number | undefined;
  private utf8CommittedNonAscii = false;
  private timer: NodeJS.Timeout | undefined;
  private resolveEncoding: (value: string) => void = () => undefined;
  private rejectEncoding: (error: Error) => void = () => undefined;
  private encodingSettled = false;
  readonly resolvedEncoding = new Promise<string>((resolve, reject) => {
    this.resolveEncoding = resolve;
    this.rejectEncoding = reject;
  });

  constructor(private readonly consoleCodePage: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      if (this.decoder) {
        try {
          const decoded = this.decoder.decode(chunk, { stream: true });
          if (this.selectedCodePage === 65001 && chunk.some((byte) => byte >= 0x80)) this.utf8CommittedNonAscii = true;
          this.push(Buffer.from(decoded, "utf8"));
        } catch (error) {
          if (this.selectedCodePage === 65001 && !this.utf8CommittedNonAscii) {
            this.selectedCodePage = this.consoleCodePage;
            this.decoder = decoderForCodePage(this.consoleCodePage);
            this.push(Buffer.from(this.decoder.decode(chunk, { stream: true }), "utf8"));
          } else {
            throw new BridgeError("UNSUPPORTED_ENCODING", "Process output is not valid in its detected encoding; set output_encoding explicitly.", {
              cause: error,
              details: { detected_encoding: this.selectedCodePage === 65001 ? "utf-8" : `cp${this.selectedCodePage}` },
            });
          }
        }
        callback();
        return;
      }
      const copy = Buffer.from(chunk);
      this.pending.push(copy);
      this.pendingBytes += copy.length;
      const sample = Buffer.concat(this.pending, this.pendingBytes);
      if (!isPotentialUtf8(sample) || this.pendingBytes >= AUTO_SAMPLE_BYTES) this.chooseEncoding();
      else if (!this.timer) {
        this.timer = setTimeout(() => this.chooseEncoding(), AUTO_SAMPLE_DELAY_MS);
        this.timer.unref();
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.chooseEncoding();
      const final = this.decoder?.decode() ?? "";
      if (final) this.push(Buffer.from(final, "utf8"));
      this.settleEncoding();
      callback();
    } catch (error) {
      this.failEncoding(error as Error);
      callback(error as Error);
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timer) clearTimeout(this.timer);
    if (error) this.failEncoding(error);
    callback(error);
  }

  private chooseEncoding(): void {
    if (this.decoder) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const buffered = Buffer.concat(this.pending, this.pendingBytes);
    const utf8 = isPotentialUtf8(buffered);
    const codePage = utf8 ? 65001 : this.consoleCodePage;
    this.selectedCodePage = codePage;
    this.decoder = decoderForCodePage(codePage);
    this.pending.length = 0;
    this.pendingBytes = 0;
    const decoded = this.decoder.decode(buffered, { stream: true });
    if (codePage === 65001 && buffered.some((byte) => byte >= 0x80)) this.utf8CommittedNonAscii = true;
    if (decoded) this.push(Buffer.from(decoded, "utf8"));
  }

  private settleEncoding(): void {
    if (this.encodingSettled) return;
    this.encodingSettled = true;
    const codePage = this.selectedCodePage ?? 65001;
    this.resolveEncoding(codePage === 65001 ? "utf-8" : `cp${codePage}`);
  }

  private failEncoding(error: Error): void {
    if (this.encodingSettled) return;
    this.encodingSettled = true;
    this.rejectEncoding(error);
  }
}

export interface NormalizedOutput {
  stream: Readable;
  resolvedEncoding: Promise<string>;
}

export function normalizeWindowsOutputStream(
  stream: Readable,
  requested: OutputEncoding,
  consoleCodePage: number,
): NormalizedOutput {
  if (requested === "auto") {
    const transform = new AutoDecodeTransform(consoleCodePage);
    return { stream: stream.pipe(transform), resolvedEncoding: transform.resolvedEncoding };
  }
  const codePage = codePageFromRequest(requested, consoleCodePage);
  if (codePage === null) throw new BridgeError("UNSUPPORTED_ENCODING", `Unsupported output encoding: ${requested}`);
  const transform = decodeTransform(codePage);
  return {
    stream: stream.pipe(transform),
    resolvedEncoding: Promise.resolve(codePage === 65001 ? "utf-8" : `cp${codePage}`),
  };
}

export function transcodeWindowsCodePageStream(stream: Readable, codePage: number): Readable {
  return stream.pipe(decodeTransform(codePage));
}
