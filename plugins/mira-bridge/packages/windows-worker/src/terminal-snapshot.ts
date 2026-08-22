import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { Terminal } from "@xterm/headless";
import { BridgeError } from "../../protocol/src/index.js";

export interface TerminalSnapshot {
  sequence: number;
  cols: number;
  rows: number;
  title: string;
  buffer: "normal" | "alternate";
  cursor: { row: number; column: number };
  lines: string[];
  updated_at: string;
  final: boolean;
}

export class TerminalRecorder {
  private static readonly PERSIST_INTERVAL_MS = 50;
  private readonly terminal: Terminal;
  private title = "";
  private sequence = 0;
  private final = false;
  private chain = Promise.resolve();
  private persistTimer: NodeJS.Timeout | undefined;
  private lastPersistedAt = 0;
  private finishPromise: Promise<void> | undefined;

  constructor(readonly path: string, cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    this.terminal.onTitleChange((title) => { this.title = title.slice(0, 4096); });
  }

  write(data: Buffer): Promise<void> {
    this.chain = this.chain.then(async () => {
      await new Promise<void>((resolve) => this.terminal.write(data, resolve));
      await this.schedulePersist();
    });
    return this.chain;
  }

  resize(cols: number, rows: number): Promise<void> {
    this.clearPersistTimer();
    this.chain = this.chain.then(async () => {
      this.terminal.resize(cols, rows);
      await this.persistNow();
    });
    return this.chain;
  }

  finish(): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    this.clearPersistTimer();
    this.finishPromise = this.chain = this.chain.then(async () => {
      this.final = true;
      await this.persistNow();
      this.terminal.dispose();
    });
    return this.finishPromise;
  }

  private async schedulePersist(): Promise<void> {
    if (this.final || this.persistTimer) return;
    const delay = Math.max(0, TerminalRecorder.PERSIST_INTERVAL_MS - (Date.now() - this.lastPersistedAt));
    if (delay === 0) {
      await this.persistNow();
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.chain = this.chain.then(async () => await this.persistNow());
    }, delay);
    this.persistTimer.unref();
  }

  private clearPersistTimer(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
  }

  private async persistNow(): Promise<void> {
    const active = this.terminal.buffer.active;
    const lines = Array.from({ length: this.terminal.rows }, (_, row) =>
      active.getLine(active.viewportY + row)?.translateToString(true) ?? "");
    const snapshot: TerminalSnapshot = {
      sequence: ++this.sequence,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      title: this.title,
      buffer: active.type,
      cursor: { row: active.cursorY, column: active.cursorX },
      lines,
      updated_at: new Date().toISOString(),
      final: this.final,
    };
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, this.path);
      this.lastPersistedAt = Date.now();
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export async function readTerminalSnapshot(path: string): Promise<TerminalSnapshot> {
  try {
    const decoded = JSON.parse(await readFile(path, "utf8")) as Partial<TerminalSnapshot>;
    if (
      !Number.isInteger(decoded.sequence) ||
      !Number.isInteger(decoded.cols) ||
      !Number.isInteger(decoded.rows) ||
      typeof decoded.title !== "string" ||
      !Array.isArray(decoded.lines) ||
      !decoded.lines.every((line) => typeof line === "string") ||
      !decoded.cursor ||
      !Number.isInteger(decoded.cursor.row) ||
      !Number.isInteger(decoded.cursor.column) ||
      typeof decoded.updated_at !== "string" ||
      typeof decoded.final !== "boolean" ||
      (decoded.buffer !== "normal" && decoded.buffer !== "alternate")
    ) throw new Error("Terminal snapshot fields are invalid.");
    return decoded as TerminalSnapshot;
  } catch (error) {
    throw new BridgeError("TERMINAL_SNAPSHOT_UNAVAILABLE", "The ConPTY terminal snapshot is not available.", {
      retryable: true,
      cause: error,
      details: { path },
    });
  }
}
