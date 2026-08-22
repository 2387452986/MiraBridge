import { z } from "zod";
import { errorCodes, type ErrorCode } from "./constants.js";

export const bridgeErrorSchema = z.object({
  code: z.enum(errorCodes),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export type BridgeErrorData = z.infer<typeof bridgeErrorSchema>;

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "BridgeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }

  toJSON(): BridgeErrorData {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const details = code ? {
    system_code: code,
    ...((error as NodeJS.ErrnoException).syscall ? { syscall: (error as NodeJS.ErrnoException).syscall } : {}),
  } : {};
  if (code === "ENOENT") return new BridgeError("PATH_NOT_FOUND", "Requested path was not found.", { cause: error, details });
  if (code === "EACCES" || code === "EPERM") {
    return new BridgeError("PERMISSION_DENIED", "The Windows account denied this operation.", { cause: error, details });
  }
  if (code === "EEXIST") return new BridgeError("FILE_CHANGED", "The destination already exists or changed during the operation.", { cause: error, details });
  if (code === "ENOSPC" || code === "EDQUOT") return new BridgeError("STORAGE_QUOTA_EXCEEDED", "The destination volume has insufficient storage space.", { cause: error, details });
  if (code === "ENOTDIR" || code === "EISDIR" || code === "ENAMETOOLONG" || code === "EINVAL" || code === "EXDEV") {
    return new BridgeError("INVALID_ARGUMENT", "The requested filesystem operation is not valid for this path or volume.", { cause: error, details });
  }
  if (code === "EBUSY") return new BridgeError("RESOURCE_CHANGED", "The requested Windows resource is busy; inspect it and retry.", { retryable: true, cause: error, details });
  return new BridgeError("INTERNAL_ERROR", "MiraBridge encountered an internal error.", { cause: error });
}
