import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  MAX_PAIRING_CODE_BYTES,
  PAIRING_CODE_PREFIX,
  PAIRING_FORMAT_VERSION,
  PAIRING_TTL_MS,
} from "./constants.js";
import { BridgeError } from "./errors.js";

const nodeId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u);
const base64Url = z.string().min(22).max(256).regex(/^[A-Za-z0-9_-]+$/u);
const sha256Fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/=]+$/u);
const isoDate = z.string().datetime({ offset: true });
const hostCandidate = z.string().min(1).max(255).refine(
  (value) => !value.startsWith("-") && !/[\0\s,@/\\]/u.test(value),
  "host candidate must be a hostname or IP literal",
);

const openSshEd25519Key = z.string().min(80).max(1024).superRefine((value, context) => {
  const parts = value.trim().split(/\s+/u);
  if (parts.length !== 2 || parts[0] !== "ssh-ed25519") {
    context.addIssue({ code: "custom", message: "public_key must contain exactly one ssh-ed25519 key without a comment" });
    return;
  }
  try {
    if (Buffer.from(parts[1] ?? "", "base64").length < 32) throw new Error("short key");
  } catch {
    context.addIssue({ code: "custom", message: "public_key is not valid OpenSSH base64" });
  }
});

const pairingBase = z.object({
  format_version: z.literal(PAIRING_FORMAT_VERSION),
  created_at: isoDate,
  expires_at: isoDate,
  nonce: base64Url,
}).strict();

export const pairingRequestSchema = pairingBase.extend({
  kind: z.literal("request"),
  node_id: nodeId,
  public_key: openSshEd25519Key,
  public_key_fingerprint: sha256Fingerprint,
  mac: z.object({
    name: z.string().min(1).max(128),
    architecture: z.enum(["arm64", "x64"]),
    mirabridge_version: z.string().min(1).max(64),
  }).strict(),
}).strict();

export type PairingRequest = z.infer<typeof pairingRequestSchema>;

export const pairingResponseSchema = pairingBase.extend({
  kind: z.literal("response"),
  request_nonce: base64Url,
  node_id: nodeId,
  public_key_fingerprint: sha256Fingerprint,
  windows: z.object({
    hostname: z.string().min(1).max(255),
    architecture: z.enum(["x64", "arm64"]),
    user: z.string().min(1).max(128),
    mirabridge_version: z.string().min(1).max(64),
  }).strict(),
  ssh: z.object({
    addresses: z.array(hostCandidate).min(1).max(32),
    port: z.number().int().min(1).max(65535),
    host_fingerprint: sha256Fingerprint,
    host_key_algorithm: z.string().min(1).max(64),
  }).strict(),
  worker_command: z.string().min(1).max(4096),
  management_command: z.string().min(1).max(4096).regex(/^[A-Za-z0-9_ .:\\"/-]+$/u).default("mirabridge-worker"),
  default_root: z.string().min(1).max(32767),
  capabilities: z.array(z.string().min(1).max(128)).max(128),
}).strict();

export type PairingResponse = z.infer<typeof pairingResponseSchema>;
export type PairingPayload = PairingRequest | PairingResponse;

const pairingPayloadSchema = z.discriminatedUnion("kind", [pairingRequestSchema, pairingResponseSchema]);

function validateWindow(payload: PairingPayload, now: Date): void {
  const created = Date.parse(payload.created_at);
  const expires = Date.parse(payload.expires_at);
  const nowMs = now.getTime();
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || expires - created > PAIRING_TTL_MS) {
    throw new BridgeError("INVALID_ARGUMENT", "Pairing code has an invalid validity window.");
  }
  if (created > nowMs + 5 * 60_000) {
    throw new BridgeError("INVALID_ARGUMENT", "Pairing code was created too far in the future.");
  }
  if (expires <= nowMs) {
    throw new BridgeError("CONFIRMATION_EXPIRED", "Pairing code has expired; create a new code.");
  }
}

export function encodePairingCode(payload: PairingPayload): string {
  const parsed = pairingPayloadSchema.parse(payload);
  const encoded = `${PAIRING_CODE_PREFIX}${Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url")}`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_PAIRING_CODE_BYTES) {
    throw new BridgeError("INVALID_ARGUMENT", `Pairing code exceeds ${MAX_PAIRING_CODE_BYTES} bytes.`);
  }
  return encoded;
}

export function decodePairingCode(value: string, now = new Date()): PairingPayload {
  if (Buffer.byteLength(value, "utf8") > MAX_PAIRING_CODE_BYTES) {
    throw new BridgeError("INVALID_ARGUMENT", `Pairing code exceeds ${MAX_PAIRING_CODE_BYTES} bytes.`);
  }
  if (!value.startsWith(PAIRING_CODE_PREFIX)) {
    throw new BridgeError("INVALID_ARGUMENT", "Pairing code prefix or version is not supported.");
  }
  let decoded: unknown;
  try {
    const encoded = value.slice(PAIRING_CODE_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error("invalid base64url");
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new BridgeError("INVALID_ARGUMENT", "Pairing code is not valid base64url JSON.");
  }
  const parsed = pairingPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new BridgeError("INVALID_ARGUMENT", "Pairing code schema is invalid.", {
      details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
    });
  }
  validateWindow(parsed.data, now);
  return parsed.data;
}

export function fingerprintOpenSshPublicKey(publicKey: string): string {
  const parsed = openSshEd25519Key.parse(publicKey);
  const encoded = parsed.split(/\s+/u)[1];
  const digest = createHash("sha256").update(Buffer.from(encoded ?? "", "base64")).digest("base64").replace(/=+$/u, "");
  return `SHA256:${digest}`;
}

export function fingerprintsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
