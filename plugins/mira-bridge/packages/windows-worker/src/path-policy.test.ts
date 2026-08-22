import { describe, expect, it } from "vitest";
import { isWithinWindowsRoot, normalizeWindowsAbsolute, normalizeWorkspaceRelative } from "./path-policy.js";

describe("Windows path policy", () => {
  it("normalizes drive paths and accepts descendants case-insensitively", () => {
    expect(normalizeWindowsAbsolute("d:/Projects/App")).toBe("d:\\Projects\\App");
    expect(isWithinWindowsRoot("D:\\Projects\\App", "d:\\projects")).toBe(true);
    expect(isWithinWindowsRoot("D:\\Projects2", "D:\\Projects")).toBe(false);
  });

  it.each([
    "..\\..\\Windows\\System32",
    "\\\\server\\share\\file.txt",
    "\\\\?\\C:\\Windows",
    "C:\\Windows",
    "file.txt:secret",
  ])("rejects workspace escape %s", (value) => {
    expect(() => normalizeWorkspaceRelative(value)).toThrow();
  });

  it("rejects traversal even when normalization would return inside", () => {
    expect(() => normalizeWindowsAbsolute("D:\\Projects\\x\\..\\safe")).toThrow();
  });
});
