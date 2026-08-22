import { z } from "zod";
import { MAX_DIRECTORY_TRANSFER_ENTRIES, PROTOCOL_VERSION, errorCodes, jobStatuses } from "./constants.js";
import { bridgeErrorSchema } from "./errors.js";

const nodeId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const pathValue = z.string().min(1).max(32767);
const sshHost = z.string().min(1).max(255).refine(
  (value) => !value.startsWith("-") && !/[\0\s,@/\\]/u.test(value),
  "host must be a hostname or IP literal without whitespace, path separators, commas, @, NUL, or a leading dash",
);
const sshUser = z.string().min(1).max(128).refine(
  (value) => !value.includes("\0") && !/[\r\n]/u.test(value),
  "user may not contain NUL or line breaks",
);
const handle = z.string().min(10).max(256);
const timeout = z.number().int().min(100).max(1_800_000).optional();
const jobTimeout = z.number().int().min(100).max(86_400_000).default(7_200_000);
const args = z.array(z.string().max(32767)).max(256).default([]);
const environment = z
  .record(z.string().min(1).max(128), z.string().max(32767))
  .refine((value) => Object.keys(value).length <= 128, "env may contain at most 128 entries")
  .default({});

export const outputEncodingSchema = z.union([
  z.enum(["auto", "utf-8", "console"]),
  z.string().regex(/^cp\d{3,5}$/u, "output_encoding must be auto, utf-8, console, or cpNNN"),
]);
export type OutputEncoding = z.infer<typeof outputEncodingSchema>;

const terminalSize = z.object({
  cols: z.number().int().min(20).max(500).default(120),
  rows: z.number().int().min(5).max(200).default(30),
}).strict();

const processInput = {
  workspace_id: handle,
  program: z.string().min(1).max(32767),
  args,
  cwd: pathValue.default("."),
  env: environment,
  timeout_ms: timeout,
  output_encoding: outputEncodingSchema.default("auto"),
};

const jobInputMessage = z.object({
  job_id: handle,
  data: z.string().default(""),
  close: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  const bytes = Buffer.byteLength(value.data, "utf8");
  if (bytes > 64 * 1024) {
    context.addIssue({ code: "custom", path: ["data"], message: "data may contain at most 64 KiB of UTF-8 input" });
  }
  if (bytes === 0 && !value.close) {
    context.addIssue({ code: "custom", message: "data must be non-empty unless close is true" });
  }
});

export const publicResultSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: bridgeErrorSchema.optional(),
});

export type PublicResult = z.infer<typeof publicResultSchema>;

