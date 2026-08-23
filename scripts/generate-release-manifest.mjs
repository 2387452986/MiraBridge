#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
const ignored = new Set([".git", "node_modules", "dist", "coverage", "artifacts"]);
const localOnly = new Set([
  "AGENTS.md",
  "MODULE_DEVELOPMENT.md",
  "docs/RELEASE_CHECKLIST.md",
  "plugins/mira-bridge/AGENTS.md",
  "plugins/mira-bridge/MODULE_DEVELOPMENT.md",
  "plugins/mira-bridge/docs/IMPLEMENTATION_CHECKLIST.md",
  "plugins/mira-bridge/docs/TEST_REPORT.md",
]);
const files = [];
async function visit(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored.has(entry.name) || entry.name.endsWith(".tgz") || entry.name === "release-manifest.json") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile()) files.push(path);
  }
}
await visit(root);
const entries = [];
for (const path of files) {
  const releasePath = relative(root, path).replaceAll("\\", "/");
  if (localOnly.has(releasePath)) continue;
  const bytes = await readFile(path);
  entries.push({ path: releasePath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const manifest = { schema_version: 1, product: "MiraBridge", version: "2.0.0-rc.4", generated_at: new Date().toISOString(), files: entries };
await writeFile(resolve(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${entries.length} files recorded.\n`);
