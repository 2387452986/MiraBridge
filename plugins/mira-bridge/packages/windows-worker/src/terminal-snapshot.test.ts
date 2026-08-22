import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTerminalSnapshot, TerminalRecorder } from "./terminal-snapshot.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("ConPTY terminal snapshots", () => {
  it("persists the active VT screen, title, cursor, resize, sequence, and final state", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-terminal-"));
    roots.push(root);
    const path = join(root, "terminal.json");
    const recorder = new TerminalRecorder(path, 80, 24);
    await recorder.write(Buffer.from("\u001b]0;Mira REPL\u0007第一行\r\n第二行", "utf8"));
    const initial = await readTerminalSnapshot(path);
    expect(initial).toMatchObject({ cols: 80, rows: 24, title: "Mira REPL", final: false });
    expect(initial.lines.join("\n")).toContain("第一行");
    expect(initial.lines.join("\n")).toContain("第二行");
    await recorder.resize(120, 40);
    const resized = await readTerminalSnapshot(path);
    expect(resized).toMatchObject({ cols: 120, rows: 40, sequence: initial.sequence + 1 });
    await recorder.finish();
    expect(await readTerminalSnapshot(path)).toMatchObject({ final: true, sequence: resized.sequence + 1 });
  });

  it("returns a stable error when no persisted snapshot exists", async () => {
    await expect(readTerminalSnapshot(join(tmpdir(), "mirabridge-terminal-does-not-exist.json"))).rejects.toMatchObject({
      code: "TERMINAL_SNAPSHOT_UNAVAILABLE",
      retryable: true,
    });
  });
});
