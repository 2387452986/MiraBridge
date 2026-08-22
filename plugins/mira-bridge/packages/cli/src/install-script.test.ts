import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Mac installer", () => {
  it("quotes the managed Node executable in the default path containing Application Support", async () => {
    const script = await readFile(resolve(import.meta.dirname, "../../../scripts/install-mac.sh"), "utf8");

    expect(script).toContain('install_root="${MIRABRIDGE_INSTALL_ROOT:-$HOME/Library/Application Support/MiraBridge}"');
    expect(script).toContain('managed_node_version=$("$node_bin" --version)');
    expect(script).not.toMatch(/\$\(\$node_bin\s/u);
    expect(script).toContain('Refusing an unsafe MiraBridge install root');
  });

  it("rejects broad uninstall roots before recursive removal", async () => {
    const script = await readFile(resolve(import.meta.dirname, "../../../scripts/uninstall-mac.sh"), "utf8");
    expect(script).toContain('Refusing an unsafe MiraBridge uninstall root');
    expect(script.indexOf('Refusing an unsafe MiraBridge uninstall root')).toBeLessThan(script.indexOf('rm -rf "$install_root/releases"'));
  });
});
