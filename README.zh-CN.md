<p align="center">
  <img src="./plugins/mira-bridge/assets/mirabridge-logo.png" width="168" alt="MiraBridge 图标" />
</p>

<h1 align="center">MiraBridge</h1>

<p align="center"><strong>让 Mac 上的 Codex 使用你的 Windows 电脑——Windows 无需代理、无需安装 Codex、无需登录 OpenAI 账号。</strong></p>

<p align="center">Codex 留在 Mac，Windows 只负责执行并把结果传回来。</p>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <a href="https://github.com/2387452986/MiraBridge/releases/tag/v2.0.0-rc.6">下载 2.0.0-rc.6</a>
  · <a href="#一次对话完成安装">安装</a>
  · <a href="./docs/TEST_REPORT.md">真实测试证据</a>
  · <a href="./SECURITY.md">安全说明</a>
</p>

---

## Mac 负责思考，Windows 负责动手

你可能已经在 Mac 上正常使用 Codex，但真正需要的显卡、项目、编译器、打包工具或文件却在 Windows 电脑里。

MiraBridge 把两台电脑连起来，同时不把 Windows 变成第二台 Codex 电脑：

```text
你 → Mac 上的 Codex → 已批准的操作 → Windows 上的 MiraBridge Worker
你 ← 回答与证据 ← 日志、文件、截图和最终产物
```

Agent、账号、对话、规划、审批和完成判断都留在 Mac。Windows 只运行一个不含模型的 Worker，执行明确操作并返回证据；它不运行 Codex、第二个 Agent 或 LLM。

## 为什么使用 MiraBridge？

