import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), "mirabridge-packages-"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

async function pack(workspace) {
  const { stdout } = await execFileAsync("npm", ["pack", "--workspace", workspace, "--pack-destination", temporary, "--json"], { encoding: "utf8" });
  const [result] = JSON.parse(stdout);
  if (!result?.filename) throw new Error(`npm pack did not return a filename for ${workspace}.`);
  return join(temporary, result.filename);
}

async function installAndRun(tarball, packagePath, entry, expected) {
  const prefix = join(temporary, packagePath);
  await execFileAsync("npm", ["install", "--prefix", prefix, "--no-save", "--package-lock=false", "--ignore-scripts", tarball], { encoding: "utf8" });
  const installed = join(prefix, "node_modules", "@mirabridge", packagePath, "dist", entry);
  const { stdout } = await execFileAsync(process.execPath, [installed, "--version"], { encoding: "utf8" });
  if (stdout.trim() !== expected) throw new Error(`Unexpected ${packagePath} version output: ${stdout.trim()}`);
  return stdout.trim();
}

try {
  const cli = await pack("@mirabridge/cli");
  const worker = await pack("@mirabridge/windows-worker");
  const results = await Promise.all([
    installAndRun(cli, "cli", "index.mjs", `mirabridge ${version}`),
    installAndRun(worker, "windows-worker", "index.cjs", `mirabridge-worker ${version}`),
  ]);
  process.stdout.write(`${JSON.stringify({ ok: true, installed_tarballs: 2, versions: results })}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
