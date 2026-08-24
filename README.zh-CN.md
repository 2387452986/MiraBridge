<p align="center">
  <img src="./plugins/mira-bridge/assets/mirabridge-logo.png" width="168" alt="MiraBridge 图标" />
</p>

<h1 align="center">MiraBridge</h1>

<p align="center"><strong>让 Mac 上思考的 Codex，把 Windows 电脑当作原生工具执行环境。</strong></p>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <a href="https://github.com/2387452986/MiraBridge/releases/tag/v2.0.0-rc.6">下载 2.0.0-rc.6</a>
  · <a href="#一次对话完成安装">安装</a>
  · <a href="./docs/TEST_REPORT.md">真实测试证据</a>
  · <a href="./SECURITY.md">安全说明</a>
</p>

---

MiraBridge 把 Agent、LLM、任务规划、审批和完成判断留在 macOS。Windows Worker 不包含模型或自主循环；它只执行明确的文件、进程、终端、浏览器、传输和维护操作，再把结构化证据返回 Mac。

## 不是远程命令 Demo，而是完整工作闭环

### 交付一个完整 Windows 项目

> “检查 Windows 上的这个 .NET 项目，修复测试，完成 Release 打包，把安装产物传回 Mac。”

Codex 可以检查现有 Windows 工作区，搜索和读取源码，用 SHA-256 保护的精确编辑修复问题，运行测试并分析失败，构建原生安装包，核对文件与哈希，最后只把成品拉回 Mac。

### 在 Windows 开发并真实验收网页

> “在 Windows 上制作一个 Vite 网页，启动服务，用 Edge 检查桌面和移动端效果，修完控制台错误后把源码和构建目录传回来。”

MiraBridge 可以安装依赖，把开发服务器作为持久 Job 运行，用 Windows `curl.exe` 验证 HTTP，通过隔离的 Edge 生成桌面和移动截图，返回控制台与页面错误，完成生产构建并传回整个项目目录。

### 用 Windows GPU 执行媒体与计算任务

> “检测这台 Windows 的显卡能力，用可用编码器渲染视频；断线也要继续，结束后验证分辨率、帧率和时长。”

节点会真实报告 NVIDIA、AMD、Intel、虚拟显卡或纯 CPU 环境，而不是假设只有某一种显卡。Codex 可以先探测真实编码链路，再启动 FFmpeg 或其他渲染 Job；即使 SSH/MCP 暂时断开，也能重新找回任务、分页读取日志、验证产物并拉回 macOS。

### 真实案例：安装 MiniMax H3 并完成 Windows 原生渲染

> “读取我的 Windows 配置，按质量优先安装完整版 MiniMax H3，生成带声音的视频；遇到问题要查清原因，不要降质量绕过，最后把验收后的成片传回 Mac。”

这项任务已在真实 Windows 11 x64 电脑上完成：Ryzen 7 9700X、32 GiB
内存、RTX 5070 Ti 16 GiB。完整证据记录在[测试报告](./docs/TEST_REPORT.md)，
不是 Mock，也不是把 Mac 生成结果冒充成 Windows 执行。

1. Mac 上的 Codex 先调用 `describe_node`，读取真实 GPU、CUDA、内存、
   架构、磁盘和 Windows 代码页，并取得操作者对 MiniMax H3 Community
   License 与非排除地区的明确确认。
2. 保留 C 盘现有的系统管理页面文件，在 D 盘新增 64 GiB 页面文件，
   重启并核对生效状态。页面文件用于容量准备，不被拿来掩盖运行时缺陷。
3. 在 Windows 建立隔离目录 `D:\MiraBridgeRoot\AI\MiniMax-H3`。模型从
   国内 ModelScope 源下载，同时用对应 Hugging Face LFS 对象的 SHA-256
   校验完整性，避免消耗代理流量又不牺牲可信度。
