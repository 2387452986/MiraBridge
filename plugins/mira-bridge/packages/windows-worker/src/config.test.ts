import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addAllowedRoot, initializeWorkerConfig, loadWorkerConfig, removeAllowedRoot, setWorkerCapability } from "./config.js";

const previous = process.env.MIRABRIDGE_WORKER_CONFIG;
afterEach(() => {
  if (previous === undefined) delete process.env.MIRABRIDGE_WORKER_CONFIG;
  else process.env.MIRABRIDGE_WORKER_CONFIG = previous;
});

describe("worker config commands", () => {
  it("initializes idempotently and preserves a backup on mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mirabridge-config-"));
    const path = join(directory, "worker.toml");
    const initial = await initializeWorkerConfig(path, join(directory, "root"));
    expect(initial.created).toBe(true);
    expect((await initializeWorkerConfig(path)).created).toBe(false);
    await setWorkerCapability("recycle-bin", "false", path);
    expect((await loadWorkerConfig(path)).recycle_bin_enabled).toBe(false);
    expect(await readFile(`${path}.bak`, "utf8")).toContain("recycle_bin_enabled = true");
  });

  it("adds and removes roots without duplicates or deleting the last root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mirabridge-roots-"));
    const path = join(directory, "worker.toml");
    await initializeWorkerConfig(path, join(directory, "one"));
    await addAllowedRoot(join(directory, "two"), path);
    await addAllowedRoot(join(directory, "two"), path);
    expect((await loadWorkerConfig(path)).allowed_roots).toHaveLength(2);
    await removeAllowedRoot(join(directory, "two"), path);
    await expect(removeAllowedRoot(join(directory, "one"), path)).rejects.toThrow(/At least one/u);
  });
});
