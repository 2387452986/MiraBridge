import { rm } from "node:fs/promises";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createJobInputEndpoint, listenForJobInput, sendJobInput, sendJobResize, type JobInputChannel } from "./job-input.js";

const channels: JobInputChannel[] = [];
const endpoints: string[] = [];

afterEach(async () => {
  await Promise.all(channels.splice(0).map((channel) => channel.close()));
  if (process.platform !== "win32") {
    await Promise.all(endpoints.splice(0).map((endpoint) => rm(endpoint, { force: true })));
  }
});

async function channel(): Promise<{ endpoint: string; channel: JobInputChannel }> {
  const endpoint = createJobInputEndpoint();
  endpoints.push(endpoint);
  const inputChannel = await listenForJobInput(endpoint);
  channels.push(inputChannel);
  return { endpoint, channel: inputChannel };
}

async function terminalChannel(): Promise<{ endpoint: string; channel: JobInputChannel }> {
  const endpoint = createJobInputEndpoint();
  endpoints.push(endpoint);
  const inputChannel = await listenForJobInput(endpoint, "conpty");
  channels.push(inputChannel);
  return { endpoint, channel: inputChannel };
}

describe("durable Job input channel", () => {
  it("buffers pre-attach UTF-8 input and delivers explicit EOF in order", async () => {
    const active = await channel();
    await expect(sendJobInput(active.endpoint, Buffer.from("先发", "utf8"), false)).resolves.toEqual({
      bytes_written: 6,
      input_closed: false,
    });
    let text = "";
    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    active.channel.attach(new Writable({
      write(chunk, _encoding, callback): void {
        text += (chunk as Buffer).toString("utf8");
        callback();
      },
      final(callback): void {
        finish();
        callback();
      },
    }));
    await expect(sendJobInput(active.endpoint, Buffer.from("后发\n", "utf8"), true)).resolves.toEqual({
      bytes_written: 7,
      input_closed: true,
    });
    await finished;
    expect(text).toBe("先发后发\n");
    await expect(sendJobInput(active.endpoint, Buffer.from("late"), false)).rejects.toMatchObject({ code: "JOB_INPUT_UNAVAILABLE" });
  });

  it("bounds queued input before the child process attaches", async () => {
    const active = await channel();
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let index = 0; index < 16; index += 1) {
      await expect(sendJobInput(active.endpoint, chunk, false)).resolves.toMatchObject({ bytes_written: chunk.length });
    }
    await expect(sendJobInput(active.endpoint, Buffer.from("overflow"), false)).rejects.toMatchObject({
      code: "JOB_INPUT_UNAVAILABLE",
      retryable: true,
    });
  });

  it("routes VT input, EOF, and resize through one durable ConPTY control channel", async () => {
    const active = await terminalChannel();
    await expect(sendJobResize(active.endpoint, 120, 40)).resolves.toEqual({ cols: 120, rows: 40 });
    await expect(sendJobInput(active.endpoint, Buffer.from("\u001b[B中文", "utf8"), false)).resolves.toMatchObject({ bytes_written: 9 });
    const effects: string[] = [];
    let appliedResize: (value: unknown) => void = () => undefined;
    const resized = new Promise((resolve) => { appliedResize = resolve; });
    active.channel.attachTerminal({
      write: async (data) => { effects.push(`write:${data.toString("utf8")}`); },
      close: async () => { effects.push("close"); },
      resize: async (cols, rows) => { effects.push(`resize:${cols}x${rows}`); },
    }, async (cols, rows) => { effects.push(`persist:${cols}x${rows}`); appliedResize(undefined); });
    await resized;
    await expect(sendJobInput(active.endpoint, Buffer.alloc(0), true)).resolves.toEqual({ bytes_written: 0, input_closed: true });
    expect(effects).toEqual(["write:\u001b[B中文", "resize:120x40", "persist:120x40", "close"]);
  });

  it("rejects resize for a non-ConPTY Job channel", async () => {
    const active = await channel();
    await expect(sendJobResize(active.endpoint, 120, 40)).rejects.toMatchObject({ code: "JOB_INPUT_UNAVAILABLE" });
  });
});
