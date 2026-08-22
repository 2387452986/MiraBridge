import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { BridgeError, MAX_RPC_MESSAGE_BYTES } from "../../protocol/src/index.js";
import { encodePowerShell, findPowerShell, terminateProcessTree } from "./process-exec.js";

const PIPE_PREFIX = "\\\\.\\pipe\\MiraBridge-";
const RUNNER_START_TIMEOUT_MS = 15_000;
const LAUNCH_OUTPUT_LIMIT_BYTES = 64 * 1024;

export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

function capture(child: ReturnType<typeof spawn>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: { exitCode: number | null; stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? { exitCode: null, stdout: "", stderr: "" });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new BridgeError("PROCESS_START_FAILED", "Persistent runner launcher timed out."));
    }, RUNNER_START_TIMEOUT_MS);
    timer.unref();
    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > LAUNCH_OUTPUT_LIMIT_BYTES) {
        child.kill();
        finish(new BridgeError("PROCESS_START_FAILED", "Persistent runner launcher produced excessive output."));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", (error) => finish(new BridgeError("PROCESS_START_FAILED", "Persistent runner launcher could not start.", { cause: error })));
    child.once("close", (exitCode) => finish(undefined, {
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function createPersistentProcess(commandLine: string): Promise<number> {
  const encodedCommandLine = Buffer.from(commandLine, "utf16le").toString("base64");
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    `$commandLine=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedCommandLine}'))`,
    "$created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$commandLine}",
    "[pscustomobject]@{ReturnValue=[int]$created.ReturnValue;ProcessId=[int]$created.ProcessId}|ConvertTo-Json -Compress",
    "if ([int]$created.ReturnValue -ne 0) { exit 1 }",
  ].join(";");
  const child = spawn(await findPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = await capture(child);
  let decoded: { ReturnValue?: unknown; ProcessId?: unknown };
  try {
    decoded = JSON.parse(result.stdout.trim()) as { ReturnValue?: unknown; ProcessId?: unknown };
  } catch (error) {
    throw new BridgeError("PROCESS_START_FAILED", "Persistent runner launcher returned invalid output.", {
      cause: error,
      details: { exit_code: result.exitCode, stderr: result.stderr.slice(-2048) },
    });
  }
  if (result.exitCode !== 0 || decoded.ReturnValue !== 0 || !Number.isInteger(decoded.ProcessId) || Number(decoded.ProcessId) <= 0) {
    throw new BridgeError("PROCESS_START_FAILED", "Windows could not create the persistent Job runner.", {
      details: { exit_code: result.exitCode, wmi_return_value: decoded.ReturnValue, stderr: result.stderr.slice(-2048) },
    });
  }
  return Number(decoded.ProcessId);
}

export async function launchPersistentRunner(entry: string, bootstrap: unknown): Promise<number> {
  if (process.platform !== "win32") throw new BridgeError("PROCESS_START_FAILED", "Persistent Job runners require Windows.");
  const payload = JSON.stringify(bootstrap);
  if (Buffer.byteLength(payload) > MAX_RPC_MESSAGE_BYTES) {
    throw new BridgeError("INVALID_ARGUMENT", "Job bootstrap payload exceeds 2 MiB.");
  }
  const pipePath = `${PIPE_PREFIX}${randomUUID()}`;
  const pipeArgument = Buffer.from(pipePath, "utf8").toString("base64url");
  const commandLine = [process.execPath, entry, "internal-run-job-pipe", pipeArgument].map(quoteWindowsArgument).join(" ");
  const server = createServer();
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  let deliverResolve: () => void = () => undefined;
  let deliverReject: (error: Error) => void = () => undefined;
  const delivered = new Promise<void>((resolve, reject) => {
    deliverResolve = resolve;
    deliverReject = reject;
  });
  let accepted = false;
  server.on("connection", (socket) => {
    if (accepted) {
      socket.destroy();
      return;
    }
    accepted = true;
    socket.once("error", deliverReject);
    socket.end(payload, "utf8", deliverResolve);
  });
  await listening;
  let runnerPid: number | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    runnerPid = await createPersistentProcess(commandLine);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BridgeError("PROCESS_START_FAILED", "Persistent Job runner did not connect to its bootstrap pipe.")), RUNNER_START_TIMEOUT_MS);
    });
    await Promise.race([delivered, timeout]);
    return runnerPid;
  } catch (error) {
    if (runnerPid) await terminateProcessTree(runnerPid);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
  }
}

export async function readPersistentRunnerBootstrap(encodedPipePath: string): Promise<string> {
  const pipePath = Buffer.from(encodedPipePath, "base64url").toString("utf8");
  if (!pipePath.startsWith(PIPE_PREFIX) || pipePath.length > 256) {
    throw new BridgeError("INVALID_ARGUMENT", "Persistent runner pipe path is invalid.");
  }
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const socket = createConnection(pipePath);
    socket.setTimeout(RUNNER_START_TIMEOUT_MS, () => socket.destroy(new Error("Bootstrap pipe timed out.")));
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_RPC_MESSAGE_BYTES) {
        socket.destroy(new Error("Bootstrap pipe payload exceeds 2 MiB."));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("error", (error) => reject(new BridgeError("PROCESS_START_FAILED", "Persistent runner could not read its bootstrap pipe.", { cause: error })));
  });
}
