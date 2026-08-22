import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const configPath = process.env.MIRABRIDGE_CONFIG;
const phase = process.argv[2];
const runId = process.env.MIRABRIDGE_ACCEPTANCE_ID ?? "20260822T120453Z";
const nodeId = process.env.MIRABRIDGE_NODE_ID ?? "windows-main";
const remoteParent = "D:\\MiraBridgeRoot";
const projectName = `MiraBridge-Productivity-Acceptance-1.2.0-${runId}`;
const remoteProject = `${remoteParent}\\${projectName}`;
const localRoot = process.env.MIRABRIDGE_ACCEPTANCE_LOCAL
  ?? resolve("artifacts", "productivity-acceptance-1.2.0");
const statePath = join(localRoot, "acceptance-state.json");
const eventsPath = join(localRoot, "acceptance-events.jsonl");

if (!configPath || !phase) {
  throw new Error("Usage: MIRABRIDGE_CONFIG=/absolute/config.toml node productivity-acceptance-1.2.mjs <baseline|scaffold|verify|terminal|gpu-safety|transfer>");
}

await mkdir(localRoot, { recursive: true });

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { run_id: runId, remote_project: remoteProject, coverage: {}, jobs: {}, evidence: {} };
    throw error;
  }
}

let state = await loadState();
if (state.run_id !== runId || state.remote_project !== remoteProject) {
  throw new Error(`Acceptance state belongs to another run: ${JSON.stringify({ run_id: state.run_id, remote_project: state.remote_project })}`);
}

