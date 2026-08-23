declare const __MIRABRIDGE_VERSION__: string | undefined;

export const MIRABRIDGE_VERSION =
  typeof __MIRABRIDGE_VERSION__ === "string" ? __MIRABRIDGE_VERSION__ : "2.0.0-rc.2";
export const PROTOCOL_VERSION = "2.0";
export const PAIRING_FORMAT_VERSION = 1;
export const PAIRING_CODE_PREFIX = "MBPAIR1.";
export const PAIRING_TTL_MS = 30 * 60 * 1000;
export const MAX_PAIRING_CODE_BYTES = 16 * 1024;
export const MAX_RPC_MESSAGE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_INLINE_OUTPUT_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 256 * 1024;
export const TRANSFER_CHUNK_BYTES = 512 * 1024;
export const MAX_DIRECTORY_TRANSFER_ENTRIES = 250_000;
export const MAX_INLINE_MANIFEST_BYTES = 1024 * 1024;
export const RECYCLE_SCAN_TTL_MS = 15 * 60 * 1000;
export const LOG_TAIL_BYTES = 64 * 1024;

export const errorCodes = [
  "NODE_NOT_FOUND",
  "NODE_OFFLINE",
  "SSH_AUTH_FAILED",
  "HOST_KEY_MISMATCH",
  "WORKER_NOT_FOUND",
  "PROTOCOL_MISMATCH",
  "INVALID_ARGUMENT",
  "DUPLICATE_REQUEST_ID",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_READ_ONLY",
  "WORKSPACE_OUT_OF_BOUNDS",
  "CAPABILITY_NOT_ENABLED",
  "PATH_NOT_FOUND",
  "PATH_IS_BINARY",
  "UNSUPPORTED_ENCODING",
  "FILE_CHANGED",
  "PROGRAM_NOT_FOUND",
  "PROCESS_START_FAILED",
  "PROCESS_TIMEOUT",
  "JOB_NOT_FOUND",
  "JOB_ALREADY_FINISHED",
  "JOB_INPUT_UNAVAILABLE",
  "TERMINAL_UNAVAILABLE",
  "TERMINAL_SNAPSHOT_UNAVAILABLE",
  "TRANSFER_FAILED",
  "OUTPUT_NOT_FOUND",
  "OUTPUT_EXPIRED",
  "JOB_LOGS_EXPIRED",
  "RESOURCE_CHANGED",
  "CONFIRMATION_EXPIRED",
  "RECYCLE_BIN_NOT_EMPTY",
  "BROWSER_UNAVAILABLE",
  "STORAGE_QUOTA_EXCEEDED",
  "NODE_MAINTENANCE",
  "PERMISSION_DENIED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export const jobStatuses = [
  "queued",
  "starting",
  "running",
  "exited",
  "failed_to_start",
  "cancelled",
  "timed_out",
  "lost",
] as const;

export type JobStatus = (typeof jobStatuses)[number];
export const terminalJobStatuses = new Set<JobStatus>([
  "exited",
  "failed_to_start",
  "cancelled",
  "timed_out",
  "lost",
]);
