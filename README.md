# Workbench

本机多 Agent 桌面指挥台。Workbench 是一个 Tauri Host 壳，用统一的会话、权限、流式事件和桌面 UI 管理本机已经安装的 Agent CLI；它不重写各家 Agent 的模型能力，也不把 CLI 或密钥打进安装包。

参考架构：`docs/MULTI-AGENT-WORKBENCH-方案.md`

## 能力概览

| Runtime | 接入方式 | 状态 | 说明 |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json` | 已启用 | 支持 cc-switch/本机 Claude 配置、会话恢复、MCP 权限审批桥 |
| Codex | `codex app-server --stdio` | 已启用 | 支持模型/推理档位、会话恢复、权限审批 |
| Kimi Code | ACP | 已启用 | 依赖本机 CLI 与 ACP 可用性 |
| Grok Build | ACP: `grok agent stdio` | 已启用 | 支持流式消息、工具事件、Host 权限门 |

Workbench 的重点是统一桌面体验：

- 三栏工作台：会话列表、聊天窗口、会话/运行状态面板
- 每个会话绑定一个 runtime，运行中不热切换 Agent
- Host 管理连接、流式输出、工具事件、权限请求和会话落盘
- 支持 `ask`、`auto`、`read_only`、`full_access` 等权限模式，具体可用项由 runtime manifest 决定
- 本机 CLI 探测：PATH + 常见安装路径 + 用户 override
- 运行数据独立存储在 Workbench app data，不写入仓库

## 架构

```text
React UI
  -> Tauri commands
    -> SessionManager + Session FSM
      -> Runtime Registry
        -> ACP adapters
        -> Codex App Server adapter
        -> Claude stream-json adapter
```

| 路径 | 职责 |
|---|---|
| `src/` | React UI、会话切换、聊天渲染、权限条、运行状态面板 |
| `src-tauri/src/session_fsm.rs` | Host 独占状态机 |
| `src-tauri/src/session_manager.rs` | 会话生命周期、事件转发、消息 journal |
| `src-tauri/src/runtime/` | Runtime trait、registry、各 CLI adapter |
| `src-tauri/src/host/events.rs` | UI 消费的统一 HostEvent |
| `src-tauri/runtimes/builtin.json` | 内置 runtime manifest |
| `src-tauri/src/runtime/claude_permission_bridge.mjs` | Claude Code 权限审批 MCP bridge |

## 本机数据与隐私

Workbench 默认不提交、不打包、不写入用户的 Agent 登录态或 API Key。

- App 数据目录：Windows `%APPDATA%\workbench\Workbench`
- 会话镜像：`sessions/`
- 会话 trace：`sessions/<session-id>/trace.jsonl`；右键导出到 `exports/*.trace.jsonl`
- trace 默认只记录时间、状态、耗时、字节数、工具名和错误码，不记录对话正文、权限 preview、工具命令或敏感路径
- 隔离 Agent home fallback：`agent-homes/`
- 日志：`logs/`
- Claude 权限桥临时配置：系统 temp 下的 `workbench-claude-mcp/`，启动时会清理超过 24 小时的旧文件

仓库 `.gitignore` 已排除：

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- `.env`、`.env.*`
- `*.log`

当前代码只读取本机 CLI 配置用于探测和显示，例如 Claude 模型 alias；不会把真实 key/token 写入仓库。发布前仍建议执行一次密钥扫描。

## 开发环境

本项目使用 Tauri 2 + Rust + React 19 + TypeScript + Vite。

推荐 Windows 本机工具链：

| 组件 | 说明 |
|---|---|
| Node / pnpm | 前端与 Tauri CLI |
| Rust stable | 推荐使用 `D:\tools\rustup`、`D:\tools\cargo` |
| MSVC Build Tools | `scripts/dev-env.ps1` 会加载本机 VC 环境 |
| WebView2 | Windows 桌面运行需要 |

常用命令：

```powershell
cd X:\1_2026_project\work

# 推荐桌面开发
.\scripts\dev.ps1

# 仅前端预览
pnpm dev:ui

# 类型检查
pnpm typecheck

# 前端生产构建
pnpm build:ui

# Rust 检查
. .\scripts\dev-env.ps1
cd src-tauri
cargo check
```

## 打包

```powershell
pnpm tauri build
```

调试打包但跳过 installer：

```powershell
pnpm tauri build --debug --no-bundle
```

图标来自 `public/logo.png`。如果需要重新生成 Windows 任务栏、EXE、installer 图标：

```powershell
pnpm tauri icon public\logo.png
```

该命令会覆盖 `src-tauri/icons/` 下的 PNG/ICO/ICNS/Appx/iOS/Android 图标生成物。Windows installer/EXE 主要使用 `src-tauri/icons/icon.ico`。

## 发布流程

建议发布前执行：

```powershell
pnpm typecheck
pnpm build:ui
. .\scripts\dev-env.ps1
cd src-tauri
cargo check
cargo test runtime::claude::tests
```

完整 release 建议：

1. 确认 `README.md`、`src-tauri/tauri.conf.json`、`package.json`、`src-tauri/Cargo.toml` 版本一致。
2. 执行 `pnpm tauri build` 生成安装包。
3. 安装构建产物，验证 Claude/Codex/Kimi/Grok 至少各一条消息。
4. 对 Claude 验证 `ask`、`auto`、`full_access` 权限模式。
5. 执行密钥扫描，确认无 `.env`、token、API key、日志或用户 home 数据进入提交。
6. 创建 Git tag，推送并在 GitHub Release 上传安装包。

## License

MIT. See `LICENSE`.