export interface ToolDefinition {
  description: string;
  input: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const queryState = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const mutate = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const openWorldMutate = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export const toolDefinitions = {
  mira_bridge_list_nodes: {
    description: "List configured Windows nodes without connecting to them.",
    input: z.object({}).strict(),
    annotations: readOnly,
  },
  mira_bridge_describe_node: {
    description: "Connect to one Windows node and return its real OS, native/process architecture, CPU, memory, complete display-adapter inventory, shells, roots, and capabilities.",
    input: z.object({ node_id: nodeId }).strict(),
    annotations: readOnly,
  },
  mira_bridge_open_workspace: {
    description: "Open an allowed Windows directory as a bounded read-only or read-write workspace.",
    input: z.object({ node_id: nodeId, path: pathValue, mode: z.enum(["read-only", "read-write"]).default("read-write") }).strict(),
    annotations: queryState,
  },
  mira_bridge_exec: {
    description: "Run a Windows-native program with a structured argv array. This does not translate shell commands.",
    input: z.object(processInput).strict(),
    annotations: mutate,
  },
  mira_bridge_powershell: {
    description: "Run an explicit non-interactive PowerShell script on Windows. This is a high-risk, approval-gated tool.",
    input: z.object({ workspace_id: handle, script: z.string().min(1).max(1_048_576), cwd: pathValue.default("."), timeout_ms: timeout }).strict(),
    annotations: mutate,
  },
  mira_bridge_list_directory: {
    description: "List one Windows workspace directory with bounded, mutation-aware pagination and optional metadata sorting.",
    input: z.object({
      workspace_id: handle,
      path: pathValue.default("."),
      cursor: z.string().max(512).optional(),
      max_entries: z.number().int().min(1).max(1000).default(200),
      sort_by: z.enum(["name", "modified_at", "size"]).default("name"),
      sort_order: z.enum(["asc", "desc"]).default("asc"),
    }).strict(),
    annotations: readOnly,
  },
  mira_bridge_stat: {
    description: "Return Windows path metadata and, for bounded files or explicit requests, SHA-256 without forcing every large artifact through a full hash.",
    input: z.object({ workspace_id: handle, path: pathValue, hash_mode: z.enum(["auto", "always", "never"]).default("auto") }).strict(),
    annotations: readOnly,
  },
  mira_bridge_read_text: {
    description: "Read a bounded line range from a text file; include_integrity=false may stop after the requested page instead of scanning a huge file to EOF.",
    input: z.object({ workspace_id: handle, path: pathValue, start_line: z.number().int().min(1).default(1), max_lines: z.number().int().min(1).max(2000).default(500), include_integrity: z.boolean().default(true) }).strict(),
    annotations: readOnly,
  },
  mira_bridge_write_text: {
    description: "Atomically write UTF-8 text in a read-write Windows workspace, optionally guarded by expected SHA-256.",
    input: z.object({ workspace_id: handle, path: pathValue, content: z.string().max(1_048_576), expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), create_parents: z.boolean().default(false) }).strict(),
    annotations: mutate,
  },
  mira_bridge_edit_text: {
    description: "Atomically apply exact text replacements to an existing Windows text file guarded by its SHA-256.",
    input: z.object({
      workspace_id: handle,
      path: pathValue,
      expected_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      edits: z.array(z.object({
        old_text: z.string().min(1).max(1_048_576),
        new_text: z.string().max(1_048_576),
        replace_all: z.boolean().default(false),
      }).strict()).min(1).max(64),
    }).strict(),
    annotations: mutate,
  },
  mira_bridge_manage_path: {
    description: "Create, copy, move, or delete one exact path inside a read-write Windows workspace without shell wildcards.",
    input: z.object({
      workspace_id: handle,
      action: z.enum(["mkdir", "copy", "move", "delete"]),
      path: pathValue,
      destination_path: pathValue.optional(),
      recursive: z.boolean().default(false),
      overwrite: z.boolean().default(false),
      expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }).strict(),
    annotations: mutate,
  },
  mira_bridge_search_text: {
    description: "Search text files in a Windows workspace and return bounded snippets with line numbers.",
    input: z.object({ workspace_id: handle, query: z.string().min(1).max(4096), path: pathValue.default("."), file_glob: z.string().min(1).max(4096).default("**/*"), case_sensitive: z.boolean().default(false), cursor: z.string().max(512).optional(), max_results: z.number().int().min(1).max(1000).default(100) }).strict(),
    annotations: readOnly,
  },
  mira_bridge_glob: {
    description: "Match file and directory names in a Windows workspace with bounded pagination, metadata, and optional modification-time sorting.",
    input: z.object({
      workspace_id: handle,
      pattern: z.string().min(1).max(4096),
      path: pathValue.default("."),
      cursor: z.string().max(512).optional(),
      max_results: z.number().int().min(1).max(1000).default(200),
      sort_by: z.enum(["path", "modified_at", "size"]).default("path"),
      sort_order: z.enum(["asc", "desc"]).default("asc"),
    }).strict(),
    annotations: readOnly,
  },
  mira_bridge_push: {
    description: "Upload one explicit Mac-local file or directory to an allowed absolute Windows path with manifest and SHA-256 verification.",
    input: z.object({ node_id: nodeId, source_path: pathValue, destination_path: pathValue, kind: z.enum(["auto", "file", "directory"]).default("auto"), overwrite: z.boolean().default(false) }).strict(),
    annotations: mutate,
  },
  mira_bridge_pull: {
    description: "Download one allowed Windows file or directory to an explicit Mac-local path with manifest and SHA-256 verification.",
    input: z.object({ node_id: nodeId, source_path: pathValue, destination_path: pathValue, kind: z.enum(["auto", "file", "directory"]).default("auto"), overwrite: z.boolean().default(false) }).strict(),
    annotations: mutate,
  },
  mira_bridge_start_job: {
    description: "Start a durable long-running Windows process and immediately return a Job ID.",
    input: z.object({
      ...processInput,
      timeout_ms: jobTimeout,
      label: z.string().trim().min(1).max(200).optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
      stdin_mode: z.enum(["closed", "pipe", "conpty"]).default("closed"),
      terminal_size: terminalSize.optional(),
    }).strict().superRefine((value, context) => {
      if (value.stdin_mode !== "conpty" && value.terminal_size !== undefined) {
        context.addIssue({ code: "custom", path: ["terminal_size"], message: "terminal_size is valid only with stdin_mode=conpty" });
      }
      if (value.stdin_mode === "conpty" && value.output_encoding !== "auto" && value.output_encoding !== "utf-8") {
        context.addIssue({ code: "custom", path: ["output_encoding"], message: "ConPTY output is always UTF-8" });
      }
    }),
    annotations: mutate,
  },
  mira_bridge_write_job_input: {
    description: "Write bounded UTF-8 input, VT control keys, or EOF to an active pipe or ConPTY Windows Job.",
    input: jobInputMessage,
    annotations: mutate,
  },
  mira_bridge_read_job_terminal: {
    description: "Read the latest persisted active-screen snapshot for a ConPTY Windows Job.",
    input: z.object({ job_id: handle }).strict(),
    annotations: readOnly,
  },
  mira_bridge_resize_job_terminal: {
    description: "Resize an active ConPTY Windows Job terminal.",
    input: z.object({ job_id: handle, ...terminalSize.shape }).strict(),
    annotations: mutate,
  },
  mira_bridge_get_job: {
    description: "Read executor status and exit metadata for a Windows Job.",
    input: z.object({ job_id: handle }).strict(),
    annotations: readOnly,
  },
  mira_bridge_list_jobs: {
    description: "List durable Windows Jobs for a node with status filtering and bounded pagination.",
    input: z.object({
      node_id: nodeId,
      statuses: z.array(z.enum(jobStatuses)).max(jobStatuses.length).optional(),
      cursor: z.string().max(512).optional(),
      max_results: z.number().int().min(1).max(500).default(100),
    }).strict(),
    annotations: readOnly,
  },
  mira_bridge_read_job_logs: {
    description: "Read a bounded byte range or tail from a Windows Job stdout or stderr log.",
    input: z.object({ job_id: handle, stream: z.enum(["stdout", "stderr"]).default("stdout"), offset: z.number().int().min(0).default(0), max_bytes: z.number().int().min(1).max(262144).default(65536), tail_lines: z.number().int().min(1).max(2000).optional() }).strict(),
    annotations: readOnly,
  },
  mira_bridge_wait_job: {
    description: "Wait up to 60 seconds for a Windows Job status change, then return current executor status.",
    input: z.object({ job_id: handle, timeout_ms: z.number().int().min(100).max(60000).default(30000) }).strict(),
    annotations: readOnly,
  },
  mira_bridge_cancel_job: {
    description: "Cancel a running Windows Job and terminate its recorded process tree.",
    input: z.object({ job_id: handle }).strict(),
    annotations: mutate,
  },
  mira_bridge_read_output: {
    description: "Read a bounded byte range or tail from a previously truncated Windows command output.",
    input: z.object({ output_ref: handle, stream: z.enum(["stdout", "stderr"]).default("stdout"), offset: z.number().int().min(0).default(0), max_bytes: z.number().int().min(1).max(262144).default(65536), tail_lines: z.number().int().min(1).max(2000).optional() }).strict(),
    annotations: readOnly,
  },
  mira_bridge_scan_recycle_bin: {
    description: "Read the current Windows account Recycle Bin and create a short-lived immutable scan receipt.",
    input: z.object({
      node_id: nodeId,
      drives: z.array(z.string().regex(/^[A-Z]$/)).max(26).optional(),
      max_items: z.number().int().min(0).max(500).default(100),
    }).strict(),
    annotations: readOnly,
  },
  mira_bridge_empty_recycle_bin: {
    description: "Permanently empty only the drives captured by an unexpired, unchanged Recycle Bin scan receipt.",
    input: z.object({ scan_id: handle }).strict(),
    annotations: mutate,
  },
  mira_bridge_web_snapshot: {
    description: "Open an HTTP(S) page in isolated headless Microsoft Edge and save a screenshot inside the Windows workspace.",
    input: z.object({
      workspace_id: handle,
      url: z.string().url().max(4096),
      screenshot_path: pathValue,
      dom_path: pathValue.optional(),
      viewport: z.object({ width: z.number().int().min(320).max(7680).default(1440), height: z.number().int().min(240).max(4320).default(900) }).strict().default({ width: 1440, height: 900 }),
      full_page: z.boolean().default(true),
      overwrite: z.boolean().default(false),
      wait_until: z.enum(["domcontentloaded", "load", "networkidle"]).default("networkidle"),
      network_policy: z.enum(["local-only", "allow-external"]).default("local-only"),
      timeout_ms: z.number().int().min(100).max(120000).default(30000),
    }).strict(),
    annotations: openWorldMutate,
  },
} satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof toolDefinitions;
export const toolNames = Object.keys(toolDefinitions) as ToolName[];

