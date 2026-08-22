import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { decodeTarListingName, pullFile, pullPath, pushFile, pushPath } from "../packages/mcp-server/src/transfers.js";
import type { RemoteCaller } from "../packages/mcp-server/src/ssh-rpc.js";
import { canonicalJson, sha256, type RpcPayload } from "../packages/protocol/src/index.js";

const execFileAsync = promisify(execFile);

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function ok(result: Record<string, unknown>): RpcPayload {
  return { protocol_version: "2.0", request_id: "req-transfer", ok: true, result, duration_ms: 0 };
}

class TransferRemote implements RemoteCaller {
  uploaded: Buffer[] = [];
  readonly pulled = Buffer.from("Windows 产物".repeat(70_000), "utf8");
  finishCalls = 0;
  corruptHash = false;
  finishFails = false;
  directoryBegin: Record<string, unknown> | undefined;

  async call(_nodeId: string, operation: string, args: Record<string, unknown>): Promise<RpcPayload> {
    if (operation === "transfer_begin_push") return ok({ transfer_id: "transfer_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000001" });
    if (operation === "transfer_begin_directory_push") {
      this.directoryBegin = args;
      return ok({ transfer_id: "transfer_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000001", kind: "directory" });
    }
    if (operation === "transfer_write_chunk") {
      this.uploaded.push(Buffer.from(String(args.data_base64), "base64"));
      return ok({ transferred: Number(args.offset) + this.uploaded.at(-1)!.length });
    }
    if (operation === "transfer_commit_push") {
      const bytes = Buffer.concat(this.uploaded);
      return ok({ destination_path: "D:\\Projects\\asset.bin", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    if (operation === "transfer_begin_pull") {
      return ok({
        transfer_id: "transfer_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000002",
        size: this.pulled.length,
        sha256: this.corruptHash ? "0".repeat(64) : createHash("sha256").update(this.pulled).digest("hex"),
      });
    }
    if (operation === "transfer_read_chunk") {
      const offset = Number(args.offset);
      const bytes = this.pulled.subarray(offset, offset + Number(args.max_bytes));
      return ok({ data_base64: bytes.toString("base64") });
    }
    if (operation === "transfer_finish") {
      this.finishCalls += 1;
      if (this.finishFails) throw new Error("simulated cleanup disconnect");
      return ok({ removed: true });
    }
    throw new Error(`Unexpected operation ${operation}`);
  }
  lastKnownStatus(): "unknown" { return "unknown"; }
  close(): void {}
}

describe.skipIf(process.platform === "win32")("single-file transfers (Mac transfer owner)", () => {
  it("pushes in 512 KiB chunks and reports verified metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-push-"));
    roots.push(root);
    const source = join(root, "source.bin");
    const bytes = Buffer.alloc(700_000, 7);
    await writeFile(source, bytes);
    const remote = new TransferRemote();
    const progress: number[] = [];
    const result = await pushFile(remote, "windows-main", source, "D:\\Projects\\asset.bin", false, (value) => { progress.push(value); });
    expect(Buffer.concat(remote.uploaded)).toEqual(bytes);
    expect(remote.uploaded).toHaveLength(2);
    expect(progress.at(-1)).toBe(bytes.length);
    expect(result).toMatchObject({ size: bytes.length, source_path: source });
  }, 15_000);

  it("pulls atomically and removes a failed hash download", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-pull-"));
    roots.push(root);
    const destination = join(root, "artifact.bin");
    const remote = new TransferRemote();
    await pullFile(remote, "windows-main", "D:\\Render\\artifact.bin", destination, false);
    expect(await readFile(destination)).toEqual(remote.pulled);
    expect(remote.finishCalls).toBe(1);

    const failedDestination = join(root, "corrupt.bin");
    remote.corruptHash = true;
    await expect(pullFile(remote, "windows-main", "D:\\Render\\bad.bin", failedDestination, false)).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
    expect((await readdir(root)).filter((name) => name.includes("mirabridge-part"))).toEqual([]);
    expect(remote.finishCalls).toBe(2);
  }, 15_000);

  it("reports remote cleanup debt without turning an installed pull into a false failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-pull-cleanup-"));
    roots.push(root);
    const destination = join(root, "artifact.bin");
    const remote = new TransferRemote();
    remote.finishFails = true;
    const result = await pullFile(remote, "windows-main", "D:\\Render\\artifact.bin", destination, false);
    expect(await readFile(destination)).toEqual(remote.pulled);
    expect(result).toMatchObject({ remote_cleanup_pending: true });
  }, 15_000);
});

class DirectoryPullRemote implements RemoteCaller {
  finishCalls = 0;

  constructor(
    readonly archive: Buffer,
    readonly manifest: Array<Record<string, unknown>>,
    readonly inlineManifest = true,
  ) {}

  async call(_nodeId: string, operation: string, args: Record<string, unknown>): Promise<RpcPayload> {
    if (operation === "transfer_begin_pull") return ok({
      transfer_id: "transfer_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000008",
      kind: "directory",
      size: this.archive.length,
      sha256: createHash("sha256").update(this.archive).digest("hex"),
      ...(this.inlineManifest ? { manifest: this.manifest } : {}),
      manifest_sha256: sha256(canonicalJson(this.manifest)),
      entries: this.manifest.length,
      files: this.manifest.filter((entry) => entry.type === "file").length,
      total_file_bytes: this.manifest.reduce((sum, entry) => sum + Number(entry.size), 0),
    });
    if (operation === "transfer_read_chunk") {
      const offset = Number(args.offset);
      return ok({ data_base64: this.archive.subarray(offset, offset + Number(args.max_bytes)).toString("base64") });
    }
    if (operation === "transfer_finish") { this.finishCalls += 1; return ok({ removed: true }); }
    throw new Error(`Unexpected operation ${operation}`);
  }
  lastKnownStatus(): "unknown" { return "unknown"; }
  close(): void {}
}

