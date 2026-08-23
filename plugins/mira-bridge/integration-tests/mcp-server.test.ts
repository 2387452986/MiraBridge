import { createHash } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../packages/mcp-server/src/server.js";
import { SshPool, type RemoteCaller } from "../packages/mcp-server/src/ssh-rpc.js";
import { createScopedId, type RpcPayload } from "../packages/protocol/src/index.js";

const roots: string[] = [];
const fakeKey = Buffer.from("mirabridge-fake-host-key", "utf8");
const fakeKeyText = fakeKey.toString("base64");
const fakeFingerprint = `SHA256:${createHash("sha256").update(fakeKey).digest("base64").replace(/=+$/, "")}`;
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeRemote implements RemoteCaller {
  calls = 0;
  readonly recorded: Array<{ nodeId: string; operation: string; args: Record<string, unknown> }> = [];
  async call(nodeId: string, operation: string, args: Record<string, unknown>): Promise<RpcPayload> {
    this.calls += 1;
    this.recorded.push({ nodeId, operation, args });
    const result = operation === "mira_bridge_exec"
      ? { exit_code: 0, stdout: "x".repeat(20_000), stderr: "", duration_ms: 5, timed_out: false, truncated: false, output_ref: null }
      : { node_id: nodeId, os: "Windows 11" };
    return { protocol_version: "2.0", request_id: "req_fake", ok: true, result, duration_ms: 1 };
  }
  lastKnownStatus(): "online" | "offline" | "unknown" { return "unknown"; }
  close(): void {}
}

describe.skipIf(process.platform === "win32")("MCP consumer contract (Mac MCP owner)", () => {
  it("lists 28 tools and keeps list_nodes entirely Mac-local", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-mcp-"));
    roots.push(root);
    const config = join(root, "config.toml");
    await writeFile(config, `[nodes.windows-main]\nhost="192.0.2.1"\nport=22\nuser="mirabridge"\nidentity_file="/tmp/fake"\nhost_fingerprint="${fakeFingerprint}"\nworker_command="mirabridge-worker serve --stdio"\nconnect_timeout_ms=1000\n`);
    const remote = new FakeRemote();
    const runtime = createServer(remote, config);
    const client = new Client({ name: "mirabridge-test", version: "2.0.0-rc.3" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(28);
      const listed = await client.callTool({ name: "mira_bridge_list_nodes", arguments: {} });
      expect(listed.isError).toBe(false);
      expect(remote.calls).toBe(0);
      const described = await client.callTool({ name: "mira_bridge_describe_node", arguments: { node_id: "windows-main" } });
      expect(described.isError).toBe(false);
      expect(remote.calls).toBe(1);
      const executed = await client.callTool({
        name: "mira_bridge_exec",
        arguments: { workspace_id: createScopedId("ws", "windows-main"), program: "node.exe", args: [] },
      });
      expect(executed.isError).toBe(false);
      const content = executed.content as Array<{ type: string; text?: string }>;
      expect(content[0]).toMatchObject({ type: "text" });
      expect(content[0]?.text?.length).toBeLessThan(512);
      expect(content[0]?.text).not.toContain("x".repeat(100));
      expect(executed.structuredContent).toMatchObject({ ok: true, result: { stdout: "x".repeat(20_000) } });

      const workspaceId = createScopedId("ws", "windows-main");
      await client.callTool({ name: "mira_bridge_stat", arguments: { workspace_id: workspaceId, path: "large.bin" } });
      expect(remote.recorded.at(-1)?.args).not.toHaveProperty("hash_mode");
      await client.callTool({ name: "mira_bridge_stat", arguments: { workspace_id: workspaceId, path: "large.bin", hash_mode: "auto" } });
      expect(remote.recorded.at(-1)?.args).toMatchObject({ hash_mode: "auto" });
      await client.callTool({ name: "mira_bridge_list_directory", arguments: { workspace_id: workspaceId } });
      expect(remote.recorded.at(-1)?.args).not.toHaveProperty("sort_by");
      expect(remote.recorded.at(-1)?.args).not.toHaveProperty("sort_order");
    } finally {
      await client.close();
      runtime.close();
    }
  });

  it("runs MCP through the SSH stdio adapter and structured worker RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-vertical-"));
    roots.push(root);
    const config = join(root, "config.toml");
    await writeFile(config, `[nodes.windows-main]\nhost="192.0.2.1"\nport=22\nuser="mirabridge"\nidentity_file="/tmp/fake"\nhost_fingerprint="${fakeFingerprint}"\nworker_command="mirabridge-worker serve --stdio"\nconnect_timeout_ms=1000\n`);
    await writeFile(join(root, "known_hosts"), `192.0.2.1 ssh-ed25519 ${fakeKeyText}\n`);
    const pool = new SshPool(config, resolve("integration-tests/fixtures/fake-ssh.mjs"));
    const runtime = createServer(pool, config);
    const client = new Client({ name: "mirabridge-vertical-test", version: "2.0.0-rc.3" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "mira_bridge_describe_node", arguments: { node_id: "windows-main" } });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({ ok: true, result: { hostname: "FAKE-WINDOWS", os: "Windows 11" } });
    } finally {
      await client.close();
      runtime.close();
    }
  });
});
