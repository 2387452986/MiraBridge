import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeError, encodePairingCode, fingerprintOpenSshPublicKey, type PairingRequest, type PairingResponse } from "../../protocol/src/index.js";
import { loadMacConfig, writeMacConfig } from "../../mcp-server/src/config.js";
import { acceptPairingResponse, reconnectNodeAddress, savePendingPairing } from "./pairing-client.js";

const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKYmyTVY9UGb2JUsf5zmY8x2qNCyQWRon9y1zLxyLxiq";
const testAddress = "192.0.2.74";
const testHostFingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const now = new Date("2026-08-23T00:00:00.000Z");
const previousAddress = "192.0.2.74";
const nextAddress = "192.0.2.145";

async function seedReconnectNode(directory: string, includeSharedNode = false): Promise<string> {
  const configPath = join(directory, "config.toml");
  const node = {
    host: previousAddress,
    port: 22,
    user: "Administrator",
    identity_file: join(directory, "id_ed25519"),
    host_fingerprint: testHostFingerprint,
    worker_command: "mirabridge-worker serve --stdio",
    connect_timeout_ms: 10_000,
  };
  await writeMacConfig({ nodes: { "windows-main": node, ...(includeSharedNode ? { "windows-backup": node } : {}) } }, configPath);
  await writeFile(join(directory, "known_hosts"), `${previousAddress} ssh-ed25519 AAAAC3NzaOldPinnedKey\n`, { mode: 0o600 });
  return configPath;
}

function request(): PairingRequest {
  return {
    kind: "request",
    format_version: 1,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
    nonce: "1pRvuX6uLgTvJx4oFyxskU_X6gK5bNbC",
    node_id: "windows-main",
    public_key: publicKey,
    public_key_fingerprint: fingerprintOpenSshPublicKey(publicKey),
    mac: { name: "test-mac", architecture: "arm64", mirabridge_version: "2.0.0-rc.7" },
  };
}

function response(value = request()): PairingResponse {
  return {
    kind: "response",
    format_version: 1,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
    nonce: "9FFcoFjlsYN2jw8d6CV4-GmUjKnYIh5d",
    request_nonce: value.nonce,
    node_id: value.node_id,
    public_key_fingerprint: value.public_key_fingerprint,
    windows: { hostname: "WINDOWS-NODE", architecture: "x64", user: "Administrator", mirabridge_version: "2.0.0-rc.7" },
    ssh: { addresses: [testAddress], port: 22, host_fingerprint: testHostFingerprint, host_key_algorithm: "ssh-ed25519" },
    worker_command: "mirabridge-worker serve --stdio",
    management_command: "mirabridge-worker",
    default_root: "D:\\MiraBridgeRoot",
    capabilities: ["process", "filesystem"],
  };
}

describe("Mac pairing acceptance", () => {
  it("pins a live matching host key and verifies before committing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mirabridge-pair-"));
    const configPath = join(directory, "config.toml");
    const pending = request();
    await savePendingPairing({ request: pending, identity_file: join(directory, "id_ed25519") }, configPath);
    const result = await acceptPairingResponse(encodePairingCode(response(pending)), configPath, {
      now: () => new Date(now.getTime() + 60_000),
      scan: async () => [{ line: `${testAddress} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestHostKeyBytes1234567890`, fingerprint: response().ssh.host_fingerprint }],
      verify: async () => ({ protocol_version: "2.0", request_id: "req_test", ok: true, result: { hostname: "WINDOWS-NODE" }, duration_ms: 1 }),
    });
    expect(result.host).toBe(testAddress);
    expect((await loadMacConfig(configPath)).nodes["windows-main"]?.worker_command).toBe("mirabridge-worker serve --stdio");
    expect(await readFile(join(directory, "known_hosts"), "utf8")).toContain("ssh-ed25519");
  });

  it("rolls back the node and host key if the Worker handshake fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mirabridge-pair-rollback-"));
    const configPath = join(directory, "config.toml");
    const pending = request();
    await savePendingPairing({ request: pending, identity_file: join(directory, "id_ed25519") }, configPath);
    await expect(acceptPairingResponse(encodePairingCode(response(pending)), configPath, {
      now: () => new Date(now.getTime() + 60_000),
      scan: async () => [{ line: `${testAddress} ssh-ed25519 AAAAC3NzaFake`, fingerprint: response().ssh.host_fingerprint }],
      verify: async () => { throw new Error("worker unavailable"); },
    })).rejects.toThrow(/worker unavailable/u);
    expect(Object.keys((await loadMacConfig(configPath)).nodes)).toEqual([]);
    expect(await readFile(join(directory, "known_hosts"), "utf8")).toBe("");
  });
});