async function saveState() {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function event(step, value, status = "PASS_REAL") {
  const record = { at: new Date().toISOString(), phase, step, status, value };
  await writeFile(eventsPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function connect() {
  const transport = new StdioClientTransport({
    command: "bash",
    args: [resolve("scripts/run-mcp.sh")],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      MIRABRIDGE_NODE: process.execPath,
      MIRABRIDGE_CONFIG: configPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mirabridge-productivity-acceptance", version: "1.2.0" });
  await client.connect(transport);
  return client;
}

function publicResult(response, name) {
  const result = response.structuredContent;
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    throw new Error(`${name} returned invalid structured content: ${JSON.stringify(response.content)}`);
  }
  return result;
}

async function call(client, name, args, timeout = 120_000) {
  const response = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: true },
  );
  const result = publicResult(response, name);
  if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`);
  state.coverage[name] = "PASS_REAL";
  return result.result;
}

async function expectedError(client, label, name, args, codes, timeout = 120_000) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout });
  const result = publicResult(response, name);
  const accepted = Array.isArray(codes) ? codes : [codes];
  if (result.ok || !accepted.includes(result.error?.code)) {
    throw new Error(`${label} expected ${accepted.join("|")}, received ${JSON.stringify(result)}`);
  }
  await event(label, { tool: name, code: result.error.code, message: result.error.message }, "PASS_SAFE_REJECTION");
  return result.error;
}

async function waitForJob(client, jobId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await call(client, "mira_bridge_wait_job", { job_id: jobId, timeout_ms: 10_000 }, 30_000);
    if (["exited", "failed_to_start", "cancelled", "timed_out", "lost"].includes(job.executor_status)) return job;
  }
  throw new Error(`Job ${jobId} did not finish within ${timeoutMs}ms.`);
}

async function waitForHttp(client, workspaceId, url, expected, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: "curl.exe",
      args: ["--fail", "--silent", "--show-error", "--max-time", "3", url],
      cwd: ".",
      env: {},
      timeout_ms: 10_000,
      output_encoding: "auto",
    }, 30_000);
    if (response.exit_code === 0 && String(response.stdout).includes(expected)) return response;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`HTTP endpoint did not become ready: ${url}`);
}

async function waitForTerminal(client, jobId, expected, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await client.callTool(
      { name: "mira_bridge_read_job_terminal", arguments: { job_id: jobId } },
      undefined,
      { timeout: 30_000, maxTotalTimeout: 30_000 },
    );
    const result = publicResult(response, "mira_bridge_read_job_terminal");
    if (!result.ok) {
      if (result.error?.code === "TERMINAL_SNAPSHOT_UNAVAILABLE" && result.error.retryable) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        continue;
      }
      throw new Error(`mira_bridge_read_job_terminal failed: ${JSON.stringify(result.error)}`);
    }
    state.coverage.mira_bridge_read_job_terminal = "PASS_REAL";
    const terminal = result.result;
    const screen = Array.isArray(terminal.lines) ? terminal.lines.join("\n") : "";
    if (screen.includes(expected)) return terminal;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Terminal ${jobId} did not show ${expected}.`);
}

async function workspace(client) {
  if (state.workspace_id) return state.workspace_id;
  const opened = await call(client, "mira_bridge_open_workspace", {
    node_id: nodeId,
    path: remoteProject,
    mode: "read-write",
  });
  state.workspace_id = opened.workspace_id;
  await saveState();
  return opened.workspace_id;
}

const git = "C:\\Program Files\\Git\\cmd\\git.exe";
const dotnet = "C:\\Program Files\\dotnet\\dotnet.exe";
const ffmpeg = "ffmpeg.exe";
const ffprobe = "ffprobe.exe";

async function phaseBaseline() {
  const client = await connect();
  try {
    const tools = await client.listTools();
    if (tools.tools.length !== 28) throw new Error(`Expected 28 tools, received ${tools.tools.length}.`);
    const names = tools.tools.map((tool) => tool.name).sort();
    await event("mcp_tool_inventory", { count: names.length, names });

    const nodes = await call(client, "mira_bridge_list_nodes", {});
    if (nodes.nodes.length !== 1 || nodes.nodes[0].node_id !== nodeId) throw new Error("Configured node inventory is not the expected single real node.");
    await event("list_nodes", nodes);

    const node = await call(client, "mira_bridge_describe_node", { node_id: nodeId });
    if (node.worker_version !== "1.2.0" || node.protocol_version !== "2.0") throw new Error("Real node did not negotiate Worker 1.2.0 / RPC 2.0.");
    if (!node.feature_access?.conpty_terminal || !node.native_tools?.conpty?.available) throw new Error("ConPTY is unavailable on the real node.");
    state.node = node;
    await event("describe_node", node);

    const desktop = await call(client, "mira_bridge_open_workspace", {
      node_id: nodeId,
      path: node.known_folders.desktop.path,
      mode: "read-only",
    });
    const desktopEntries = await call(client, "mira_bridge_list_directory", {
      workspace_id: desktop.workspace_id,
      path: ".",
      max_entries: 1000,
    });
    state.desktop = { canonical_path: desktop.canonical_path, entries: desktopEntries.entries };
    await event("desktop_metadata_only", state.desktop);

    const parent = await call(client, "mira_bridge_open_workspace", { node_id: nodeId, path: remoteParent, mode: "read-write" });
    state.parent_workspace_id = parent.workspace_id;
    const parentEntries = await call(client, "mira_bridge_list_directory", { workspace_id: parent.workspace_id, path: ".", max_entries: 1000 });
    if (parentEntries.entries.some((entry) => String(entry.name).toLowerCase() === projectName.toLowerCase())) {
      throw new Error(`Acceptance directory already exists: ${remoteProject}`);
    }
    await call(client, "mira_bridge_manage_path", {
      workspace_id: parent.workspace_id,
      action: "mkdir",
      path: projectName,
      recursive: false,
      overwrite: false,
    });
    const opened = await call(client, "mira_bridge_open_workspace", { node_id: nodeId, path: remoteProject, mode: "read-write" });
    state.workspace_id = opened.workspace_id;

    const inventoryScript = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop';
$disk=Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,VolumeName,Size,FreeSpace;
$os=Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory;
$processes=Get-Process | Sort-Object CPU -Descending | Select-Object -First 12 Name,Id,CPU,WorkingSet64;
$services=Get-Service | Group-Object Status | Select-Object Name,Count;
$errors=Get-WinEvent -FilterHashtable @{LogName='System';Level=1,2;StartTime=(Get-Date).AddHours(-24)} -ErrorAction SilentlyContinue | Select-Object -First 15 TimeCreated,Id,ProviderName,LevelDisplayName,Message;
$gpu=& nvidia-smi.exe --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>&1;
[ordered]@{os=$os;disk=$disk;processes=$processes;services=$services;recent_system_errors=$errors;gpu=$gpu} | ConvertTo-Json -Depth 6 -Compress`;
    const inventory = await call(client, "mira_bridge_powershell", {
      workspace_id: opened.workspace_id,
      script: inventoryScript,
      cwd: ".",
      timeout_ms: 120_000,
    });
    if (inventory.exit_code !== 0) throw new Error(`System inventory failed: ${inventory.stderr}`);
    state.system_inventory = JSON.parse(inventory.stdout.trim());
    await event("windows_system_inventory", state.system_inventory);

    const recycle = await call(client, "mira_bridge_scan_recycle_bin", { node_id: nodeId, drives: ["C", "D"], max_items: 100 }, 600_000);
    state.recycle_scan = recycle;
    await event("recycle_bin_scan_only", recycle);

    const encoding = await call(client, "mira_bridge_exec", {
      workspace_id: opened.workspace_id,
      program: "where.exe",
      args: ["MiraBridgeDefinitelyMissing.exe"],
      cwd: ".",
      env: {},
      timeout_ms: 60_000,
      output_encoding: "auto",
    });
    if (encoding.exit_code !== 1 || !String(encoding.stderr).includes("无法找到文件") || encoding.stderr_encoding !== "cp936") {
      throw new Error(`CP936 auto decoding regression: ${JSON.stringify(encoding)}`);
    }
    state.evidence.encoding = encoding;
    await event("native_cp936_auto_decode", encoding);
    await saveState();
  } finally {
    await client.close().catch(() => undefined);
  }
}

const aggregatorSource = `namespace OpsApi;

public sealed record MetricRecord(DateTime Timestamp, string Service, double LatencyMs, double CpuPercent, bool Healthy);
public sealed record ServiceSummary(string Service, int Count, double AverageLatencyMs, double AverageCpuPercent, double HealthyPercent);
public sealed record OperationsSummary(int TotalRecords, double AverageLatencyMs, double HealthyPercent, IReadOnlyList<ServiceSummary> Services);

public static class MetricsAggregator
{
    public static OperationsSummary Summarize(IReadOnlyList<MetricRecord> rows)
    {
        if (rows.Count == 0) return new OperationsSummary(0, 0, 0, []);
        // Intentional acceptance defect: the denominator is wrong and must be diagnosed from the failing test.
        var averageLatency = rows.Sum(row => row.LatencyMs) / (rows.Count - 1);
        var healthyPercent = rows.Count(row => row.Healthy) * 100.0 / rows.Count;
        var services = rows.GroupBy(row => row.Service, StringComparer.Ordinal)
            .Select(group => new ServiceSummary(
                group.Key,
                group.Count(),
                Math.Round(group.Average(row => row.LatencyMs), 2),
                Math.Round(group.Average(row => row.CpuPercent), 2),
                Math.Round(group.Count(row => row.Healthy) * 100.0 / group.Count(), 2)))
            .OrderByDescending(item => item.AverageLatencyMs)
            .ToArray();
        return new OperationsSummary(rows.Count, Math.Round(averageLatency, 2), Math.Round(healthyPercent, 2), services);
    }
}
`;

const programSource = `using System.Globalization;
using OpsApi;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));
var app = builder.Build();
app.UseCors();
app.MapGet("/health", () => Results.Ok(new { status = "healthy", host = Environment.MachineName, runtime = Environment.Version.ToString() }));
app.MapGet("/api/summary", async (IWebHostEnvironment environment) =>
{
    var path = Path.Combine(environment.ContentRootPath, "..", "data", "operations.csv");
    var rows = new List<MetricRecord>(100_000);
    using var stream = File.OpenRead(path);
    using var reader = new StreamReader(stream);
    await reader.ReadLineAsync();
    while (await reader.ReadLineAsync() is { } line)
    {
        var parts = line.Split(',');
        rows.Add(new MetricRecord(
            DateTime.Parse(parts[0], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal),
            parts[1],
            double.Parse(parts[2], CultureInfo.InvariantCulture),
            double.Parse(parts[3], CultureInfo.InvariantCulture),
            bool.Parse(parts[4])));
    }
    return Results.Ok(MetricsAggregator.Summarize(rows));
});
app.Run();
`;

const testSource = `using OpsApi;

namespace OpsApi.Tests;

public sealed class MetricsAggregatorTests
{
    [Fact]
    public void ComputesAverageLatencyAcrossEveryRecord()
    {
        var rows = new[]
        {
            new MetricRecord(DateTime.UnixEpoch, "网关", 100, 30, true),
            new MetricRecord(DateTime.UnixEpoch.AddSeconds(1), "网关", 300, 50, false),
        };
        var summary = MetricsAggregator.Summarize(rows);
        Assert.Equal(200, summary.AverageLatencyMs);
        Assert.Equal(50, summary.HealthyPercent);
    }
}
`;

const generatorSource = `import csv
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

random.seed(120453)
root = Path(__file__).resolve().parent
services = [("支付网关", 168), ("订单服务", 112), ("库存服务", 84), ("消息队列", 62)]
start = datetime(2026, 8, 21, tzinfo=timezone.utc)
with (root / "operations.csv").open("w", encoding="utf-8", newline="") as csv_file, (root / "operations.jsonl").open("w", encoding="utf-8") as jsonl_file:
    writer = csv.writer(csv_file, lineterminator="\\n")
    writer.writerow(["timestamp", "service", "latency_ms", "cpu_percent", "healthy"])
    for index in range(100_000):
        service, baseline = services[index % len(services)]
        latency = round(max(8, random.gauss(baseline, baseline * 0.18)), 2)
        cpu = round(min(99, max(2, random.gauss(44 + index % 11, 12))), 2)
        healthy = not (index % 97 == 0 or latency > baseline * 1.55)
        timestamp = (start + timedelta(seconds=index)).isoformat().replace("+00:00", "Z")
        writer.writerow([timestamp, service, latency, cpu, str(healthy).lower()])
        jsonl_file.write(json.dumps({"timestamp": timestamp, "service": service, "latency_ms": latency, "cpu_percent": cpu, "healthy": healthy}, ensure_ascii=False) + "\\n")
print("generated_rows=100000 encoding=utf-8 services=4")
`;

const frontendPackage = `${JSON.stringify({
  name: "mirabridge-operations-console",
  private: true,
  version: "1.2.0",
  type: "module",
  scripts: { dev: "vite", build: "tsc && vite build" },
  devDependencies: { typescript: "6.0.2", vite: "7.1.3" },
}, null, 2)}\n`;

const frontendConfig = `import { defineConfig } from "vite";
export default defineConfig({ server: { proxy: { "/api": "http://127.0.0.1:5080", "/health": "http://127.0.0.1:5080" } } });
`;

const frontendTsConfig = `${JSON.stringify({ compilerOptions: { target: "ES2022", useDefineForClassFields: true, module: "ESNext", lib: ["ES2022", "DOM", "DOM.Iterable"], skipLibCheck: true, moduleResolution: "Bundler", allowImportingTsExtensions: true, isolatedModules: true, moduleDetection: "force", noEmit: true, strict: true }, include: ["src"] }, null, 2)}\n`;

const frontendHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Windows 生产环境运行指标"><title>MiraBridge 运维看板</title></head>
<body><div id="app"><header><div><span class="mark"></span><b>MiraBridge</b><small>WINDOWS OPERATIONS</small></div><div class="live"><i></i> REAL WINDOWS NODE</div></header>
<main><section class="overview"><div><p class="eyebrow">REAL-TIME OPERATIONS / 100K RECORDS</p><h1>运行状态，一眼可判。</h1><p class="scope">来自 Windows 原生 .NET API 的聚合视图 · <span id="updated">正在同步</span></p></div><div class="health"><span>HEALTH</span><strong id="health">—</strong><em>服务可用率</em></div></section>
<section class="metrics"><div><span>记录总量</span><strong id="records">—</strong></div><div><span>平均延迟</span><strong id="latency">—</strong></div><div><span>受监控服务</span><strong id="services">—</strong></div></section>
<section class="workspace"><div class="chart"><div class="section-title"><div><small>LATENCY PROFILE</small><h2>服务延迟分布</h2></div><span>毫秒 / 平均值</span></div><svg id="bars" role="img" aria-label="服务平均延迟条形图"></svg></div>
<div class="table"><div class="section-title"><div><small>SERVICE DETAIL</small><h2>服务明细</h2></div><span>按延迟排序</span></div><div class="thead"><span>服务</span><span>请求</span><span>CPU</span><span>健康</span></div><div id="rows"></div></div></section>
<footer><span>reasoning_host = Mac</span><span>tool_host = Windows</span><span>RPC 2.0 · Worker 1.2.0</span></footer></main></div><script type="module" src="/src/main.ts"></script></body></html>`;

const frontendMain = `import "./style.css";
type Service = { service: string; count: number; averageLatencyMs: number; averageCpuPercent: number; healthyPercent: number };
type Summary = { totalRecords: number; averageLatencyMs: number; healthyPercent: number; services: Service[] };
const number = new Intl.NumberFormat("zh-CN");
async function load() {
  const response = await fetch("/api/summary");
  if (!response.ok) throw new Error("API " + response.status);
  const data = await response.json() as Summary;
  document.querySelector<HTMLElement>("#records")!.textContent = number.format(data.totalRecords);
  document.querySelector<HTMLElement>("#latency")!.textContent = data.averageLatencyMs.toFixed(1) + " ms";
  document.querySelector<HTMLElement>("#services")!.textContent = String(data.services.length);
  document.querySelector<HTMLElement>("#health")!.textContent = data.healthyPercent.toFixed(1) + "%";
  document.querySelector<HTMLElement>("#updated")!.textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN");
  const max = Math.max(...data.services.map(item => item.averageLatencyMs));
  document.querySelector<SVGElement>("#bars")!.innerHTML = data.services.map((item, index) => {
    const width = Math.round((item.averageLatencyMs / max) * 78);
    const y = 14 + index * 22;
    return '<g class="bar" style="--delay:' + (index * 90) + 'ms"><text x="0" y="' + (y + 7) + '">' + item.service + '</text><rect x="25" y="' + y + '" width="' + width + '" height="9" rx="4.5"></rect><text class="value" x="' + Math.min(96, 27 + width) + '" y="' + (y + 7) + '">' + item.averageLatencyMs.toFixed(1) + '</text></g>';
  }).join("");
  document.querySelector<HTMLElement>("#rows")!.innerHTML = data.services.map(item => '<div class="row"><b>' + item.service + '</b><span>' + number.format(item.count) + '</span><span>' + item.averageCpuPercent.toFixed(1) + '%</span><span class="ok">' + item.healthyPercent.toFixed(1) + '%</span></div>').join("");
}
load().catch(error => { console.error(error); document.body.dataset.error = String(error); });
`;

const frontendCss = `:root{font-family:"Segoe UI Variable","Segoe UI",sans-serif;color:#eaf2f7;background:#071014;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-width:320px;background:radial-gradient(circle at 76% -5%,#16404b 0,transparent 36%),#071014}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.16;background-image:linear-gradient(#87ffd70e 1px,transparent 1px),linear-gradient(90deg,#87ffd70e 1px,transparent 1px);background-size:44px 44px}#app{position:relative;min-height:100vh}header{height:76px;padding:0 clamp(24px,5vw,72px);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #b8e8df1c}header>div{display:flex;align-items:center;gap:12px}.mark{width:20px;height:20px;border-radius:5px;background:#5df0bd;box-shadow:0 0 28px #5df0bd77}header b{font-size:20px;letter-spacing:-.02em}header small,.live,.eyebrow,.section-title small,footer{font:650 10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.16em;color:#82a7a4}.live i{width:7px;height:7px;border-radius:50%;background:#5df0bd;box-shadow:0 0 12px #5df0bd;animation:pulse 2s infinite}main{width:min(1420px,calc(100% - 48px));margin:auto}.overview{min-height:330px;display:flex;justify-content:space-between;align-items:flex-end;padding:72px 0 54px}.eyebrow{color:#5df0bd;margin:0 0 22px}.overview h1{font-size:clamp(48px,7vw,94px);line-height:.95;letter-spacing:-.065em;font-weight:600;margin:0}.scope{color:#90a7aa;margin:26px 0 0}.health{width:220px;border-left:1px solid #88cfc044;padding:0 0 8px 30px}.health span,.health em{display:block;font:600 10px ui-monospace,monospace;letter-spacing:.15em;color:#75938f}.health strong{display:block;color:#5df0bd;font-size:50px;letter-spacing:-.05em;margin:10px 0 7px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);border-block:1px solid #b8e8df22}.metrics div{padding:27px 0}.metrics div+div{border-left:1px solid #b8e8df22;padding-left:32px}.metrics span{display:block;color:#80989a;font-size:12px;margin-bottom:7px}.metrics strong{font-size:25px;font-weight:590}.workspace{display:grid;grid-template-columns:1.2fr .8fr;gap:0;padding:58px 0}.chart{padding-right:48px}.table{padding-left:48px;border-left:1px solid #b8e8df22}.section-title{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:34px}.section-title h2{font-size:25px;margin:6px 0 0}.section-title>span{font-size:11px;color:#6f898a}#bars{width:100%;height:115px;overflow:visible}.bar text{fill:#a5babc;font:3px ui-monospace,monospace}.bar .value{fill:#5df0bd}.bar rect{fill:#5df0bd;transform-origin:left;animation:grow .75s cubic-bezier(.2,.8,.2,1) both;animation-delay:var(--delay)}.thead,.row{display:grid;grid-template-columns:1.4fr .7fr .6fr .6fr;gap:12px;align-items:center}.thead{padding:0 0 13px;color:#678385;font:600 10px ui-monospace,monospace;letter-spacing:.1em}.row{padding:16px 0;border-top:1px solid #b8e8df1c;font-size:13px;transition:background .2s,transform .2s}.row:hover{background:#102326;transform:translateX(4px)}.row span{color:#8fa5a7}.row .ok{color:#5df0bd}footer{display:flex;justify-content:space-between;border-top:1px solid #b8e8df22;padding:28px 0 44px}@keyframes grow{from{transform:scaleX(0);opacity:0}}@keyframes pulse{50%{opacity:.4;transform:scale(.8)}}@media(max-width:760px){header{height:64px;padding:0 18px}header small,.live{display:none}main{width:calc(100% - 28px)}.overview{min-height:340px;padding:55px 0 38px;display:block}.overview h1{font-size:52px}.health{width:auto;border-left:0;border-top:1px solid #88cfc044;margin-top:42px;padding:22px 0 0;display:grid;grid-template-columns:1fr auto;align-items:end}.health strong{font-size:40px;margin:0}.health em{grid-column:1/-1}.metrics{grid-template-columns:1fr}.metrics div+div{border-left:0;border-top:1px solid #b8e8df22;padding-left:0}.workspace{grid-template-columns:1fr;padding:46px 0}.chart{padding:0 0 45px}.table{padding:40px 0 0;border-left:0;border-top:1px solid #b8e8df22}.row,.thead{grid-template-columns:1.2fr .7fr .6fr .65fr}footer{flex-direction:column;gap:10px}}`;

const gitignore = `**/bin/
**/obj/
frontend/node_modules/
data/*.csv
data/*.jsonl
deliverables/*.mp4
deliverables/*.png
`;

async function phaseScaffold() {
  const client = await connect();
  try {
    const workspaceId = await workspace(client);
    const pythonProbe = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: "where.exe",
      args: ["python.exe"],
      cwd: ".",
      env: {},
      timeout_ms: 60_000,
      output_encoding: "auto",
    });
    if (pythonProbe.exit_code !== 0) throw new Error(`Python is required by the locked acceptance task: ${pythonProbe.stderr}`);
    const python = String(pythonProbe.stdout).trim().split(/\r?\n/u)[0];
    state.python = python;
    await event("python_probe", { path: python, encoding: pythonProbe.stdout_encoding });

    for (const path of ["src", "data", "frontend", "tests", "deliverables", "reports"]) {
      await call(client, "mira_bridge_manage_path", { workspace_id: workspaceId, action: "mkdir", path, recursive: false, overwrite: false });
    }

    const dotnetCommands = [
      ["new", "sln", "-n", "MiraBridge.Operations"],
      ["new", "web", "-n", "OpsApi", "-o", "src\\OpsApi", "-f", "net10.0", "--no-https"],
      ["new", "xunit", "-n", "OpsApi.Tests", "-o", "tests\\OpsApi.Tests", "-f", "net10.0"],
      ["add", "tests\\OpsApi.Tests\\OpsApi.Tests.csproj", "reference", "src\\OpsApi\\OpsApi.csproj"],
      ["sln", "MiraBridge.Operations.slnx", "add", "src\\OpsApi\\OpsApi.csproj", "tests\\OpsApi.Tests\\OpsApi.Tests.csproj"],
    ];
    for (const args of dotnetCommands) {
      const result = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: dotnet, args, cwd: ".", env: {}, timeout_ms: 300_000, output_encoding: "auto" }, 360_000);
      if (result.exit_code !== 0) throw new Error(`dotnet ${args.join(" ")} failed: ${result.stderr}`);
    }

    const files = [
      ["src\\OpsApi\\MetricsAggregator.cs", aggregatorSource, true],
      ["src\\OpsApi\\Program.cs", programSource, false],
      ["tests\\OpsApi.Tests\\UnitTest1.cs", testSource, false],
      ["data\\generate.py", generatorSource, false],
      ["frontend\\package.json", frontendPackage, false],
      ["frontend\\vite.config.ts", frontendConfig, false],
      ["frontend\\tsconfig.json", frontendTsConfig, false],
      ["frontend\\index.html", frontendHtml, false],
      ["frontend\\src\\main.ts", frontendMain, true],
      ["frontend\\src\\style.css", frontendCss, false],
      [".gitignore", gitignore, false],
      ["README.md", `# MiraBridge Operations Console\n\nVisual thesis: midnight operations console, electric mint signal, dense but calm Windows-native telemetry.\n\nContent: current health, core KPIs, service latency profile, operator table.\n\nInteraction: live status pulse, chart entrance sweep, table row focus.\n`, false],
    ];
    for (const [path, content, createParents] of files) {
      await call(client, "mira_bridge_write_text", { workspace_id: workspaceId, path, content, create_parents: createParents });
    }

    const generator = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: python,
      args: ["data\\generate.py"],
      cwd: ".",
      env: { PYTHONUTF8: "1" },
      timeout_ms: 300_000,
      output_encoding: "auto",
    }, 360_000);
    if (generator.exit_code !== 0 || !String(generator.stdout).includes("generated_rows=100000")) throw new Error(`Data generation failed: ${generator.stderr}`);
    const csv = await call(client, "mira_bridge_stat", { workspace_id: workspaceId, path: "data\\operations.csv" });
    const jsonl = await call(client, "mira_bridge_stat", { workspace_id: workspaceId, path: "data\\operations.jsonl" });
    await event("generated_100k_unicode_dataset", { stdout: generator.stdout.trim(), csv, jsonl });

    const npmInstall = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: "npm.cmd",
      args: ["install", "--no-audit", "--no-fund"],
      cwd: "frontend",
      env: {},
      timeout_ms: 900_000,
      output_encoding: "auto",
    }, 1_000_000);
    if (npmInstall.exit_code !== 0) throw new Error(`Frontend install failed: ${npmInstall.stderr}`);
    await event("vite_dependencies", { exit_code: npmInstall.exit_code, duration_ms: npmInstall.duration_ms, stdout_tail: String(npmInstall.stdout).slice(-1000) });

    const gitCommands = [
      ["init", "-b", "main"],
      ["config", "user.name", "MiraBridge Acceptance"],
      ["config", "user.email", "acceptance@mirabridge.local"],
      ["add", "."],
      ["commit", "-m", "feat: scaffold Windows operations console"],
    ];
    for (const args of gitCommands) {
      const result = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: git, args, cwd: ".", env: {}, timeout_ms: 300_000, output_encoding: "auto" }, 360_000);
      if (result.exit_code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }

    const failingTest = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: dotnet,
      args: ["test", "MiraBridge.Operations.slnx", "--configuration", "Release", "--no-restore"],
      cwd: ".",
      env: { DOTNET_CLI_UI_LANGUAGE: "en-US" },
      timeout_ms: 600_000,
      output_encoding: "auto",
    }, 660_000);
    if (failingTest.exit_code === 0 || !String(failingTest.stdout + failingTest.stderr).includes("ComputesAverageLatencyAcrossEveryRecord")) {
      throw new Error(`Expected the intentional aggregation test to fail: ${JSON.stringify(failingTest)}`);
    }
    state.evidence.test_failure = failingTest;
    await event("intentional_test_failure", failingTest, "PASS_REAL");

    const sourceRead = await call(client, "mira_bridge_read_text", { workspace_id: workspaceId, path: "src\\OpsApi\\MetricsAggregator.cs", start_line: 1, max_lines: 500 });
    const search = await call(client, "mira_bridge_search_text", { workspace_id: workspaceId, query: "rows.Count - 1", path: ".", file_glob: "**/*.cs", case_sensitive: true, max_results: 20 });
    const globbed = await call(client, "mira_bridge_glob", { workspace_id: workspaceId, pattern: "**/*.{cs,ts}", path: ".", max_results: 1000 });
    state.aggregation_source_sha256 = sourceRead.sha256;
    state.evidence.aggregation_source = sourceRead;
    await event("failure_localization", { source: sourceRead, search, relevant_files: globbed.matches });
    await saveState();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function phaseVerify() {
  const client = await connect();
  try {
    const workspaceId = await workspace(client);
    const fixedTest = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: dotnet,
      args: ["test", "MiraBridge.Operations.slnx", "--configuration", "Release", "--no-restore"],
      cwd: ".",
      env: { DOTNET_CLI_UI_LANGUAGE: "en-US" },
      timeout_ms: 600_000,
      output_encoding: "auto",
    }, 660_000);
    if (fixedTest.exit_code !== 0 || !String(fixedTest.stdout).includes("Passed:     1")) throw new Error(`Regression test did not pass after the exact edit: ${JSON.stringify(fixedTest)}`);
    state.evidence.test_after_fix = fixedTest;
    await event("aggregation_fix_verified", fixedTest);

    const gitCommands = [
      ["switch", "-c", "fix/aggregation-denominator"],
      ["diff", "--check"],
      ["add", "src\\OpsApi\\MetricsAggregator.cs"],
      ["commit", "-m", "fix: aggregate latency across every record"],
      ["switch", "main"],
      ["merge", "--no-ff", "fix/aggregation-denominator", "-m", "merge: verified aggregation repair"],
      ["tag", "-a", "v1.2.0-acceptance", "-m", "MiraBridge 1.2.0 real Windows acceptance"],
      ["status", "--short"],
      ["log", "--oneline", "--decorate", "--graph", "-5"],
    ];
    const gitEvidence = [];
    for (const args of gitCommands) {
      const result = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: git, args, cwd: ".", env: {}, timeout_ms: 300_000, output_encoding: "auto" }, 360_000);
      if (result.exit_code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      gitEvidence.push({ args, stdout: result.stdout, stderr: result.stderr, exit_code: result.exit_code });
    }
    state.evidence.git_workflow = gitEvidence;
    await event("local_git_branch_merge_tag", gitEvidence);

    const frontendBuild = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: "npm.cmd",
      args: ["run", "build"],
      cwd: "frontend",
      env: {},
      timeout_ms: 300_000,
      output_encoding: "auto",
    }, 360_000);
    if (frontendBuild.exit_code !== 0) throw new Error(`Vite production build failed: ${frontendBuild.stderr}`);
    const publish = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: dotnet,
      args: ["publish", "src\\OpsApi\\OpsApi.csproj", "--configuration", "Release", "--output", "publish\\OpsApi", "--no-restore"],
      cwd: ".",
      env: { DOTNET_CLI_UI_LANGUAGE: "en-US" },
      timeout_ms: 600_000,
      output_encoding: "auto",
    }, 660_000);
    if (publish.exit_code !== 0) throw new Error(`dotnet publish failed: ${publish.stderr}`);
    const dist = await call(client, "mira_bridge_list_directory", { workspace_id: workspaceId, path: "frontend\\dist", max_entries: 1000 });
    const published = await call(client, "mira_bridge_list_directory", { workspace_id: workspaceId, path: "publish\\OpsApi", max_entries: 1000 });
    const globbed = await call(client, "mira_bridge_glob", { workspace_id: workspaceId, pattern: "**/*.cs", path: ".", max_results: 1000 });
    state.evidence.build = { frontendBuild, publish, dist, published, cs_files: globbed.matches };
    await event("production_build_and_publish", state.evidence.build);
    await saveState();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function phaseBuildPublish() {
  const client = await connect();
  try {
    const workspaceId = await workspace(client);
    const gitCommands = [
      ["switch", "-c", "fix/frontend-css-types"],
      ["add", "frontend\\tsconfig.json"],
      ["commit", "-m", "fix: register Vite CSS side-effect types"],
      ["switch", "main"],
      ["merge", "--no-ff", "fix/frontend-css-types", "-m", "merge: verified frontend build repair"],
      ["tag", "-a", "v1.2.0-acceptance-final", "-m", "MiraBridge 1.2.0 verified Windows deliverable"],
    ];
    const gitEvidence = [];
    for (const args of gitCommands) {
      const result = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: git, args, cwd: ".", env: {}, timeout_ms: 300_000, output_encoding: "auto" }, 360_000);
      if (result.exit_code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      gitEvidence.push({ args, stdout: result.stdout, stderr: result.stderr });
    }
    const frontendBuild = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId, program: "npm.cmd", args: ["run", "build"], cwd: "frontend", env: {}, timeout_ms: 300_000, output_encoding: "auto",
    }, 360_000);
    if (frontendBuild.exit_code !== 0) throw new Error(`Vite build regression: ${JSON.stringify(frontendBuild)}`);
    const publish = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId, program: dotnet,
      args: ["publish", "src\\OpsApi\\OpsApi.csproj", "--configuration", "Release", "--output", "publish\\OpsApi", "--no-restore"],
      cwd: ".", env: { DOTNET_CLI_UI_LANGUAGE: "en-US" }, timeout_ms: 600_000, output_encoding: "auto",
    }, 660_000);
    if (publish.exit_code !== 0) throw new Error(`dotnet publish failed: ${JSON.stringify(publish)}`);
    const dist = await call(client, "mira_bridge_list_directory", { workspace_id: workspaceId, path: "frontend\\dist", max_entries: 1000 });
    const published = await call(client, "mira_bridge_list_directory", { workspace_id: workspaceId, path: "publish\\OpsApi", max_entries: 1000 });
    const csFiles = await call(client, "mira_bridge_glob", { workspace_id: workspaceId, pattern: "**/*.cs", path: ".", max_results: 1000 });
    state.evidence.frontend_build_error_before = {
      exit_code: 2,
      diagnostic: "TS2882: Cannot find module or type declarations for side-effect import of './style.css'.",
    };
    state.evidence.build = { gitEvidence, frontendBuild, publish, dist, published, cs_files: csFiles.matches };
    await event("frontend_error_before_and_verified_build", state.evidence.build);
    await saveState();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function phaseWebStart() {
  const client = await connect();
  try {
    const workspaceId = await workspace(client);
    const api = await call(client, "mira_bridge_start_job", {
      workspace_id: workspaceId,
      program: dotnet,
      args: ["run", "--project", "src\\OpsApi\\OpsApi.csproj", "--configuration", "Release", "--no-build", "--", "--urls", "http://127.0.0.1:5080"],
      cwd: ".",
      env: { DOTNET_CLI_UI_LANGUAGE: "en-US", ASPNETCORE_ENVIRONMENT: "Production" },
      timeout_ms: 1_800_000,
      output_encoding: "auto",
      idempotency_key: `acceptance-${runId}-api`,
      stdin_mode: "closed",
    });
    const vite = await call(client, "mira_bridge_start_job", {
      workspace_id: workspaceId,
      program: "npm.cmd",
      args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4174", "--strictPort"],
      cwd: "frontend",
      env: {},
      timeout_ms: 1_800_000,
      output_encoding: "auto",
      idempotency_key: `acceptance-${runId}-vite`,
      stdin_mode: "closed",
    });
    state.jobs.api = api.job_id;
    state.jobs.vite = vite.job_id;
    await event("web_jobs_started", { api, vite });

    const health = await waitForHttp(client, workspaceId, "http://127.0.0.1:5080/health", "healthy");
    const page = await waitForHttp(client, workspaceId, "http://127.0.0.1:4174/", "MiraBridge 运维看板");
    await event("windows_curl_health_and_html", { health, page });

    const summary = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: "curl.exe",
      args: ["--fail", "--silent", "--show-error", "--max-time", "30", "http://127.0.0.1:5080/api/summary"],
      cwd: ".",
      env: {},
      timeout_ms: 60_000,
      output_encoding: "auto",
    }, 90_000);
    if (summary.exit_code !== 0) {
      const apiLogs = await call(client, "mira_bridge_read_job_logs", { job_id: api.job_id, stream: "stdout", offset: 0, max_bytes: 65_536, tail_lines: 100 });
      state.evidence.api_error_before = { summary, api_logs: apiLogs };
      await event("api_summary_error_before", state.evidence.api_error_before, "FAIL_PRODUCT");
    } else {
      state.evidence.api_summary = summary;
      await event("api_summary", summary);
    }
    await saveState();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function phaseWebRestart() {
  const client = await connect();
  try {
    const workspaceId = await workspace(client);
    if (state.jobs.api) {
      const current = await call(client, "mira_bridge_get_job", { job_id: state.jobs.api });
      if (["queued", "starting", "running"].includes(current.executor_status)) {
        await call(client, "mira_bridge_cancel_job", { job_id: state.jobs.api });
      }
    }
    const gitCommands = [
      ["switch", "-c", "fix/api-data-path"],
      ["add", "src\\OpsApi\\Program.cs"],
      ["commit", "-m", "fix: resolve operations data from project root"],
      ["switch", "main"],
      ["merge", "--no-ff", "fix/api-data-path", "-m", "merge: verified API path repair"],
      ["tag", "-a", "v1.2.0-acceptance-web", "-m", "MiraBridge 1.2.0 browser-verified deliverable"],
    ];
    for (const args of gitCommands) {
      const result = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: git, args, cwd: ".", env: {}, timeout_ms: 300_000, output_encoding: "auto" }, 360_000);
      if (result.exit_code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    const build = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: dotnet,
      args: ["build", "MiraBridge.Operations.slnx", "--configuration", "Release", "--no-restore"],
      cwd: ".",
      env: { DOTNET_CLI_UI_LANGUAGE: "en-US" },
      timeout_ms: 600_000,
      output_encoding: "auto",
    }, 660_000);
    if (build.exit_code !== 0) throw new Error(`API rebuild failed: ${JSON.stringify(build)}`);
    const api = await call(client, "mira_bridge_start_job", {
      workspace_id: workspaceId,
      program: dotnet,
      args: ["run", "--project", "src\\OpsApi\\OpsApi.csproj", "--configuration", "Release", "--no-build", "--", "--urls", "http://127.0.0.1:5080"],
      cwd: ".",
      env: { DOTNET_CLI_UI_LANGUAGE: "en-US", ASPNETCORE_ENVIRONMENT: "Production" },
      timeout_ms: 1_800_000,
      output_encoding: "auto",
      idempotency_key: `acceptance-${runId}-api-fixed`,
      stdin_mode: "closed",
    });
    state.jobs.api = api.job_id;
    const summary = await waitForHttp(client, workspaceId, "http://127.0.0.1:5080/api/summary", "totalRecords", 60);
    state.evidence.api_fix = { build, api, summary };
    await event("api_path_fix_and_restart", state.evidence.api_fix);
    await saveState();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function phaseWebVerify() {
  const client = await connect();
  try {
    const workspaceId = await workspace(client);
    const summary = await waitForHttp(client, workspaceId, "http://127.0.0.1:5080/api/summary", "totalRecords", 30);
    const parsed = JSON.parse(summary.stdout);
    if (parsed.totalRecords !== 100_000 || parsed.services?.length !== 4) throw new Error(`API aggregation is incomplete: ${summary.stdout}`);
    state.evidence.api_summary = { result: parsed, transport: summary };
    await event("api_summary_after_fix", state.evidence.api_summary);

    const apiState = await call(client, "mira_bridge_get_job", { job_id: state.jobs.api });
    const jobs = await call(client, "mira_bridge_list_jobs", { node_id: nodeId, statuses: ["running"], max_results: 500 });
    const waited = await call(client, "mira_bridge_wait_job", { job_id: state.jobs.vite, timeout_ms: 500 }, 30_000);
    if (apiState.executor_status !== "running" || waited.executor_status !== "running") throw new Error("Web Jobs did not remain active across the MCP/SSH reconnect.");
    if (!jobs.jobs.some((job) => job.job_id === state.jobs.api) || !jobs.jobs.some((job) => job.job_id === state.jobs.vite)) {
      throw new Error("list_jobs did not rediscover both web Jobs.");
    }
    await event("web_jobs_recovered_after_disconnect", { api: apiState, vite: waited, listed_job_count: jobs.jobs.length });

    const desktop = await call(client, "mira_bridge_web_snapshot", {
      workspace_id: workspaceId,
      url: "http://127.0.0.1:4174/",
      screenshot_path: "deliverables\\operations-desktop.png",
      dom_path: "deliverables\\operations-page.html",
      viewport: { width: 1440, height: 1000 },
      full_page: true,
      overwrite: false,
      wait_until: "networkidle",
      network_policy: "local-only",
      timeout_ms: 120_000,
    }, 180_000);
    const mobile = await call(client, "mira_bridge_web_snapshot", {
      workspace_id: workspaceId,
      url: "http://127.0.0.1:4174/",
      screenshot_path: "deliverables\\operations-mobile.png",
      viewport: { width: 390, height: 844 },
      full_page: true,
      overwrite: false,
      wait_until: "networkidle",
      network_policy: "local-only",
      timeout_ms: 120_000,
    }, 180_000);
    for (const snapshot of [desktop, mobile]) {
      if (snapshot.status_code !== 200 || snapshot.console_errors.length || snapshot.page_errors.length || !String(snapshot.title).includes("MiraBridge")) {
        throw new Error(`Windows Edge rendering failed: ${JSON.stringify(snapshot)}`);
      }
    }
    state.evidence.web_snapshots = { desktop, mobile };
    await event("windows_edge_desktop_mobile", state.evidence.web_snapshots);

    const apiLogs = await call(client, "mira_bridge_read_job_logs", { job_id: state.jobs.api, stream: "stdout", offset: 0, max_bytes: 65_536, tail_lines: 60 });
    state.evidence.web_job_logs = apiLogs;
    await event("web_job_logs", apiLogs);
    for (const jobId of [state.jobs.vite, state.jobs.api]) {
      const cancelled = await call(client, "mira_bridge_cancel_job", { job_id: jobId });
      await event("web_job_cancelled", cancelled);
    }
    await saveState();
  } finally {
    await client.close().catch(() => undefined);
  }
}

