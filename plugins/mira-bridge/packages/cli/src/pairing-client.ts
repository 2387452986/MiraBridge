import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  MIRABRIDGE_VERSION,
  PAIRING_TTL_MS,
  BridgeError,
  assertNodeId,
  decodePairingCode,
  encodePairingCode,
  fingerprintOpenSshPublicKey,
  fingerprintsEqual,
  nodeConfigSchema,
  pairingRequestSchema,
  type MacConfig,
  type PairingRequest,
  type PairingResponse,
  type RpcPayload,
} from "../../protocol/src/index.js";
import {
  defaultConfigPath,
  ensureConfigDirectory,
  knownHostsPath,
  loadMacConfig,
  writeMacConfig,
} from "../../mcp-server/src/config.js";
import { SshPool } from "../../mcp-server/src/ssh-rpc.js";
import { scanHostKeys, selectHostKey, type ScannedHostKey } from "./host-keys.js";

const execFileAsync = promisify(execFile);

interface PendingPairing {
  request: PairingRequest;
  identity_file: string;
}

interface AcceptedPairing {
  node_id: string;
  paired_at: string;
  mac_public_key_fingerprint: string;
  windows_host_fingerprint: string;
  windows_hostname: string;
  windows_version: string;
}

export interface PairingDependencies {
  now?: () => Date;
  scan?: (host: string, port: number) => Promise<ScannedHostKey[]>;
  verify?: (nodeId: string, configPath: string) => Promise<RpcPayload>;
}

function pairingDirectory(configPath: string): string {
  return join(dirname(configPath), "pairings");
}

function pendingPath(configPath: string, nonce: string): string {
  return join(pairingDirectory(configPath), "pending", `${nonce}.json`);
}

function acceptedPath(configPath: string, nodeId: string): string {
  return join(pairingDirectory(configPath), "accepted", `${nodeId}.json`);
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await import("node:fs/promises").then(({ rename }) => rename(temporary, path));
  await chmod(path, 0o600);
}

async function ensureIdentity(nodeId: string, configPath: string): Promise<{ privateKey: string; publicKey: string }> {
  const directory = join(dirname(configPath), "identities");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privateKey = join(directory, `${nodeId}.ed25519`);
  try {
    await access(privateKey);
  } catch {
    try {
      await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", privateKey], { timeout: 30_000 });
    } catch (error) {
      throw new BridgeError("INTERNAL_ERROR", "Could not create the MiraBridge Ed25519 identity.", { cause: error });
    }
  }
  const mode = (await stat(privateKey)).mode & 0o777;
  if (mode & 0o077) await chmod(privateKey, 0o600);
  let text: string;
  try {
    text = await readFile(`${privateKey}.pub`, "utf8");
  } catch {
    const { stdout } = await execFileAsync("ssh-keygen", ["-y", "-f", privateKey], { encoding: "utf8", timeout: 15_000 });
    text = stdout;
  }
  const fields = text.trim().split(/\s+/u);
  const publicKey = `${fields[0] ?? ""} ${fields[1] ?? ""}`;
  return { privateKey, publicKey };
}

export async function savePendingPairing(pending: PendingPairing, configPath = defaultConfigPath()): Promise<void> {
  pairingRequestSchema.parse(pending.request);
  await writePrivate(pendingPath(configPath, pending.request.nonce), `${JSON.stringify(pending, null, 2)}\n`);
}

async function loadPendingPairing(nonce: string, configPath: string, now: Date): Promise<PendingPairing> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(pendingPath(configPath, nonce), "utf8"));
  } catch (error) {
    throw new BridgeError("INVALID_ARGUMENT", "No matching pending pairing request exists on this Mac.", { cause: error, details: { nonce } });
  }
  if (!raw || typeof raw !== "object" || typeof (raw as { identity_file?: unknown }).identity_file !== "string") {
    throw new BridgeError("INVALID_ARGUMENT", "Pending pairing state is invalid.");
  }
  const request = pairingRequestSchema.parse((raw as { request?: unknown }).request);
  decodePairingCode(encodePairingCode(request), now);
  return { request, identity_file: resolve((raw as { identity_file: string }).identity_file) };
}

