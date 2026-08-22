import { MIRABRIDGE_VERSION, BridgeError } from "../../protocol/src/index.js";
import { revokeAuthorizedKey } from "./authorized-keys.js";
import { conptyAvailability } from "./conpty-process.js";
import {
  addAllowedRoot,
  ensureWorkerDirectories,
  initializeWorkerConfig,
  loadWorkerConfig,
  removeAllowedRoot,
  setWorkerCapability,
  workerConfigPath,
  workerDataRoot,
  type WorkerCapability,
} from "./config.js";
import { getJob, listJobs, reconcileJobs, runJob } from "./jobs.js";
import { windowsArchitecture } from "./hardware.js";
import { PathPolicy } from "./path-policy.js";
import { readPersistentRunnerBootstrap } from "./persistent-runner.js";
import { serveWorkerStdio } from "./stdio-server.js";
import { WorkerState } from "./state.js";
import { pruneStorage, storageStatus } from "./storage.js";
import { detectEdgeExecutable } from "./web-snapshot.js";
import { detectActiveConsoleCodePage, isWindowsCodePageSupported, windowsCodePageLabel } from "./windows-codepage.js";

async function doctor(): Promise<number> {
  const checks: Record<string, unknown> = {
    platform: process.platform,
    node: process.version,
    config_path: workerConfigPath(),
    data_root: workerDataRoot(),
  };
  try {
    const config = await loadWorkerConfig();
    const architecture = windowsArchitecture();
    const architectureSupported = ["x64", "arm64"].includes(architecture.architecture)
      && ["x64", "arm64"].includes(architecture.process_architecture);
    checks.architecture = { ...architecture, supported: architectureSupported };
    const paths = await PathPolicy.create(config.allowed_roots);
    checks.allowed_roots = paths.allowedRoots;
    await ensureWorkerDirectories();
    const state = new WorkerState();
    try {
      await reconcileJobs(state);
      checks.storage = await storageStatus(state, config.storage);
      checks.execution_maintenance = state.executionMaintenance() ?? null;
      checks.sqlite_user_version = (state.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    }
    finally { state.close(); }
    const terminal = await conptyAvailability();
    checks.conpty = terminal;
    let encodingSupported = false;
    try {
      const codePage = await detectActiveConsoleCodePage();
      const label = windowsCodePageLabel(codePage);
      encodingSupported = isWindowsCodePageSupported(codePage);
      checks.output_encoding = { default: "auto", console_code_page: codePage, console_label: label, supported: encodingSupported };
    } catch (error) {
      checks.output_encoding = { default: "auto", supported: false, error: error instanceof Error ? error.message : String(error) };
    }
    const edge = await detectEdgeExecutable();
    checks.edge = { required: config.web_snapshot_enabled, executable: edge };
    checks.runtime_ready = architectureSupported && terminal.available && encodingSupported && (!config.web_snapshot_enabled || edge !== null);
    checks.configured = true;
  } catch (error) {
    checks.configured = false;
    checks.error = error instanceof Error ? error.message : String(error);
  }
  checks.windows_supported = process.platform === "win32";
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  return checks.configured && checks.windows_supported && checks.runtime_ready ? 0 : 1;
}

async function maintenanceCommand(args: string[]): Promise<number> {
  await ensureWorkerDirectories();
  const owner = args[1];
  if (owner && !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(owner)) {
    throw new BridgeError("INVALID_ARGUMENT", "Maintenance owner must be a lowercase identifier up to 64 characters.");
  }
  const state = new WorkerState();
  try {
    if (args[0] === "status" && args.length === 1) {
      process.stdout.write(`${JSON.stringify({ ok: true, lease: state.executionMaintenance() ?? null }, null, 2)}\n`);
      return 0;
    }
    if (args[0] === "begin" && owner && args[2] && args.length <= 4) {
      const leaseMs = Number(args[3] ?? "7200000");
      if (!Number.isInteger(leaseMs) || leaseMs < 60_000 || leaseMs > 14_400_000) {
        throw new BridgeError("INVALID_ARGUMENT", "Maintenance lease must be from 60000 to 14400000 milliseconds.");
      }
      await reconcileJobs(state);
      const admission = state.beginExecutionMaintenance(owner, args[2], leaseMs);
      process.stdout.write(`${JSON.stringify({ ok: admission.acquired, ...admission }, null, 2)}\n`);
      return 0;
    }
    if (args[0] === "end" && owner && args.length === 2) {
      process.stdout.write(`${JSON.stringify({ ok: true, released: state.endExecutionMaintenance(owner) }, null, 2)}\n`);
      return 0;
    }
    throw new BridgeError("INVALID_ARGUMENT", "Usage: mirabridge-worker maintenance status | maintenance begin OWNER REASON [LEASE_MS] | maintenance end OWNER");
  } finally { state.close(); }
}

async function storageCommand(args: string[]): Promise<number> {
  await ensureWorkerDirectories();
  const config = await loadWorkerConfig();
  const state = new WorkerState();
  try {
    if (args[0] === "status" && args.length === 1) {
      process.stdout.write(`${JSON.stringify(await storageStatus(state, config.storage), null, 2)}\n`);
      return 0;
    }
    if (args[0] === "prune" && (args[1] === "--dry-run" || args[1] === "--execute") && args.length === 2) {
      const result = await pruneStorage(state, config.storage, { dryRun: args[1] === "--dry-run", reason: args[1] === "--dry-run" ? "manual-dry-run" : "manual" });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    throw new BridgeError("INVALID_ARGUMENT", "Usage: mirabridge-worker storage status | storage prune --dry-run | storage prune --execute");
  } finally { state.close(); }
}

async function jobsCommand(args: string[]): Promise<number> {
  await ensureWorkerDirectories();
  const state = new WorkerState();
  try {
    await reconcileJobs(state);
    if (args[0] === "list") process.stdout.write(`${JSON.stringify(listJobs(state), null, 2)}\n`);
    else if (args[0] === "inspect" && args[1]) process.stdout.write(`${JSON.stringify(getJob(state, args[1]), null, 2)}\n`);
    else throw new BridgeError("INVALID_ARGUMENT", "Usage: mirabridge-worker jobs list | jobs inspect <job_id>");
    return 0;
  } finally { state.close(); }
}

async function configCommand(args: string[]): Promise<number> {
  const operation = args[0];
  let result: unknown;
  if (operation === "show" && args.length === 1) result = await loadWorkerConfig();
  else if (operation === "init" && args.length <= 2) result = await initializeWorkerConfig(workerConfigPath(), args[1]);
  else if (operation === "add-root" && args[1] && args.length === 2) result = await addAllowedRoot(args[1]);
  else if (operation === "remove-root" && args[1] && args.length === 2) result = await removeAllowedRoot(args[1]);
  else if (operation === "set-capability" && args[1] && args[2] && args.length === 3) {
    const capabilities: WorkerCapability[] = ["desktop", "recycle-bin", "web-snapshot", "web-snapshot-external"];
    if (!capabilities.includes(args[1] as WorkerCapability)) {
      throw new BridgeError("INVALID_ARGUMENT", `Unknown capability: ${args[1]}`);
    }
    result = await setWorkerCapability(args[1] as WorkerCapability, args[2]);
  } else {
    throw new BridgeError("INVALID_ARGUMENT", "Usage: mirabridge-worker config show | config init [ROOT] | config add-root PATH | config remove-root PATH | config set-capability desktop|recycle-bin|web-snapshot|web-snapshot-external VALUE");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
  return 0;
}

async function pairingCommand(args: string[]): Promise<number> {
  if (args[0] !== "revoke" || !args[1] || args.length !== 2) {
    throw new BridgeError("INVALID_ARGUMENT", "Usage: mirabridge-worker pairing revoke SHA256:FINGERPRINT");
  }
  const result = await revokeAuthorizedKey(args[1]);
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
  return result.removed > 0 ? 0 : 2;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--version")) {
    process.stdout.write(`mirabridge-worker ${MIRABRIDGE_VERSION}\n`);
    return 0;
  }
  if (args[0] === "doctor") return await doctor();
  if (args[0] === "config") return await configCommand(args.slice(1));
  if (args[0] === "pairing") return await pairingCommand(args.slice(1));
  if (args[0] === "jobs") return await jobsCommand(args.slice(1));
  if (args[0] === "storage") return await storageCommand(args.slice(1));
  if (args[0] === "maintenance") return await maintenanceCommand(args.slice(1));
  if (args[0] === "internal-run-job-pipe" && args[1]) {
    if (process.platform !== "win32") throw new BridgeError("INVALID_ARGUMENT", "Job runners require Windows.");
    await runJob(await readPersistentRunnerBootstrap(args[1]));
    return 0;
  }
  if (args[0] === "serve" && args[1] === "--stdio") {
    if (process.platform !== "win32") throw new BridgeError("INVALID_ARGUMENT", "mirabridge-worker serve requires Windows.");
    await ensureWorkerDirectories();
    const state = new WorkerState();
    await reconcileJobs(state);
    state.close();
    await serveWorkerStdio();
    return 0;
  }
  process.stderr.write("Usage: mirabridge-worker --version | doctor | config show|init|add-root|remove-root|set-capability | pairing revoke FINGERPRINT | serve --stdio | jobs list | jobs inspect <job_id> | storage status | storage prune --dry-run|--execute | maintenance status|begin|end\n");
  return 64;
}

void main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

export { WorkerRuntime } from "./runtime.js";
export { WorkerStdioServer } from "./stdio-server.js";