4. 安装固定的 ComfyUI 0.33.1 Python 运行环境、完整
   `minimax_h3_fl2va_int8_convrot`、Qwen3-VL 文本编码器和官方音视频 VAE。
   四个模型文件共 55,539,098,189 字节；不使用 Turbo LoRA、
   SageAttention 或 `--fast` 质量捷径。
5. 验收参数为 1344×768、124 帧、24 fps、20 个采样步骤、非 Turbo
   工作流、DynamicVRAM 和原生 `convrot_w4a4`。
6. ComfyUI 通过标准持久 MiraBridge Job 运行，并使用
   `output_encoding=auto`。Agent 保留 Job ID、分页读取日志、查看 GPU
   遥测，而不是把数十分钟任务绑在一条脆弱的 SSH 命令上。
7. 首个进度条字符曾让 Job 误报 `lost`。隔离运行证明 ComfyUI 原生进程
   正常，真正责任方是 MiraBridge 对 CP936 输出执行 fatal UTF-8 解码后，
   没有立即接住 Promise 异常。修复的是共享输出生命周期，然后原参数
   重跑；没有换内核、降低分辨率、减少步数或去掉声音。
8. 修复后的标准 Job 完成 20/20。`ffprobe` 验证成片为 5.167 秒、
   1344×768、24 fps、H.264，并带 AAC 双声道；1,940,180 字节文件传回
   Mac 后 SHA-256 完全一致。

自动验收使用固定、无界面的 ComfyUI 运行时，以保证可复现。
**Comfy Desktop 是另外安装的用户界面启动器**，不是 MiraBridge 持久 Job
链路的替代品。它可以接管现有 ComfyUI 或配置共享模型路径，但 MiraBridge
不会静默改写已验证的生产环境；不同显卡和内存配置仍必须以真实节点探测为准。

