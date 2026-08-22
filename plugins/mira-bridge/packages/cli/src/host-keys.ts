import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { BridgeError } from "../../protocol/src/index.js";

const execFileAsync = promisify(execFile);

export interface ScannedHostKey {
  line: string;
  fingerprint: string;
}

export async function fingerprintHostKey(keyLine: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("ssh-keygen", ["-lf", "-", "-E", "sha256"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      const match = /SHA256:[A-Za-z0-9+/=]+/u.exec(stdout);
      if (code === 0 && match) resolve(match[0]);
      else reject(new BridgeError("INTERNAL_ERROR", `ssh-keygen could not fingerprint the host key: ${stderr.trim()}`));
    });
    child.stdin.end(`${keyLine}\n`);
  });
}

export async function scanHostKeys(host: string, port: number): Promise<ScannedHostKey[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ssh-keyscan", ["-p", String(port), "-T", "10", host], { encoding: "utf8", timeout: 15_000 }));
  } catch (error) {
    throw new BridgeError("NODE_OFFLINE", `Could not scan SSH host keys for ${host}:${port}.`, { retryable: true, cause: error });
  }
  const lines = stdout.split(/\r?\n/u).filter((value) => value && !value.startsWith("#"));
  if (!lines.length) throw new BridgeError("NODE_OFFLINE", "ssh-keyscan did not return a host key.", { retryable: true });
  return await Promise.all(lines.map(async (line) => ({ line, fingerprint: await fingerprintHostKey(line) })));
}

export function selectHostKey(candidates: ScannedHostKey[], expected?: string): ScannedHostKey {
  const selected = expected
    ? candidates.find((candidate) => candidate.fingerprint === expected)
    : candidates.find((candidate) => candidate.line.includes(" ssh-ed25519 ")) ?? candidates[0];
  if (!selected) {
    throw new BridgeError(
      expected ? "HOST_KEY_MISMATCH" : "NODE_OFFLINE",
      expected
        ? "No scanned SSH host key matches the independently verified fingerprint."
        : "ssh-keyscan did not return a usable host key.",
      {
        retryable: !expected,
        details: expected ? { expected, scanned: candidates.map((candidate) => candidate.fingerprint) } : {},
      },
    );
  }
  return selected;
}
