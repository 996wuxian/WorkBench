# AGENTS.md — Workbench

编码 Agent 在本仓库工作时的**强制入口规则**。比 README 更短、更硬；冲突时以本文件为准。

## 项目身份

| 项 | 值 |
|----|-----|
| 名称 | **Workbench** |
| 定位 | 本机多 Agent 桌面指挥台（Host 壳，不重写各家 Agent 大脑） |
| P0 引擎 | **Grok**（`grok agent stdio` / ACP）+ **Codex**（`codex app-server --stdio`） |
| 后置 | Claude、Kimi、工作流编排（未启用前不要当真实现） |
| 栈 | Tauri 2 + Rust Host · React 19 + TypeScript + Vite + Tailwind |
| 参考 | 架构思想对齐 `../grok-app`；**本仓库独立**，不要直接改 grok-app 除非用户明确要求 |

产品/架构背景：`docs/MULTI-AGENT-WORKBENCH-方案.md`  
日常说明：`README.md`

---

## 必须先确认（硬约束）

在执行下列操作**之前**，必须先向用户说明意图并获得明确同意。**禁止默认执行。**

### 1. 删除 / 破坏性操作

- 删除文件或目录（含 `rm`、`Remove-Item`、清空目录、批量清理）
- `git clean`、`git reset --hard`、丢弃未提交改动
- 覆盖用户正在编辑且非本任务产生的文件（先读、先问）
- 修改/删除仓库外路径（如用户 `~/.grok`、`~/.codex`、系统目录）

### 2. 安装 / 变更依赖与工具链

- `pnpm install` / `npm install` / `yarn` **新增或升级**依赖（改 `package.json` / lockfile）
- `cargo add` / 修改 `Cargo.toml` 依赖版本
- 安装系统级工具：Rust、Visual Studio Build Tools、WebView2、winget/choco 等
- 全局安装 CLI（`npm i -g`、改 PATH 的安装脚本）
- 下载/安装各 Agent CLI（grok / codex / claude / kimi）

### 3. 其他需确认

- `git push`、改 remote、force-push
- 改动 CI/CD、发布配置、签名/证书相关
- 向用户本机 Agent 配置目录**写入**（`GROK_HOME`、`~/.codex` 等）；默认只读探测
- 大规模重命名/搬迁目录结构

**允许不经确认的常规工作：** 阅读代码、编辑/新增本仓库内实现文件、运行下方已列出的只读或本地验证命令（见「命令」）。若验证命令会触发首次自动装包，仍须先确认。

---

## 命令

工作目录：`X:\1_2026_project\work`（或本仓库根）。

| 用途 | 命令 |
|------|------|
| 装依赖（**须先确认**） | `pnpm install` |
| 加载本机编译环境 | `. .\scripts\dev-env.ps1` |
| 完整桌面（推荐） | `.\scripts\dev.ps1` |
| 仅前端预览 | `pnpm dev:ui` → `http://localhost:1430` |
| 类型检查 | `pnpm typecheck` |
| 前端生产构建 | `pnpm build:ui` |
| 单测（前端） | `pnpm test` |
| Rust 检查 | `. .\scripts\dev-env.ps1` 后 `cd src-tauri; cargo check` |
| 重生成 Tauri 图标（先说明） | `pnpm tauri icon public\logo.png` |

### 本机工具链（已装，优先 D 盘）

| 项 | 路径 |
|----|------|
| `RUSTUP_HOME` | `D:\tools\rustup` |
| `CARGO_HOME` | `D:\tools\cargo`（含 `config.toml` rsproxy 镜像） |
| cargo/rustc bin | `D:\tools\cargo\bin` |
| MSVC vcvars | `X:\Visual-Studio\ide\VC\Auxiliary\Build\vcvarsall.bat` |
| WebView2 | 系统已装 |

注意：系统代理 `127.0.0.1:7892` 可能导致 crates.io 失败；`dev-env.ps1` 会清代理并用 rsproxy。**不要擅自改用户系统代理**；cargo 侧用 `CARGO_HOME/config.toml` + 脚本即可。

### 图标与任务栏清晰度

- **分清两套图标入口**：`public/logo.png` 只影响 WebView 内容区和 favicon；Windows 任务栏 / Alt-Tab / exe 关联图标来自 `src-tauri/icons/icon.ico`，并由 Tauri 编译进 `src-tauri/target/debug/workbench.exe`。
- **先判定问题位置**：窗口内 logo 模糊，查 `src/App.tsx`、`src/styles/app.css` 和 `/logo.png` 渲染尺寸；任务栏图标模糊，查 `src-tauri/icons/32x32.png`、`64x64.png`、`icon.ico`，不要只改前端 CSS 或 `<img src="/logo.png">`。
- **重生成命令**：`pnpm tauri icon public\logo.png`。该命令会批量覆盖/生成 `src-tauri/icons/` 下的 PNG/ICO/ICNS/Appx/iOS/Android 图标文件；执行前向用户说明意图，执行后检查 diff。
- **Windows 尺寸要求**：`icon.ico` 至少应包含 `16/24/32/48/64/256`。缺少 `24` 或 `64` 时，高 DPI 任务栏可能从不匹配尺寸插值导致发糊。
- **构建触发**：`build.rs` 应监听图标文件变化，避免 Rust/Tauri 复用旧 exe 资源。当前约定监听 `icons/icon.ico`、`icons/32x32.png`、`icons/64x64.png`。
- **源图取舍**：图标源图如果是 3D 渐变、阴影、柔边，在 16–32px 下天然更容易显糊；`code2img` / `doTime` 清晰是因为小尺寸里有高对比符号。若用户要求“和原图一样”，优先从原图重生成完整图标集；若用户要求“小尺寸更清晰”，再考虑单独设计扁平/高对比小图标版本，但必须先说明会与原图不完全一致。
- **重启与验证**：重新生成图标后必须停掉旧 `workbench.exe` / WebView2 / Vite dev 链路并重启。可从 exe 抽取关联图标验证是否已嵌入；若 exe 中抽取出的关联图标已更新但任务栏仍旧，优先怀疑 Windows 图标缓存，不要继续误改前端。

