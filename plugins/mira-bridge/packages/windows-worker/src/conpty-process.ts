import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BridgeError, MAX_RPC_MESSAGE_BYTES } from "../../protocol/src/index.js";

const execFileAsync = promisify(execFile);

export interface ConptyStart {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface ConptyControl {
  write(data: Buffer): Promise<void>;
  close(): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
}

export interface ConptyAvailability {
  available: boolean;
  helper_path: string;
  runtime_version: string | null;
  self_contained: boolean;
  reason: string | null;
}

export function conptyHostPath(entry = process.argv[1]): string {
  if (!entry) return "";
  return join(dirname(entry), "conpty-host", "MiraBridge.ConPtyHost.exe");
}

export async function conptyAvailability(entry = process.argv[1]): Promise<ConptyAvailability> {
  const helperPath = conptyHostPath(entry);
  if (process.platform !== "win32") return { available: false, helper_path: helperPath, runtime_version: null, self_contained: true, reason: "ConPTY requires Windows." };
  try {
    await access(helperPath);
    return { available: true, helper_path: helperPath, runtime_version: "self-contained", self_contained: true, reason: null };
  } catch { /* accept the 1.x framework-dependent assembly during in-place migration */ }
  const legacyPath = join(dirname(entry ?? ""), "conpty-host", "MiraBridge.ConPtyHost.dll");
  try { await access(legacyPath); }
  catch { return { available: false, helper_path: helperPath, runtime_version: null, self_contained: true, reason: "The packaged ConPTY host is missing." }; }
  try {
    const { stdout } = await execFileAsync("dotnet.exe", ["--list-runtimes"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    const runtime = stdout.split(/\r?\n/u).map((line) => line.match(/^Microsoft\.NETCore\.App\s+(10\.\d+\.\d+)/u)?.[1]).find(Boolean) ?? null;
    return runtime
      ? { available: true, helper_path: legacyPath, runtime_version: runtime, self_contained: false, reason: null }
      : { available: false, helper_path: legacyPath, runtime_version: null, self_contained: false, reason: ".NET 10 Runtime is not installed." };
  } catch {
    return { available: false, helper_path: legacyPath, runtime_version: null, self_contained: false, reason: "dotnet.exe is unavailable." };
  }
}

function writeLine(child: ChildProcessWithoutNullStreams, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > MAX_RPC_MESSAGE_BYTES) {
    return Promise.reject(new BridgeError("INVALID_ARGUMENT", "ConPTY control message exceeds 2 MiB."));
  }
  return new Promise((resolve, reject) => {
    child.stdin.write(line, "utf8", (error) => error ? reject(new BridgeError("TERMINAL_UNAVAILABLE", "ConPTY control input failed.", { cause: error, retryable: true })) : resolve());
  });
}

export async function spawnConpty(start: ConptyStart): Promise<{ child: ChildProcessWithoutNullStreams; control: ConptyControl }> {
  const availability = await conptyAvailability();
  if (!availability.available) {
    throw new BridgeError("TERMINAL_UNAVAILABLE", availability.reason ?? "ConPTY is unavailable.", {
      details: { ...availability },
    });
  }
  const child = spawn(availability.self_contained ? availability.helper_path : "dotnet.exe", availability.self_contained ? [] : [availability.helper_path], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await writeLine(child, { type: "start", ...start });
  let chain = Promise.resolve();
  const enqueue = (value: unknown): Promise<void> => {
    chain = chain.then(() => writeLine(child, value));
    return chain;
  };
  return {
    child,
    control: {
      write: async (data) => await enqueue({ type: "input", data_base64: data.toString("base64") }),
      close: async () => await enqueue({ type: "close" }),
      resize: async (cols, rows) => await enqueue({ type: "resize", cols, rows }),
    },
  };
}
