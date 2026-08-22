import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import { BridgeError, macConfigSchema, type MacConfig, type NodeConfig } from "../../protocol/src/index.js";

export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return resolve(value);
}

export function defaultConfigPath(): string {
  if (process.env.MIRABRIDGE_CONFIG) return expandUserPath(process.env.MIRABRIDGE_CONFIG);
  const base = process.env.XDG_CONFIG_HOME ? expandUserPath(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config");
  return join(base, "mirabridge", "config.toml");
}

export function knownHostsPath(configPath = defaultConfigPath()): string {
  return join(dirname(configPath), "known_hosts");
}

export async function ensureConfigDirectory(configPath = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
}

export async function loadMacConfig(configPath = defaultConfigPath()): Promise<MacConfig> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nodes: {} };
    throw error;
  }
  const parsed = macConfigSchema.safeParse(parse(text));
  if (!parsed.success) {
    throw new BridgeError("INVALID_ARGUMENT", "MiraBridge node configuration is invalid.", {
      details: { path: configPath, issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    });
  }
  return {
    nodes: Object.fromEntries(
      Object.entries(parsed.data.nodes).map(([nodeId, node]) => [nodeId, { ...node, identity_file: expandUserPath(node.identity_file) }]),
    ),
  };
}

export async function writeMacConfig(config: MacConfig, configPath = defaultConfigPath()): Promise<MacConfig> {
  const parsed = macConfigSchema.parse(config);
  await ensureConfigDirectory(configPath);
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(stringify(parsed), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, configPath);
  await chmod(configPath, 0o600);
  return parsed;
}

export async function requireNode(nodeId: string, configPath = defaultConfigPath()): Promise<NodeConfig> {
  const config = await loadMacConfig(configPath);
  const node = config.nodes[nodeId];
  if (!node) throw new BridgeError("NODE_NOT_FOUND", `Windows node '${nodeId}' is not configured.`, { details: { node_id: nodeId } });
  return node;
}
