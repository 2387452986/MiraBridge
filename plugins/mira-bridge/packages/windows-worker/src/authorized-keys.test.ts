import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { revokeAuthorizedKey } from "./authorized-keys.js";

describe("paired Mac revocation", () => {
  it("removes only the exact MiraBridge-marked key and preserves other administrators", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mirabridge-authorized-"));
    const path = join(directory, "administrators_authorized_keys");
    await writeFile(path, [
      "ssh-ed25519 AAAAexisting user-key",
      "ssh-ed25519 AAAAmira mirabridge:SHA256:abc+/123",
      "ssh-rsa AAAAother other-key",
      "",
    ].join("\r\n"), "utf8");
    expect(await revokeAuthorizedKey("SHA256:abc+/123", path)).toMatchObject({ removed: 1 });
    const result = await readFile(path, "utf8");
    expect(result).toContain("AAAAexisting");
    expect(result).toContain("AAAAother");
    expect(result).not.toContain("AAAAmira");
    expect(await readFile(`${path}.mirabridge.bak`, "utf8")).toContain("AAAAmira");
  });
});
