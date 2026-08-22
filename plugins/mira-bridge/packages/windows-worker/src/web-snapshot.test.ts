import { describe, expect, it } from "vitest";
import { validateWebSnapshotUrl } from "./web-snapshot.js";

describe("Web Snapshot URL policy", () => {
  it("allows loopback HTTP(S) and rejects file, data, and external URLs by default", () => {
    expect(validateWebSnapshotUrl("http://127.0.0.1:5173/demo", "local-only", false).hostname).toBe("127.0.0.1");
    expect(validateWebSnapshotUrl("http://[::1]:4173/", "local-only", false).hostname).toBe("[::1]");
    expect(() => validateWebSnapshotUrl("file:///C:/secret.txt", "local-only", false)).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() => validateWebSnapshotUrl("data:text/html,hello", "local-only", false)).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() => validateWebSnapshotUrl("https://example.com", "local-only", false)).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("requires both explicit tool policy and worker configuration for external pages", () => {
    expect(() => validateWebSnapshotUrl("https://example.com", "allow-external", false)).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_ENABLED" }));
    expect(validateWebSnapshotUrl("https://example.com", "allow-external", true).hostname).toBe("example.com");
  });
});