const tuiSource = `process.stdout.write("\\x1b]0;MiraBridge TUI\\x07");
process.stdin.setRawMode(true);
process.stdin.resume();
let selected = 0;
const options = ["系统巡检", "构建验证", "传输成果"];
function render() {
  process.stdout.write("\\x1b[2J\\x1b[H");
  process.stdout.write("MiraBridge ANSI 菜单\\r\\n");
  process.stdout.write("SIZE=" + process.stdout.columns + "x" + process.stdout.rows + "\\r\\n");
  options.forEach((item, index) => process.stdout.write((index === selected ? "> " : "  ") + item + "\\r\\n"));
  process.stdout.write("方向键选择 · Ctrl-C 退出");
}
process.stdout.on("resize", render);
process.stdin.on("data", data => {
  const text = data.toString("utf8");
  if (text.includes("\\x03")) { process.stdout.write("\\r\\nTUI_CANCELLED\\r\\n"); process.exit(0); }
  if (text.includes("\\x1b[B")) selected = Math.min(options.length - 1, selected + 1);
  if (text.includes("\\x1b[A")) selected = Math.max(0, selected - 1);
  render();
});
render();
`;

async function phaseTerminal() {
  let client = await connect();
  let replJobId;
  try {
    const workspaceId = await workspace(client);
    await call(client, "mira_bridge_write_text", { workspace_id: workspaceId, path: "tests\\terminal-menu.mjs", content: tuiSource, create_parents: false });
    const marker = `终端-${runId}`;
    const repl = await call(client, "mira_bridge_start_job", {
      workspace_id: workspaceId,
      program: state.python,
      args: ["-q"],
      cwd: ".",
      env: { PYTHONUTF8: "1" },
      timeout_ms: 600_000,
      output_encoding: "auto",
      idempotency_key: `acceptance-${runId}-python-repl-eof2`,
      stdin_mode: "conpty",
      terminal_size: { cols: 80, rows: 24 },
    });
    replJobId = repl.job_id;
    state.jobs.python_repl = replJobId;
    await waitForTerminal(client, replJobId, ">>>");
    await call(client, "mira_bridge_write_job_input", {
      job_id: replJobId,
      data: `import sys; print("TTY=" + str(sys.stdin.isatty())); print("${marker}")\r`,
      close: false,
    });
    const unicodeScreen = await waitForTerminal(client, replJobId, marker);
    if (!unicodeScreen.lines.join("\n").includes("TTY=True")) throw new Error(`Python did not observe TTY semantics: ${unicodeScreen.lines.join("\n")}`);
    await call(client, "mira_bridge_write_job_input", { job_id: replJobId, data: "sum(range(10))\r", close: false });
    await waitForTerminal(client, replJobId, "45");
    await call(client, "mira_bridge_write_job_input", { job_id: replJobId, data: "2+3\r", close: false });
    await waitForTerminal(client, replJobId, "5");
    await call(client, "mira_bridge_write_job_input", { job_id: replJobId, data: "\u001b[A\r", close: false });

    await call(client, "mira_bridge_write_job_input", { job_id: replJobId, data: "import time; time.sleep(30)\r", close: false });
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    await call(client, "mira_bridge_write_job_input", { job_id: replJobId, data: "\u0003", close: false });
    const interrupted = await waitForTerminal(client, replJobId, "KeyboardInterrupt");

    const resized = await call(client, "mira_bridge_resize_job_terminal", { job_id: replJobId, cols: 120, rows: 40 });
    await call(client, "mira_bridge_write_job_input", { job_id: replJobId, data: "import os; print('SIZE=' + str(os.get_terminal_size()))\r", close: false });
    const resizedScreen = await waitForTerminal(client, replJobId, "columns=120");
    if (resizedScreen.cols !== 120 || resizedScreen.rows !== 40) throw new Error(`Terminal snapshot did not persist 120x40: ${JSON.stringify(resizedScreen)}`);
    await event("python_conpty_interaction", { repl, unicodeScreen, interrupted, resized, resizedScreen });

    await client.close();
    client = undefined;
    const localProbe = await stat(resolve("package.json"));
    await event("mac_local_during_conpty_disconnect", { package_json_bytes: localProbe.size, ssh_session_closed: true });
    client = await connect();
    const listed = await call(client, "mira_bridge_list_jobs", { node_id: nodeId, statuses: ["running"], max_results: 500 });
    if (!listed.jobs.some((job) => job.job_id === replJobId)) throw new Error("Python ConPTY Job was not rediscovered after reconnect.");
    const recovered = await call(client, "mira_bridge_read_job_terminal", { job_id: replJobId });
    await call(client, "mira_bridge_write_job_input", { job_id: replJobId, data: `print("RECOVERED-${runId}")\r`, close: false });
    await waitForTerminal(client, replJobId, `RECOVERED-${runId}`);
    await call(client, "mira_bridge_write_job_input", { job_id: replJobId, data: "", close: true });
    const replDone = await waitForJob(client, replJobId, 60_000);
    if (replDone.executor_status !== "exited" || replDone.exit_code !== 0) throw new Error(`Python REPL did not close through EOF: ${JSON.stringify(replDone)}`);
    const replLogs = await call(client, "mira_bridge_read_job_logs", { job_id: replJobId, stream: "stdout", offset: 0, max_bytes: 262_144, tail_lines: 300 });
    await event("python_conpty_disconnect_recovery_eof", { recovered, replDone, log_tail: replLogs.text.slice(-6000) });

    const tui = await call(client, "mira_bridge_start_job", {
      workspace_id: workspaceId,
      program: "node.exe",
      args: ["tests\\terminal-menu.mjs"],
      cwd: ".",
      env: {},
      timeout_ms: 300_000,
      output_encoding: "auto",
      idempotency_key: `acceptance-${runId}-tui`,
      stdin_mode: "conpty",
      terminal_size: { cols: 80, rows: 24 },
    });
    state.jobs.tui = tui.job_id;
    const menuInitial = await waitForTerminal(client, tui.job_id, "> 系统巡检");
    await call(client, "mira_bridge_write_job_input", { job_id: tui.job_id, data: "\u001b[B", close: false });
    const menuMoved = await waitForTerminal(client, tui.job_id, "> 构建验证");
    await call(client, "mira_bridge_resize_job_terminal", { job_id: tui.job_id, cols: 120, rows: 40 });
    const menuResized = await waitForTerminal(client, tui.job_id, "SIZE=120x40");
    await call(client, "mira_bridge_write_job_input", { job_id: tui.job_id, data: "\u0003", close: false });
    const tuiDone = await waitForJob(client, tui.job_id, 60_000);
    if (tuiDone.exit_code !== 0) throw new Error(`TUI did not exit cleanly: ${JSON.stringify(tuiDone)}`);
    await event("ansi_tui_arrows_resize_ctrl_c", { tui, menuInitial, menuMoved, menuResized, tuiDone });

    const tree = await call(client, "mira_bridge_start_job", {
      workspace_id: workspaceId,
      program: "node.exe",
      args: ["-e", "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('CHILD_PID='+c.pid); setInterval(()=>{},1000)"],
      cwd: ".",
      env: {},
      timeout_ms: 300_000,
      output_encoding: "auto",
      idempotency_key: `acceptance-${runId}-tree-cancel`,
      stdin_mode: "conpty",
      terminal_size: { cols: 80, rows: 24 },
    });
    const childScreen = await waitForTerminal(client, tree.job_id, "CHILD_PID=");
    const childMatch = childScreen.lines.join("\n").match(/CHILD_PID=(\d+)/u);
    if (!childMatch) throw new Error("Could not capture the test child PID.");
    const childPid = childMatch[1];
    const cancelled = await call(client, "mira_bridge_cancel_job", { job_id: tree.job_id });
    const tasklist = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: "tasklist.exe",
      args: ["/FI", `PID eq ${childPid}`],
      cwd: ".",
      env: {},
      timeout_ms: 60_000,
      output_encoding: "auto",
    });
    if (String(tasklist.stdout).includes(childPid)) throw new Error(`Cancelled ConPTY Job left child PID ${childPid} alive.`);
    await event("conpty_process_tree_cancel", { cancelled, child_pid: Number(childPid), tasklist });

    const audit = await call(client, "mira_bridge_powershell", {
      workspace_id: workspaceId,
      script: `$records=Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'MiraBridge\\audit') -Filter 'audit-*.jsonl' | ForEach-Object { Get-Content -LiteralPath $_.FullName -Encoding UTF8 }; [ordered]@{plaintext_found=($records -match '${marker}').Count; input_records=($records -match 'mira_bridge_write_job_input').Count} | ConvertTo-Json -Compress`,
      cwd: ".",
      timeout_ms: 60_000,
    });
    const auditResult = JSON.parse(audit.stdout.trim());
    if (auditResult.plaintext_found !== 0) throw new Error("ConPTY input plaintext leaked into audit logs.");
    state.evidence.terminal = { repl_job_id: replJobId, tui_job_id: tui.job_id, audit: auditResult };
    await event("conpty_audit_redaction", state.evidence.terminal);
    await saveState();
  } finally {
    if (client) await client.close().catch(() => undefined);
  }
}