export function isToolName(value: string): value is ToolName {
  return Object.hasOwn(toolDefinitions, value);
}

export function parseToolInput(name: ToolName, value: unknown): Record<string, unknown> {
  return toolDefinitions[name].input.parse(value) as Record<string, unknown>;
}

export const nodeConfigSchema = z.object({
  host: sshHost,
  port: z.number().int().min(1).max(65535).default(22),
  user: sshUser,
  identity_file: pathValue.refine((value) => !value.includes("\0"), "identity_file may not contain NUL"),
  host_fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/=]+$/),
  worker_command: z.string().min(1).max(4096).default("mirabridge-worker serve --stdio"),
  management_command: z.string().min(1).max(4096).regex(/^[A-Za-z0-9_ .:\\"/-]+$/u).optional(),
  connect_timeout_ms: z.number().int().min(100).max(120000).default(10000),
}).strict();

export const macConfigSchema = z.object({ nodes: z.record(nodeId, nodeConfigSchema).default({}) }).strict();
export type MacConfig = z.infer<typeof macConfigSchema>;
export type NodeConfig = z.infer<typeof nodeConfigSchema>;

export const storageConfigSchema = z.object({
  request_retention_days: z.number().int().min(1).max(3650).default(7),
  output_retention_days: z.number().int().min(1).max(3650).default(7),
  job_log_retention_days: z.number().int().min(1).max(3650).default(14),
  metadata_retention_days: z.number().int().min(1).max(3650).default(90),
  audit_retention_days: z.number().int().min(1).max(3650).default(90),
  max_bytes: z.number().int().min(64 * 1024 * 1024).max(Number.MAX_SAFE_INTEGER).default(10 * 1024 * 1024 * 1024),
  min_free_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(2 * 1024 * 1024 * 1024),
  max_stream_bytes: z.number().int().min(1024 * 1024).max(4 * 1024 * 1024 * 1024).default(256 * 1024 * 1024),
  maintenance_interval_minutes: z.number().int().min(1).max(1440).default(60),
}).strict();

