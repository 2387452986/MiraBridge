#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const manifestPath = resolve(process.argv[2] ?? "release-manifest.json");
const root = resolve(process.argv[3] ?? ".");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schema_version !== 1 || manifest.product !== "MiraBridge" || manifest.version !== "2.0.0-rc.1" || !Array.isArray(manifest.files)) {
  throw new Error("Release manifest identity or schema is invalid.");
}
for (const entry of manifest.files) {
  if (typeof entry.path !== "string" || entry.path.startsWith("/") || entry.path.split("/").includes("..")) throw new Error("Unsafe release manifest path.");
  const path = resolve(root, entry.path);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Release manifest path escaped its root.");
  const bytes = await readFile(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== entry.bytes || actual !== entry.sha256) throw new Error(`Release manifest mismatch: ${entry.path}`);
}
process.stdout.write(`Verified MiraBridge ${manifest.version}: ${manifest.files.length} files.\n`);
