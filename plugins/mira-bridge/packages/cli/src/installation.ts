import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeError, MIRABRIDGE_VERSION } from "../../protocol/src/index.js";

async function firstExisting(paths: string[]): Promise<string> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch { /* try the next supported layout */ }
  }
  throw new BridgeError("PATH_NOT_FOUND", "MiraBridge's installation manager was not found; rerun install-mac.sh from the fixed release source.", {
    details: { searched: paths },
  });
}

function scriptCandidates(name: string): string[] {
  const entryDirectory = dirname(fileURLToPath(import.meta.url));
  const explicitRoot = process.env.MIRABRIDGE_SOURCE_ROOT;
  return [
    ...(explicitRoot ? [resolve(explicitRoot, "plugins/mira-bridge/scripts", name)] : []),
    resolve(entryDirectory, "../scripts", name),
    resolve(entryDirectory, "../../../scripts", name),
  ];
}

async function runScript(name: string, args: string[] = []): Promise<number> {
  const script = await firstExisting(scriptCandidates(name));
  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn("sh", [script, ...args], { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new BridgeError("INTERNAL_ERROR", `MiraBridge manager stopped with signal ${signal}.`));
      else resolveExit(code ?? 1);
    });
  });
}

export async function installMac(): Promise<number> {
  const script = await firstExisting(scriptCandidates("install-mac.sh"));
  try
  {
    await access(resolve(dirname(script), "../package.json"));
    return await runScript("install-mac.sh");
  }
  catch (error)
  {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    process.stdout.write(`MiraBridge ${MIRABRIDGE_VERSION} is already installed. Run 'mirabridge doctor' or 'mirabridge update' to repair/replace it.\n`);
    return 0;
  }
}

export async function updateMac(version?: string): Promise<number> {
  return await runScript("update-mac.sh", version ? [version] : []);
}

export async function uninstallMac(purgeData = false): Promise<number> {
  return await runScript("uninstall-mac.sh", purgeData ? ["--purge-data"] : []);
}
