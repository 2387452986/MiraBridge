import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SshPool, SshRpcClient, responseTimeoutMs } from "../packages/mcp-server/src/ssh-rpc.js";
import type { NodeConfig } from "../packages/protocol/src/index.js";

const fakeSsh = resolve("integration-tests/fixtures/fake-ssh.mjs");
const fakeKey = Buffer.from("mirabridge-fake-host-key", "utf8");
const fakeKeyText = fakeKey.toString("base64");
const fakeFingerprint = `SHA256:${createHash("sha256").update(fakeKey).digest("base64").replace(/=+$/, "")}`;
const node: NodeConfig = {
  host: "192.0.2.1",
  port: 22,
  user: "mirabridge",
  identity_file: "/tmp/fake-key",
  host_fingerprint: fakeFingerprint,
  worker_command: "mirabridge-worker serve --stdio",
  connect_timeout_ms: 1000,
};

const roots: string[] = [];
let knownHosts = "";
beforeAll(async () => chmod(fakeSsh, 0o755));
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "mirabridge-known-hosts-"));
  roots.push(root);
  knownHosts = join(root, "known_hosts");
  await writeFile(knownHosts, `192.0.2.1 ssh-ed25519 ${fakeKeyText}\n`);
});
afterEach(async () => {
  delete process.env.FAKE_SSH_MODE;
  delete process.env.FAKE_SSH_SENTINEL;
  delete process.env.FAKE_SSH_REQUEST_LOG;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("SSH JSON-RPC transport (Mac transport owner)", () => {
  it("uses bounded operation-aware response timeouts", () => {
    expect(responseTimeoutMs(node, "mira_bridge_describe_node", {})).toBe(45_000 + 15_000);
    expect(responseTimeoutMs(node, "mira_bridge_exec", { timeout_ms: 300_000 })).toBe(315_000);
    expect(responseTimeoutMs(node, "mira_bridge_exec", { timeout_ms: 9_000_000 })).toBe(1_900_000);
    expect(responseTimeoutMs(node, "mira_bridge_start_job", { timeout_ms: 7_200_000 })).toBe(60_000);
  });
  it("round-trips structured UTF-8 results", async () => {
    const client = new SshRpcClient("windows-main", node, knownHosts, fakeSsh);
    try {
      const result = await client.call("mira_bridge_exec", { program: "node.exe", args: ["测试"] }, "req_stable");
      expect(result).toMatchObject({ ok: true, request_id: "req_stable", result: { exit_code: 0, stdout: "测试通过" } });
    } finally { client.close(); }
  });

  it("rejects an oversized RPC request before transport", async () => {
    const client = new SshRpcClient("windows-main", node, knownHosts, "/path/that/must/not/run");
    await expect(client.call("mira_bridge_powershell", { script: "x".repeat(2 * 1024 * 1024) }, "req_oversized_request")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    client.close();
  });

  it("maps host-key mismatch without retryable ambiguity", async () => {
    process.env.FAKE_SSH_MODE = "host-key-mismatch";
    const client = new SshRpcClient("windows-main", node, knownHosts, fakeSsh);
    await expect(client.call("mira_bridge_describe_node", {}, "req_hostkey")).rejects.toMatchObject({ code: "HOST_KEY_MISMATCH", retryable: false });
    client.close();
  });

  it("maps public-key authentication failure", async () => {
    process.env.FAKE_SSH_MODE = "auth-failed";
    const client = new SshRpcClient("windows-main", node, knownHosts, fakeSsh);
    await expect(client.call("mira_bridge_describe_node", {}, "req_auth")).rejects.toMatchObject({ code: "SSH_AUTH_FAILED" });
    client.close();
  });

  it.each(["invalid-json", "oversized-response"])("rejects %s worker protocol output", async (mode) => {
    process.env.FAKE_SSH_MODE = mode;
    const client = new SshRpcClient("windows-main", node, knownHosts, fakeSsh);
    await expect(client.call("mira_bridge_describe_node", {}, `req_${mode}`)).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    client.close();
  });

  it("maps a missing worker binary", async () => {
    process.env.FAKE_SSH_MODE = "worker-not-found";
    const client = new SshRpcClient("windows-main", node, knownHosts, fakeSsh);
    await expect(client.call("mira_bridge_describe_node", {}, "req_worker")).rejects.toMatchObject({ code: "WORKER_NOT_FOUND" });
    client.close();
  });

  it("reconnects once with the identical request ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-retry-"));
    roots.push(root);
    const config = join(root, "config.toml");
    const sentinel = join(root, "sentinel");
    const requestLog = join(root, "requests.log");
    await writeFile(config, `[nodes.windows-main]\nhost="192.0.2.1"\nport=22\nuser="mirabridge"\nidentity_file="/tmp/fake"\nhost_fingerprint="${fakeFingerprint}"\nworker_command="mirabridge-worker serve --stdio"\nconnect_timeout_ms=1000\n`);
    await writeFile(join(root, "known_hosts"), `192.0.2.1 ssh-ed25519 ${fakeKeyText}\n`);
    process.env.FAKE_SSH_MODE = "disconnect-once";
    process.env.FAKE_SSH_SENTINEL = sentinel;
    process.env.FAKE_SSH_REQUEST_LOG = requestLog;
    const pool = new SshPool(config, fakeSsh);
    try {
      const result = await pool.call("windows-main", "mira_bridge_describe_node", {}, "req_retry_stable");
      expect(result.ok).toBe(true);
      expect((await readFile(requestLog, "utf8")).trim().split(/\r?\n/)).toEqual(["req_retry_stable", "req_retry_stable"]);
    } finally { pool.close(); }
  });

  it("rejects a configured fingerprint that differs from managed known_hosts before spawning SSH", async () => {
    const client = new SshRpcClient("windows-main", { ...node, host_fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, knownHosts, "/path/that/must/not/run");
    await expect(client.call("mira_bridge_describe_node", {}, "req_config_mismatch")).rejects.toMatchObject({ code: "HOST_KEY_MISMATCH" });
    client.close();
  });
});