describe.skipIf(process.platform === "win32")("directory transfers (Mac transfer owner)", () => {
  it("decodes the octal UTF-8 names emitted by Windows bsdtar", () => {
    expect(decodeTarListingName("proof/\\346\\272\\220.txt")).toBe("proof/源.txt");
    expect(() => decodeTarListingName("proof/\\q.txt")).toThrowError(/unsupported escape/u);
    expect(() => decodeTarListingName("proof/\\377.txt")).toThrowError(/invalid UTF-8/u);
  });

  it("uploads a Unicode directory as one archive with a controlled manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-directory-push-"));
    roots.push(root);
    const source = join(root, "网页源码");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "index.html"), "<h1>你好</h1>", "utf8");
    await writeFile(join(source, "src", "main.ts"), "console.log('MiraBridge')", "utf8");
    const remote = new TransferRemote();
    const result = await pushPath(remote, "windows-main", source, "D:\\MiraBridgeRoot\\网页源码", "directory", false);
    expect(remote.directoryBegin?.manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "index.html", type: "file" }),
      expect.objectContaining({ path: "src/main.ts", type: "file" }),
    ]));
    expect(Buffer.concat(remote.uploaded).length).toBeGreaterThan(0);
    expect(result).toMatchObject({ kind: "directory", source_path: source });
  });

  it("uploads more than 10,000 entries without embedding the manifest in one RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-large-directory-push-"));
    roots.push(root);
    const source = join(root, "large-tree");
    await mkdir(source);
    const count = 10_050;
    const names = Array.from({ length: count }, (_, index) => `entry-${String(index).padStart(5, "0")}-${"x".repeat(80)}`);
    for (let offset = 0; offset < names.length; offset += 64) {
      await Promise.all(names.slice(offset, offset + 64).map(async (name) => await mkdir(join(source, name))));
    }
    const remote = new TransferRemote();
    await pushPath(remote, "windows-main", source, "D:\\MiraBridgeRoot\\large-tree", "directory", false);
    expect(remote.directoryBegin?.manifest).toBeUndefined();
    expect(remote.directoryBegin).toMatchObject({ manifest_entries: count, manifest_files: 0, total_file_bytes: 0 });
    expect(Buffer.byteLength(JSON.stringify(remote.directoryBegin), "utf8")).toBeLessThan(2 * 1024 * 1024);
  }, 120_000);

  it("downloads, verifies, and atomically installs a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-directory-pull-"));
    roots.push(root);
    const source = join(root, "remote");
    await mkdir(join(source, "dist"), { recursive: true });
    const content = Buffer.from("Windows 构建产物", "utf8");
    await writeFile(join(source, "dist", "index.html"), content);
    const archivePath = join(root, "payload.tar");
    await execFileAsync("/usr/bin/tar", ["-cf", archivePath, "-C", source, "."]);
    const archive = await readFile(archivePath);
    const manifest = [
      { path: "dist", type: "directory", size: 0, sha256: null },
      { path: "dist/index.html", type: "file", size: content.length, sha256: createHash("sha256").update(content).digest("hex") },
    ];
    const remote = new DirectoryPullRemote(archive, manifest);
    const destination = join(root, "accepted");
    const result = await pullPath(remote, "windows-main", "D:\\MiraBridgeRoot\\site", destination, "directory", false);
    expect(await readFile(join(destination, "dist", "index.html"))).toEqual(content);
    expect(result).toMatchObject({ kind: "directory", entries: 2, files: 1 });
    expect(remote.finishCalls).toBe(1);
  });

  it("downloads and verifies a directory from only its manifest hash and summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-directory-summary-pull-"));
    roots.push(root);
    const source = join(root, "remote");
    await mkdir(source);
    const content = Buffer.from("hash-only manifest", "utf8");
    await writeFile(join(source, "result.txt"), content);
    const archivePath = join(root, "payload.tar");
    await execFileAsync("/usr/bin/tar", ["-cf", archivePath, "-C", source, "."]);
    const manifest = [{ path: "result.txt", type: "file", size: content.length, sha256: createHash("sha256").update(content).digest("hex") }];
    const remote = new DirectoryPullRemote(await readFile(archivePath), manifest, false);
    const destination = join(root, "accepted");
    const result = await pullPath(remote, "windows-main", "D:\\MiraBridgeRoot\\site", destination, "directory", false);
    await expect(readFile(join(destination, "result.txt"), "utf8")).resolves.toBe("hash-only manifest");
    expect(result).toMatchObject({ manifest_sha256: sha256(canonicalJson(manifest)), entries: 1, files: 1 });
  });

  it("rejects a linked archive before extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-directory-link-"));
    roots.push(root);
    const source = join(root, "malicious");
    await mkdir(source);
    await symlink("/tmp", join(source, "escape"));
    const archivePath = join(root, "linked.tar");
    await execFileAsync("/usr/bin/tar", ["-cf", archivePath, "-C", source, "."]);
    const archive = await readFile(archivePath);
    const manifest = [{ path: "escape", type: "file", size: 0, sha256: "0".repeat(64) }];
    const remote = new DirectoryPullRemote(archive, manifest);
    await expect(pullPath(remote, "windows-main", "D:\\MiraBridgeRoot\\bad", join(root, "should-not-exist"), "directory", false)).rejects.toMatchObject({ code: "TRANSFER_FAILED" });
  });
});