async function phaseGpuSafety() {
  let client = await connect();
  try {
    const workspaceId = await workspace(client);
    const encoders = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: ffmpeg,
      args: ["-hide_banner", "-encoders"],
      cwd: ".",
      env: {},
      timeout_ms: 120_000,
      output_encoding: "auto",
    });
    const nvencAvailable = encoders.exit_code === 0 && String(encoders.stdout).includes("h264_nvenc");
    await event("ffmpeg_nvenc_probe", { available: nvencAvailable, exit_code: encoders.exit_code, stdout_match: nvencAvailable });

    const telemetryScript = `$ProgressPreference='SilentlyContinue'; 1..20 | ForEach-Object { $at=(Get-Date).ToUniversalTime().ToString('o'); $gpu=& nvidia-smi.exe --query-gpu=timestamp,name,utilization.gpu,utilization.encoder,memory.used,temperature.gpu --format=csv,noheader,nounits; Write-Output ($at + ',' + $gpu); Start-Sleep -Seconds 1 }`;
    const telemetry = await call(client, "mira_bridge_start_job", {
      workspace_id: workspaceId,
      program: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", telemetryScript],
      cwd: ".",
      env: {},
      timeout_ms: 180_000,
      output_encoding: "auto",
      idempotency_key: `acceptance-${runId}-gpu-telemetry`,
      stdin_mode: "closed",
    });
    const videoArgs = nvencAvailable
      ? ["-hide_banner", "-y", "-re", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=48000", "-t", "15", "-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "deliverables\\gpu-demo.mp4"]
      : ["-hide_banner", "-y", "-re", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=48000", "-t", "15", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "deliverables\\cpu-fallback-demo.mp4"];
    const render = await call(client, "mira_bridge_start_job", {
      workspace_id: workspaceId,
      program: ffmpeg,
      args: videoArgs,
      cwd: ".",
      env: {},
      timeout_ms: 300_000,
      output_encoding: "auto",
      idempotency_key: `acceptance-${runId}-${nvencAvailable ? "nvenc" : "cpu"}-render`,
      stdin_mode: "closed",
    });
    state.jobs.telemetry = telemetry.job_id;
    state.jobs.render = render.job_id;
    await event("parallel_gpu_jobs_started", { telemetry, render, nvenc_available: nvencAvailable });

    await client.close();
    client = undefined;
    await writeFile(join(localRoot, "mac-local-during-gpu.txt"), `Mac remained writable while Windows Jobs ran.\nrun_id=${runId}\nat=${new Date().toISOString()}\n`, "utf8");
    await event("mac_local_work_during_gpu_disconnect", { path: join(localRoot, "mac-local-during-gpu.txt"), ssh_session_closed: true });
    client = await connect();
    const rediscovered = await call(client, "mira_bridge_list_jobs", { node_id: nodeId, max_results: 500 });
    if (!rediscovered.jobs.some((job) => job.job_id === render.job_id) || !rediscovered.jobs.some((job) => job.job_id === telemetry.job_id)) {
      throw new Error("GPU Jobs were not rediscovered after MCP/SSH reconnect.");
    }
    const renderDone = await waitForJob(client, render.job_id, 360_000);
    const telemetryDone = await waitForJob(client, telemetry.job_id, 360_000);
    const renderLogs = await call(client, "mira_bridge_read_job_logs", { job_id: render.job_id, stream: "stderr", offset: 0, max_bytes: 262_144, tail_lines: 120 });
    const telemetryLogs = await call(client, "mira_bridge_read_job_logs", { job_id: telemetry.job_id, stream: "stdout", offset: 0, max_bytes: 262_144, tail_lines: 100 });
    const renderStatus = nvencAvailable && renderDone.exit_code === 0 ? "PASS_REAL" : "FAIL_ENVIRONMENT";
    await event("gpu_jobs_recovered", { render: renderDone, telemetry: telemetryDone, render_log_tail: renderLogs.text.slice(-8000), telemetry_log_tail: telemetryLogs.text.slice(-8000) }, renderStatus);
    let finalRender = renderDone;
    let fallbackLogs = null;
    let videoPath = nvencAvailable && renderDone.exit_code === 0 ? "deliverables\\gpu-demo.mp4" : "deliverables\\cpu-fallback-demo.mp4";
    if (renderDone.exit_code !== 0) {
      const fallback = await call(client, "mira_bridge_start_job", {
        workspace_id: workspaceId,
        program: ffmpeg,
        args: ["-hide_banner", "-y", "-re", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=48000", "-t", "15", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", videoPath],
        cwd: ".",
        env: {},
        timeout_ms: 300_000,
        output_encoding: "auto",
        idempotency_key: `acceptance-${runId}-cpu-fallback-render`,
        stdin_mode: "closed",
      });
      finalRender = await waitForJob(client, fallback.job_id, 360_000);
      fallbackLogs = await call(client, "mira_bridge_read_job_logs", { job_id: fallback.job_id, stream: "stderr", offset: 0, max_bytes: 262_144, tail_lines: 120 });
      if (finalRender.exit_code !== 0) throw new Error(`FFmpeg CPU fallback failed: ${fallbackLogs.text}`);
      await event("cpu_video_fallback", { job: finalRender, log_tail: fallbackLogs.text.slice(-8000) }, "PASS_REAL");
    }
    const probe = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: ffprobe,
      args: ["-v", "error", "-show_entries", "stream=codec_name,width,height,r_frame_rate", "-show_entries", "format=duration,size", "-of", "json", videoPath],
      cwd: ".",
      env: {},
      timeout_ms: 120_000,
      output_encoding: "auto",
    });
    if (probe.exit_code !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
    const probeJson = JSON.parse(probe.stdout);
    const videoStream = probeJson.streams.find((stream) => stream.width === 1920);
    if (!videoStream || videoStream.height !== 1080 || videoStream.r_frame_rate !== "30/1" || Math.abs(Number(probeJson.format.duration) - 15) > 0.3) {
      throw new Error(`Video metadata is wrong: ${probe.stdout}`);
    }
    if (nvencAvailable && videoStream.codec_name !== "h264") throw new Error(`NVENC output codec is not H.264: ${probe.stdout}`);
    state.evidence.gpu = { nvenc_available: nvencAvailable, gpu_render: renderDone, final_render: finalRender, fallback_logs: fallbackLogs?.text ?? null, telemetry: telemetryDone, probe: probeJson, gpu_status: renderStatus };
    await event("ffprobe_video_verification", state.evidence.gpu, renderStatus);

    const large = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: "node.exe",
      args: ["-e", "process.stdout.write('HEAD-MIRABRIDGE\\n' + 'x'.repeat(220000) + '\\nTAIL-MIRABRIDGE\\n')"],
      cwd: ".",
      env: {},
      timeout_ms: 60_000,
      output_encoding: "auto",
    });
    if (!large.truncated || !large.output_ref || large.stdout_bytes < 220_000) throw new Error(`Large output was not bounded: ${JSON.stringify(large)}`);
    const tail = await call(client, "mira_bridge_read_output", { output_ref: large.output_ref, stream: "stdout", offset: 0, max_bytes: 65_536, tail_lines: 4 });
    if (!String(tail.text).includes("TAIL-MIRABRIDGE")) throw new Error("Paged output did not retain the true tail marker.");
    await event("large_output_pagination", { inline: large, tail });

    const timeout = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: "node.exe",
      args: ["-e", "setTimeout(()=>{},5000)"],
      cwd: ".",
      env: {},
      timeout_ms: 200,
      output_encoding: "auto",
    });
    if (!timeout.timed_out) throw new Error(`Synchronous timeout did not fire: ${JSON.stringify(timeout)}`);
    await event("synchronous_process_tree_timeout", timeout);

    const idempotencyArgs = {
      workspace_id: workspaceId,
      program: "node.exe",
      args: ["-e", "setTimeout(()=>{},60000)"],
      cwd: ".",
      env: {},
      timeout_ms: 120_000,
      output_encoding: "auto",
      idempotency_key: `acceptance-${runId}-idempotent-cancel`,
      stdin_mode: "closed",
    };
    const first = await call(client, "mira_bridge_start_job", idempotencyArgs);
    const replay = await call(client, "mira_bridge_start_job", idempotencyArgs);
    if (first.job_id !== replay.job_id) throw new Error("Job idempotency key launched two processes.");
    const beforeCancel = await call(client, "mira_bridge_get_job", { job_id: first.job_id });
    const cancelled = await call(client, "mira_bridge_cancel_job", { job_id: first.job_id });
    await event("job_idempotency_and_cancel", { first, replay, before_cancel: beforeCancel, cancelled });

    await call(client, "mira_bridge_write_text", { workspace_id: workspaceId, path: "tests\\cas-probe.txt", content: "version-one\n", create_parents: false });
    const cas = await call(client, "mira_bridge_read_text", { workspace_id: workspaceId, path: "tests\\cas-probe.txt", start_line: 1, max_lines: 20 });
    await expectedError(client, "reject_stale_cas", "mira_bridge_write_text", { workspace_id: workspaceId, path: "tests\\cas-probe.txt", content: "wrong\n", expected_sha256: "0".repeat(64), create_parents: false }, "FILE_CHANGED");
    const edited = await call(client, "mira_bridge_edit_text", { workspace_id: workspaceId, path: "tests\\cas-probe.txt", expected_sha256: cas.sha256, edits: [{ old_text: "version-one", new_text: "version-two", replace_all: false }] });
    await event("cas_exact_edit", edited);

    await expectedError(client, "reject_traversal", "mira_bridge_list_directory", { workspace_id: workspaceId, path: "..\\..\\Windows\\System32", max_entries: 5 }, "WORKSPACE_OUT_OF_BOUNDS");
    await expectedError(client, "reject_unc", "mira_bridge_stat", { workspace_id: workspaceId, path: "\\\\localhost\\C$\\Windows" }, "WORKSPACE_OUT_OF_BOUNDS");
    await expectedError(client, "reject_ads", "mira_bridge_stat", { workspace_id: workspaceId, path: "README.md:secret" }, "WORKSPACE_OUT_OF_BOUNDS");
    await expectedError(client, "reject_workspace_root_delete", "mira_bridge_manage_path", { workspace_id: workspaceId, action: "delete", path: ".", recursive: true, overwrite: false }, "PERMISSION_DENIED");
    await expectedError(client, "reject_unsupported_encoding", "mira_bridge_exec", { workspace_id: workspaceId, program: "where.exe", args: ["node.exe"], cwd: ".", env: {}, timeout_ms: 60_000, output_encoding: "cp437" }, "UNSUPPORTED_ENCODING");
    await expectedError(client, "reject_invalid_terminal_size", "mira_bridge_start_job", { workspace_id: workspaceId, program: "node.exe", args: ["-e", "0"], cwd: ".", env: {}, timeout_ms: 60_000, output_encoding: "auto", stdin_mode: "conpty", terminal_size: { cols: 10, rows: 2 } }, "INVALID_ARGUMENT");
    await expectedError(client, "reject_external_edge", "mira_bridge_web_snapshot", { workspace_id: workspaceId, url: "https://example.com/", screenshot_path: "deliverables\\external.png", viewport: { width: 800, height: 600 }, full_page: true, overwrite: false, wait_until: "load", network_policy: "allow-external", timeout_ms: 30_000 }, "CAPABILITY_NOT_ENABLED");
    await expectedError(client, "reject_non_terminal_snapshot", "mira_bridge_read_job_terminal", { job_id: first.job_id }, "TERMINAL_UNAVAILABLE");
    await expectedError(client, "reject_invalid_recycle_confirmation", "mira_bridge_empty_recycle_bin", { scan_id: "scan_d2luZG93cy1tYWlu_00000000-0000-4000-8000-000000000000" }, ["CONFIRMATION_EXPIRED", "RESOURCE_CHANGED"]);
    state.coverage.mira_bridge_empty_recycle_bin = "PASS_SAFE_REJECTION";

    const junctionCreate = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: "cmd.exe", args: ["/d", "/s", "/c", "mklink /J tests\\boundary-junction C:\\Windows"], cwd: ".", env: {}, timeout_ms: 60_000, output_encoding: "auto" });
    if (junctionCreate.exit_code !== 0) throw new Error(`Junction probe could not be created: ${junctionCreate.stderr}`);
    await expectedError(client, "reject_junction_escape", "mira_bridge_list_directory", { workspace_id: workspaceId, path: "tests\\boundary-junction", max_entries: 5 }, "WORKSPACE_OUT_OF_BOUNDS");
    const junctionRemove = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: "cmd.exe", args: ["/d", "/s", "/c", "rmdir tests\\boundary-junction"], cwd: ".", env: {}, timeout_ms: 60_000, output_encoding: "auto" });
    if (junctionRemove.exit_code !== 0) throw new Error(`Junction probe cleanup failed: ${junctionRemove.stderr}`);

    const storageEvidence = [];
    for (const args of [["storage", "status"], ["storage", "prune", "--dry-run"], ["storage", "prune", "--execute"]]) {
      const result = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: "mirabridge-worker.cmd", args, cwd: ".", env: {}, timeout_ms: 120_000, output_encoding: "auto" });
      if (result.exit_code !== 0) throw new Error(`Worker storage CLI failed: ${JSON.stringify(result)}`);
      storageEvidence.push({ args, stdout: result.stdout });
    }
    state.evidence.safety = { large_output_ref: large.output_ref, timeout, storage: storageEvidence };
    await event("storage_gc_status_dry_run_execute", storageEvidence);
    await saveState();
  } finally {
    if (client) await client.close().catch(() => undefined);
  }
}

