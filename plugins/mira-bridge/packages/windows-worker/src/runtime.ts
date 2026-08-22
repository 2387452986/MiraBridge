import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { cpus, freemem, hostname, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  BridgeError,
  MIRABRIDGE_VERSION,
  PROTOCOL_VERSION,
  createScopedId,
  internalTransferSchemas,
  isToolName,
  parseScopedId,
  parseToolInput,
  sha256,
  type OutputEncoding,
  type WorkerConfig,
} from "../../protocol/src/index.js";
import { workerDataRoot } from "./config.js";
import { editText, globPaths, listDirectory, managePath, readText, searchText, statPath, writeText } from "./filesystem.js";
import { cancelJob, getJob, listJobs, readJobLogs, readJobTerminal, reconcileJobs, resizeJobTerminal, startJob, waitJob, writeJobInput } from "./jobs.js";
import { previewFile, readOutputRange } from "./output-files.js";
import { isWithinWindowsRoot, normalizeWorkspaceRelative, PathPolicy } from "./path-policy.js";
import { encodePowerShell, executeProcess, findPowerShell } from "./process-exec.js";
import { emptyRecycleBin, scanRecycleBin } from "./recycle-bin.js";
import { WorkerState, type WorkspaceRow } from "./state.js";
import { ensureStorageCapacity, pathSize, pruneStorage, storageMaintenanceDue, storageStatus } from "./storage.js";
import { TransferStore } from "./transfers.js";
import { detectEdgeExecutable, webSnapshot } from "./web-snapshot.js";
import { conptyAvailability } from "./conpty-process.js";
import { gpuInventory, windowsArchitecture } from "./hardware.js";
import { assertOutputEncodingSupported, detectActiveConsoleCodePage, isWindowsCodePageSupported, windowsCodePageLabel } from "./windows-codepage.js";

const execFileAsync = promisify(execFile);
const powerShellUtf8 = "$ProgressPreference='SilentlyContinue'; [Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $OutputEncoding=[Text.UTF8Encoding]::new();";

async function desktopKnownFolder(): Promise<string | null> {
  if (platform() !== "win32") return null;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${powerShellUtf8} [Environment]::GetFolderPath('Desktop')`],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    );
    return stdout.trim() || null;
  } catch { return null; }
}

async function commandExists(command: string): Promise<boolean> {
  try { await execFileAsync("where.exe", [command], { windowsHide: true }); return true; }
  catch { return false; }
}

async function windowsOsName(): Promise<string> {
  if (platform() !== "win32") return `${platform()} ${release()}`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${powerShellUtf8} (Get-CimInstance Win32_OperatingSystem).Caption`],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    );
    return stdout.trim() || `Windows ${release()}`;
  } catch {
    return `Windows ${release()}`;
  }
}

export class WorkerRuntime {
  readonly transfers: TransferStore;
  private maintenanceTimer: NodeJS.Timeout | undefined;

  private constructor(
    readonly config: WorkerConfig,
    readonly state: WorkerState,
    readonly paths: PathPolicy,
    readonly desktopPath: string | null,
  ) {
    this.transfers = new TransferStore(state, paths, config.storage);
  }