const defaultStorage = storageConfigSchema.parse({});

export const workerConfigSchema = z.object({
  allowed_roots: z.array(pathValue).min(1),
  desktop_access: z.enum(["disabled", "read-only", "read-write"]).default("disabled"),
  recycle_bin_enabled: z.boolean().default(false),
  web_snapshot_enabled: z.boolean().default(false),
  web_snapshot_allow_external: z.boolean().default(false),
  max_concurrent_jobs: z.number().int().min(1).max(64).default(2),
  max_queued_jobs: z.number().int().min(1).max(1000).default(32),
  max_inline_output_bytes: z.number().int().min(1024).max(1_048_576).default(65536),
  default_timeout_ms: z.number().int().min(100).max(1_800_000).default(300000),
  max_sync_timeout_ms: z.number().int().min(100).max(1_800_000).default(1800000),
  storage: storageConfigSchema.default(defaultStorage),
}).strict().refine((value) => value.default_timeout_ms <= value.max_sync_timeout_ms, {
  path: ["default_timeout_ms"],
  message: "default_timeout_ms must not exceed max_sync_timeout_ms",
});
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;

export const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().min(1).max(128),
  method: z.literal("mirabridge.invoke"),
  params: z.object({
    protocol_version: z.string(),
    request_id: z.string().min(1).max(128),
    node_id: nodeId,
    operation: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()),
    timestamp: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

export const rpcPayloadSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION),
  request_id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: bridgeErrorSchema.optional(),
  duration_ms: z.number().int().min(0),
});
export type RpcPayload = z.infer<typeof rpcPayloadSchema>;

