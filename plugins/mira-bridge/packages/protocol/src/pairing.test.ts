import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_PREFIX,
  decodePairingCode,
  encodePairingCode,
  fingerprintOpenSshPublicKey,
  type PairingRequest,
  type PairingResponse,
} from "./index.js";

const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKYmyTVY9UGb2JUsf5zmY8x2qNCyQWRon9y1zLxyLxiq";

function request(now = new Date("2026-08-23T00:00:00.000Z")): PairingRequest {
  return {
    kind: "request",
    format_version: 1,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
    nonce: "1pRvuX6uLgTvJx4oFyxskU_X6gK5bNbC",
    node_id: "windows-main",
    public_key: publicKey,
    public_key_fingerprint: fingerprintOpenSshPublicKey(publicKey),
    mac: { name: "Mira Mac", architecture: "arm64", mirabridge_version: "2.0.0-rc.7" },
  };
}

describe("pairing codes", () => {
  it("round trips a bounded request", () => {
    const encoded = encodePairingCode(request());
    expect(encoded.startsWith(PAIRING_CODE_PREFIX)).toBe(true);
    expect(decodePairingCode(encoded, new Date("2026-08-23T00:10:00.000Z"))).toEqual(request());
  });

  it("rejects expiry and tampering", () => {
    const encoded = encodePairingCode(request());
    expect(() => decodePairingCode(encoded, new Date("2026-08-23T00:31:00.000Z"))).toThrow(/expired/u);
    expect(() => decodePairingCode(`${encoded.slice(0, -2)}??`)).toThrow(/base64url/u);
  });

  it("computes the OpenSSH SHA-256 fingerprint", () => {
    expect(fingerprintOpenSshPublicKey(publicKey)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/u);
  });

  it("accepts the quoted stable Host command emitted by the Windows app", () => {
    const response: PairingResponse = {
      kind: "response",
      format_version: 1,
      created_at: "2026-08-22T19:31:44.2699551+00:00",
      expires_at: "2026-08-22T20:01:44.2699551+00:00",
      nonce: "CJEvG2XfrBzbXra5yLhnOK7CPiQF8xC1",
      request_nonce: "1pRvuX6uLgTvJx4oFyxskU_X6gK5bNbC",
      node_id: "windows-main",
      public_key_fingerprint: fingerprintOpenSshPublicKey(publicKey),
      windows: { hostname: "WINDOWS-NODE", architecture: "x64", user: "Administrator", mirabridge_version: "2.0.0-rc.7" },
      ssh: { addresses: ["192.0.2.74"], port: 22, host_fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", host_key_algorithm: "ssh-ed25519" },
      worker_command: "\"C:\\Users\\Administrator\\AppData\\Local\\MiraBridge.Windows\\current\\MiraBridge.Host.exe\" worker serve --stdio",
      management_command: "\"C:\\Users\\Administrator\\AppData\\Local\\MiraBridge.Windows\\current\\MiraBridge.Host.exe\" worker",
      default_root: "D:\\MiraBridgeRoot",
      capabilities: ["process", "filesystem"],
    };
    expect(decodePairingCode(encodePairingCode(response), new Date("2026-08-22T19:32:00.000Z"))).toEqual(response);
  });
});