参考：[MiniMax H3 模型与许可](https://huggingface.co/MiniMaxAI/MiniMax-H3)、
[ComfyUI 官方 H3 工作流](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_t2v.json)、
[Windows Comfy Desktop](https://docs.comfy.org/installation/desktop/windows)。

### 使用 Windows 专属工程工具链

> “在 Windows 上运行 PowerShell、交互式 CLI 和打包工具，处理中文输出，失败后继续排查。”

结构化 argv 执行不会翻译 Bash。独立 PowerShell、UTF-8/Windows 代码页识别、持久 stdin 和 ConPTY 终端快照可以支持普通 CLI、REPL、交互提示、控制键、窗口尺寸变化和全屏 TUI。

### 安全地巡检和维护真实电脑

> “告诉我 Windows 桌面有哪些文件，扫描 D 盘和回收站里可以清理的内容，先给候选，确认后再精确删除。”

Desktop 能力使用真实 Windows Known Folder。回收站和磁盘清理先扫描、返回大小与证据，删除前要求即时凭证或明确目标，完成后重新扫描验证。未知个人文件不会因为体积大就被当作垃圾。

## Agent 可以操作什么

- 文件与项目：列出、状态、分页读取、搜索、Glob、创建、精确编辑、复制、移动和受保护删除。
- 原生执行：结构化 `.exe`、`.cmd`、`.bat`、PowerShell、超时、完整进程树取消和中文输出。
- 持久任务：可找回 Job、幂等启动、日志分页、断线恢复、stdin 和 ConPTY 终端快照。
- 文件传输：带 SHA-256 和原子替换的单文件或完整目录 push/pull，不做后台同步。
- 网页验收：本地 HTTP 验证和隔离 Edge 桌面/移动截图，不使用浏览器登录状态。
- 电脑能力：真实架构、CPU、内存、全部显示适配器、Desktop 授权、回收站扫描、存储保留与配额。

Codex 插件公开且只公开 28 个 `mira_bridge_*` MCP 工具。普通 Mac 本地任务仍在 Mac 上执行，不会连接 Windows。

## 一次对话完成安装

当前版本是未签名的 Release Candidate。Windows SmartScreen 可能显示“未知发布者”。请只从本仓库 Release 下载，并核对发布的 SHA-256 清单。稳定版 `2.0.0` 仍以 Windows 代码签名、真实 Windows 10 和 ARM64 GUI 验收为发布门禁。

在 Mac 上告诉 Codex：

> 请从 `https://github.com/2387452986/MiraBridge` 安装 `v2.0.0-rc.6`，完成 doctor 并生成 Windows 配对码。

Codex 会校验固定 tag 和 release manifest，安装受管 Node 24、MCP Server 与 CLI，不依赖 Homebrew，并注册 `mira-bridge@mirabridge`。

在 Windows 上从同一 Release 下载对应的 x64 或 ARM64 Setup 并运行。打开 **连接 Mac** 页面：

1. 点击**复制整条命令**，把 `~/.local/bin/mirabridge pair create` 交给 Mac 上的 Codex。
2. 把 Mac 生成的请求码粘贴进 Windows，点击**授权并生成响应**。
3. 点击**复制完成命令**，把整条 `~/.local/bin/mirabridge pair accept …` 命令交回 Mac 上的 Codex。

第 2 步已经完成授权。正常流程不需要密码、私钥复制、TOML 编辑、手工修改 SSH 文件或手输主机指纹。

<details>
<summary>明确的 Mac 安装命令</summary>

```sh
git clone --branch v2.0.0-rc.6 --depth 1 https://github.com/2387452986/MiraBridge.git
cd MiraBridge
./plugins/mira-bridge/scripts/install-mac.sh
~/.local/bin/mirabridge doctor
~/.local/bin/mirabridge pair create
```

</details>

## 架构与信任边界

```text
Mac                                                    Windows
┌──────────────────────────────┐                       ┌─────────────────────────┐
│ Codex / Agent                │                       │ MiraBridge for Windows  │
│ 推理、规划、审批、完成判断   │                       │ 安装、状态、权限         │
└──────────────┬───────────────┘                       └────────────┬────────────┘
               │ MCP                                                │ Worker CLI
┌──────────────▼───────────────┐       固定指纹 SSH / stdio          ▼
│ mirabridge-mcp               ├──────────────────────────────► 确定性 Worker
│ 节点配置与主机信任           │◄────────────────────────────── 结构化执行证据
└──────────────────────────────┘

reasoning_host = Mac
tool_host      = Windows
```

MiraBridge 不是远程桌面、Windows Agent、云端中继、Bash 翻译器或双向同步系统。它不开放自定义命令端口，也不在 Windows 保存 LLM 对话或用户目标。

## 产品默认值

- 默认使用 Windows Administrator；Worker 路径边界与 Mac 侧审批仍然生效。
- `%USERPROFILE%\MiraBridge` 和 Desktop 权限可在 Windows 应用中配置。
- 清空回收站需要即时且内容未变化的扫描凭证。
- 网页快照默认只允许 loopback/local，不使用浏览器 Cookie 或扩展。
- OpenSSH 使用公钥、固定主机指纹和 `LocalSubnet` 防火墙规则。
- 普通输出保留 7 天，Job 日志 14 天，元数据与审计 90 天；总配额 10 GiB，保留 2 GiB 可用空间。
- 提供 x64 和 ARM64 安装包；Node 24 不支持 32 位 x86 Windows。

## 文档

- [在 macOS 安装](./docs/INSTALL_MAC.md)
- [在 Windows 安装](./docs/INSTALL_WINDOWS.md)
- [配对与 SSH 信任](./docs/PAIRING.md)
- [从 1.x 迁移与回滚](./docs/MIGRATION_1X.md)
- [支持矩阵](./SUPPORT_MATRIX.md)
- [安全策略](./SECURITY.md)
- [真实测试报告](./docs/TEST_REPORT.md)

## 许可证

MiraBridge 使用 [MIT License](./LICENSE)，第三方依赖见 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES.md)。
