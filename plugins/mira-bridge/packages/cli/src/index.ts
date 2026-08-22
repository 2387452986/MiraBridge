import { execFile } from "node:child_process";
import { access, appendFile, chmod, open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { BridgeError, MIRABRIDGE_VERSION, assertNodeId, nodeConfigSchema, type NodeConfig } from "../../protocol/src/index.js";
import { defaultConfigPath, ensureConfigDirectory, expandUserPath, knownHostsPath, loadMacConfig, writeMacConfig } from "../../mcp-server/src/config.js";
import { SshPool } from "../../mcp-server/src/ssh-rpc.js";
import { scanHostKeys, selectHostKey } from "./host-keys.js";
import { installMac, uninstallMac, updateMac } from "./installation.js";
import { acceptPairingResponse, createPairingRequest, listPairings, revokePairing } from "./pairing-client.js";

const execFileAsync = promisify(execFile);

function flags(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new BridgeError("INVALID_ARGUMENT", `Unexpected argument: ${key ?? ""}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new BridgeError("INVALID_ARGUMENT", `Missing value for ${key}.`);
    parsed.set(key.slice(2), value);
    index += 1;
  }
  return parsed;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new BridgeError("INVALID_ARGUMENT", `--${name} is required.`);
  return value;
}

async function init(): Promise<void> {
  const configPath = defaultConfigPath();
  await ensureConfigDirectory(configPath);
  try { await access(configPath); }
  catch { await writeMacConfig({ nodes: {} }, configPath); }
  const hosts = knownHostsPath(configPath);
  const handle = await open(hosts, "a", 0o600);
  await handle.close();
  await chmod(hosts, 0o600);
  process.stdout.write(`MiraBridge configuration: ${configPath}\nManaged known_hosts: ${hosts}\n`);
}

async function confirmFingerprint(value: string): Promise<void> {
  if (!process.stdin.isTTY) throw new BridgeError("HOST_KEY_MISMATCH", "Pass --fingerprint with an independently verified SHA-256 value in non-interactive mode.");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`Candidate SSH host fingerprint: ${value}\nCompare it on Windows, then type yes to trust it: `);
  prompt.close();
  if (answer.trim() !== "yes") throw new BridgeError("HOST_KEY_MISMATCH", "Host key was not approved.");
}

async function addNode(values: string[]): Promise<void> {
  const options = flags(values);
  const nodeId = required(options, "id");
  assertNodeId(nodeId);
  const host = required(options, "host");
  const port = Number(options.get("port") ?? "22");
  const user = required(options, "user");
  const connectTimeoutMs = Number(options.get("connect-timeout-ms") ?? "10000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BridgeError("INVALID_ARGUMENT", "--port must be an integer from 1 to 65535.");
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 100 || connectTimeoutMs > 120_000) {
    throw new BridgeError("INVALID_ARGUMENT", "--connect-timeout-ms must be an integer from 100 to 120000.");
  }
  const identityFile = resolve(expandUserPath(required(options, "identity-file")));
  await access(identityFile);
  const mode = (await stat(identityFile)).mode & 0o777;
  if (mode & 0o077) throw new BridgeError("PERMISSION_DENIED", "SSH identity file is readable by group or others.", { details: { mode: mode.toString(8) } });
  const expected = options.get("fingerprint");
  const candidates = await scanHostKeys(host, port);
  const selected = selectHostKey(candidates, expected);
  if (!expected) await confirmFingerprint(selected.fingerprint);
  const configPath = defaultConfigPath();
  await ensureConfigDirectory(configPath);
  const config = await loadMacConfig(configPath);
  const node: NodeConfig = nodeConfigSchema.parse({
    host,
    port,
    user,
    identity_file: identityFile,
    host_fingerprint: selected.fingerprint,
    worker_command: options.get("worker-command") ?? "mirabridge-worker serve --stdio",
    connect_timeout_ms: connectTimeoutMs,
  });
  const knownHosts = knownHostsPath(configPath);
  const current = await readFile(knownHosts, "utf8").catch(() => "");
  if (!current.split(/\r?\n/).includes(selected.line)) await appendFile(knownHosts, `${selected.line}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(knownHosts, 0o600);
  config.nodes[nodeId] = node;
  await writeMacConfig(config, configPath);
  process.stdout.write(`Added ${nodeId} with pinned fingerprint ${selected.fingerprint}.\n`);
}

async function listNodes(): Promise<void> {
  const config = await loadMacConfig();
  process.stdout.write(`${JSON.stringify({ nodes: Object.entries(config.nodes).map(([nodeId, node]) => ({ node_id: nodeId, host: node.host, port: node.port, user: node.user })) }, null, 2)}\n`);
}

async function testNode(nodeId: string): Promise<void> {
  const pool = new SshPool();
  try {
    const result = await pool.call(nodeId, "mira_bridge_describe_node", { node_id: nodeId });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally { pool.close(); }
}

async function doctor(): Promise<void> {
  const result: Record<string, unknown> = {
    version: MIRABRIDGE_VERSION,
    node: process.version,
    node_24: process.versions.node.startsWith("24."),
    config_path: defaultConfigPath(),
    known_hosts: knownHostsPath(),
  };
  try {
    result.ssh = (await execFileAsync("ssh", ["-V"], { encoding: "utf8" })).stderr.trim();
    result.nodes = Object.keys((await loadMacConfig()).nodes);
    result.ok = Boolean(result.node_24);
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

function usage(): void {
  process.stderr.write("Usage: mirabridge install|uninstall|update|doctor | init | pair create [--id ID] | pair accept RESPONSE | pair list | pair revoke ID [--local-only] | node add --id ID --host HOST --user USER --identity-file PATH [--port 22 --fingerprint SHA256:...] | node list | node test ID | worker check ID\n");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--version")) { process.stdout.write(`mirabridge ${MIRABRIDGE_VERSION}\n`); return 0; }
  if (args[0] === "install" && args.length === 1) return await installMac();
  if (args[0] === "update" && args.length <= 2) return await updateMac(args[1]);
  if (args[0] === "uninstall" && args.length <= 2) return await uninstallMac(args[1] === "--purge-data");
  if (args[0] === "init") { await init(); return 0; }
  if (args[0] === "pair" && args[1] === "create") {
    const options = flags(args.slice(2));
    process.stdout.write(`${JSON.stringify(await createPairingRequest(options.get("id") ?? "windows-main"), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "pair" && args[1] === "accept" && args[2]) {
    process.stdout.write(`${JSON.stringify(await acceptPairingResponse(args[2]), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "pair" && args[1] === "list" && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await listPairings(), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "pair" && args[1] === "revoke" && args[2]) {
    const localOnly = args.slice(3).includes("--local-only");
    process.stdout.write(`${JSON.stringify(await revokePairing(args[2], defaultConfigPath(), localOnly), null, 2)}\n`);
    return 0;
  }
  if (args[0] === "node" && args[1] === "add") { await addNode(args.slice(2)); return 0; }
  if (args[0] === "node" && args[1] === "list") { await listNodes(); return 0; }
  if (args[0] === "node" && args[1] === "test" && args[2]) { await testNode(args[2]); return typeof process.exitCode === "number" ? process.exitCode : 0; }
  if (args[0] === "doctor") { await doctor(); return typeof process.exitCode === "number" ? process.exitCode : 0; }
  if (args[0] === "worker" && args[1] === "check" && args[2]) { await testNode(args[2]); return typeof process.exitCode === "number" ? process.exitCode : 0; }
  usage();
  return 64;
}

try { process.exitCode = await main(); }
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