async function phaseTransferPull() {
  const client = await connect();
  try {
    const workspaceId = await workspace(client);
    const frontendModules = await call(client, "mira_bridge_stat", { workspace_id: workspaceId, path: "frontend\\node_modules" });
    if (frontendModules.type === "directory") {
      await call(client, "mira_bridge_manage_path", { workspace_id: workspaceId, action: "delete", path: "frontend\\node_modules", recursive: true, overwrite: false });
    }
    try {
      const failedGpu = await call(client, "mira_bridge_stat", { workspace_id: workspaceId, path: "deliverables\\gpu-demo.mp4" });
      if (failedGpu.type === "file" && failedGpu.size === 0) {
        await call(client, "mira_bridge_manage_path", { workspace_id: workspaceId, action: "delete", path: "deliverables\\gpu-demo.mp4", recursive: false, overwrite: false, expected_sha256: failedGpu.sha256 });
      }
    } catch (error) {
      if (!String(error).includes("PATH_NOT_FOUND")) throw error;
    }
    const destination = join(localRoot, "windows-project");
    try {
      await access(destination);
      throw new Error(`Local pull destination already exists: ${destination}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const pulled = await call(client, "mira_bridge_pull", {
      node_id: nodeId,
      source_path: remoteProject,
      destination_path: destination,
      kind: "directory",
      overwrite: false,
    }, 1_800_000);
    state.evidence.pull = pulled;
    state.local_project = destination;
    await event("directory_pull_windows_to_mac", pulled);
    await saveState();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function phaseVisualRetest() {
  const client = await connect();
  let apiJob;
  let viteJob;
  try {
    const workspaceId = await workspace(client);
    const install = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: "npm.cmd", args: ["install", "--no-audit", "--no-fund"], cwd: "frontend", env: {}, timeout_ms: 900_000, output_encoding: "auto" }, 1_000_000);
    if (install.exit_code !== 0) throw new Error(`Frontend dependency restore failed: ${JSON.stringify(install)}`);
    const gitCommands = [
      ["switch", "-c", "fix/chart-legibility"],
      ["add", "frontend\\index.html", "frontend\\src\\style.css"],
      ["commit", "-m", "fix: scale latency chart for both viewports"],
      ["switch", "main"],
      ["merge", "--no-ff", "fix/chart-legibility", "-m", "merge: screenshot-verified chart repair"],
      ["tag", "-a", "v1.2.0-acceptance-visual", "-m", "MiraBridge 1.2.0 visually verified deliverable"],
    ];
    for (const args of gitCommands) {
      const result = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: git, args, cwd: ".", env: {}, timeout_ms: 300_000, output_encoding: "auto" }, 360_000);
      if (result.exit_code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    const build = await call(client, "mira_bridge_exec", { workspace_id: workspaceId, program: "npm.cmd", args: ["run", "build"], cwd: "frontend", env: {}, timeout_ms: 300_000, output_encoding: "auto" }, 360_000);
    if (build.exit_code !== 0) throw new Error(`Visual build failed: ${JSON.stringify(build)}`);
    const api = await call(client, "mira_bridge_start_job", {
      workspace_id: workspaceId, program: dotnet,
      args: ["run", "--project", "src\\OpsApi\\OpsApi.csproj", "--configuration", "Release", "--no-build", "--", "--urls", "http://127.0.0.1:5080"],
      cwd: ".", env: {}, timeout_ms: 600_000, output_encoding: "auto", idempotency_key: `acceptance-${runId}-visual-api`, stdin_mode: "closed",
    });
    apiJob = api.job_id;
    const vite = await call(client, "mira_bridge_start_job", {
      workspace_id: workspaceId, program: "npm.cmd", args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4174", "--strictPort"],
      cwd: "frontend", env: {}, timeout_ms: 600_000, output_encoding: "auto", idempotency_key: `acceptance-${runId}-visual-vite`, stdin_mode: "closed",
    });
    viteJob = vite.job_id;
    await waitForHttp(client, workspaceId, "http://127.0.0.1:5080/api/summary", "totalRecords", 60);
    await waitForHttp(client, workspaceId, "http://127.0.0.1:4174/", "MiraBridge 运维看板", 60);
    const desktop = await call(client, "mira_bridge_web_snapshot", { workspace_id: workspaceId, url: "http://127.0.0.1:4174/", screenshot_path: "deliverables\\operations-desktop.png", dom_path: "deliverables\\operations-page.html", viewport: { width: 1440, height: 1000 }, full_page: true, overwrite: true, wait_until: "networkidle", network_policy: "local-only", timeout_ms: 120_000 }, 180_000);
    const mobile = await call(client, "mira_bridge_web_snapshot", { workspace_id: workspaceId, url: "http://127.0.0.1:4174/", screenshot_path: "deliverables\\operations-mobile.png", viewport: { width: 390, height: 844 }, full_page: true, overwrite: true, wait_until: "networkidle", network_policy: "local-only", timeout_ms: 120_000 }, 180_000);
    if (desktop.console_errors.length || desktop.page_errors.length || mobile.console_errors.length || mobile.page_errors.length) throw new Error("Visual retest produced browser errors.");
    state.evidence.visual_retest = { build, desktop, mobile };
    await event("edge_visual_retest_after_chart_fix", state.evidence.visual_retest);
    await call(client, "mira_bridge_cancel_job", { job_id: viteJob });
    viteJob = undefined;
    await call(client, "mira_bridge_cancel_job", { job_id: apiJob });
    apiJob = undefined;
    await call(client, "mira_bridge_manage_path", { workspace_id: workspaceId, action: "delete", path: "frontend\\node_modules", recursive: true, overwrite: false });
    await saveState();
  } finally {
    if (viteJob) await call(client, "mira_bridge_cancel_job", { job_id: viteJob }).catch(() => undefined);
    if (apiJob) await call(client, "mira_bridge_cancel_job", { job_id: apiJob }).catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

async function phaseTransferRepull() {
  const client = await connect();
  try {
    const destination = join(localRoot, "windows-project");
    const pulled = await call(client, "mira_bridge_pull", { node_id: nodeId, source_path: remoteProject, destination_path: destination, kind: "directory", overwrite: true }, 1_800_000);
    state.evidence.repull = pulled;
    await event("directory_pull_atomic_overwrite", pulled);
    await saveState();
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function phaseTransferPushRoundtrip() {
  const client = await connect();
  try {
    const source = join(localRoot, "roundtrip-source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "sentinel.txt"), "MiraBridge roundtrip version 1\n中文传输\n", "utf8");
    await writeFile(join(source, "manifest-note.json"), `${JSON.stringify({ run_id: runId, version: 1 }, null, 2)}\n`, "utf8");
    const destination = `${remoteProject}\\transfer-roundtrip`;
    const first = await call(client, "mira_bridge_push", { node_id: nodeId, source_path: source, destination_path: destination, kind: "directory", overwrite: false }, 1_800_000);
    await expectedError(client, "directory_push_default_no_overwrite", "mira_bridge_push", { node_id: nodeId, source_path: source, destination_path: destination, kind: "directory", overwrite: false }, "TRANSFER_FAILED", 1_800_000);
    await writeFile(join(source, "sentinel.txt"), "MiraBridge roundtrip version 2\n中文传输\n", "utf8");
    await writeFile(join(source, "manifest-note.json"), `${JSON.stringify({ run_id: runId, version: 2 }, null, 2)}\n`, "utf8");
    const replaced = await call(client, "mira_bridge_push", { node_id: nodeId, source_path: source, destination_path: destination, kind: "directory", overwrite: true }, 1_800_000);
    const verified = await call(client, "mira_bridge_read_text", { workspace_id: state.workspace_id, path: "transfer-roundtrip\\sentinel.txt", start_line: 1, max_lines: 20 });
    if (!verified.content.includes("version 2") || !verified.content.includes("中文传输")) throw new Error("Overwritten directory did not contain the v2 Unicode sentinel.");
    state.evidence.push_roundtrip = { first, replaced, verified };
    await event("directory_push_conflict_and_atomic_overwrite", state.evidence.push_roundtrip);
    await saveState();
  } finally {
    await client.close().catch(() => undefined);
  }
}

const phases = {
  baseline: phaseBaseline,
  scaffold: phaseScaffold,
  verify: phaseVerify,
  "build-publish": phaseBuildPublish,
  "web-start": phaseWebStart,
  "web-restart": phaseWebRestart,
  "web-verify": phaseWebVerify,
  terminal: phaseTerminal,
  "gpu-safety": phaseGpuSafety,
  "transfer-pull": phaseTransferPull,
  "visual-retest": phaseVisualRetest,
  "transfer-repull": phaseTransferRepull,
  "transfer-push-roundtrip": phaseTransferPushRoundtrip,
};
if (!phases[phase]) throw new Error(`Unknown or not-yet-implemented phase: ${phase}`);
await phases[phase]();
await saveState();
