# Workbench

**本机多 Agent 桌面指挥台**（P0：Grok Build + Codex）

> 参考架构：[grok-app](../grok-app) 的 Host 思想（Session FSM、每会话一进程、权限 Host、三栏工作台），扩展为 **Runtime Adapter** 多引擎模型。  
> 方案文档：[`docs/MULTI-AGENT-WORKBENCH-方案.md`](./docs/MULTI-AGENT-WORKBENCH-方案.md)

## 产品决策（已拍板）

| 项 | 选择 |
|----|------|
| 产品名 | **Workbench** |
| P0 引擎 | **Grok**（`grok agent stdio` / ACP）+ **Codex**（`codex app-server --stdio`） |
| 后置 | Claude stream-json、Kimi ACP、工作流编排 |

## 架构骨架

```
UI (React)
  → Tauri commands
    → SessionManager + Session FSM
      → Runtime Registry
        → Grok adapter (ACP stub → real)
        → Codex adapter (App Server stub → real)
```

| 路径 | 职责 |
|------|------|
| `src/` | 三栏 UI、会话切换、Doctor 探测面板 |
| `src-tauri/src/session_fsm.rs` | Host 独占状态机 |
| `src-tauri/src/session_manager.rs` | 会话生命周期 |
| `src-tauri/src/runtime/` | Runtime trait + Grok/Codex adapters |
| `src-tauri/src/host/events.rs` | 统一 HostEvent 模型 |

## 本机 CLI（探测目标）

| Runtime | 命令 | 常见路径 |
|---------|------|----------|
| Grok | `grok agent stdio` | `D:\tools\grok\bin\grok.exe` |
| Codex | `codex app-server --stdio` | `D:\codex\codex.exe` |

## 开发

### 依赖（本机已就绪）

| 组件 | 位置 / 说明 |
|------|-------------|
| Node 20+ / pnpm | 已有 |
| **Rust stable** | **D 盘**：`D:\tools\rustup` + `D:\tools\cargo`（`rustc 1.97.1`） |
| MSVC | `X:\Visual-Studio\ide`（已有 VC Tools） |
| WebView2 | 系统已装 |
| Cargo 镜像 | `D:\tools\cargo\config.toml` → rsproxy（避免坏掉的系统代理） |
| grok / codex | 可选；缺失时 Doctor 显示 missing |

用户环境变量（已写入）：`RUSTUP_HOME`、`CARGO_HOME`、PATH 含 `D:\tools\cargo\bin`。

### 命令

```powershell
cd X:\1_2026_project\work

# 推荐：带 MSVC + D: Rust 环境启动桌面
.\scripts\dev.ps1

# 或先加载环境再 pnpm
. .\scripts\dev-env.ps1
pnpm dev

# 仅前端（浏览器预览，mock 数据）
pnpm dev:ui

# 类型检查
pnpm typecheck
```

> 新开终端若找不到 `cargo`，先重开一次 PowerShell（读用户 PATH），或执行 `. .\scripts\dev-env.ps1`。

数据目录（独立，不污染 CLI home）：

- Windows: `%APPDATA%\workbench\Workbench`
- 内含 `sessions/`、`agent-homes/grok|codex/`、`logs/`

## 当前状态

- [x] Tauri 2 + React + TS + Tailwind 工程
- [x] 三栏工作台 UI（会话 / 对话 / Doctor）
- [x] Runtime Registry（Grok/Codex 启用，Claude/Kimi 占位）
- [x] Session FSM + SessionManager 命令面
- [x] CLI 路径探测（PATH + 常见安装路径）
- [x] **真 Grok ACP**（`grok agent stdio` + 流式 `session://stream`）
- [x] 工具权限 MVP：Host 自动 allow（UI 审批条后置）
- [ ] 真 Codex App Server 客户端
- [ ] 权限条 UI / journal 落盘 / 项目信任选择器

## 下一步建议

1. SPIKE：`codex app-server --stdio` schema / 最小握手  
2. 移植/实现通用流式 stdio 帧 + Grok ACP  
3. Host 事件 `emit` 到前端，替换 stub 回复  
4. 权限 Ask 条（对齐 grok-app）

## License

Private / local project.
