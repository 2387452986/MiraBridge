import { createHash, randomUUID } from "node:crypto";
import { BridgeError } from "./errors.js";

const nodeIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const scopedIdPattern = /^(ws|job|output|transfer|scan)_([A-Za-z0-9_-]+)_([0-9a-f-]{36})$/;

export function assertNodeId(nodeId: string): void {
  if (!nodeIdPattern.test(nodeId)) {
    throw new BridgeError("INVALID_ARGUMENT", "node_id must be lower-case kebab-case and at most 64 characters.", {
      details: { field: "node_id" },
    });
  }
}

export type ScopedIdKind = "ws" | "job" | "output" | "transfer" | "scan";

export function createScopedId(kind: ScopedIdKind, nodeId: string): string {
  assertNodeId(nodeId);
  return `${kind}_${Buffer.from(nodeId, "utf8").toString("base64url")}_${randomUUID()}`;
}

export function parseScopedId(value: string, expectedKind?: ScopedIdKind): { kind: ScopedIdKind; nodeId: string } {
  const match = scopedIdPattern.exec(value);
  if (!match) throw new BridgeError("INVALID_ARGUMENT", "Invalid MiraBridge resource identifier.");
  const kind = match[1] as ScopedIdKind;
  if (expectedKind && kind !== expectedKind) {
    throw new BridgeError("INVALID_ARGUMENT", `Expected a ${expectedKind} identifier.`);
  }
  const encodedNode = match[2];
  if (!encodedNode) throw new BridgeError("INVALID_ARGUMENT", "Invalid scoped identifier.");
  const nodeId = Buffer.from(encodedNode, "base64url").toString("utf8");
  assertNodeId(nodeId);
  return { kind, nodeId };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
