import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { BridgeError, asBridgeError } from "../../protocol/src/index.js";
import type { ConptyControl } from "./conpty-process.js";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_CONTROL_MESSAGE_BYTES = 128 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;

type InputRequest = { type: "input"; data_base64: string; close: boolean };
type ResizeRequest = { type: "resize"; cols: number; rows: number };
type ControlRequest = InputRequest | ResizeRequest;

interface ControlResponse {
  ok: boolean;
  bytes_written?: number;
  input_closed?: boolean;
  cols?: number;
  rows?: number;
  error?: ReturnType<BridgeError["toJSON"]>;
}

interface ControlTarget {
  write(data: Buffer): Promise<void>;
  close(): Promise<void>;
  resize?: (cols: number, rows: number) => Promise<void>;
}

export interface JobInputChannel {
  attach(input: Writable): void;
  attachTerminal(control: ConptyControl, onResize: (cols: number, rows: number) => Promise<void>): void;
  close(): Promise<void>;
}

export function createJobInputEndpoint(): string {
  const id = randomUUID();
  return process.platform === "win32"
    ? `\\\\.\\pipe\\MiraBridge-JobInput-${id}`
    : join(tmpdir(), `mb-${id.slice(0, 16)}.sock`);
}

function send(socket: Socket, value: ControlResponse): void {
  socket.end(`${JSON.stringify(value)}\n`, "utf8");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function writableTarget(input: Writable): ControlTarget {
  return {
    write: async (data) => await new Promise<void>((resolve, reject) => {
      input.write(data, (error) => error ? reject(error) : resolve());
    }),
    close: async () => await new Promise<void>((resolve) => {
      input.end(resolve);
    }),
  };
}

export async function listenForJobInput(endpoint: string, mode: "pipe" | "conpty" = "pipe"): Promise<JobInputChannel> {
  let target: ControlTarget | undefined;
  let targetError: Error | undefined;
  let inputClosed = false;
  let bufferedBytes = 0;
  let buffered: Buffer[] = [];
  let pendingResize: { cols: number; rows: number } | undefined;
  let delivery = Promise.resolve();
  const sockets = new Set<Socket>();

  const enqueue = (effect: () => Promise<void>): Promise<void> => {
    delivery = delivery.then(effect);
    return delivery;
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => undefined);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      bytes += chunk.length;
      if (bytes > MAX_CONTROL_MESSAGE_BYTES) {
        handled = true;
        send(socket, { ok: false, error: new BridgeError("INVALID_ARGUMENT", "Job control message exceeds 128 KiB.").toJSON() });
        return;
      }
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      const newline = all.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      void (async () => {
        try {
          const raw = JSON.parse(all.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
          const type = raw.type ?? "input";
          if (type === "resize") {
            if (mode !== "conpty") throw new BridgeError("JOB_INPUT_UNAVAILABLE", "Only ConPTY Jobs can be resized.");
            if (!Number.isInteger(raw.cols) || !Number.isInteger(raw.rows) || Number(raw.cols) < 20 || Number(raw.cols) > 500 || Number(raw.rows) < 5 || Number(raw.rows) > 200) {
              throw new BridgeError("INVALID_ARGUMENT", "Terminal dimensions are outside supported bounds.");
            }
            const cols = Number(raw.cols);
            const rows = Number(raw.rows);
            if (target?.resize) await enqueue(async () => await target?.resize?.(cols, rows));
            else pendingResize = { cols, rows };
            send(socket, { ok: true, cols, rows });
            return;
          }
          if (type !== "input" || typeof raw.data_base64 !== "string" || typeof raw.close !== "boolean") {
            throw new BridgeError("INVALID_ARGUMENT", "Job input control message is invalid.");
          }
          const data = Buffer.from(raw.data_base64, "base64");
          if (data.length > MAX_INPUT_BYTES || data.toString("base64") !== raw.data_base64) {
            throw new BridgeError("INVALID_ARGUMENT", "Job input must be valid base64 containing at most 64 KiB.");
          }
          if (data.length === 0 && !raw.close) throw new BridgeError("INVALID_ARGUMENT", "Job input must contain data or close stdin.");
          if (inputClosed) throw new BridgeError("JOB_INPUT_UNAVAILABLE", "Job stdin is already closed.");
          if (targetError) throw new BridgeError("JOB_INPUT_UNAVAILABLE", "Job stdin is no longer writable.", { cause: targetError });
          if (!target && bufferedBytes + data.length > MAX_BUFFERED_BYTES) {
            throw new BridgeError("JOB_INPUT_UNAVAILABLE", "Job stdin has not attached and its 1 MiB input buffer is full.", { retryable: true });
          }
          if (data.length > 0) {
            if (target) await enqueue(async () => await target?.write(data));
            else {
              buffered.push(data);
              bufferedBytes += data.length;
            }
          }
          if (raw.close) {
            inputClosed = true;
            if (target) await enqueue(async () => await target?.close());
          }
          send(socket, { ok: true, bytes_written: data.length, input_closed: inputClosed });
        } catch (error) {
          send(socket, { ok: false, error: asBridgeError(error).toJSON() });
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });

  const attach = (next: ControlTarget): void => {
    if (target) throw new BridgeError("INTERNAL_ERROR", "Job input was attached more than once.");
    target = next;
    const queued = buffered;
    buffered = [];
    bufferedBytes = 0;
    void enqueue(async () => {
      try {
        for (const chunk of queued) await next.write(chunk);
        if (pendingResize && next.resize) await next.resize(pendingResize.cols, pendingResize.rows);
        if (inputClosed) await next.close();
      } catch (error) {
        targetError = error as Error;
      }
    });
  };

  return {
    attach(input: Writable): void {
      if (mode !== "pipe") throw new BridgeError("INTERNAL_ERROR", "A ConPTY Job cannot attach a plain stdin stream.");
      input.once("error", (error) => { targetError = error; });
      attach(writableTarget(input));
    },
    attachTerminal(control: ConptyControl, onResize: (cols: number, rows: number) => Promise<void>): void {
      if (mode !== "conpty") throw new BridgeError("INTERNAL_ERROR", "A pipe Job cannot attach a ConPTY controller.");
      attach({
        write: async (data) => await control.write(data),
        close: async () => await control.close(),
        resize: async (cols, rows) => {
          await control.resize(cols, rows);
          await onResize(cols, rows);
        },
      });
    },
    async close(): Promise<void> {
      await delivery.catch(() => undefined);
      if (target && !inputClosed) await target.close().catch(() => undefined);
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

function sendOnce(endpoint: string, request: ControlRequest): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: ControlResponse): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? { ok: false });
    };
    socket.setTimeout(1_000, () => finish(new Error("Job control pipe timed out.")));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`, "utf8"));
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_CONTROL_MESSAGE_BYTES) {
        finish(new Error("Job control response exceeds 128 KiB."));
        return;
      }
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      const newline = all.indexOf(0x0a);
      if (newline < 0) return;
      try { finish(undefined, JSON.parse(all.subarray(0, newline).toString("utf8")) as ControlResponse); }
      catch (error) { finish(error as Error); }
    });
    socket.once("end", () => {
      if (!settled) finish(new Error("Job control pipe closed without a response."));
    });
  });
}

async function sendControl(endpoint: string, request: ControlRequest): Promise<ControlResponse> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await sendOnce(endpoint, request);
      if (!response.ok) {
        const error = response.error;
        throw new BridgeError(error?.code ?? "JOB_INPUT_UNAVAILABLE", error?.message ?? "Job control request was rejected.", {
          retryable: error?.retryable ?? false,
          details: error?.details ?? {},
        });
      }
      return response;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new BridgeError("JOB_INPUT_UNAVAILABLE", "The durable Job control pipe is unavailable.", { retryable: true, cause: lastError });
}

export async function sendJobInput(endpoint: string, data: Buffer, close: boolean): Promise<{ bytes_written: number; input_closed: boolean }> {
  const response = await sendControl(endpoint, { type: "input", data_base64: data.toString("base64"), close });
  return { bytes_written: response.bytes_written ?? 0, input_closed: response.input_closed ?? false };
}

export async function sendJobResize(endpoint: string, cols: number, rows: number): Promise<{ cols: number; rows: number }> {
  const response = await sendControl(endpoint, { type: "resize", cols, rows });
  return { cols: response.cols ?? cols, rows: response.rows ?? rows };
}
