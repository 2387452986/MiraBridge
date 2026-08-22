import { spawn as nodeSpawn } from "node:child_process";
import { type Readable, type Writable } from "node:stream";
import { open } from "node:fs/promises";
import crossSpawn from "cross-spawn";
import { BridgeError, LOG_TAIL_BYTES, type OutputEncoding } from "../../protocol/src/index.js";
import { spawnConpty, type ConptyControl } from "./conpty-process.js";
import { assertOutputEncodingSupported, detectActiveConsoleCodePage, normalizeWindowsOutputStream } from "./windows-codepage.js";

export { transcodeWindowsCodePageStream } from "./windows-codepage.js";

export interface ProcessSpec {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  baseEnv?: Record<string, string>;
  stdinMode?: "closed" | "pipe" | "conpty";
  outputEncoding?: OutputEncoding;
  terminal?: { cols: number; rows: number };
}

export interface ProcessOutcome {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  pid: number;
  stdout: StreamCapture;
  stderr: StreamCapture;
  stdoutEncoding: string;
  stderrEncoding: string;
}

export interface StreamCapture {
  totalBytes: number;
  storedBytes: number;
  storageTruncated: boolean;
  omittedBytes: number;
}

function appendTail(current: Buffer<ArrayBufferLike>, incoming: Buffer<ArrayBufferLike>, limit: number): Buffer<ArrayBufferLike> {
  if (incoming.length >= limit) return Buffer.from(incoming.subarray(incoming.length - limit));
  if (current.length + incoming.length <= limit) return Buffer.concat([current, incoming]);
  return Buffer.concat([current.subarray(current.length + incoming.length - limit), incoming]);
}