export const rpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  result: rpcPayloadSchema,
}).strict();
export type RpcResponse = z.infer<typeof rpcResponseSchema>;

export const persistedJobSchema = z.object({
  job_id: handle,
  node_id: nodeId,
  workspace_id: handle,
  executor_status: z.enum(jobStatuses),
  exit_code: z.number().int().nullable(),
  pid: z.number().int().positive().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  stdout_bytes: z.number().int().min(0),
  stderr_bytes: z.number().int().min(0),
  stdin_mode: z.enum(["closed", "pipe", "conpty"]),
  output_encoding: outputEncodingSchema,
  stdout_encoding: z.string().nullable(),
  stderr_encoding: z.string().nullable(),
  terminal_cols: z.number().int().nullable(),
  terminal_rows: z.number().int().nullable(),
});

export const transferManifestEntrySchema = z.object({
  path: z.string().min(1).max(4096),
  type: z.enum(["file", "directory"]),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
}).strict().superRefine((value, context) => {
  if (value.type === "directory" && (value.size !== 0 || value.sha256 !== null)) context.addIssue({ code: "custom", message: "Directory manifest entries require size=0 and sha256=null." });
  if (value.type === "file" && value.sha256 === null) context.addIssue({ code: "custom", message: "File manifest entries require sha256." });
});

const transferManifest = z.array(transferManifestEntrySchema).max(MAX_DIRECTORY_TRANSFER_ENTRIES);

const directoryTransferSummary = {
  manifest_entries: z.number().int().min(0).max(MAX_DIRECTORY_TRANSFER_ENTRIES).optional(),
  manifest_files: z.number().int().min(0).max(MAX_DIRECTORY_TRANSFER_ENTRIES).optional(),
  total_file_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
};

export const internalTransferSchemas = {
  transfer_begin_push: z.object({ destination_path: pathValue, size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/), overwrite: z.boolean() }).strict(),
  transfer_begin_directory_push: z.object({
    destination_path: pathValue,
    size: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    manifest: transferManifest.optional(),
    manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    ...directoryTransferSummary,
    overwrite: z.boolean(),
  }).strict().superRefine((value, context) => {
    if (!value.manifest && (value.manifest_entries === undefined || value.manifest_files === undefined || value.total_file_bytes === undefined)) {
      context.addIssue({ code: "custom", message: "Directory push requires either an inline manifest or all manifest summary fields." });
    }
    if (value.manifest_files !== undefined && value.manifest_entries !== undefined && value.manifest_files > value.manifest_entries) {
      context.addIssue({ code: "custom", message: "manifest_files cannot exceed manifest_entries." });
    }
  }),
  transfer_write_chunk: z.object({
    transfer_id: handle,
    offset: z.number().int().min(0),
    data_base64: z.string().max(800000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "data_base64 must be canonical base64"),
  }).strict(),
  transfer_commit_push: z.object({ transfer_id: handle }).strict(),
  transfer_begin_pull: z.object({ source_path: pathValue, kind: z.enum(["auto", "file", "directory"]).default("auto") }).strict(),
  transfer_read_chunk: z.object({ transfer_id: handle, offset: z.number().int().min(0), max_bytes: z.number().int().min(1).max(524288) }).strict(),
  transfer_finish: z.object({ transfer_id: handle }).strict(),
} as const;
