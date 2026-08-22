import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), "mirabridge-cli-"));
const config = join(temporary, "config.toml");
const executable = resolve("packages/cli/dist/index.mjs");
const env = { ...process.env, MIRABRIDGE_CONFIG: config };
try {
  await execFileAsync(process.execPath, [executable, "init"], { env, encoding: "utf8" });
  const listed = await execFileAsync(process.execPath, [executable, "node", "list"], { env, encoding: "utf8" });
  const doctor = await execFileAsync(process.execPath, [executable, "doctor"], { env, encoding: "utf8" });
  const listResult = JSON.parse(listed.stdout);
  const doctorResult = JSON.parse(doctor.stdout);
  const hosts = await readFile(join(temporary, "known_hosts"), "utf8");
  if (!Array.isArray(listResult.nodes) || listResult.nodes.length !== 0) throw new Error("Fresh CLI config should contain no nodes.");
  if (!doctorResult.ok || !doctorResult.node_24) throw new Error("CLI doctor did not accept the isolated Node 24 runtime.");
  if (hosts !== "") throw new Error("Fresh managed known_hosts should be empty.");
  process.stdout.write(`${JSON.stringify({ ok: true, init: true, nodes: 0, doctor: true })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
