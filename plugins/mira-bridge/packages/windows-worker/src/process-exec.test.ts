import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { executeProcess, transcodeWindowsCodePageStream } from "./process-exec.js";
import { normalizeWindowsOutputStream } from "./windows-codepage.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function paths(): Promise<{ root: string; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "mirabridge-process-"));
  roots.push(root);
  return { root, stdout: join(root, "stdout.log"), stderr: join(root, "stderr.log") };
}

describe("structured process execution", () => {
  it("transcodes chunked Windows cmd output from the active OEM code page to UTF-8", async () => {
    const decoded: Buffer[] = [];
    for await (const chunk of transcodeWindowsCodePageStream(Readable.from([Buffer.from([0xd6]), Buffer.from([0xd0, 0xce, 0xc4])]), 936)) {
      decoded.push(chunk as Buffer);
    }
    expect(Buffer.concat(decoded).toString("utf8")).toBe("中文");
  });

  it("auto-detects UTF-8 and CP936 independently and reports the resolved encoding", async () => {
    const utf8 = normalizeWindowsOutputStream(Readable.from([Buffer.from("中文 UTF-8", "utf8")]), "auto", 936);
    const utf8Chunks: Buffer[] = [];
    for await (const chunk of utf8.stream) utf8Chunks.push(chunk as Buffer);
    expect(Buffer.concat(utf8Chunks).toString("utf8")).toBe("中文 UTF-8");
    await expect(utf8.resolvedEncoding).resolves.toBe("utf-8");

    const console = normalizeWindowsOutputStream(Readable.from([Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]), "auto", 936);
    const consoleChunks: Buffer[] = [];
    for await (const chunk of console.stream) consoleChunks.push(chunk as Buffer);
    expect(Buffer.concat(consoleChunks).toString("utf8")).toBe("中文");
    await expect(console.resolvedEncoding).resolves.toBe("cp936");

    const utf8OnUnsupportedConsole = normalizeWindowsOutputStream(Readable.from([Buffer.from("plain UTF-8 ✓", "utf8")]), "auto", 437);
    const portableChunks: Buffer[] = [];
    for await (const chunk of utf8OnUnsupportedConsole.stream) portableChunks.push(chunk as Buffer);
    expect(Buffer.concat(portableChunks).toString("utf8")).toBe("plain UTF-8 ✓");
    await expect(utf8OnUnsupportedConsole.resolvedEncoding).resolves.toBe("utf-8");
  });

  it("reclassifies delayed CP936 after an ASCII-only prefix instead of locking UTF-8 early", async () => {
    const source = Readable.from((async function* () {
      yield Buffer.from("ASCII prefix: ", "ascii");
      await new Promise((resolve) => setTimeout(resolve, 150));
      yield Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    })());
    const normalized = normalizeWindowsOutputStream(source, "auto", 936);
    const chunks: Buffer[] = [];
    for await (const chunk of normalized.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("ASCII prefix: 中文");
    await expect(normalized.resolvedEncoding).resolves.toBe("cp936");
  });

  it("honors explicit code pages and rejects unavailable decoders", async () => {
    const explicit = normalizeWindowsOutputStream(Readable.from([Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]), "cp936", 65001);
    const chunks: Buffer[] = [];
    for await (const chunk of explicit.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("中文");
    await expect(explicit.resolvedEncoding).resolves.toBe("cp936");
    expect(() => normalizeWindowsOutputStream(Readable.from([]), "cp437", 65001)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_ENCODING" }));
  });

  it("preserves argv and UTF-8 stdout/stderr", async () => {
    const files = await paths();
    const outcome = await executeProcess({
      program: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1]); process.stderr.write('警告')", "中文 参数"],
      cwd: files.root,
      env: {},
      timeoutMs: 5_000,
    }, files.stdout, files.stderr);
    expect(outcome).toMatchObject({ exitCode: 0, timedOut: false });
    expect(outcome).toMatchObject({ stdoutEncoding: "utf-8", stderrEncoding: "utf-8" });
    expect(await readFile(files.stdout, "utf8")).toBe("中文 参数");
    expect(await readFile(files.stderr, "utf8")).toBe("警告");
  });

  it("preserves caller-provided process environment values", async () => {
    const files = await paths();
    const outcome = await executeProcess({
      program: process.execPath,
      args: ["-e", "process.stdout.write(process.env.PYTHONUTF8 + '|' + process.env.PYTHONIOENCODING)"],
      cwd: files.root,
      env: { PYTHONUTF8: "0", PYTHONIOENCODING: "cp936" },
      timeoutMs: 5_000,
    }, files.stdout, files.stderr);
    expect(outcome.exitCode).toBe(0);
    expect(await readFile(files.stdout, "utf8")).toBe("0|cp936");
  });

  it("writes UTF-8 data and EOF to an explicitly piped process stdin", async () => {
    const files = await paths();
    const outcome = await executeProcess({
      program: process.execPath,
      args: ["-e", "let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => process.stdout.write('ACK:' + text))"],
      cwd: files.root,
      env: {},
      timeoutMs: 5_000,
      stdinMode: "pipe",
    }, files.stdout, files.stderr, undefined, Number.MAX_SAFE_INTEGER, (input) => input.end("中文输入\n", "utf8"));
    expect(outcome).toMatchObject({ exitCode: 0, timedOut: false });
    expect(await readFile(files.stdout, "utf8")).toBe("ACK:中文输入\n");
  });

  it("maps a missing executable without hanging output streams", async () => {
    const files = await paths();
    await expect(executeProcess({
      program: "mirabridge-program-that-does-not-exist",
      args: [], cwd: files.root, env: {}, timeoutMs: 2_000,
    }, files.stdout, files.stderr)).rejects.toMatchObject({ code: "PROGRAM_NOT_FOUND" });
  });

  it("times out and terminates the process", async () => {
    const files = await paths();
    const outcome = await executeProcess({
      program: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"], cwd: files.root, env: {}, timeoutMs: 100,
    }, files.stdout, files.stderr);
    expect(outcome.timedOut).toBe(true);
  });

  it("drains oversized streams while storing a bounded head, omission marker, and tail", async () => {
    const files = await paths();
    const outcome = await executeProcess({
      program: process.execPath,
      args: ["-e", "process.stdout.write('HEAD' + 'x'.repeat(20000) + 'TAIL')"], cwd: files.root, env: {}, timeoutMs: 5_000,
    }, files.stdout, files.stderr, undefined, 4096);
    const stored = await readFile(files.stdout, "utf8");
    expect(outcome.stdout).toMatchObject({ totalBytes: 20_008, storageTruncated: true });
    expect(outcome.stdout.storedBytes).toBeLessThanOrEqual(4096);
    expect(stored.startsWith("HEAD")).toBe(true);
    expect(stored).toContain("MiraBridge omitted");
    expect(stored.endsWith("TAIL")).toBe(true);
  });

  it("terminates a process promptly when explicit output decoding fails", async () => {
    const files = await paths();
    const startedAt = Date.now();
    await expect(executeProcess({
      program: process.execPath,
      args: [
        "-e",
        "process.stderr.write('ASCII READY\\n'); setTimeout(() => process.stderr.write(Buffer.from([0xA8, 0x84])), 50); setInterval(() => {}, 1000)",
      ],
      cwd: files.root,
      env: {},
      timeoutMs: 30_000,
      outputEncoding: "utf-8",
    }, files.stdout, files.stderr)).rejects.toMatchObject({ code: "UNSUPPORTED_ENCODING" });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 5_000);
});
