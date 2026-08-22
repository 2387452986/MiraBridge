#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const moduleRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(moduleRoot, "../..");
const target = process.argv[2];
if (target !== "plugin" && target !== "skill") throw new Error("Usage: validate-release.mjs plugin|skill");

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

if (target === "plugin") {
  const manifest = await json(resolve(moduleRoot, ".codex-plugin/plugin.json"));
  const mcp = await json(resolve(moduleRoot, ".mcp.json"));
  const marketplace = await json(resolve(repositoryRoot, ".agents/plugins/marketplace.json"));
  invariant(manifest.name === "mira-bridge", "Plugin name must be mira-bridge.");
  invariant(manifest.version === "2.0.0-rc.1", "Plugin version must be 2.0.0-rc.1.");
  invariant(manifest.license === "MIT", "Plugin license must be MIT.");
  invariant(manifest.skills === "./skills/", "Plugin must expose its skills directory.");
  invariant(manifest.mcpServers === "./.mcp.json", "Plugin must bind its local MCP manifest.");
  invariant(manifest.interface?.composerIcon === "./assets/mirabridge-logo.png", "Plugin composer icon is missing.");
  await access(resolve(moduleRoot, "assets/mirabridge-logo.png"));
  const server = mcp.mcpServers?.mirabridge;
  invariant(server?.command === "bash" && server?.args?.[0] === "./scripts/run-mcp.sh", "MCP stdio launcher is invalid.");
  invariant(server.default_tools_approval_mode === "writes", "MCP default approval mode must be writes.");
  for (const name of ["mira_bridge_exec", "mira_bridge_powershell", "mira_bridge_empty_recycle_bin", "mira_bridge_web_snapshot"]) {
    invariant(server.tools?.[name]?.approval_mode === "prompt", `${name} must require prompt approval.`);
  }
  invariant(marketplace.name === "mirabridge", "Marketplace name must be mirabridge.");
  const listing = marketplace.plugins?.find((plugin) => plugin.name === "mira-bridge");
  invariant(listing?.source?.source === "local" && listing.source.path === "./plugins/mira-bridge", "Marketplace source must point at the repository plugin.");
  process.stdout.write("MiraBridge plugin release contract is valid.\n");
} else {
  const skill = await readFile(resolve(moduleRoot, "skills/mira-bridge/SKILL.md"), "utf8");
  invariant(skill.startsWith("---\n"), "SKILL.md must begin with YAML frontmatter.");
  invariant(/^name:\s*mira-bridge\s*$/mu.test(skill), "Skill name must be mira-bridge.");
  invariant(/^description:\s*.+Windows.+Mac/imu.test(skill), "Skill description must distinguish Windows targeting from Mac-local work.");
  for (const [pattern, label] of [[/describe_node/u, "describe_node"], [/exit code `0`/iu, "exit code 0"], [/Windows Worker/u, "Windows Worker"], [/Recycle Bin/u, "Recycle Bin"]]) {
    invariant(pattern.test(skill), `Skill is missing required guidance: ${label}`);
  }
  process.stdout.write("MiraBridge skill release contract is valid.\n");
}
