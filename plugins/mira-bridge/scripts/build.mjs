import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const entries = [
  ["packages/mcp-server/src/index.ts", "packages/mcp-server/dist/index.mjs", "esm"],
  ["packages/windows-worker/src/index.ts", "packages/windows-worker/dist/index.cjs", "cjs"],
  ["packages/cli/src/index.ts", "packages/cli/dist/index.mjs", "esm"],
];

for (const packageName of ["mcp-server", "windows-worker", "cli"]) {
  await rm(resolve(root, "packages", packageName, "dist"), { recursive: true, force: true });
}

for (const [entry, output, format] of entries) {
  const outfile = resolve(root, output);
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(root, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format,
    target: "node24",
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    define: { __MIRABRIDGE_VERSION__: JSON.stringify(manifest.version) },
    external: entry.includes("windows-worker") ? ["@xterm/headless", "playwright-core"] : [],
  });
  await chmod(outfile, 0o755);
}

const windowsBuild = process.platform === "win32" || process.argv.includes("--windows");
if (windowsBuild) {
  if (process.platform !== "win32") throw new Error("The self-contained ConPTY host must be published on Windows.");
  const project = resolve(root, "packages/conpty-host/MiraBridge.ConPtyHost.csproj");
  const output = resolve(root, "packages/windows-worker/dist/conpty-host");
  await new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.env.MIRABRIDGE_DOTNET || "dotnet.exe", [
      "publish", project,
      "--configuration", "Release",
      "--self-contained",
      "true",
      "--runtime",
      process.arch === "arm64" ? "win-arm64" : "win-x64",
      "--output", output,
      `/p:Version=${manifest.version}`,
      `/p:InformationalVersion=${manifest.version}`,
    ], {
      stdio: "inherit",
      windowsHide: true,
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
    });
    child.once("error", rejectBuild);
    child.once("exit", (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`dotnet publish exited with code ${code}.`)));
  });
}