export async function createPairingRequest(
  nodeId = "windows-main",
  configPath = defaultConfigPath(),
  now = new Date(),
): Promise<{ request_code: string; expires_at: string; node_id: string; public_key_fingerprint: string }> {
  assertNodeId(nodeId);
  await ensureConfigDirectory(configPath);
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (!architecture) throw new BridgeError("INVALID_ARGUMENT", `Unsupported Mac architecture: ${process.arch}`);
  const identity = await ensureIdentity(nodeId, configPath);
  const request: PairingRequest = {
    kind: "request",
    format_version: 1,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
    nonce: randomBytes(24).toString("base64url"),
    node_id: nodeId,
    public_key: identity.publicKey,
    public_key_fingerprint: fingerprintOpenSshPublicKey(identity.publicKey),
    mac: { name: hostname(), architecture, mirabridge_version: MIRABRIDGE_VERSION },
  };
  await savePendingPairing({ request, identity_file: identity.privateKey }, configPath);
  return {
    request_code: encodePairingCode(request),
    expires_at: request.expires_at,
    node_id: request.node_id,
    public_key_fingerprint: request.public_key_fingerprint,
  };
}

function removeHostLines(text: string, host: string, port: number): string {
  const accepted = new Set([host, `[${host}]:${port}`]);
  return text.split(/\r?\n/u).filter((line) => {
    const field = line.trim().split(/\s+/u)[0];
    return !field || field.startsWith("#") || !field.split(",").some((candidate) => accepted.has(candidate));
  }).filter(Boolean).join("\n");
}

async function defaultVerify(nodeId: string, configPath: string): Promise<RpcPayload> {
  const pool = new SshPool(configPath);
  try {
    return await pool.call(nodeId, "mira_bridge_describe_node", { node_id: nodeId });
  } finally {
    pool.close();
  }
}

