import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (process.platform !== "win32") throw new Error("backup-worker-state.mjs must run on Windows.");
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA is not set.");

const dataRoot = join(localAppData, "MiraBridge");
const timestamp = new Date().toISOString().replaceAll(/[-:.]/gu, "");
const destination = resolve(process.argv[2] ?? join(dataRoot, "backups", `pre-upgrade-${timestamp}`));
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination, { recursive: false });

const sourceDatabase = join(dataRoot, "state.sqlite3");
const targetDatabase = join(destination, "state.sqlite3");
const sourceConfig = join(dataRoot, "worker.toml");
const targetConfig = join(destination, "worker.toml");
await copyFile(sourceConfig, targetConfig);

const database = new DatabaseSync(sourceDatabase);
try {
  const sqlPath = targetDatabase.replaceAll("'", "''");
  database.exec(`VACUUM INTO '${sqlPath}'`);
} finally {
  database.close();
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

process.stdout.write(`${JSON.stringify({
  backup_directory: destination,
  config: { path: targetConfig, sha256: await digest(targetConfig) },
  database: { path: targetDatabase, sha256: await digest(targetDatabase) },
}, null, 2)}\n`);
