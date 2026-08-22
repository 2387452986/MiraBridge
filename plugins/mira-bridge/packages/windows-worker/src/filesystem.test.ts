import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeText, editText, globPaths, listDirectory, managePath, readText, searchText, statPath, writeText } from "./filesystem.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("worker text files", () => {
  it("decodes Chinese UTF-8 and rejects binary content", () => {
    expect(decodeText(Buffer.from("你好，Windows", "utf8"))).toEqual({ text: "你好，Windows", encoding: "utf-8" });
    expect(() => decodeText(Buffer.from([0, 1, 2, 3]))).toThrow();
  });

  it("streams UTF-16 pagination and bounds one read to 256 KiB", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-read-"));
    roots.push(root);
    const utf16Path = join(root, "utf16.txt");
    await writeFile(utf16Path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("第一行\r\n第二行\r\n第三行", "utf16le")]));
    const page = await readText(utf16Path, 2, 1);
    expect(page).toMatchObject({ encoding: "utf-16le", total_lines: 3, start_line: 2, end_line: 2, content: "第二行", content_truncated: false });

    const largePath = join(root, "large.txt");
    await writeFile(largePath, "界".repeat(120_000), "utf8");
    const bounded = await readText(largePath, 1, 500);
    expect(Buffer.byteLength(String(bounded.content))).toBeLessThanOrEqual(256 * 1024);
    expect(bounded.content_truncated).toBe(true);

    const fastPath = join(root, "many-lines.txt");
    await writeFile(fastPath, Array.from({ length: 20_000 }, (_, index) => `line-${index}`).join("\n"), "utf8");
    const fast = await readText(fastPath, 1, 2, false);
    expect(fast).toMatchObject({ content: "line-0\nline-1", total_lines: null, sha256: null, scan_complete: false, next_start_line: 3 });
  });

  it("allows metadata-only stat without hashing file contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-stat-"));
    roots.push(root);
    const path = join(root, "artifact.bin");
    await writeFile(path, "artifact", "utf8");
    await expect(statPath(path, "never")).resolves.toMatchObject({ size: 8, sha256: null, sha256_computed: false, sha256_omitted_reason: "disabled" });
    await expect(statPath(path, "always")).resolves.toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/u), sha256_computed: true });
  });

  it("atomically writes and enforces expected SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-text-"));
    roots.push(root);
    const path = join(root, "中文.txt");
    const first = await writeText(path, "第一版", undefined, false);
    expect(await readFile(path, "utf8")).toBe("第一版");
    await expect(writeText(path, "冲突", "0".repeat(64), false)).rejects.toMatchObject({ code: "FILE_CHANGED" });
    await writeText(path, "第二版", String(first.sha256), false);
    expect(await readFile(path, "utf8")).toBe("第二版");
  });

  it("applies exact CAS edits and rejects ambiguous or stale replacements", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-edit-"));
    roots.push(root);
    const path = join(root, "app.ts");
    const initial = await writeText(path, "const value = 1;\nconst label = '旧值';\n", undefined, false);
    const edited = await editText(path, String(initial.sha256), [{ old_text: "value = 1", new_text: "value = 2", replace_all: false }]);
    expect(await readFile(path, "utf8")).toContain("value = 2");
    await expect(editText(path, String(initial.sha256), [{ old_text: "旧值", new_text: "新值", replace_all: false }])).rejects.toMatchObject({ code: "FILE_CHANGED" });
    const duplicate = join(root, "duplicate.txt");
    const duplicateState = await writeText(duplicate, "same same", undefined, false);
    await expect(editText(duplicate, String(duplicateState.sha256), [{ old_text: "same", new_text: "x", replace_all: false }])).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(edited).toMatchObject({ replacements: [{ edit_index: 0, count: 1 }] });
  });

  it("manages exact paths atomically and rejects linked directory trees", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-manage-"));
    roots.push(root);
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "中文.txt"), "内容", "utf8");
    const copied = join(root, "copied");
    await managePath({ action: "copy", source, destination: copied, recursive: true, overwrite: false });
    expect(await readFile(join(copied, "中文.txt"), "utf8")).toBe("内容");
    const moved = join(root, "moved");
    await managePath({ action: "move", source: copied, destination: moved, recursive: true, overwrite: false });
    await expect(access(copied)).rejects.toMatchObject({ code: "ENOENT" });
    await managePath({ action: "delete", source: moved, recursive: true, overwrite: false });
    await expect(access(moved)).rejects.toMatchObject({ code: "ENOENT" });

    const linked = join(root, "linked");
    await mkdir(linked);
    await symlink(join(root, "outside"), join(linked, "escape"));
    await expect(managePath({ action: "copy", source: linked, destination: join(root, "unsafe-copy"), recursive: true, overwrite: false })).rejects.toMatchObject({ code: "WORKSPACE_OUT_OF_BOUNDS" });
  });

  it("deletes a link itself without following its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-unlink-"));
    roots.push(root);
    const outside = join(root, "outside");
    await mkdir(outside);
    const sentinel = join(outside, "keep.txt");
    await writeFile(sentinel, "must remain", "utf8");
    const linked = join(root, "cleanup-link");
    await symlink(outside, linked);

    await expect(managePath({ action: "delete", source: linked, recursive: true, overwrite: false })).resolves.toMatchObject({
      deleted: true,
      type: "link",
      followed: false,
    });
    await expect(access(linked)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("must remain");
  });

  it("matches root files with a recursive glob", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-glob-"));
    roots.push(root);
    await writeFile(join(root, "中文.txt"), "CAS 更新成功", "utf8");
    expect(await globPaths(root, "**/*.txt", undefined, 20)).toMatchObject({
      matches: [{ path: "中文.txt", type: "file" }],
      total_matches: 1,
    });
    expect(await searchText(root, "CAS 更新成功", "**/*.txt", false, undefined, 20)).toMatchObject({
      matches: [{ path: "中文.txt", line: 1, snippet: "CAS 更新成功" }],
      total_matches: 1,
    });
    expect(await globPaths(root, "**/*.{md,txt}", undefined, 20)).toMatchObject({ total_matches: 1 });
  });

  it("sorts directory and glob results by modification time and invalidates stale directory cursors", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-list-sort-"));
    roots.push(root);
    const older = join(root, "older.txt");
    const newer = join(root, "newer.txt");
    await writeFile(older, "old", "utf8");
    await writeFile(newer, "new", "utf8");
    await utimes(older, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    await utimes(newer, new Date("2026-02-01T00:00:00.000Z"), new Date("2026-02-01T00:00:00.000Z"));

    const listed = await listDirectory(root, undefined, 1, "modified_at", "desc");
    expect(listed).toMatchObject({ entries: [expect.objectContaining({ name: "newer.txt" })], total_entries: 2, sort_by: "modified_at", sort_order: "desc" });
    const cursor = String(listed.cursor);
    await utimes(root, new Date("2026-03-01T00:00:00.000Z"), new Date("2026-03-01T00:00:00.000Z"));
    await expect(listDirectory(root, cursor, 1, "modified_at", "desc")).rejects.toMatchObject({ code: "RESOURCE_CHANGED", retryable: true });

    const globbed = await globPaths(root, "**/*.txt", undefined, 10, "modified_at", "desc");
    expect(globbed).toMatchObject({
      matches: [
        expect.objectContaining({ path: "newer.txt", size: 3, modified_at: "2026-02-01T00:00:00.000Z" }),
        expect.objectContaining({ path: "older.txt", size: 3, modified_at: "2026-01-01T00:00:00.000Z" }),
      ],
    });
  });

  it("uses mutation-aware cursors for recursive glob and text search", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirabridge-collection-cursor-"));
    roots.push(root);
    await writeFile(join(root, "a.txt"), "needle one\nneedle two\n", "utf8");
    await writeFile(join(root, "b.txt"), "needle three\n", "utf8");

    const firstGlob = await globPaths(root, "**/*.txt", undefined, 1);
    expect(firstGlob.cursor).toEqual(expect.any(String));
    const secondGlob = await globPaths(root, "**/*.txt", firstGlob.cursor, 1);
    expect(secondGlob).toMatchObject({ matches: [expect.objectContaining({ path: "b.txt" })], cursor: null });
    await writeFile(join(root, "c.txt"), "needle four\n", "utf8");
    await expect(globPaths(root, "**/*.txt", firstGlob.cursor, 1)).rejects.toMatchObject({ code: "RESOURCE_CHANGED", retryable: true });

    const firstSearch = await searchText(root, "needle", "**/*.txt", false, undefined, 1);
    expect(firstSearch.cursor).toEqual(expect.any(String));
    const secondSearch = await searchText(root, "needle", "**/*.txt", false, firstSearch.cursor, 1);
    expect(secondSearch).toMatchObject({ matches: [expect.objectContaining({ line: 2, snippet: "needle two" })] });
    await writeFile(join(root, "b.txt"), "changed\n", "utf8");
    await expect(searchText(root, "needle", "**/*.txt", false, firstSearch.cursor, 1)).rejects.toMatchObject({ code: "RESOURCE_CHANGED", retryable: true });
  });
});
