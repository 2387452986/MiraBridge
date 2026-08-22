import { describe, expect, it } from "vitest";
import { quoteWindowsArgument } from "./persistent-runner.js";

describe("persistent runner command line", () => {
  it("quotes Windows arguments without changing simple values", () => {
    expect(quoteWindowsArgument("internal-run-job-pipe")).toBe("internal-run-job-pipe");
    expect(quoteWindowsArgument("")).toBe('""');
    expect(quoteWindowsArgument("C:\\Program Files\\nodejs\\node.exe")).toBe('"C:\\Program Files\\nodejs\\node.exe"');
  });

  it("escapes embedded quotes and trailing backslashes using CommandLineToArgvW rules", () => {
    expect(quoteWindowsArgument('a b"c')).toBe('"a b\\"c"');
    expect(quoteWindowsArgument("C:\\path with space\\")).toBe('"C:\\path with space\\\\"');
  });
});
