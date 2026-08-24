import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const nodeId = process.env.MIRABRIDGE_E2E_NODE ?? "windows-main";
const configPath = process.env.MIRABRIDGE_CONFIG;
const expectedWorkerVersion = process.env.MIRABRIDGE_E2E_EXPECTED_WORKER ?? "2.0.0-rc.6";
const projectName = process.env.MIRABRIDGE_E2E_PROJECT ?? "MiraBridge-Release-Acceptance-2.0.0-rc.6";
const localDestination = process.env.MIRABRIDGE_E2E_PULL_DESTINATION
  ?? resolve("artifacts", "real-lan", projectName);
const remoteParent = "D:\\MiraBridgeRoot";
const remoteProject = `${remoteParent}\\${projectName}`;
const emptyRecycleBin = process.env.MIRABRIDGE_E2E_EMPTY_RECYCLE_BIN === "1";
const resumeExistingProject = process.env.MIRABRIDGE_E2E_RESUME === "1";

if (!configPath) throw new Error("MIRABRIDGE_CONFIG must identify the real Mac node configuration.");

function event(step, value) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), step, value })}\n`);
}

function publicResult(response) {
  const value = response.structuredContent;
  if (!value || typeof value !== "object" || typeof value.ok !== "boolean") {
    throw new Error(`MCP response did not contain MiraBridge structuredContent: ${JSON.stringify(response.content)}`);
  }
  return value;
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
  const client = new Client({ name: "mirabridge-real-lan-e2e", version: "2.0.0-rc.6" });
  await client.connect(transport);
  return client;
}

async function call(client, name, args, timeout = 120_000) {
  const response = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout, resetTimeoutOnProgress: true, maxTotalTimeout: timeout },
  );
  const result = publicResult(response);
  if (!result.ok) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`);
  return result.result;
}

async function expectedError(client, label, name, args, code) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const result = publicResult(response);
  if (result.ok || result.error?.code !== code) {
    throw new Error(`${label} expected ${code}, received ${JSON.stringify(result)}`);
  }
  event(label, { code: result.error.code, message: result.error.message });
}

async function waitForJob(client, jobId, terminal = new Set(["exited", "failed_to_start", "cancelled", "timed_out", "lost"])) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await call(client, "mira_bridge_wait_job", { job_id: jobId, timeout_ms: 10_000 }, 30_000);
    if (terminal.has(current.executor_status)) return current;
  }
  throw new Error(`Job ${jobId} did not reach a terminal state.`);
}

async function waitForHttp(client, workspaceId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await call(client, "mira_bridge_exec", {
      workspace_id: workspaceId,
      program: "curl.exe",
      args: ["--fail", "--silent", "--show-error", "--max-time", "3", "http://127.0.0.1:4173/"],
      cwd: ".",
      env: {},
      timeout_ms: 10_000,
    }, 30_000);
    if (result.exit_code === 0 && String(result.stdout).includes("MiraBridge Windows Studio")) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error("Vite did not become ready on Windows loopback port 4173.");
}

const packageJson = `${JSON.stringify({
  name: "mirabridge-windows-studio",
  private: true,
  version: "2.0.0-rc.6",
  type: "module",
  scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
  devDependencies: { vite: "7.1.3" },
}, null, 2)}\n`;

const indexHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="MiraBridge Windows runtime acceptance experience" />
    <title>MiraBridge Windows Studio</title>
  </head>
  <body>
    <main>
      <nav><span class="brand"><i></i>MiraBridge</span><span class="runtime">WINDOWS NATIVE RUNTIME</span></nav>
      <section class="hero">
        <p class="eyebrow">MAC REASONS · WINDOWS EXECUTES</p>
        <h1>把 Windows 变成<br /><em>Agent 的原生工具空间。</em></h1>
        <p class="lede">命令、文件、持久任务与浏览器验收，经由一条可审计的 SSH 链路完成。Windows 不思考，只提供确定、真实的执行结果。</p>
        <div class="actions"><button id="pulse">验证运行时</button><a href="#proof">查看闭环证据 ↓</a></div>
      </section>
      <section class="signal" aria-label="Runtime signal"><div class="orb"><span></span></div><div><small>NODE STATUS</small><strong id="status">CONNECTED</strong><p id="clock">同步 Windows 时间…</p></div></section>
      <section class="proof" id="proof">
        <article><b>01</b><h2>原生执行</h2><p>结构化 argv、PowerShell 与 UTF-8 输出，不做 Bash 翻译。</p></article>
        <article><b>02</b><h2>持久任务</h2><p>SSH 断开后仍可凭 Job ID 找回状态、日志与真实退出码。</p></article>
        <article><b>03</b><h2>可验证产物</h2><p>Edge 真机渲染、控制台检查、SHA-256 目录回传形成闭环。</p></article>
      </section>
      <footer><span>reasoning_host = Mac</span><span>tool_host = Windows</span></footer>
    </main>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`;

const mainJs = `import "./styles.css";
const clock = document.querySelector("#clock");
const button = document.querySelector("#pulse");
const status = document.querySelector("#status");
const renderClock = () => { clock.textContent = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date()); };
renderClock();
setInterval(renderClock, 1000);
button.addEventListener("click", () => {
  status.textContent = "VERIFIED";
  document.body.classList.remove("verified");
  requestAnimationFrame(() => document.body.classList.add("verified"));
});
`;

const styles = `:root{font-family:Inter,"Segoe UI",sans-serif;color:#eaf1ff;background:#07111f;font-synthesis:none}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-width:320px;background:radial-gradient(circle at 77% 16%,#123e70 0,transparent 34%),linear-gradient(145deg,#07111f 0%,#091827 55%,#06101c 100%)}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.17;background-image:linear-gradient(#7db9ff22 1px,transparent 1px),linear-gradient(90deg,#7db9ff22 1px,transparent 1px);background-size:56px 56px}main{width:min(1180px,calc(100% - 48px));margin:auto;position:relative}nav{height:108px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #a9cbff2e}.brand{font-weight:760;letter-spacing:-.02em;font-size:21px;display:flex;gap:12px;align-items:center}.brand i{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#77d1ff,#326bff);box-shadow:0 0 28px #4c9dff}.runtime,.eyebrow,footer{font:600 11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.18em;color:#86b9f5}.hero{padding:100px 0 70px;max-width:900px}.eyebrow{margin:0 0 26px}.hero h1{font-size:clamp(48px,7vw,92px);line-height:.98;letter-spacing:-.065em;margin:0;font-weight:650}.hero h1 em{font-style:normal;color:#78caff}.lede{max-width:710px;color:#aebed2;font-size:19px;line-height:1.75;margin:36px 0}.actions{display:flex;align-items:center;gap:28px}.actions button{border:0;border-radius:999px;padding:15px 24px;background:#eaf4ff;color:#081523;font-size:15px;font-weight:750;cursor:pointer}.actions a{color:#a9cfff;text-decoration:none;font-weight:600}.signal{display:flex;align-items:center;gap:24px;padding:28px;border:1px solid #7ab9ff35;background:#0c1d31cc;backdrop-filter:blur(14px);border-radius:22px}.orb{width:66px;height:66px;border-radius:50%;display:grid;place-items:center;border:1px solid #79c8ff55}.orb span{width:18px;height:18px;border-radius:50%;background:#66e3ad;box-shadow:0 0 28px #55eca8;animation:breathe 2.4s ease-in-out infinite}.signal small{display:block;color:#7da8d8;letter-spacing:.15em}.signal strong{font-size:26px;letter-spacing:.08em}.signal p{margin:4px 0 0;color:#8fa5bd}.proof{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:86px 0}.proof article{min-height:250px;padding:30px;border-top:1px solid #85bdff66;background:linear-gradient(160deg,#10253cbd,#09162580)}.proof b{color:#72bfff;font:600 13px ui-monospace,monospace}.proof h2{font-size:27px;margin:50px 0 16px}.proof p{color:#9db0c7;line-height:1.7;margin:0}footer{display:flex;justify-content:space-between;padding:30px 0 48px;border-top:1px solid #a9cbff2e}.verified .signal{animation:flash .8s ease}@keyframes breathe{50%{transform:scale(1.3);opacity:.7}}@keyframes flash{50%{border-color:#65e5ad;box-shadow:0 0 45px #52e8a633}}@media(max-width:720px){main{width:min(100% - 28px,1180px)}nav{height:82px}.runtime{display:none}.hero{padding:72px 0 52px}.hero h1{font-size:48px}.lede{font-size:16px}.actions{align-items:flex-start;flex-direction:column}.proof{grid-template-columns:1fr;padding:58px 0}.proof article{min-height:auto}.proof h2{margin-top:30px}footer{flex-direction:column;gap:12px}}
`;

let client = await connect();
let devJobId;
try {
  const tools = await client.listTools();
  if (tools.tools.length !== 28) throw new Error(`Expected 28 MCP tools, received ${tools.tools.length}.`);
  event("mcp_tools", { count: tools.tools.length, names: tools.tools.map((tool) => tool.name) });

  const node = await call(client, "mira_bridge_describe_node", { node_id: nodeId });
  if (node.protocol_version !== "2.0" || node.worker_version !== expectedWorkerVersion) {
    throw new Error(`Real node did not negotiate MiraBridge ${expectedWorkerVersion} / RPC 2.0.`);
  }
  event("describe_node", node);

  const desktop = await call(client, "mira_bridge_open_workspace", {
    node_id: nodeId,
    path: String(node.known_folders.desktop.path),
    mode: "read-only",
  });
  const desktopEntries = await call(client, "mira_bridge_list_directory", {
    workspace_id: desktop.workspace_id, path: ".", max_entries: 1000,
  });
  event("desktop_read_only", { canonical_path: desktop.canonical_path, entries: desktopEntries.entries });

  const parent = await call(client, "mira_bridge_open_workspace", { node_id: nodeId, path: remoteParent, mode: "read-write" });
  const parentEntries = await call(client, "mira_bridge_list_directory", { workspace_id: parent.workspace_id, path: ".", max_entries: 1000 });
  const projectExists = parentEntries.entries.some((entry) => String(entry.name).toLocaleLowerCase() === projectName.toLocaleLowerCase());
  let workspace;
  if (projectExists) {
    if (!resumeExistingProject) throw new Error(`Remote acceptance directory already exists; refusing to overwrite it: ${remoteProject}`);
    workspace = await call(client, "mira_bridge_open_workspace", { node_id: nodeId, path: remoteProject, mode: "read-write" });
    event("resume_existing_project", { canonical_path: workspace.canonical_path });
  } else {
    await call(client, "mira_bridge_manage_path", { workspace_id: parent.workspace_id, action: "mkdir", path: projectName, recursive: false, overwrite: false });
    workspace = await call(client, "mira_bridge_open_workspace", { node_id: nodeId, path: remoteProject, mode: "read-write" });

  await call(client, "mira_bridge_write_text", { workspace_id: workspace.workspace_id, path: "package.json", content: packageJson, create_parents: false });
  await call(client, "mira_bridge_write_text", { workspace_id: workspace.workspace_id, path: "index.html", content: indexHtml, create_parents: false });
  await call(client, "mira_bridge_write_text", { workspace_id: workspace.workspace_id, path: "src\\main.js", content: mainJs, create_parents: true });
  await call(client, "mira_bridge_write_text", { workspace_id: workspace.workspace_id, path: "src\\styles.css", content: styles, create_parents: false });
  const readIndex = await call(client, "mira_bridge_read_text", { workspace_id: workspace.workspace_id, path: "index.html", start_line: 1, max_lines: 500 });
  const edited = await call(client, "mira_bridge_edit_text", {
    workspace_id: workspace.workspace_id,
    path: "index.html",
    expected_sha256: readIndex.sha256,
    edits: [{ old_text: "可审计的 SSH 链路", new_text: "可审计、可恢复的 SSH 链路", replace_all: false }],
  });
  event("exact_edit", edited);

  await call(client, "mira_bridge_manage_path", { workspace_id: workspace.workspace_id, action: "mkdir", path: "proof", recursive: false, overwrite: false });
  await call(client, "mira_bridge_write_text", { workspace_id: workspace.workspace_id, path: "proof\\源.txt", content: "MiraBridge 中文路径闭环\n", create_parents: false });
  await call(client, "mira_bridge_manage_path", { workspace_id: workspace.workspace_id, action: "copy", path: "proof\\源.txt", destination_path: "proof\\副本.txt", recursive: false, overwrite: false });
  await call(client, "mira_bridge_manage_path", { workspace_id: workspace.workspace_id, action: "move", path: "proof\\副本.txt", destination_path: "proof\\已移动.txt", recursive: false, overwrite: false });
  await call(client, "mira_bridge_manage_path", { workspace_id: workspace.workspace_id, action: "delete", path: "proof\\已移动.txt", recursive: false, overwrite: false });

  await expectedError(client, "reject_traversal", "mira_bridge_list_directory", { workspace_id: workspace.workspace_id, path: "..\\..\\Windows\\System32", max_entries: 5 }, "WORKSPACE_OUT_OF_BOUNDS");
  await expectedError(client, "reject_unc", "mira_bridge_stat", { workspace_id: workspace.workspace_id, path: "\\\\localhost\\C$\\Windows" }, "WORKSPACE_OUT_OF_BOUNDS");
  await expectedError(client, "reject_ads", "mira_bridge_stat", { workspace_id: workspace.workspace_id, path: "index.html:secret" }, "WORKSPACE_OUT_OF_BOUNDS");
  await expectedError(client, "reject_root_delete", "mira_bridge_manage_path", { workspace_id: workspace.workspace_id, action: "delete", path: ".", recursive: true, overwrite: false }, "PERMISSION_DENIED");

  const junctionCreate = await call(client, "mira_bridge_exec", {
    workspace_id: workspace.workspace_id,
    program: "cmd.exe",
    args: ["/d", "/s", "/c", "mklink /J boundary-junction C:\\Windows"],
    cwd: ".", env: {}, timeout_ms: 30_000,
  });
  if (junctionCreate.exit_code !== 0) throw new Error(`Could not create isolated Junction probe: ${junctionCreate.stderr}`);
  await expectedError(client, "reject_junction", "mira_bridge_list_directory", { workspace_id: workspace.workspace_id, path: "boundary-junction", max_entries: 5 }, "WORKSPACE_OUT_OF_BOUNDS");
  const junctionRemove = await call(client, "mira_bridge_exec", {
    workspace_id: workspace.workspace_id,
    program: "cmd.exe",
    args: ["/d", "/s", "/c", "rmdir boundary-junction"],
    cwd: ".", env: {}, timeout_ms: 30_000,
  });
  if (junctionRemove.exit_code !== 0) throw new Error(`Could not remove isolated Junction probe: ${junctionRemove.stderr}`);

  const install = await call(client, "mira_bridge_exec", {
    workspace_id: workspace.workspace_id,
    program: "npm.cmd",
    args: ["install", "--no-audit", "--no-fund"],
    cwd: ".", env: {}, timeout_ms: 900_000,
  }, 1_000_000);
  if (install.exit_code !== 0) throw new Error(`npm install failed: ${install.stderr}`);
  event("vite_install", { exit_code: install.exit_code, duration_ms: install.duration_ms, stdout_tail: String(install.stdout_tail ?? install.stdout).slice(-2000) });

  const devJob = await call(client, "mira_bridge_start_job", {
    workspace_id: workspace.workspace_id,
    program: "npm.cmd",
    args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
    cwd: ".", env: {}, timeout_ms: 1_800_000,
    idempotency_key: `mirabridge-${expectedWorkerVersion}-vite-dev`,
  });
  devJobId = devJob.job_id;
  const curl = await waitForHttp(client, workspace.workspace_id);
  event("windows_curl", { exit_code: curl.exit_code, bytes: curl.stdout_bytes, title_found: String(curl.stdout).includes("MiraBridge Windows Studio") });

  const desktopShot = await call(client, "mira_bridge_web_snapshot", {
    workspace_id: workspace.workspace_id,
    url: "http://127.0.0.1:4173/",
    screenshot_path: "acceptance\\desktop.png",
    dom_path: "acceptance\\page.html",
    viewport: { width: 1440, height: 900 },
    full_page: true, overwrite: false, wait_until: "networkidle", network_policy: "local-only", timeout_ms: 60_000,
  }, 120_000);
  const mobileShot = await call(client, "mira_bridge_web_snapshot", {
    workspace_id: workspace.workspace_id,
    url: "http://127.0.0.1:4173/",
    screenshot_path: "acceptance\\mobile.png",
    viewport: { width: 390, height: 844 },
    full_page: true, overwrite: false, wait_until: "networkidle", network_policy: "local-only", timeout_ms: 60_000,
  }, 120_000);
  for (const snapshot of [desktopShot, mobileShot]) {
    if (snapshot.status_code !== 200 || snapshot.console_errors.length || snapshot.page_errors.length) {
      throw new Error(`Edge rendering acceptance failed: ${JSON.stringify(snapshot)}`);
    }
  }
  event("edge_snapshots", { desktop: desktopShot, mobile: mobileShot });

  const build = await call(client, "mira_bridge_exec", {
    workspace_id: workspace.workspace_id,
    program: "npm.cmd", args: ["run", "build"], cwd: ".", env: {}, timeout_ms: 300_000,
  }, 360_000);
  if (build.exit_code !== 0) throw new Error(`Vite build failed: ${build.stderr}`);
  const dist = await call(client, "mira_bridge_list_directory", { workspace_id: workspace.workspace_id, path: "dist", max_entries: 1000 });
  event("vite_build", { exit_code: build.exit_code, duration_ms: build.duration_ms, dist_entries: dist.entries });

  await call(client, "mira_bridge_cancel_job", { job_id: devJobId });
  devJobId = undefined;
  await call(client, "mira_bridge_manage_path", { workspace_id: workspace.workspace_id, action: "delete", path: "node_modules", recursive: true, overwrite: false });
  }

  try {
    await access(localDestination);
    if (!resumeExistingProject) throw new Error(`Local acceptance destination already exists; refusing to overwrite it: ${localDestination}`);
    event("resume_existing_pull", { destination_path: localDestination });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await access(localDestination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const pulled = await call(client, "mira_bridge_pull", {
      node_id: nodeId, source_path: remoteProject, destination_path: localDestination, kind: "directory", overwrite: false,
    }, 600_000);
    event("directory_pull", pulled);
  }

  const durable = await call(client, "mira_bridge_start_job", {
    workspace_id: workspace.workspace_id,
    program: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ProgressPreference='SilentlyContinue'; 1..7 | ForEach-Object { Write-Output ('durable-tick-' + $_); Start-Sleep -Seconds 5 }; Write-Output 'durable-finished'"],
    cwd: ".", env: {}, timeout_ms: 120_000,
    idempotency_key: `mirabridge-${expectedWorkerVersion}-disconnect-${Date.now()}`,
  });
  const durableJobId = durable.job_id;
  await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
  await client.close();
  client = undefined;
  const localProbe = await stat(resolve("package.json"));
  event("mac_local_during_windows_job", { package_json_bytes: localProbe.size, ssh_session_closed: true });

  client = await connect();
  const jobs = await call(client, "mira_bridge_list_jobs", { node_id: nodeId, max_results: 500 });
  if (!jobs.jobs.some((job) => job.job_id === durableJobId)) throw new Error(`list_jobs did not rediscover ${durableJobId}.`);
  event("job_rediscovered", { job_id: durableJobId, listed_status: jobs.jobs.find((job) => job.job_id === durableJobId)?.executor_status });
  const terminal = await waitForJob(client, durableJobId);
  const logTail = await call(client, "mira_bridge_read_job_logs", { job_id: durableJobId, stream: "stdout", offset: 0, max_bytes: 65_536, tail_lines: 20 });
  if (terminal.executor_status !== "exited" || terminal.exit_code !== 0 || !String(logTail.text).includes("durable-finished")) {
    throw new Error(`Durable Job recovery failed: ${JSON.stringify({ terminal, logTail })}`);
  }
  event("durable_job", { job_id: durableJobId, terminal, log_tail: logTail.text });

  const recycleScan = await call(client, "mira_bridge_scan_recycle_bin", { node_id: nodeId, drives: ["C", "D"], max_items: 20 }, 600_000);
  event("recycle_scan", recycleScan);
  if (emptyRecycleBin) {
    const cleared = await call(client, "mira_bridge_empty_recycle_bin", { scan_id: recycleScan.scan_id }, 900_000);
    event("recycle_empty", cleared);
  } else {
    event("recycle_empty_skipped", { reason: "Set MIRABRIDGE_E2E_EMPTY_RECYCLE_BIN=1 only with explicit user authorization." });
  }

  event("acceptance_complete", { node_id: nodeId, remote_project: remoteProject, local_destination: localDestination, recycle_bin_emptied: emptyRecycleBin });
} finally {
  if (client && devJobId) await call(client, "mira_bridge_cancel_job", { job_id: devJobId }).catch(() => undefined);
  if (client) await client.close().catch(() => undefined);
}