export async function acceptPairingResponse(
  responseCode: string,
  configPath = defaultConfigPath(),
  dependencies: PairingDependencies = {},
): Promise<{ node_id: string; host: string; fingerprint: string; handshake: unknown }> {
  const now = (dependencies.now ?? (() => new Date()))();
  const payload = decodePairingCode(responseCode, now);
  if (payload.kind !== "response") throw new BridgeError("INVALID_ARGUMENT", "pair accept requires a Windows response code.");
  const response: PairingResponse = payload;
  const pending = await loadPendingPairing(response.request_nonce, configPath, now);
  if (response.node_id !== pending.request.node_id || !fingerprintsEqual(response.public_key_fingerprint, pending.request.public_key_fingerprint)) {
    throw new BridgeError("INVALID_ARGUMENT", "Pairing response does not match the pending Mac request.");
  }

  const scan = dependencies.scan ?? scanHostKeys;
  let selected: ScannedHostKey | undefined;
  let selectedHost: string | undefined;
  const failures: Array<{ host: string; error: string }> = [];
  for (const host of response.ssh.addresses) {
    try {
      selected = selectHostKey(await scan(host, response.ssh.port), response.ssh.host_fingerprint);
      selectedHost = host;
      break;
    } catch (error) {
      failures.push({ host, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (!selected || !selectedHost) {
    throw new BridgeError("HOST_KEY_MISMATCH", "No live Windows address presented the fingerprint in the pairing response.", {
      retryable: true,
      details: { expected: response.ssh.host_fingerprint, failures },
    });
  }

  const originalConfig = await loadMacConfig(configPath);
  const hostsPath = knownHostsPath(configPath);
  const originalHosts = await readFile(hostsPath, "utf8").catch(() => "");
  const node = nodeConfigSchema.parse({
    host: selectedHost,
    port: response.ssh.port,
    user: response.windows.user,
    identity_file: pending.identity_file,
    host_fingerprint: response.ssh.host_fingerprint,
    worker_command: response.worker_command,
    management_command: response.management_command,
    connect_timeout_ms: 10_000,
  });
  const nextConfig: MacConfig = { nodes: { ...originalConfig.nodes, [response.node_id]: node } };
  const retainedHosts = removeHostLines(originalHosts, selectedHost, response.ssh.port);
  const nextHosts = `${retainedHosts ? `${retainedHosts}\n` : ""}${selected.line}\n`;
  await writePrivate(hostsPath, nextHosts);
  await writeMacConfig(nextConfig, configPath);
  try {
    const verification = await (dependencies.verify ?? defaultVerify)(response.node_id, configPath);
    if (!verification.ok) throw new BridgeError(verification.error?.code ?? "INTERNAL_ERROR", verification.error?.message ?? "Windows handshake failed.");
    const accepted: AcceptedPairing = {
      node_id: response.node_id,
      paired_at: now.toISOString(),
      mac_public_key_fingerprint: pending.request.public_key_fingerprint,
      windows_host_fingerprint: response.ssh.host_fingerprint,
      windows_hostname: response.windows.hostname,
      windows_version: response.windows.mirabridge_version,
    };
    await writePrivate(acceptedPath(configPath, response.node_id), `${JSON.stringify(accepted, null, 2)}\n`);
    await rm(pendingPath(configPath, response.request_nonce), { force: true });
    return { node_id: response.node_id, host: selectedHost, fingerprint: response.ssh.host_fingerprint, handshake: verification.result };
  } catch (error) {
    await writeMacConfig(originalConfig, configPath);
    await writePrivate(hostsPath, originalHosts);
    throw error;
  }
}

export async function listPairings(configPath = defaultConfigPath()): Promise<{ nodes: unknown[]; pending: unknown[] }> {
  const config = await loadMacConfig(configPath);
  const nodes = await Promise.all(Object.entries(config.nodes).map(async ([nodeId, node]) => {
    let record: AcceptedPairing | undefined;
    try { record = JSON.parse(await readFile(acceptedPath(configPath, nodeId), "utf8")) as AcceptedPairing; } catch { /* legacy/manual node */ }
    return { node_id: nodeId, host: node.host, port: node.port, user: node.user, fingerprint: node.host_fingerprint, paired_at: record?.paired_at ?? null };
  }));
  const pendingDirectory = join(pairingDirectory(configPath), "pending");
  const names = await readdir(pendingDirectory).catch(() => []);
  const pending: unknown[] = [];
  for (const name of names.filter((value) => value.endsWith(".json"))) {
    try {
      const state = JSON.parse(await readFile(join(pendingDirectory, name), "utf8")) as PendingPairing;
      pending.push({ node_id: state.request.node_id, expires_at: state.request.expires_at, public_key_fingerprint: state.request.public_key_fingerprint });
    } catch { /* report only valid pending state */ }
  }
  return { nodes, pending };
}

export async function revokePairing(nodeId: string, configPath = defaultConfigPath(), localOnly = false): Promise<{ node_id: string; remote_revoked: boolean }> {
  assertNodeId(nodeId);
  const config = await loadMacConfig(configPath);
  const node = config.nodes[nodeId];
  if (!node) throw new BridgeError("NODE_NOT_FOUND", `Windows node '${nodeId}' is not configured.`);
  let accepted: AcceptedPairing | undefined;
  try { accepted = JSON.parse(await readFile(acceptedPath(configPath, nodeId), "utf8")) as AcceptedPairing; } catch { /* legacy node */ }
  if (!localOnly) {
    if (!accepted?.mac_public_key_fingerprint) {
      throw new BridgeError("INVALID_ARGUMENT", "This legacy node has no pairing record; use --local-only and revoke its key in the Windows app.");
    }
    const remote = `${node.management_command ?? "mirabridge-worker"} pairing revoke ${accepted.mac_public_key_fingerprint}`;
    await execFileAsync("ssh", [
      "-T", "-p", String(node.port), "-i", node.identity_file,
      "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHostsPath(configPath)}`, "-l", node.user, node.host, remote,
    ], { encoding: "utf8", timeout: 30_000 });
  }
  const remaining = { ...config.nodes };
  delete remaining[nodeId];
  await writeMacConfig({ nodes: remaining }, configPath);
  const hostsPath = knownHostsPath(configPath);
  const currentHosts = await readFile(hostsPath, "utf8").catch(() => "");
  const retained = removeHostLines(currentHosts, node.host, node.port);
  await writePrivate(hostsPath, retained ? `${retained}\n` : "");
  await rm(acceptedPath(configPath, nodeId), { force: true });
  return { node_id: nodeId, remote_revoked: !localOnly };
}
