import { describe, expect, it } from "vitest";
import { selectHostKey, type ScannedHostKey } from "./host-keys.js";

const candidates: ScannedHostKey[] = [
  { line: "host ssh-rsa AAAA", fingerprint: "SHA256:rsa" },
  { line: "host ecdsa-sha2-nistp256 AAAA", fingerprint: "SHA256:ecdsa" },
  { line: "host ssh-ed25519 AAAA", fingerprint: "SHA256:ed25519" },
];

describe("SSH host-key selection", () => {
  it("matches a verified fingerprint even when it is not the first scanned key", () => {
    expect(selectHostKey(candidates, "SHA256:ed25519")).toEqual(candidates[2]);
  });

  it("prefers Ed25519 for interactive enrollment", () => {
    expect(selectHostKey(candidates)).toEqual(candidates[2]);
  });

  it("reports every scanned fingerprint when verification fails", () => {
    expect(() => selectHostKey(candidates, "SHA256:missing")).toThrowError(expect.objectContaining({
      code: "HOST_KEY_MISMATCH",
      details: { expected: "SHA256:missing", scanned: ["SHA256:rsa", "SHA256:ecdsa", "SHA256:ed25519"] },
    }));
  });
});
