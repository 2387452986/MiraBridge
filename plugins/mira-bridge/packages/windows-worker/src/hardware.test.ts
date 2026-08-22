import { describe, expect, it } from "vitest";
import {
  classifyGpuDeviceType,
  classifyGpuVendor,
  mergeGpuInventory,
  normalizeWindowsArchitecture,
  parseNvidiaSmiOutput,
  windowsArchitecture,
} from "./hardware.js";

describe("Windows hardware discovery", () => {
  it("keeps NVIDIA, AMD, Intel, and virtual adapters in one inventory", () => {
    const inventory = mergeGpuInventory([
      { Name: "NVIDIA Test Adapter", AdapterRAM: 4_294_967_295, DriverVersion: "32.0.16.1088", PNPDeviceID: "PCI\\VEN_10DE&DEV_0001", Status: "OK" },
      { Name: "AMD Radeon(TM) Graphics", AdapterCompatibility: "Advanced Micro Devices, Inc.", AdapterRAM: 536_870_912, DriverVersion: "32.0.21043.5001", PNPDeviceID: "PCI\\VEN_1002&DEV_13C0", Status: "OK" },
      { Name: "Intel(R) Arc(TM) Graphics", AdapterRAM: 1_073_741_824, PNPDeviceID: "PCI\\VEN_8086&DEV_7D55", Status: "OK" },
      { Name: "Remote Virtual Display", AdapterCompatibility: "Example", PNPDeviceID: "ROOT\\DISPLAY\\0000", Status: "OK" },
    ], [{ index: 0, name: "NVIDIA Test Adapter", memoryBytes: 17_094_934_528, driverVersion: "610.88" }]);

    expect(inventory.map((gpu) => gpu.vendor)).toEqual(["nvidia", "amd", "intel", "other"]);
    expect(inventory.map((gpu) => gpu.device_type)).toEqual(["hardware", "hardware", "hardware", "virtual"]);
    expect(inventory[0]).toMatchObject({ vram_bytes: 17_094_934_528, driver_version: "610.88", cuda_available: true });
    expect(inventory[1]).toMatchObject({ cuda_available: false });
  });

  it("accepts NVIDIA-only fallback and no-GPU hosts", () => {
    const nvidia = [{ index: 0, name: "NVIDIA RTX", memoryBytes: 8_589_934_592, driverVersion: "610.88" }];
    expect(mergeGpuInventory([], nvidia)).toEqual([expect.objectContaining({ vendor: "nvidia", cuda_available: true })]);
    expect(mergeGpuInventory([], [])).toEqual([]);
  });

  it("parses NVIDIA CSV from both ends so commas in names are preserved", () => {
    expect(parseNvidiaSmiOutput("0, NVIDIA, Engineering Sample, 8192, 610.88\r\n")).toEqual([
      { index: 0, name: "NVIDIA, Engineering Sample", memoryBytes: 8_589_934_592, driverVersion: "610.88" },
    ]);
  });

  it("classifies PCI vendors and virtual display roots without model lists", () => {
    expect(classifyGpuVendor({ PNPDeviceID: "PCI\\VEN_1002&DEV_0001" })).toBe("amd");
    expect(classifyGpuVendor({ AdapterCompatibility: "Intel Corporation" })).toBe("intel");
    expect(classifyGpuDeviceType({ PNPDeviceID: "ROOT\\DISPLAY\\0001" })).toBe("virtual");
  });

  it("reports native and emulated Windows architectures independently", () => {
    expect(normalizeWindowsArchitecture("AMD64")).toBe("x64");
    expect(normalizeWindowsArchitecture("aarch64")).toBe("arm64");
    expect(windowsArchitecture("x64", { PROCESSOR_ARCHITEW6432: "ARM64" }, "win32")).toEqual({
      architecture: "arm64",
      process_architecture: "x64",
      architecture_emulated: true,
    });
    expect(windowsArchitecture("arm64", { PROCESSOR_ARCHITECTURE: "ARM64" }, "win32")).toEqual({
      architecture: "arm64",
      process_architecture: "arm64",
      architecture_emulated: false,
    });
  });
});