describe("paired node DHCP reconnect", () => {
  it("moves the address only after the pinned key and Worker handshake match", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mirabridge-reconnect-"));
    const configPath = await seedReconnectNode(directory);
    const result = await reconnectNodeAddress("windows-main", nextAddress, configPath, {
      scan: async () => [{ line: `${nextAddress} ssh-ed25519 AAAAC3NzaSamePinnedKey`, fingerprint: testHostFingerprint }],
      verify: async () => ({ protocol_version: "2.0", request_id: "req_reconnect", ok: true, result: { hostname: "WINDOWS-NODE" }, duration_ms: 1 }),
    });
    expect(result).toMatchObject({ node_id: "windows-main", previous_host: previousAddress, host: nextAddress, fingerprint: testHostFingerprint });
    expect((await loadMacConfig(configPath)).nodes["windows-main"]?.host).toBe(nextAddress);
    const hosts = await readFile(join(directory, "known_hosts"), "utf8");
    expect(hosts).toContain(`${nextAddress} ssh-ed25519`);
    expect(hosts).not.toContain(`${previousAddress} ssh-ed25519`);
  });

  it("stops with a bilingual warning when the new address has a different key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mirabridge-reconnect-mismatch-"));
    const configPath = await seedReconnectNode(directory);
    const originalHosts = await readFile(join(directory, "known_hosts"), "utf8");
    await expect(reconnectNodeAddress("windows-main", nextAddress, configPath, {
      scan: async () => [{ line: `${nextAddress} ssh-ed25519 AAAAC3NzaDifferentKey`, fingerprint: "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }],
    })).rejects.toThrow(/Stopped:.*已停止：/su);
    expect((await loadMacConfig(configPath)).nodes["windows-main"]?.host).toBe(previousAddress);
    expect(await readFile(join(directory, "known_hosts"), "utf8")).toBe(originalHosts);
  });

  it("restores config and known_hosts when the Worker handshake fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mirabridge-reconnect-rollback-"));
    const configPath = await seedReconnectNode(directory);
    const originalHosts = await readFile(join(directory, "known_hosts"), "utf8");
    await expect(reconnectNodeAddress("windows-main", nextAddress, configPath, {
      scan: async () => [{ line: `${nextAddress} ssh-ed25519 AAAAC3NzaSamePinnedKey`, fingerprint: testHostFingerprint }],
      verify: async () => { throw new BridgeError("SSH_AUTH_FAILED", "SSH public-key authentication failed."); },
    })).rejects.toThrow(/restored.*已恢复/su);
    expect((await loadMacConfig(configPath)).nodes["windows-main"]?.host).toBe(previousAddress);
    expect(await readFile(join(directory, "known_hosts"), "utf8")).toBe(originalHosts);
  });

  it("keeps the old host entry when another node still uses that endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mirabridge-reconnect-shared-"));
    const configPath = await seedReconnectNode(directory, true);
    await reconnectNodeAddress("windows-main", nextAddress, configPath, {
      scan: async () => [{ line: `${nextAddress} ssh-ed25519 AAAAC3NzaSamePinnedKey`, fingerprint: testHostFingerprint }],
      verify: async () => ({ protocol_version: "2.0", request_id: "req_shared", ok: true, result: {}, duration_ms: 1 }),
    });
    const hosts = await readFile(join(directory, "known_hosts"), "utf8");
    expect(hosts).toContain(`${previousAddress} ssh-ed25519`);
    expect(hosts).toContain(`${nextAddress} ssh-ed25519`);
  });
});