export async function captureBoundedStream(
  stream: Readable,
  path: string,
  maxBytes: number,
  tailBytes = Math.min(LOG_TAIL_BYTES, Math.floor(maxBytes / 4)),
  onChunk?: (chunk: Buffer) => Promise<void> | void,
): Promise<StreamCapture> {
  const markerReserve = 256;
  const headLimit = Math.max(0, maxBytes - tailBytes - markerReserve);
  const handle = await open(path, "wx+", 0o600);
  let totalBytes = 0;
  let storageTruncated = false;
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      await onChunk?.(chunk);
      if (!storageTruncated && totalBytes + chunk.length <= maxBytes) {
        await handle.write(chunk, 0, chunk.length, totalBytes);
        totalBytes += chunk.length;
        continue;
      }
      if (!storageTruncated) {
        const existingTailLength = Math.max(0, totalBytes - headLimit);
        if (existingTailLength > 0) {
          const existingTail = Buffer.alloc(existingTailLength);
          const { bytesRead } = await handle.read(existingTail, 0, existingTail.length, headLimit);
          tail = appendTail(tail, existingTail.subarray(0, bytesRead), tailBytes);
        }
        if (totalBytes < headLimit) {
          const prefixLength = Math.min(headLimit - totalBytes, chunk.length);
          if (prefixLength > 0) await handle.write(chunk, 0, prefixLength, totalBytes);
          tail = appendTail(tail, chunk.subarray(prefixLength), tailBytes);
        } else {
          tail = appendTail(tail, chunk, tailBytes);
        }
        await handle.truncate(headLimit);
        storageTruncated = true;
      } else {
        tail = appendTail(tail, chunk, tailBytes);
      }
      totalBytes += chunk.length;
    }
    const omittedBytes = storageTruncated ? Math.max(0, totalBytes - headLimit - tail.length) : 0;
    if (storageTruncated) {
      const marker = Buffer.from(`\n[MiraBridge omitted ${omittedBytes} output bytes because the stream storage limit was reached.]\n`, "utf8");
      await handle.write(marker, 0, marker.length, headLimit);
      await handle.write(tail, 0, tail.length, headLimit + marker.length);
    }
    await handle.sync();
    const storedBytes = (await handle.stat()).size;
    return { totalBytes, storedBytes, storageTruncated, omittedBytes };
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function windowsProcessStartedAt(pid: number): Promise<string | null | undefined> {
  const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue; if ($null -eq $p) { exit 3 }; [Console]::Write($p.CreationDate.ToUniversalTime().ToString('o'))`;
  return await new Promise((resolve) => {
    const child = nodeSpawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 4096) chunks.push(chunk);
    });
    let settled = false;
    const finish = (value: string | null | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, 10_000);
    timer.unref();
    child.once("error", () => finish(undefined));
    child.once("exit", (code) => {
      if (code === 3) finish(null);
      else if (code === 0 && bytes <= 4096) finish(Buffer.concat(chunks).toString("utf8").trim() || undefined);
      else finish(undefined);
    });
  });
}

export async function processMatchesStart(pid: number, expectedStartedAt?: string): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processIsAlive(pid)) return false;
  if (process.platform !== "win32" || !expectedStartedAt) return true;
  const actual = await windowsProcessStartedAt(pid);
  if (actual === null) return false;
  if (actual === undefined) return false;
  const actualMs = Date.parse(actual);
  const expectedMs = Date.parse(expectedStartedAt);
  return Number.isFinite(actualMs) && Number.isFinite(expectedMs) && Math.abs(actualMs - expectedMs) <= 30_000;
}

export async function terminateProcessTree(pid: number, expectedStartedAt?: string): Promise<void> {
  if (expectedStartedAt && !await processMatchesStart(pid, expectedStartedAt)) {
    if (!processIsAlive(pid)) return;
    throw new BridgeError("INTERNAL_ERROR", "Refusing to terminate a PID whose process identity no longer matches the recorded Job.", {
      retryable: true,
      details: { pid, expected_started_at: expectedStartedAt },
    });
  }
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch { /* Process already exited. */ }
  } else {
    await new Promise<void>((resolve, reject) => {
      const killer = nodeSpawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      let settled = false;
      const finish = (error?: BridgeError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        killer.kill();
        finish(new BridgeError("INTERNAL_ERROR", "Windows process-tree termination timed out.", { retryable: true, details: { pid } }));
      }, 30_000);
      timer.unref();
      killer.once("exit", (code) => code === 0 || !processIsAlive(pid)
        ? finish()
        : finish(new BridgeError("INTERNAL_ERROR", "Windows could not terminate the recorded process tree.", { retryable: true, details: { pid, taskkill_exit_code: code } })));
      killer.once("error", (error) => !processIsAlive(pid)
        ? finish()
        : finish(new BridgeError("INTERNAL_ERROR", "Windows could not start taskkill for the recorded process tree.", { retryable: true, cause: error, details: { pid } })));
    });
  }
  for (let attempt = 0; attempt < 50 && processIsAlive(pid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  if (processIsAlive(pid)) throw new BridgeError("INTERNAL_ERROR", "The recorded process remained alive after process-tree termination.", { retryable: true, details: { pid } });
}

export async function executeProcess(
  spec: ProcessSpec,
  stdoutPath: string,
  stderrPath: string,
  onPid?: (pid: number) => void,
  maxStreamBytes = Number.MAX_SAFE_INTEGER,
  onStdin?: (input: Writable) => void,
  onTerminal?: (control: ConptyControl) => void,
  onStdoutChunk?: (chunk: Buffer) => Promise<void> | void,
): Promise<ProcessOutcome> {
  const started = Date.now();
  const conpty = spec.stdinMode === "conpty";
  const requestedEncoding = conpty ? "utf-8" : (spec.outputEncoding ?? "auto");
  let consoleCodePage = 65001;
  if (process.platform === "win32" && requestedEncoding !== "utf-8") {
    try { consoleCodePage = await detectActiveConsoleCodePage(); }
    catch (error) { throw new BridgeError("UNSUPPORTED_ENCODING", "The active Windows console output code page could not be detected.", { cause: error }); }
  }
  assertOutputEncodingSupported(requestedEncoding, consoleCodePage);
  let child;
  let terminalControl: ConptyControl | undefined;
  try {
    const environment = Object.fromEntries(Object.entries({
      ...(spec.baseEnv ?? process.env),
      ...spec.env,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    if (conpty) {
      if (!spec.terminal) throw new BridgeError("INVALID_ARGUMENT", "ConPTY requires terminal dimensions.");
      const session = await spawnConpty({ program: spec.program, args: spec.args, cwd: spec.cwd, env: environment, ...spec.terminal });
      child = session.child;
      terminalControl = session.control;
    } else {
      child = crossSpawn(spec.program, spec.args, {
        cwd: spec.cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: [spec.stdinMode === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
      });
    }
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("PROCESS_START_FAILED", "Windows process could not be started.", { cause: error });
  }
  type ChildResult = { kind: "closed"; exitCode: number | null } | { kind: "error"; error: BridgeError };
  let startedResolve: (value: number | BridgeError) => void = () => undefined;
  const startedChild = new Promise<number | BridgeError>((resolve) => { startedResolve = resolve; });
  let completedResolve: (value: ChildResult) => void = () => undefined;
  const completed = new Promise<ChildResult>((resolve) => { completedResolve = resolve; });
  let startedSettled = false;
  let completedSettled = false;
  const settleStarted = (): void => {
    if (startedSettled) return;
    startedSettled = true;
    startedResolve(child.pid ?? new BridgeError("PROCESS_START_FAILED", "Windows process did not return a PID."));
  };
  child.once("spawn", settleStarted);
  child.once("error", (error: NodeJS.ErrnoException) => {
    const mapped = error.code === "ENOENT"
      ? new BridgeError("PROGRAM_NOT_FOUND", `Program was not found: ${spec.program}`, { cause: error })
      : new BridgeError("PROCESS_START_FAILED", "Windows process could not be started.", { cause: error });
    if (!startedSettled) {
      startedSettled = true;
      startedResolve(mapped);
    }
    if (!completedSettled) {
      completedSettled = true;
      completedResolve({ kind: "error", error: mapped });
    }
  });
  child.once("close", (code) => {
    if (!completedSettled) {
      completedSettled = true;
      completedResolve({ kind: "closed", exitCode: code });
    }
  });
  if (typeof child.pid === "number") settleStarted();
  if (!completedSettled && (child.exitCode !== null || child.signalCode !== null)) {
    completedSettled = true;
    completedResolve({ kind: "closed", exitCode: child.exitCode });
  }
  if (!child.stdout || !child.stderr) throw new BridgeError("PROCESS_START_FAILED", "Windows process output pipes are unavailable.");
  const stdoutOutput = normalizeWindowsOutputStream(child.stdout, requestedEncoding, consoleCodePage);
  const stderrOutput = normalizeWindowsOutputStream(child.stderr, conpty ? "utf-8" : requestedEncoding, consoleCodePage);
  const stdoutCapture = captureBoundedStream(stdoutOutput.stream, stdoutPath, maxStreamBytes, undefined, onStdoutChunk);
  const stderrCapture = captureBoundedStream(stderrOutput.stream, stderrPath, maxStreamBytes);
  const startedResult = await startedChild;
  if (startedResult instanceof BridgeError) {
    await Promise.allSettled([stdoutCapture, stderrCapture, completed]);
    throw startedResult;
  }
  const pid = startedResult;
  onPid?.(pid);
  if (terminalControl) onTerminal?.(terminalControl);
  if (spec.stdinMode === "pipe") {
    if (!child.stdin) {
      await terminateProcessTree(pid);
      throw new BridgeError("PROCESS_START_FAILED", "Windows process stdin pipe is unavailable.");
    }
    onStdin?.(child.stdin);
  }
  let timedOut = false;
  let timeoutTermination: Promise<void> | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    timeoutTermination = terminateProcessTree(pid).catch((error: unknown) => {
      const mapped = error instanceof BridgeError
        ? error
        : new BridgeError("INTERNAL_ERROR", "Timed-out process-tree termination failed.", { retryable: true, cause: error, details: { pid } });
      stdoutOutput.stream.destroy(mapped);
      stderrOutput.stream.destroy(mapped);
      child.stdout?.destroy(mapped);
      child.stderr?.destroy(mapped);
      if (!completedSettled) {
        completedSettled = true;
        completedResolve({ kind: "error", error: mapped });
      }
    });
  }, spec.timeoutMs);

  const childResult = await completed.finally(() => clearTimeout(timeoutTimer));
  if (timeoutTermination) await timeoutTermination;
  if (childResult.kind === "error") {
    await Promise.allSettled([stdoutCapture, stderrCapture, stdoutOutput.resolvedEncoding, stderrOutput.resolvedEncoding]);
    throw childResult.error;
  }
  const [stdout, stderr, stdoutEncoding, stderrEncoding] = await Promise.all([
    stdoutCapture,
    stderrCapture,
    stdoutOutput.resolvedEncoding,
    stderrOutput.resolvedEncoding,
  ]);
  return { exitCode: childResult.exitCode, timedOut, durationMs: Date.now() - started, pid, stdout, stderr, stdoutEncoding, stderrEncoding };
}

export async function findPowerShell(): Promise<string> {
  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    const found = await new Promise<boolean>((resolve) => {
      const probe = nodeSpawn("where.exe", [candidate], { windowsHide: true, stdio: "ignore" });
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => { probe.kill(); finish(false); }, 5_000);
      timer.unref();
      probe.once("exit", (code) => finish(code === 0));
      probe.once("error", () => finish(false));
    });
    if (found) return candidate;
  }
  throw new BridgeError("PROGRAM_NOT_FOUND", "PowerShell was not found on the Windows node.");
}

export function encodePowerShell(script: string): string {
  const prelude = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $OutputEncoding=[Text.UTF8Encoding]::new();";
  return Buffer.from(`${prelude}\n${script}`, "utf16le").toString("base64");
}
