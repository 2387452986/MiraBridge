import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { BridgeError, workerConfigSchema, type WorkerConfig } from "../../protocol/src/index.js";

export function workerDataRoot(): string {
  const base = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return resolve(base, "MiraBridge");
}

export function workerConfigPath(): string {
  return resolve(process.env.MIRABRIDGE_WORKER_CONFIG || join(workerDataRoot(), "worker.toml"));
}

export async function loadWorkerConfig(path = workerConfigPath()): Promise<WorkerConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BridgeError("INVALID_ARGUMENT", `Worker configuration was not found at ${path}.`, { details: { path } });
    }
    throw error;
  }
  const parsed = workerConfigSchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new BridgeError("INVALID_ARGUMENT", "MiraBridge worker configuration is invalid.", {
      details: { path, issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    });
  }
  return parsed.data;
}

export function defaultWorkerConfig(root = join(homedir(), "MiraBridge")): WorkerConfig {
  return workerConfigSchema.parse({
    allowed_roots: [resolve(root)],
    desktop_access: "read-write",
    recycle_bin_enabled: true,
    web_snapshot_enabled: true,
    web_snapshot_allow_external: false,
  });
}

export async function writeWorkerConfig(config: WorkerConfig, path = workerConfigPath()): Promise<WorkerConfig> {
  const parsed = workerConfigSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(stringify(parsed), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await copyFile(path, `${path}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(temporary, path);
  return parsed;
}

export async function initializeWorkerConfig(path = workerConfigPath(), root?: string): Promise<{ config: WorkerConfig; created: boolean }> {
  try {
    return { config: await loadWorkerConfig(path), created: false };
  } catch (error) {
    if (!(error instanceof BridgeError) || !error.message.includes("was not found")) throw error;
  }
  const config = await writeWorkerConfig(defaultWorkerConfig(root), path);
  await ensureWorkerDirectories(workerDataRoot(), path);
  return { config, created: true };
}

export async function addAllowedRoot(root: string, path = workerConfigPath()): Promise<WorkerConfig> {
  const config = await loadWorkerConfig(path);
  const canonical = resolve(root);
  const exists = config.allowed_roots.some((value) => resolve(value).toLocaleLowerCase() === canonical.toLocaleLowerCase());
  return exists ? config : await writeWorkerConfig({ ...config, allowed_roots: [...config.allowed_roots, canonical] }, path);
}

export async function removeAllowedRoot(root: string, path = workerConfigPath()): Promise<WorkerConfig> {
  const config = await loadWorkerConfig(path);
  const canonical = resolve(root).toLocaleLowerCase();
  const allowedRoots = config.allowed_roots.filter((value) => resolve(value).toLocaleLowerCase() !== canonical);
  if (allowedRoots.length === config.allowed_roots.length) {
    throw new BridgeError("PATH_NOT_FOUND", `Allowed root is not configured: ${root}`, { details: { root } });
  }
  if (allowedRoots.length === 0) throw new BridgeError("INVALID_ARGUMENT", "At least one allowed root is required.");
  return await writeWorkerConfig({ ...config, allowed_roots: allowedRoots }, path);
}

export type WorkerCapability = "desktop" | "recycle-bin" | "web-snapshot" | "web-snapshot-external";

export async function setWorkerCapability(capability: WorkerCapability, value: string, path = workerConfigPath()): Promise<WorkerConfig> {
  const config = await loadWorkerConfig(path);
  let updated: WorkerConfig;
  if (capability === "desktop") {
    if (!(["disabled", "read-only", "read-write"] as const).includes(value as "disabled" | "read-only" | "read-write")) {
      throw new BridgeError("INVALID_ARGUMENT", "Desktop capability must be disabled, read-only, or read-write.");
    }
    updated = { ...config, desktop_access: value as WorkerConfig["desktop_access"] };
  } else {
    if (value !== "true" && value !== "false") throw new BridgeError("INVALID_ARGUMENT", `${capability} capability must be true or false.`);
    const enabled = value === "true";
    if (capability === "recycle-bin") updated = { ...config, recycle_bin_enabled: enabled };
    else if (capability === "web-snapshot") updated = { ...config, web_snapshot_enabled: enabled };
    else updated = { ...config, web_snapshot_allow_external: enabled };
  }
  return await writeWorkerConfig(updated, path);
}

export async function ensureWorkerDirectories(root = workerDataRoot(), configPath = workerConfigPath()): Promise<void> {
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(join(root, "jobs"), { recursive: true }),
    mkdir(join(root, "outputs"), { recursive: true }),
    mkdir(join(root, "transfers"), { recursive: true }),
    mkdir(join(root, "audit"), { recursive: true }),
    mkdir(dirname(configPath), { recursive: true }),
  ]);
}
