import { execFile } from "node:child_process";
import { arch, platform } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const powerShellUtf8 = "$ProgressPreference='SilentlyContinue'; [Console]::InputEncoding=[Text.UTF8Encoding]::new(); [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $OutputEncoding=[Text.UTF8Encoding]::new();";

export type GpuVendor = "nvidia" | "amd" | "intel" | "microsoft" | "other";
export type GpuDeviceType = "hardware" | "virtual" | "unknown";

export interface WindowsVideoController {
  Name?: unknown;
  AdapterCompatibility?: unknown;
  AdapterRAM?: unknown;
  DriverVersion?: unknown;
  DriverDate?: unknown;
  PNPDeviceID?: unknown;
  Status?: unknown;
}

export interface NvidiaGpu {
  index: number;
  name: string;
  memoryBytes: number;
  driverVersion: string;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function classifyGpuVendor(controller: WindowsVideoController): GpuVendor {
  const pnp = optionalString(controller.PNPDeviceID)?.toLocaleUpperCase() ?? "";
  if (pnp.includes("VEN_10DE")) return "nvidia";
  if (pnp.includes("VEN_1002")) return "amd";
  if (pnp.includes("VEN_8086")) return "intel";
  if (pnp.includes("VEN_1414")) return "microsoft";

  const label = `${optionalString(controller.AdapterCompatibility) ?? ""} ${optionalString(controller.Name) ?? ""}`.toLocaleLowerCase();
  if (label.includes("nvidia")) return "nvidia";
  if (label.includes("advanced micro devices") || label.includes("amd ") || label.includes("radeon")) return "amd";
  if (label.includes("intel")) return "intel";
  if (label.includes("microsoft")) return "microsoft";
  return "other";
}

export function classifyGpuDeviceType(controller: WindowsVideoController): GpuDeviceType {
  const pnp = optionalString(controller.PNPDeviceID)?.toLocaleUpperCase();
  if (!pnp) return "unknown";
  if (pnp.startsWith("ROOT\\DISPLAY\\")) return "virtual";
  return "hardware";
}

export function parseNvidiaSmiOutput(stdout: string): NvidiaGpu[] {
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length < 4) return [];
    const indexText = fields.shift() ?? "";
    const driverVersion = fields.pop() ?? "";
    const memoryText = fields.pop() ?? "";
    const index = Number(indexText);
    const memoryMiB = Number(memoryText);
    const name = fields.join(", ").trim();
    if (!Number.isInteger(index) || !Number.isFinite(memoryMiB) || !name || !driverVersion) return [];
    return [{ index, name, memoryBytes: memoryMiB * 1024 * 1024, driverVersion }];
  });
}

export function mergeGpuInventory(
  controllers: WindowsVideoController[],
  nvidiaGpus: NvidiaGpu[],
): Array<Record<string, unknown>> {
  const unmatchedNvidia = [...nvidiaGpus];
  const inventory = controllers.map((controller) => {
    const name = optionalString(controller.Name) ?? "Unknown display adapter";
    const vendor = classifyGpuVendor(controller);
    const matchIndex = vendor === "nvidia"
      ? unmatchedNvidia.findIndex((gpu) => normalizedName(gpu.name) === normalizedName(name))
      : -1;
    const nvidia = matchIndex >= 0 ? unmatchedNvidia.splice(matchIndex, 1)[0] : undefined;
    const adapterRam = Number(controller.AdapterRAM ?? 0);
    return {
      name,
      vendor,
      device_type: classifyGpuDeviceType(controller),
      vram_bytes: nvidia?.memoryBytes ?? (Number.isFinite(adapterRam) && adapterRam >= 0 ? adapterRam : 0),
      driver_version: nvidia?.driverVersion ?? optionalString(controller.DriverVersion),
      driver_date: optionalString(controller.DriverDate),
      pnp_device_id: optionalString(controller.PNPDeviceID),
      status: optionalString(controller.Status),
      cuda_available: nvidia !== undefined,
    };
  });
  inventory.push(...unmatchedNvidia.map((gpu) => ({
    name: gpu.name,
    vendor: "nvidia" as GpuVendor,
    device_type: "hardware" as GpuDeviceType,
    vram_bytes: gpu.memoryBytes,
    driver_version: gpu.driverVersion,
    driver_date: null,
    pnp_device_id: null,
    status: null,
    cuda_available: true,
  })));
  return inventory;
}

async function nvidiaGpuInfo(): Promise<NvidiaGpu[]> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi.exe",
      ["--query-gpu=index,name,memory.total,driver_version", "--format=csv,noheader,nounits"],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    return parseNvidiaSmiOutput(stdout);
  } catch {
    return [];
  }
}

async function windowsVideoControllers(): Promise<WindowsVideoController[]> {
  if (platform() !== "win32") return [];
  const script = `${powerShellUtf8} Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,AdapterRAM,DriverVersion,@{Name='DriverDate';Expression={if ($_.DriverDate) {$_.DriverDate.ToUniversalTime().ToString('o')} else {$null}}},PNPDeviceID,Status | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    const parsed = JSON.parse(stdout.trim() || "[]") as WindowsVideoController | WindowsVideoController[] | null;
    if (!parsed) return [];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export async function gpuInventory(): Promise<Array<Record<string, unknown>>> {
  const [controllers, nvidiaGpus] = await Promise.all([windowsVideoControllers(), nvidiaGpuInfo()]);
  return mergeGpuInventory(controllers, nvidiaGpus);
}

export function normalizeWindowsArchitecture(value: string): string {
  switch (value.trim().toLocaleLowerCase()) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    case "ia32":
    case "i386":
    case "x86":
      return "x86";
    default:
      return value.trim().toLocaleLowerCase() || "unknown";
  }
}

export function windowsArchitecture(
  processArchitecture = arch(),
  environment: NodeJS.ProcessEnv = process.env,
  runtimePlatform = platform(),
): { architecture: string; process_architecture: string; architecture_emulated: boolean } {
  const normalizedProcess = normalizeWindowsArchitecture(processArchitecture);
  const nativeValue = runtimePlatform === "win32"
    ? environment.PROCESSOR_ARCHITEW6432 ?? environment.PROCESSOR_ARCHITECTURE ?? processArchitecture
    : processArchitecture;
  const native = normalizeWindowsArchitecture(nativeValue);
  return {
    architecture: native,
    process_architecture: normalizedProcess,
    architecture_emulated: native !== normalizedProcess,
  };
}