当远端电脑可以直接运行 Codex 时，Codex 自带的 SSH 连接很方便；但其[官方设置](https://learn.chatgpt.com/docs/remote-connections)要求在远端安装并认证 Codex。

MiraBridge 服务的是另一种场景：**Windows 能被 Codex 使用，但 Windows 不需要安装 Codex、登录 OpenAI，也不需要为了控制链路连接 OpenAI 代理。**

| | Codex 原生远程连接 | MiraBridge |
|---|---|---|
| Windows 安装 Codex | SSH 模式需要 | 不需要 |
| Windows 登录 OpenAI | 需要 | 不需要 |
| Windows 访问 OpenAI/代理 | 跟随远端 Codex 的连接要求 | MiraBridge 控制链路不需要 |
| Codex 在哪里工作 | 连接的远端电脑 | Codex 留在 Mac，Windows 只执行具体操作 |
| 通用桌面和鼠标控制 | 支持的主机可使用 Computer Use | 不属于产品目标 |
| Windows 执行方式 | 通用远端 Codex 环境 | 结构化、可审计的 Worker 操作 |

> **网络说明：**MiraBridge 本身不要求 Windows 访问 OpenAI。任务如果需要下载软件、依赖或模型，仍可能需要它自己的网络或镜像源。

## 你可以直接让 Codex 做什么

### 构建和测试 Windows 项目

> “打开 Windows 上的 .NET 项目，修好失败测试，完成 Release 打包，再把安装包传回 Mac。”

Codex 可以检查和修改 Windows 项目，运行原生工具链，验证结果，并把最终产物传回来。

### 使用 Windows 显卡

> “检查这台 Windows 有什么显卡，用它渲染视频；连接中断也要继续，结束后验证成片。”

MiraBridge 会读取真实硬件，而不是假设显卡品牌。长时间渲染和计算任务不依赖 SSH 一直在线，重新连接后仍能继续查看。

### 用 Microsoft Edge 验收网页

> “在 Windows 上运行这个网页，用 Edge 检查桌面和手机版，修完错误后把截图和构建结果传回来。”

MiraBridge 可以保持本地服务运行，生成隔离的 Edge 截图，返回页面与控制台错误，并带回最终结果。

### 检查文件并谨慎清理

> “看看 Windows 桌面和回收站里有什么，删除任何内容前先问我。”

Codex 可以检查已授权位置，列出明确候选，并在得到批准后执行和复查。

## 为真实工作准备

- **Windows 原生工具：**正确运行 `.exe`、`.cmd`、`.bat`、PowerShell、构建工具、交互终端和中文输出。
- **可找回的长任务：**构建、服务、渲染、扫描和推理不会因为 SSH 或 MCP 重连而消失。
- **受控文件访问：**只在配置好的 Windows 位置中读取、搜索、编辑、复制、移动和删除。
- **可验证的传输：**在 Mac 与 Windows 间传输单个文件或完整目录，并核对大小和 SHA-256。
- **返回证据而非猜测：**把退出状态、日志、哈希、生成文件、浏览器错误、截图和硬件信息交给 Mac 上的 Codex 判断。

插件只公开 28 个职责明确的 `mira_bridge_*` 工具。普通 Mac 任务仍留在本机，不会唤醒或连接 Windows。

## 一次对话完成安装

### 你需要准备

- 一台已经可以正常使用 Codex 的 Mac。
- 一台位于同一可信局域网，或可通过现有安全 SSH 网络访问的受支持 Windows 电脑。
- Mac 插件与 Windows 安装包使用同一个 MiraBridge 版本。

### 1. 让 Mac 上的 Codex 安装 MiraBridge

> 请从 `https://github.com/2387452986/MiraBridge` 安装 `v2.0.0-rc.6`，完成 doctor 并生成 Windows 配对请求。

Codex 会验证固定版本，安装 Mac 端受管运行时和插件，然后生成配对请求。

### 2. 在 Windows 安装 MiraBridge

从 [2.0.0-rc.6 Release](https://github.com/2387452986/MiraBridge/releases/tag/v2.0.0-rc.6) 下载对应的 x64 或 ARM64 Setup，运行后打开**连接 Mac**。

### 3. 配对两台电脑

1. 从 Windows 复制完整的 `mirabridge pair create` 命令，交给 Mac 上的 Codex。
2. 把请求码粘贴进 Windows，点击**授权并生成响应**。
3. 从 Windows 复制完成命令，再交回 Codex。

正常流程不需要密码、复制私钥、编辑 TOML、手工修改 SSH 文件或输入主机指纹。

<details>
<summary>手动执行的 Mac 安装命令</summary>

```sh
git clone --branch v2.0.0-rc.6 --depth 1 https://github.com/2387452986/MiraBridge.git
cd MiraBridge
./plugins/mira-bridge/scripts/install-mac.sh
~/.local/bin/mirabridge doctor
~/.local/bin/mirabridge pair create
```

</details>

## 安全边界与当前限制

- MiraBridge 不是远程桌面，不控制任意 Windows 图形界面、鼠标，也不使用现有的已登录浏览器资料。
- Windows 必须能通过可信局域网、VPN、组网工具或其他安全 SSH 路径被 Mac 访问。
- 文件工具只能操作配置好的位置，但原生程序仍拥有其 Windows 运行账号的权限；产品当前默认使用 Administrator。
- 配对使用公钥 SSH 和固定主机指纹。MiraBridge 不开放自定义命令监听端口，也不发送后台遥测。
- `2.0.0-rc.6` 仍是未签名的 Release Candidate，Windows SmartScreen 可能显示“未知发布者”。请只从本仓库 Release 下载，并核对公开的 SHA-256 清单。

在敏感或生产电脑上使用前，请阅读[安全策略](./SECURITY.md)、[支持矩阵](./SUPPORT_MATRIX.md)和[配对说明](./docs/PAIRING.md)。

## 已在真实 Windows 电脑上验证

MiraBridge 的验收不只包含 Mock 和编译测试。当前版本已安装到真实 Windows 11 x64 电脑，通过公开 Mac 插件完成原生构建、断线可找回任务、交互终端、Edge 截图、文件传输和完整 GPU 视频工作流；传回 Mac 的产物通过 SHA-256 一致性验证。

完整证据、已知限制和发布门禁见[真实测试报告](./docs/TEST_REPORT.md)。

## 技术文档

- [在 macOS 安装](./docs/INSTALL_MAC.md)
- [在 Windows 安装](./docs/INSTALL_WINDOWS.md)
- [配对与 SSH 信任](./docs/PAIRING.md)
- [架构说明](./plugins/mira-bridge/docs/ARCHITECTURE.md)
- [工具覆盖与明确缺口](./plugins/mira-bridge/docs/TOOL_PARITY.md)
- [从 1.x 迁移与回滚](./docs/MIGRATION_1X.md)
- [版本说明](./docs/release-notes-v2.0.0-rc.6.md)

## 许可证

MiraBridge 使用 [MIT License](./LICENSE)，第三方依赖见 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES.md)。
