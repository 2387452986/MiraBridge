import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { previewFile, readOutputRange } from "./output-files.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function output(text: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mirabridge-output-range-"));
  roots.push(root);
  const path = join(root, "output.log");
  await writeFile(path, text, "utf8");
  return path;
}

describe("UTF-8 output ranges", () => {
  it("never emits replacement characters when a requested byte range splits a code point", async () => {
    const path = await output("中中中");
    expect(await readOutputRange(path, 1, 8)).toMatchObject({ text: "中中", requested_offset: 1, offset: 3, bytes: 6, next_offset: 9, eof: true });
    expect(await readOutputRange(path, 0, 4)).toMatchObject({ text: "中", offset: 0, bytes: 3, next_offset: 3, eof: false });
  });

  it("keeps truncated previews on UTF-8 boundaries", async () => {
    const path = await output("中".repeat(10));
    const preview = await previewFile(path, 10);
    expect(preview.truncated).toBe(true);
    expect(`${preview.head}${preview.tail}`).not.toContain("�");
  });
});