---

## 源码布局（热区）

```
src/                         # React UI
  App.tsx                    # 三栏壳 / 会话切换（骨架期可能较集中）
  lib/api.ts                 # Tauri invoke 封装
  lib/types.ts               # 与 Host 对齐的 TS 类型
public/
  logo.png                   # WebView 内容区 / favicon 入口，不是 Windows 任务栏图标
src-tauri/src/
  commands.rs                # Tauri 命令面
  session_fsm.rs             # Host 独占 FSM
  session_manager.rs         # 会话生命周期
  host/events.rs             # 统一 HostEvent（UI 只认这个）
  runtime/
    traits.rs                # AgentRuntime / LiveSession
    registry.rs              # 注册表；P0 仅启用 grok+codex
    grok.rs / codex.rs       # 各引擎适配器
src-tauri/icons/             # Tauri bundle / exe / 任务栏图标源；由 `pnpm tauri icon` 生成
docs/                        # 方案与 SPIKE 文档
```

生成物 / 勿手改：`node_modules/`、`dist/`、`src-tauri/target/`、`src-tauri/gen/`。
图标生成物例外：`src-tauri/icons/` 允许通过 `pnpm tauri icon public\logo.png` 批量更新，但执行前必须说明会覆盖/新增多平台图标文件。

App 数据根（运行时，非仓库）：Windows `%APPDATA%\workbench\Workbench`。

---

## 架构约定

1. **Host 拥有状态机** — 连接/流式/权限状态在 Rust FSM 内变迁；前端只投影 snapshot / 事件。
2. **一个会话绑定一个 runtime** — 禁止 live 进程中途热切换 Grok↔Codex；换引擎 = 新建或 fork。
3. **Adapter 边界** — 新引擎只加 `runtime/` 适配器 + registry；不要在 `SessionManager` 里堆 `if runtime == ...` 协议细节。
4. **统一事件** — UI 只消费 `HostEvent` / snapshot，不解析 ACP 或 Codex App Server 私有帧。
5. **不内嵌 CLI** — 只探测 PATH/常见路径；缺失时 UI 引导，不把 agent 打进安装包。
6. **默认独立数据** — 不污染用户默认 `~/.grok` / Codex home；隔离目录用 `agent-homes/`。
7. **权限默认 Ask** — 全局 YOLO 非默认；跨 runtime 的 session-allow 不互通。
8. **P0 范围** — 真连接优先 Grok ACP 与 Codex App Server；Claude/Kimi 保持 disabled 占位，除非任务明确要求。

参考实现可读 `../grok-app`，**复制思想或局部模式**；不要无说明地大面积粘贴品牌化 UI/文案。

---

## 工作规则

- **最小改动**：只改完成任务所需的文件；不做无关重构、不顺手「清理」。
- **先读后改**：改 Host/协议前先读 `runtime/traits.rs`、`session_fsm.rs`、方案文档相关节。
- **先定位渲染层**：UI 内容区问题看 React/CSS/public 资源；窗口壳、任务栏、Alt-Tab、exe 资源问题看 Tauri/Rust 配置与 `src-tauri/icons/`，不要混淆。
- **弹窗关闭按钮**：Modal / Dialog 标题栏的关闭操作必须使用标准 X 图标按钮（优先复用 `IconClose`），禁止显示“关闭”文字；必须同时提供明确的 `title` 和 `aria-label`。弹窗底部的“取消”命令仍使用文字按钮。
- **中文沟通**：与用户对话默认中文；代码标识符/协议字段用英文。
- **密钥与日志**：禁止把 API Key、token 写入仓库或日志；UI 只显示 `hasKey` 类布尔。
- **错误分类**：对外错误尽量映射 `AgentErrorCode`（CLI_NOT_FOUND / AUTH_FAILED / …），勿混淆文案。
- **文档**：架构级决策同步 `docs/` 或 README；不要把 AGENTS.md 写成 PRD 或任务清单。
- **完成标准**：改动后至少跑通相关验证（通常 `pnpm typecheck`；触及 Rust 且环境有 cargo 时再 `cargo check`）。环境缺工具则报告 blocker，不擅自安装。

---

## 边界速查

| 可以 | 不行（除非用户确认） |
|------|----------------------|
| 增改本仓库源码与文档 | 删文件/目录 |
| 运行 typecheck / dev:ui / test | 新增 npm/cargo 依赖、装系统工具 |
| 只读探测本机 grok/codex | 改写用户 CLI 全局配置、登录态 |
| 参考 grok-app 设计 | 在未说明时改 grok-app 仓库 |
| 提 SPIKE / 方案 diff | 默认 force-push、清 git 历史 |

---

## 完成时回报

- 改了哪些路径、为什么  
- 跑过哪些命令、结果如何  
- **未做**的删除/安装及原因（若曾需要但未获确认）  
- 已知风险或后续建议（一两句）
