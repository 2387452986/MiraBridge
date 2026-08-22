import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { redactRecord, sha256, summarizeArguments } from "../../protocol/src/index.js";
import { workerDataRoot } from "./config.js";

export interface AuditEvent {
  request_id: string;
  node_id: string;
  workspace_id?: string;
  operation: string;
  program?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  started_at: string;
  finished_at: string;
  exit_code?: number | null;
  error_code?: string;
  ok: boolean;
}

export function powerShellAuditArguments(script: string): string[] {
  return [
    `script_sha256=${sha256(script)}`,
    `script_summary=chars:${script.length},lines:${script.split(/\r\n|\r|\n/u).length}`,
  ];
}

export function jobInputAuditArguments(data: string, close: boolean): string[] {
  return [
    `input_sha256=${sha256(data)}`,
    `input_bytes=${Buffer.byteLength(data, "utf8")}`,
    `close=${close}`,
  ];
}

export function terminalResizeAuditArguments(cols: number, rows: number): string[] {
  return [`terminal_cols=${cols}`, `terminal_rows=${rows}`];
}

export function operationAuditArguments(operation: string, args: Record<string, unknown>): string[] {
  if (operation === "mira_bridge_powershell" && typeof args.script === "string") return powerShellAuditArguments(args.script);
  if (operation === "mira_bridge_write_job_input" && typeof args.data === "string") return jobInputAuditArguments(args.data, args.close === true);
  if (operation === "mira_bridge_resize_job_terminal" && typeof args.cols === "number" && typeof args.rows === "number") {
    return terminalResizeAuditArguments(args.cols, args.rows);
  }

  const summary: string[] = [];
  if (Array.isArray(args.args)) summary.push(...args.args.filter((value): value is string => typeof value === "string"));
  const scalarFields = [
    "action", "path", "source_path", "destination_path", "kind", "mode", "cwd", "job_id", "output_ref", "transfer_id",
    "stream", "offset", "start_line", "max_lines", "recursive", "overwrite", "create_parents", "tail", "label",
    "hash_mode", "include_integrity", "output_encoding", "stdin_mode", "timeout_ms", "sort_by", "sort_order",
  ] as const;
  for (const key of scalarFields) {
    const value = args[key];
    if (["string", "number", "boolean"].includes(typeof value)) summary.push(`${key}=${String(value)}`);
  }
  if (typeof args.idempotency_key === "string") summary.push(`idempotency_key_sha256=${sha256(args.idempotency_key)}`);
  if (typeof args.scan_id === "string") summary.push(`scan_id_sha256=${sha256(args.scan_id)}`);
  if (typeof args.query === "string") summary.push(`query_sha256=${sha256(args.query)}`, `query_chars=${args.query.length}`);
  if (typeof args.pattern === "string") summary.push(`pattern=${args.pattern}`);
  if (typeof args.file_glob === "string") summary.push(`file_glob=${args.file_glob}`);
  if (typeof args.expected_sha256 === "string") summary.push(`expected_sha256=${args.expected_sha256}`);
  if (typeof args.content === "string") {
    summary.push(`content_sha256=${sha256(args.content)}`, `content_bytes=${Buffer.byteLength(args.content, "utf8")}`);
  }
  if (Array.isArray(args.edits)) {
    summary.push(`edits_sha256=${sha256(JSON.stringify(args.edits))}`, `edit_count=${args.edits.length}`);
  }
  if (typeof args.url === "string") {
    summary.push(`url_sha256=${sha256(args.url)}`);
    try { summary.push(`url_origin=${new URL(args.url).origin}`); }
    catch { /* schema/runtime reports the malformed URL */ }
  }
  return summary;
}

export async function writeAudit(event: AuditEvent): Promise<void> {
  const record = {
    request_id: event.request_id,
    node_id: event.node_id,
    workspace_id: event.workspace_id,
    operation: event.operation,
    program: event.program,
    args_summary: event.args ? summarizeArguments(event.args) : undefined,
    environment_keys: event.env ? Object.keys(redactRecord(event.env)).sort() : undefined,
    cwd: event.cwd,
    started_at: event.started_at,
    finished_at: event.finished_at,
    exit_code: event.exit_code,
    error_code: event.error_code,
    ok: event.ok,
  };
  const day = event.started_at.slice(0, 10);
  const auditDirectory = join(workerDataRoot(), "audit");
  await mkdir(auditDirectory, { recursive: true });
  await appendFile(join(auditDirectory, `audit-${day}.jsonl`), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}
