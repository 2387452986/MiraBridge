import { DEFAULT_INLINE_OUTPUT_BYTES } from "./constants.js";

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export interface OutputPreview {
  truncated: boolean;
  total_bytes: number;
  text?: string;
  head?: string;
  tail?: string;
}

export function previewOutput(bytes: Uint8Array, limit = DEFAULT_INLINE_OUTPUT_BYTES): OutputPreview {
  if (bytes.byteLength <= limit) {
    return { truncated: false, total_bytes: bytes.byteLength, text: decode(bytes) };
  }
  const headBytes = Math.floor(limit / 2);
  const tailBytes = limit - headBytes;
  return {
    truncated: true,
    total_bytes: bytes.byteLength,
    head: decode(bytes.subarray(0, headBytes)),
    tail: decode(bytes.subarray(bytes.byteLength - tailBytes)),
  };
}
