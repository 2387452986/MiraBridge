import { describe, expect, it } from "vitest";
import { basename, dirname } from "node:path";
import { conptyHostPath } from "./conpty-process.js";

describe("ConPTY host packaging", () => {
  it("prefers the packaged self-contained Windows helper", () => {
    const helper = conptyHostPath(process.argv[1]);
    expect(basename(helper)).toBe("MiraBridge.ConPtyHost.exe");
    expect(basename(dirname(helper))).toBe("conpty-host");
  });
});
