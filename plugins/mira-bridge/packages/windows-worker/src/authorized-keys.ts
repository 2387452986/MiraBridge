import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { BridgeError } from "../../protocol/src/index.js";

export function administratorsAuthorizedKeysPath(): string {
  const programData = process.env.ProgramData ?? "C:\\ProgramData";
  return join(programData, "ssh", "administrators_authorized_keys");
}

function marker(fingerprint: string): string {
  if (!/^SHA256:[A-Za-z0-9+/=]+$/u.test(fingerprint)) {
    throw new BridgeError("INVALID_ARGUMENT", "A valid SHA-256 public-key fingerprint is required.");
  }
  return `mirabridge:${fingerprint.replace(/=+$/u, "")}`;
}

export async function revokeAuthorizedKey(fingerprint: string, path = administratorsAuthorizedKeysPath()): Promise<{ removed: number; path: string }> {
  const expected = marker(fingerprint);
  let current: string;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, path };
    throw error;
  }
  const lines = current.split(/\r?\n/u);
  const retained = lines.filter((line) => !line.trimEnd().endsWith(expected));
  const removed = lines.length - retained.length;
  if (removed === 0) return { removed: 0, path };
  await mkdir(dirname(path), { recursive: true });
  await copyFile(path, `${path}.mirabridge.bak`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${retained.filter((line, index) => line.length > 0 || index < retained.length - 1).join("\r\n").replace(/(?:\r?\n)+$/u, "")}\r\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return { removed, path };
}