  static async create(config: WorkerConfig, state = new WorkerState()): Promise<WorkerRuntime> {
    const desktop = await desktopKnownFolder();
    const configuredRoots = desktop && config.desktop_access !== "disabled"
      ? [...config.allowed_roots, desktop]
      : config.allowed_roots;
    const paths = await PathPolicy.create(configuredRoots);
    const canonicalDesktop = desktop ? await paths.resolveAbsolute(desktop, true).catch(() => null) : null;
    const runtime = new WorkerRuntime(config, state, paths, canonicalDesktop);
    await runtime.transfers.cleanupStale();
    await reconcileJobs(state)
      .catch((error) => process.stderr.write(`MiraBridge startup Job reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`));
    if (storageMaintenanceDue(state, config.storage.maintenance_interval_minutes)) {
      await pruneStorage(state, config.storage, { dryRun: false, reason: "worker-startup" })
        .catch((error) => process.stderr.write(`MiraBridge startup GC failed: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    runtime.maintenanceTimer = setInterval(() => {
      void reconcileJobs(state)
        .then(async () => await runtime.transfers.cleanupStale())
        .then(async () => {
          if (storageMaintenanceDue(state, config.storage.maintenance_interval_minutes)) {
            await pruneStorage(state, config.storage, { dryRun: false, reason: "scheduled" });
          }
        })
        .catch((error) => process.stderr.write(`MiraBridge scheduled GC failed: ${error instanceof Error ? error.message : String(error)}\n`));
    }, config.storage.maintenance_interval_minutes * 60 * 1000);
    runtime.maintenanceTimer.unref();
    return runtime;
  }

  close(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.state.close();
  }

  private workspace(workspaceId: string, nodeId: string, writable = false): WorkspaceRow {
    if (parseScopedId(workspaceId, "ws").nodeId !== nodeId) throw new BridgeError("WORKSPACE_NOT_FOUND", "Workspace belongs to another node.");
    const workspace = this.state.getWorkspace(workspaceId);
    if (!workspace || workspace.node_id !== nodeId) throw new BridgeError("WORKSPACE_NOT_FOUND", `Workspace was not found: ${workspaceId}`);
    if (writable && workspace.mode !== "read-write") throw new BridgeError("WORKSPACE_READ_ONLY", "Workspace is read-only.");
    return workspace;
  }

  private assertScoped(value: string, kind: "job" | "output" | "transfer" | "scan", nodeId: string): void {
    if (parseScopedId(value, kind).nodeId !== nodeId) throw new BridgeError(kind === "job" ? "JOB_NOT_FOUND" : kind === "output" ? "OUTPUT_NOT_FOUND" : kind === "scan" ? "CONFIRMATION_EXPIRED" : "TRANSFER_FAILED", "Resource belongs to another node.");
  }

  async execute(operation: string, rawArgs: Record<string, unknown>, nodeId: string): Promise<Record<string, unknown>> {
    if (operation.startsWith("transfer_")) return await this.transferOperation(operation, rawArgs, nodeId);
    if (!isToolName(operation)) throw new BridgeError("INVALID_ARGUMENT", `Unsupported operation: ${operation}`);
    const args = parseToolInput(operation, rawArgs);
    switch (operation) {
      case "mira_bridge_describe_node": {
        const terminal = await conptyAvailability();
        const architecture = windowsArchitecture();
        const architectureSupported = ["x64", "arm64"].includes(architecture.architecture)
          && ["x64", "arm64"].includes(architecture.process_architecture);
        const outputEncoding = await detectActiveConsoleCodePage()
          .then((codePage) => ({ default: "auto", console_code_page: codePage, console_label: windowsCodePageLabel(codePage), supported: isWindowsCodePageSupported(codePage) }))
          .catch((error: unknown) => ({ default: "auto", console_code_page: null, console_label: null, supported: false, reason: error instanceof Error ? error.message : String(error) }));
        return {
          node_id: nodeId,
          worker_version: MIRABRIDGE_VERSION,
          protocol_version: PROTOCOL_VERSION,
          os: await windowsOsName(),
          ...architecture,
          architecture_supported: architectureSupported,
          hostname: hostname(),
          shells: ["cmd", "powershell", ...(await commandExists("pwsh.exe") ? ["pwsh"] : [])],
          powershell_version: await this.powerShellVersion(),
          cpu: { name: cpus()[0]?.model ?? "Unknown", logical_cores: cpus().length },
          memory: { total_bytes: totalmem(), available_bytes: freemem() },
          gpu: await gpuInventory(),
          allowed_roots: this.paths.allowedRoots,
          capabilities: [
            "process", "filesystem", "long_jobs", "job_input", "file_transfer", "path_management", "exact_text_edit", "job_discovery",
            ...(terminal.available ? ["conpty_terminal"] : []),
            ...(this.config.recycle_bin_enabled ? ["recycle_bin"] : []),
            ...(this.config.desktop_access !== "disabled" ? ["desktop"] : []),
            ...(this.config.web_snapshot_enabled ? ["web_snapshot"] : []),
          ],
          feature_access: {
            desktop: this.config.desktop_access,
            recycle_bin: this.config.recycle_bin_enabled,
            web_snapshot: this.config.web_snapshot_enabled,
            web_snapshot_external: this.config.web_snapshot_allow_external,
            conpty_terminal: terminal.available,
          },
          known_folders: {
            desktop: { path: this.desktopPath, access: this.config.desktop_access },
          },
          native_tools: {
            edge: await detectEdgeExecutable(),
            tar: await commandExists("tar.exe"),
            curl: await commandExists("curl.exe"),
            dotnet: await commandExists("dotnet.exe"),
            conpty: terminal,
          },
          output_encoding: outputEncoding,
          storage: await storageStatus(this.state, this.config.storage),
        };
      }
      case "mira_bridge_open_workspace": {
        const canonical = await this.paths.openWorkspace(String(args.path));
        if (this.desktopPath && isWithinWindowsRoot(canonical, this.desktopPath)) {
          if (this.config.desktop_access === "disabled") throw new BridgeError("CAPABILITY_NOT_ENABLED", "Desktop access is disabled in worker.toml.");
          if (this.config.desktop_access === "read-only" && args.mode === "read-write") throw new BridgeError("WORKSPACE_READ_ONLY", "Desktop is configured as read-only.");
        }
        const now = new Date().toISOString();
        const workspace: WorkspaceRow = {
          workspace_id: createScopedId("ws", nodeId),
          node_id: nodeId,
          canonical_path: canonical,
          mode: args.mode as "read-only" | "read-write",
          created_at: now,
          last_used_at: now,
        };
        this.state.putWorkspace(workspace);
        return { workspace_id: workspace.workspace_id, canonical_path: canonical, mode: workspace.mode };
      }
      case "mira_bridge_exec":
        return await this.executeProgram(args, nodeId);
      case "mira_bridge_powershell":
        return await this.executePowerShell(args, nodeId);
      case "mira_bridge_list_directory": {
        const workspace = this.workspace(String(args.workspace_id), nodeId);
        return await listDirectory(
          await this.paths.resolveWorkspace(workspace.canonical_path, String(args.path), true),
          args.cursor,
          Number(args.max_entries),
          args.sort_by as "name" | "modified_at" | "size",
          args.sort_order as "asc" | "desc",
        );
      }
      case "mira_bridge_stat": {
        const workspace = this.workspace(String(args.workspace_id), nodeId);
        return await statPath(
          await this.paths.resolveWorkspace(workspace.canonical_path, String(args.path), true),
          args.hash_mode as "auto" | "always" | "never",
        );
      }
      case "mira_bridge_read_text": {
        const workspace = this.workspace(String(args.workspace_id), nodeId);
        return await readText(
          await this.paths.resolveWorkspace(workspace.canonical_path, String(args.path), true),
          Number(args.start_line),
          Number(args.max_lines),
          Boolean(args.include_integrity),
        );
      }
      case "mira_bridge_write_text": {
        const workspace = this.workspace(String(args.workspace_id), nodeId, true);
        const relativePath = String(args.path);
        const target = await this.paths.resolveWorkspace(workspace.canonical_path, relativePath, false);
        const content = String(args.content);
        const result = await this.withStorageReservation(
          operation,
          0,
          dirname(target),
          Buffer.byteLength(content, "utf8"),
          10 * 60 * 1000,
          async () => await writeText(
            target,
            content,
            args.expected_sha256 as string | undefined,
            Boolean(args.create_parents),
            async () => {
              const current = await this.paths.resolveWorkspace(workspace.canonical_path, relativePath, false);
              if (current.toLocaleLowerCase() !== target.toLocaleLowerCase()) {
                throw new BridgeError("FILE_CHANGED", "The target path mapping changed before atomic replacement.");
              }
            },
          ),
        );
        await this.paths.resolveWorkspace(workspace.canonical_path, String(args.path), true);
        return result;
      }
      case "mira_bridge_edit_text": {
        const workspace = this.workspace(String(args.workspace_id), nodeId, true);
        const relativePath = String(args.path);
        const target = await this.paths.resolveWorkspace(workspace.canonical_path, relativePath, true);
        const result = await this.withStorageReservation(
          operation,
          0,
          dirname(target),
          128 * 1024 * 1024,
          30 * 60 * 1000,
          async () => await editText(
            target,
            String(args.expected_sha256),
            args.edits as Array<{ old_text: string; new_text: string; replace_all: boolean }>,
            async () => {
              const current = await this.paths.resolveWorkspace(workspace.canonical_path, relativePath, true);
              if (current.toLocaleLowerCase() !== target.toLocaleLowerCase()) throw new BridgeError("FILE_CHANGED", "The target path mapping changed before atomic replacement.");
            },
          ),
        );
        await this.paths.resolveWorkspace(workspace.canonical_path, relativePath, true);
        return result;
      }
      case "mira_bridge_manage_path": {
        const workspace = this.workspace(String(args.workspace_id), nodeId, true);
        const action = args.action as "mkdir" | "copy" | "move" | "delete";
        const relativePath = String(args.path);
        if (/[*?]/u.test(relativePath) || (typeof args.destination_path === "string" && /[*?]/u.test(args.destination_path))) {
          throw new BridgeError("INVALID_ARGUMENT", "manage_path accepts exact paths, not wildcards.");
        }
        if (normalizeWorkspaceRelative(relativePath) === ".") throw new BridgeError("PERMISSION_DENIED", "The workspace root cannot be managed or deleted.");
        const source = action === "delete"
          ? await this.paths.resolveWorkspaceEntry(workspace.canonical_path, relativePath)
          : await this.paths.resolveWorkspace(workspace.canonical_path, relativePath, action !== "mkdir");
        const destinationRelative = typeof args.destination_path === "string" ? args.destination_path : undefined;
        if ((action === "copy" || action === "move") && !destinationRelative) throw new BridgeError("INVALID_ARGUMENT", `${action} requires destination_path.`);
        if (destinationRelative && normalizeWorkspaceRelative(destinationRelative) === ".") throw new BridgeError("PERMISSION_DENIED", "The workspace root cannot be replaced.");
        const destination = destinationRelative
          ? await this.paths.resolveWorkspace(workspace.canonical_path, destinationRelative, false)
          : undefined;
        const perform = async (): Promise<Record<string, unknown>> => await managePath({
          action,
          source,
          ...(destination ? { destination } : {}),
          recursive: Boolean(args.recursive),
          overwrite: Boolean(args.overwrite),
          ...(typeof args.expected_sha256 === "string" ? { expectedSha256: args.expected_sha256 } : {}),
          beforeCommit: async () => {
            const currentSource = action === "delete"
              ? await this.paths.resolveWorkspaceEntry(workspace.canonical_path, relativePath)
              : await this.paths.resolveWorkspace(workspace.canonical_path, relativePath, action !== "mkdir");
            if (currentSource.toLocaleLowerCase() !== source.toLocaleLowerCase()) throw new BridgeError("RESOURCE_CHANGED", "The source path mapping changed during the operation.");
            if (destination && destinationRelative) {
              const currentDestination = await this.paths.resolveWorkspace(workspace.canonical_path, destinationRelative, false);
              if (currentDestination.toLocaleLowerCase() !== destination.toLocaleLowerCase()) throw new BridgeError("RESOURCE_CHANGED", "The destination path mapping changed during the operation.");
            }
          },
        });
        const result = action === "copy" && destination
          ? await this.withStorageReservation(operation, 0, dirname(destination), await pathSize(source), 60 * 60 * 1000, perform)
          : action === "mkdir"
            ? await this.withStorageReservation(operation, 0, dirname(source), 0, 10 * 60 * 1000, perform)
            : await perform();
        if (action === "mkdir") await this.paths.resolveWorkspace(workspace.canonical_path, relativePath, true);
        if ((action === "copy" || action === "move") && destinationRelative) await this.paths.resolveWorkspace(workspace.canonical_path, destinationRelative, true);
        return result;
      }
      case "mira_bridge_search_text": {
        const workspace = this.workspace(String(args.workspace_id), nodeId);
        const root = await this.paths.resolveWorkspace(workspace.canonical_path, String(args.path), true);
        return await searchText(root, String(args.query), String(args.file_glob), Boolean(args.case_sensitive), args.cursor, Number(args.max_results));
      }
      case "mira_bridge_glob": {
        const workspace = this.workspace(String(args.workspace_id), nodeId);
        const root = await this.paths.resolveWorkspace(workspace.canonical_path, String(args.path), true);
        return await globPaths(
          root,
          String(args.pattern),
          args.cursor,
          Number(args.max_results),
          args.sort_by as "path" | "modified_at" | "size",
          args.sort_order as "asc" | "desc",
        );
      }
      case "mira_bridge_start_job": {
        await reconcileJobs(this.state);
        if (this.state.countNonTerminalJobs() >= this.config.max_queued_jobs + this.config.max_concurrent_jobs) {
          throw new BridgeError("STORAGE_QUOTA_EXCEEDED", "The configured queued Job limit has been reached.", { details: { max_queued_jobs: this.config.max_queued_jobs } });
        }
        const workspace = this.workspace(String(args.workspace_id), nodeId, true);
        const cwd = await this.paths.resolveWorkspace(workspace.canonical_path, String(args.cwd), true);
        const stdinMode = args.stdin_mode as "closed" | "pipe" | "conpty";
        const outputEncoding = args.output_encoding as OutputEncoding;
        if (stdinMode === "conpty") {
          const terminal = await conptyAvailability();
          if (!terminal.available) throw new BridgeError("TERMINAL_UNAVAILABLE", terminal.reason ?? "ConPTY is unavailable.", { details: { ...terminal } });
        } else {
          const consoleCodePage = outputEncoding === "utf-8" ? 65001 : await detectActiveConsoleCodePage()
            .catch((error: unknown) => { throw new BridgeError("UNSUPPORTED_ENCODING", "The active Windows console output code page could not be detected.", { cause: error }); });
          assertOutputEncodingSupported(outputEncoding, consoleCodePage);
        }
        const storageReservationId = `job-storage-${randomUUID()}`;
        await this.beforeDiskOperation(operation, this.config.storage.max_stream_bytes * 2, {
          reservationId: storageReservationId,
          reservationTtlMs: Number(args.timeout_ms) + 60 * 60 * 1000,
        });
        try {
          return await startJob(this.state, nodeId, workspace, {
            program: String(args.program), args: args.args as string[], cwd, env: args.env as Record<string, string>, timeoutMs: Number(args.timeout_ms),
            stdinMode,
            outputEncoding,
            storageReservationId,
            ...(args.terminal_size ? { terminal: args.terminal_size as { cols: number; rows: number } } : {}),
            ...(args.label ? { label: String(args.label) } : {}),
            ...(args.idempotency_key ? { idempotencyKey: String(args.idempotency_key) } : {}),
          });
        } catch (error) {
          this.state.releaseStorageReservation(storageReservationId);
          throw error;
        }
      }
      case "mira_bridge_write_job_input":
        await reconcileJobs(this.state);
        this.assertScoped(String(args.job_id), "job", nodeId);
        return await writeJobInput(this.state, String(args.job_id), String(args.data), Boolean(args.close));
      case "mira_bridge_read_job_terminal":
        await reconcileJobs(this.state);
        this.assertScoped(String(args.job_id), "job", nodeId);
        return await readJobTerminal(this.state, String(args.job_id));
      case "mira_bridge_resize_job_terminal":
        await reconcileJobs(this.state);
        this.assertScoped(String(args.job_id), "job", nodeId);
        return await resizeJobTerminal(this.state, String(args.job_id), Number(args.cols), Number(args.rows));
      case "mira_bridge_get_job":
        await reconcileJobs(this.state);
        this.assertScoped(String(args.job_id), "job", nodeId);
        return getJob(this.state, String(args.job_id));
      case "mira_bridge_list_jobs":
        await reconcileJobs(this.state);
        return listJobs(
          this.state,
          args.statuses as Parameters<typeof listJobs>[1],
          args.cursor,
          Number(args.max_results),
          nodeId,
        );
      case "mira_bridge_read_job_logs":
        await reconcileJobs(this.state);
        this.assertScoped(String(args.job_id), "job", nodeId);
        return await readJobLogs(this.state, String(args.job_id), args.stream as "stdout" | "stderr", Number(args.offset), Number(args.max_bytes), args.tail_lines as number | undefined);
      case "mira_bridge_wait_job":
        await reconcileJobs(this.state);
        this.assertScoped(String(args.job_id), "job", nodeId);
        return await waitJob(this.state, String(args.job_id), Number(args.timeout_ms));
      case "mira_bridge_cancel_job":
        await reconcileJobs(this.state);
        this.assertScoped(String(args.job_id), "job", nodeId);
        return await cancelJob(this.state, String(args.job_id));
      case "mira_bridge_read_output": {
        const outputRef = String(args.output_ref);
        this.assertScoped(outputRef, "output", nodeId);
        const output = this.state.getOutput(outputRef);
        if (!output) throw new BridgeError("OUTPUT_NOT_FOUND", `Output was not found: ${outputRef}`);
        if (output.pruned_at) throw new BridgeError("OUTPUT_EXPIRED", "Command output expired under the configured retention policy.", { details: { output_ref: outputRef, pruned_at: output.pruned_at, reason: output.prune_reason } });
        const stream = args.stream as "stdout" | "stderr";
        const stdout = stream === "stdout";
        const range = await readOutputRange(stdout ? output.stdout_path : output.stderr_path, Number(args.offset), Number(args.max_bytes), args.tail_lines as number | undefined);
        return {
          output_ref: outputRef,
          stream,
          ...range,
          total_bytes: stdout ? output.stdout_bytes : output.stderr_bytes,
          stored_bytes: stdout ? output.stdout_stored_bytes : output.stderr_stored_bytes,
          storage_truncated: Boolean(stdout ? output.stdout_storage_truncated : output.stderr_storage_truncated),
        };
      }
      case "mira_bridge_scan_recycle_bin":
        if (!this.config.recycle_bin_enabled) throw new BridgeError("CAPABILITY_NOT_ENABLED", "Recycle Bin access is disabled in worker.toml.");
        return await this.withStorageReservation(
          operation,
          96 * 1024 * 1024,
          undefined,
          0,
          15 * 60 * 1000,
          async () => await scanRecycleBin(this.state, nodeId, args.drives as string[] | undefined, Number(args.max_items)),
        );
      case "mira_bridge_empty_recycle_bin": {
        if (!this.config.recycle_bin_enabled) throw new BridgeError("CAPABILITY_NOT_ENABLED", "Recycle Bin access is disabled in worker.toml.");
        const scanId = String(args.scan_id);
        this.assertScoped(scanId, "scan", nodeId);
        return await emptyRecycleBin(this.state, nodeId, scanId);
      }
      case "mira_bridge_web_snapshot": {
        if (!this.config.web_snapshot_enabled) throw new BridgeError("CAPABILITY_NOT_ENABLED", "Web Snapshot is disabled in worker.toml.");
        const workspace = this.workspace(String(args.workspace_id), nodeId, true);
        const screenshotRelative = String(args.screenshot_path);
        const screenshotPath = await this.paths.resolveWorkspace(workspace.canonical_path, screenshotRelative, false);
        const domRelative = typeof args.dom_path === "string" ? args.dom_path : undefined;
        const domPath = domRelative ? await this.paths.resolveWorkspace(workspace.canonical_path, domRelative, false) : undefined;
        if (domPath && domPath.toLocaleLowerCase() === screenshotPath.toLocaleLowerCase()) throw new BridgeError("INVALID_ARGUMENT", "dom_path and screenshot_path must be different.");
        const result = await this.withStorageReservation(operation, 0, dirname(screenshotPath), 256 * 1024 * 1024, Number(args.timeout_ms) + 5 * 60 * 1000, async () => await webSnapshot({
          url: String(args.url),
          screenshotPath,
          ...(domPath ? { domPath } : {}),
          viewport: args.viewport as { width: number; height: number },
          fullPage: Boolean(args.full_page),
          waitUntil: args.wait_until as "domcontentloaded" | "load" | "networkidle",
          networkPolicy: args.network_policy as "local-only" | "allow-external",
          timeoutMs: Number(args.timeout_ms),
          allowExternal: this.config.web_snapshot_allow_external,
          overwrite: Boolean(args.overwrite),
          beforeCommit: async () => {
            const currentScreenshot = await this.paths.resolveWorkspace(workspace.canonical_path, screenshotRelative, false);
            if (currentScreenshot.toLocaleLowerCase() !== screenshotPath.toLocaleLowerCase()) throw new BridgeError("RESOURCE_CHANGED", "Screenshot path mapping changed before commit.");
            if (domPath && domRelative) {
              const currentDom = await this.paths.resolveWorkspace(workspace.canonical_path, domRelative, false);
              if (currentDom.toLocaleLowerCase() !== domPath.toLocaleLowerCase()) throw new BridgeError("RESOURCE_CHANGED", "DOM path mapping changed before commit.");
            }
          },
        }));
        await this.paths.resolveWorkspace(workspace.canonical_path, screenshotRelative, true);
        if (domRelative) await this.paths.resolveWorkspace(workspace.canonical_path, domRelative, true);
        return result;
      }
      default:
        throw new BridgeError("INVALID_ARGUMENT", `Operation is not handled by the Windows worker: ${operation}`);
    }
  }

  private async executeProgram(args: Record<string, unknown>, nodeId: string): Promise<Record<string, unknown>> {
    const workspace = this.workspace(String(args.workspace_id), nodeId, true);
    const cwd = await this.paths.resolveWorkspace(workspace.canonical_path, String(args.cwd), true);
    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : this.config.default_timeout_ms;
    if (timeoutMs > this.config.max_sync_timeout_ms) throw new BridgeError("INVALID_ARGUMENT", "timeout_ms exceeds max_sync_timeout_ms; use a Job.");
    return await this.captureProcess(nodeId, {
      program: String(args.program),
      args: args.args as string[],
      cwd,
      env: args.env as Record<string, string>,
      timeoutMs,
      outputEncoding: args.output_encoding as OutputEncoding,
    });
  }

  private async executePowerShell(args: Record<string, unknown>, nodeId: string): Promise<Record<string, unknown>> {
    const workspace = this.workspace(String(args.workspace_id), nodeId, true);
    const cwd = await this.paths.resolveWorkspace(workspace.canonical_path, String(args.cwd), true);
    const script = String(args.script);
    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : this.config.default_timeout_ms;
    if (timeoutMs > this.config.max_sync_timeout_ms) throw new BridgeError("INVALID_ARGUMENT", "timeout_ms exceeds max_sync_timeout_ms; use a Job.");
    const result = await this.captureProcess(nodeId, {
      program: await findPowerShell(),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
      cwd,
      env: {},
      timeoutMs,
      outputEncoding: "utf-8",
    });
    return { ...result, script_sha256: sha256(script) };
  }

  private async captureProcess(nodeId: string, spec: { program: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number; outputEncoding: OutputEncoding }): Promise<Record<string, unknown>> {
    const outputRef = createScopedId("output", nodeId);
    const storageReservationId = `sync-storage-${outputRef}`;
    await this.beforeDiskOperation("synchronous-output", this.config.storage.max_stream_bytes * 2, {
      reservationId: storageReservationId,
      reservationTtlMs: spec.timeoutMs + 5 * 60 * 1000,
    });
    const directory = join(workerDataRoot(), "outputs", outputRef);
    let recorded = false;
    try {
      await mkdir(directory, { recursive: false });
      const stdoutPath = join(directory, "stdout.log");
      const stderrPath = join(directory, "stderr.log");
      let outcome;
      try { outcome = await executeProcess(spec, stdoutPath, stderrPath, undefined, this.config.storage.max_stream_bytes); }
      catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
      const [stdout, stderr] = await Promise.all([
        previewFile(stdoutPath, this.config.max_inline_output_bytes),
        previewFile(stderrPath, this.config.max_inline_output_bytes),
      ]);
      this.state.putOutput({
        output_ref: outputRef, node_id: nodeId, stdout_path: stdoutPath, stderr_path: stderrPath,
        stdout_bytes: outcome.stdout.totalBytes, stderr_bytes: outcome.stderr.totalBytes,
        stdout_stored_bytes: outcome.stdout.storedBytes, stderr_stored_bytes: outcome.stderr.storedBytes,
        stdout_storage_truncated: outcome.stdout.storageTruncated ? 1 : 0,
        stderr_storage_truncated: outcome.stderr.storageTruncated ? 1 : 0,
        created_at: new Date().toISOString(), pruned_at: null, prune_reason: null,
      });
      recorded = true;
      const truncated = stdout.truncated || stderr.truncated;
      return {
        exit_code: outcome.exitCode,
        stdout: stdout.text ?? "",
        stderr: stderr.text ?? "",
        stdout_head: stdout.head,
        stdout_tail: stdout.tail,
        stderr_head: stderr.head,
        stderr_tail: stderr.tail,
        duration_ms: outcome.durationMs,
        timed_out: outcome.timedOut,
        truncated,
        output_ref: truncated ? outputRef : null,
        stdout_bytes: outcome.stdout.totalBytes,
        stderr_bytes: outcome.stderr.totalBytes,
        stdout_stored_bytes: outcome.stdout.storedBytes,
        stderr_stored_bytes: outcome.stderr.storedBytes,
        stdout_storage_truncated: outcome.stdout.storageTruncated,
        stderr_storage_truncated: outcome.stderr.storageTruncated,
        stdout_encoding: outcome.stdoutEncoding,
        stderr_encoding: outcome.stderrEncoding,
      };
    } catch (error) {
      if (!recorded) await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      this.state.releaseStorageReservation(storageReservationId);
    }
  }

  private async transferOperation(operation: string, args: Record<string, unknown>, nodeId: string): Promise<Record<string, unknown>> {
    const schema = internalTransferSchemas[operation as keyof typeof internalTransferSchemas];
    if (!schema) throw new BridgeError("INVALID_ARGUMENT", `Unsupported transfer operation: ${operation}`);
    const parsed = schema.parse(args) as Record<string, unknown>;
    if ((operation === "transfer_begin_push" || operation === "transfer_begin_directory_push") && typeof parsed.destination_path === "string") {
      const target = await this.paths.resolveAbsolute(parsed.destination_path, false);
      if (this.desktopPath && isWithinWindowsRoot(target, this.desktopPath) && this.config.desktop_access !== "read-write") {
        throw new BridgeError(this.config.desktop_access === "disabled" ? "CAPABILITY_NOT_ENABLED" : "WORKSPACE_READ_ONLY", "Desktop is not authorized for transfer writes.");
      }
    }
    if (typeof parsed.transfer_id === "string") this.assertScoped(parsed.transfer_id, "transfer", nodeId);
    switch (operation) {
      case "transfer_begin_push": return await this.transfers.beginPush(nodeId, String(parsed.destination_path), Number(parsed.size), String(parsed.sha256), Boolean(parsed.overwrite));
      case "transfer_begin_directory_push": return await this.transfers.beginDirectoryPush(
        nodeId,
        String(parsed.destination_path),
        Number(parsed.size),
        String(parsed.sha256),
        parsed.manifest as Parameters<TransferStore["beginDirectoryPush"]>[4],
        String(parsed.manifest_sha256),
        Boolean(parsed.overwrite),
        parsed.manifest
          ? undefined
          : {
              entries: Number(parsed.manifest_entries),
              files: Number(parsed.manifest_files),
              total_file_bytes: Number(parsed.total_file_bytes),
            },
      );
      case "transfer_write_chunk": return await this.transfers.writeChunk(String(parsed.transfer_id), Number(parsed.offset), String(parsed.data_base64));
      case "transfer_commit_push": return await this.transfers.commitPush(String(parsed.transfer_id));
      case "transfer_begin_pull": return await this.transfers.beginPull(nodeId, String(parsed.source_path), parsed.kind as "auto" | "file" | "directory");
      case "transfer_read_chunk": return await this.transfers.readChunk(String(parsed.transfer_id), Number(parsed.offset), Number(parsed.max_bytes));
      case "transfer_finish": return await this.transfers.finish(String(parsed.transfer_id));
      default: throw new BridgeError("INVALID_ARGUMENT", `Unsupported transfer operation: ${operation}`);
    }
  }

  private async powerShellVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      return stdout.trim();
    } catch { return null; }
  }

  private async beforeDiskOperation(
    operation: string,
    requiredBytes = 0,
    options: { targetPath?: string; targetRequiredBytes?: number; reservationId?: string; reservationTtlMs?: number } = {},
  ): Promise<void> {
    await ensureStorageCapacity(this.state, this.config.storage, operation, { requiredBytes, ...options });
  }

  private async withStorageReservation<T>(
    operation: string,
    requiredBytes: number,
    targetPath: string | undefined,
    targetRequiredBytes: number,
    reservationTtlMs: number,
    action: () => Promise<T>,
  ): Promise<T> {
    const reservationId = `operation-storage-${randomUUID()}`;
    await this.beforeDiskOperation(operation, requiredBytes, {
      ...(targetPath ? { targetPath } : {}),
      targetRequiredBytes,
      reservationId,
      reservationTtlMs,
    });
    try { return await action(); }
    finally { this.state.releaseStorageReservation(reservationId); }
  }
}
