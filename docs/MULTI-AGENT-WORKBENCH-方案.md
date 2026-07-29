# Multi-Agent Workbench · 最佳实践方案

> **目标目录：** `X:\1_2026_project\work`  
> **参考实现：** `X:\1_2026_project\grok-app`（Tauri 2 + React + Grok Build ACP Host）  
> **本机已装 CLI（已探测）：**
>
> | Agent | 二进制 | 版本（探测时） | 推荐接入方式 |
> |-------|--------|----------------|--------------|
> | Grok Build | `D:\tools\grok\bin\grok.exe` | 0.2.111 | `grok agent stdio`（ACP） |
> | Claude Code | `claude` (npm global) | 2.1.121 | `-p --output-format stream-json`（流式适配层） |
> | Codex | `D:\codex\codex.exe` | 0.144.4 | `codex app-server --stdio`（官方 App 协议） |
> | Kimi Code | `D:\tools\kimi-code\bin\kimi.exe` | 0.29.1 | `kimi acp`（ACP） |
>
> **文档性质：** 架构与产品最佳实践方案（可直接开工），**不是**逐行实现规格。实现前建议对 Codex App Server / Claude stream-json 各做一次 SPIKE。
>
> **已拍板（2026-07-24）：**
> - 产品名：**Workbench**
> - P0 引擎：**Grok + Codex**（用户最常用）
> - 工程：在本目录 scaffold 骨架（见仓库根 `README.md`）

---

## 0. 一句话定位

**做一个「多 Agent 本机指挥台」：一个桌面应用里切换 / 并行 / 编排 Codex · Claude Code · Grok Build · Kimi，而不是再开四个终端。**

| 它是什么 | 它不是什么 |
|----------|------------|
| 本地 Agent Host / 会话与权限壳 | 又一个 ChatGPT 网页壳 |
| 多运行时适配器 + 统一 UI | 自己重写各家 Agent 大脑 |
| 项目 / 会话 / 编排 / 审批中心 | 云端 multi-agent farm |
| 对标 grok-app 的「指挥台」能力，扩展为多引擎 | 内嵌完整终端仿真器 |

与 grok-app 的关系：

```
grok-app  =  单引擎（Grok）指挥台
本项目    =  多引擎指挥台 + 可选编排层
```

**产品名（已定）：** **Workbench**  
下文统称 **Workbench**。

---

## 1. 为什么不能「直接 fork grok-app 改成多 Agent」

grok-app 的设计非常正确，但**深度绑定单一运行时**：

| 层 | grok-app 做法 | 多 Agent 必须改什么 |
|----|---------------|---------------------|
| 传输 | 仅 `AcpClient` + `grok agent stdio` | **Runtime Adapter** 抽象；ACP 只是其中一种 |
| 会话 | `SessionManager` 绑定一个 backend 字符串 | 会话元数据带 `runtime_id` + 能力矩阵 |
| 权限 | Host 映射 ACP `request_permission` | **统一权限事件模型**，各 Adapter 翻译进出 |
| 配置 | `GROK_HOME` / `~/.grok-app` | 每 runtime 独立 home/config，**禁止串改** |
| 模型 | Grok catalog + providers | 每 runtime 自己的 model catalog |
| 账户 | Grok 登录 / SuperGrok | 各 CLI 自有 auth；App 只探测与引导，不伪造登录 |
| 数据 | 独立 journal | App 层统一会话历史；runtime 侧 resume 尽量用各家原生 session id |

**最佳实践：复用 grok-app 的「Host 思想」与 UI 骨架，而不是硬改其单后端假设。**

可直接借鉴的模块（思想级 / 可抄模式）：

1. **Host 独占 Session FSM**（`Idle → Connecting → Ready → Streaming → AwaitingPermission → Disconnected`）
2. **每活跃会话一子进程 + 并发上限 + 闲置回收**
3. **Ask 默认权限，Allow once / session / Deny**
4. **三栏工作台**（会话 / 对话 / 资源）
5. **Doctor：CLI 探测、鉴权、版本、错误四分类**
6. **独立数据根，不污染各 CLI 默认 home**
7. **Mock 后端联调 UI**（`GROK_APP_ACP=mock` 同类开关）
8. **密钥 redact、不内嵌 CLI 二进制**

---

## 2. 产品决策锚点（建议直接拍板）

| ID | 决策 | 说明 |
|----|------|------|
| **D1** | 指挥台优先 | 核心价值是会话/权限/多引擎切换，不是「更漂亮的 Markdown」 |
| **D2** | 不内嵌 CLI | 只探测 PATH / 常见路径 / 用户指定路径；缺失则引导安装 |
| **D3** | Host 拥有状态机 | 前端只投影 snapshot；禁止前端自行拼协议 |
| **D4** | 默认独立数据 | App 数据在 `%APPDATA%\agent-workbench`（或 `~/.agent-workbench`）；可选「与某 CLI 共通」按 runtime 开关 |
| **D5** | 权限默认 Ask | YOLO / auto / bypass 仅显式开启，且按会话/按 runtime 隔离 |
| **D6** | Adapter 先窄后宽 | P0 先「单会话切换引擎」；P1「并行多会话」；P2「工作流编排」 |
| **D7** | 编排是上层产品，不是协议层 | 编排 DAG 调用的是统一 Session API，不直接碰各 CLI 私有协议 |
| **D8** | 能力降级诚实 | 某 runtime 不支持 resume/permission/tool 细节时，UI 灰显并说明，不装死 |

---

## 3. 用户要解决的真实问题

### 3.1 现状痛点

- 每天开 3～4 个 Agent CLI 窗口，cwd / 权限 / 会话切换成本高
- 同一项目想「Claude 写、Codex 审、Grok 改、Kimi 补」时，上下文靠复制粘贴
- 没有统一的项目信任、权限审批、产物预览入口

### 3.2 目标体验（成功标准）

1. **一键切换引擎：** 同一项目下，新建会话时选 `Claude | Codex | Grok | Kimi`，对话体验一致  
2. **多会话并行：** 左侧可挂多个不同引擎的会话（默认上限 3 活跃进程）  
3. **可选编排：** 定义「计划 → 实现 → Review」流水线，自动把上一步产物注入下一步  
4. **统一权限条：** 任意引擎要写文件/跑命令时，同一套 Ask UI  
5. **Doctor 一页看健康：** 哪个 CLI 装了、版本、登录态、能否 handshake  

---

## 4. 总体架构（最佳实践）

### 4.1 分层图

```
┌─────────────────────────────────────────────────────────────┐
│  UI Shell (React + TS + Tailwind)                           │
│  三栏：Sessions | Chat/Plan/Tools | Resources               │
│  Composer：Runtime 切换 · Model · Effort · Permission       │
└───────────────────────────┬─────────────────────────────────┘
                            │ Tauri commands / events
┌───────────────────────────▼─────────────────────────────────┐
│  Host Core (Rust)                                           │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│  │ SessionMgr  │ │ Orchestrator │ │ Permission Host      │  │
│  │ (FSM+Journal)│ │ (DAG/Pipeline)│ │ (once/session/deny) │  │
│  └──────┬──────┘ └──────┬───────┘ └──────────┬───────────┘  │
│         │               │                    │              │
│  ┌──────▼───────────────▼────────────────────▼───────────┐  │
│  │            Runtime Registry + Capability Matrix        │  │
│  └──────┬──────────┬──────────┬──────────┬───────────────┘  │
│         │          │          │          │                  │
│   ┌─────▼───┐ ┌────▼────┐ ┌───▼────┐ ┌───▼────┐            │
│   │ Grok    │ │ Kimi    │ │ Codex  │ │ Claude │            │
│   │ AcpAdpt │ │ AcpAdpt │ │ AppSrv │ │ Stream │            │
│   └────┬────┘ └────┬────┘ └───┬────┘ └───┬────┘            │
└────────┼───────────┼──────────┼──────────┼──────────────────┘
         │ stdio     │ stdio    │ stdio    │ stdio/process
         ▼           ▼          ▼          ▼
      grok.exe    kimi.exe   codex.exe   claude
```

### 4.2 技术栈建议（对齐 grok-app，降低重造成本）

| 层 | 选型 | 理由 |
|----|------|------|
| 桌面壳 | **Tauri 2** | 子进程、权限、文件系统、系统托盘成熟；体积小 |
| Host | **Rust** | 多进程并发、超时、stdio 帧解析适合放 Host |
| UI | **React 19 + TS + Vite + Tailwind** | 可直接参考 grok-app 组件模式 |
| 状态 | Host 权威 + 前端投影 | 与 grok-app SessionSnapshot 一致 |
| 测试 | Vitest（UI 纯逻辑）+ Cargo test（FSM/权限/Adapter mock） | 不依赖真账号 CI |

> 若团队更熟 Electron：也能做，但进程与安全边界成本更高。**有 grok-app 可参考时，Tauri 是更优默认。**

### 4.3 核心抽象：统一 Agent 事件模型

所有 Adapter 必须把私有协议翻译成 **Host Event Bus** 事件：

```ts
// 概念模型（Host 内部 / 推给前端的统一事件）
type HostEvent =
  | { type: "state"; state: SessionState; runtimeId: string; backend: string }
  | { type: "stream"; kind: "assistant" | "thought"; text: string; done: boolean }
  | { type: "tool_call"; id: string; name: string; status: string; title: string; raw?: unknown }
  | { type: "permission_request"; rpcId: string; toolName: string; title: string; preview: string; options: PermissionOption[] }
  | { type: "plan"; entries: unknown; body?: string }
  | { type: "prompt_complete"; stopReason: string }
  | { type: "turn_settled"; stopReason: string; meta: SessionMeta }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "process_exited"; code?: number }
  | { type: "retry_state"; attempt: number; max: number; reason: string }
```

**原则：** UI 永远只认 `HostEvent`，不认 ACP / Codex AppServer / Claude stream-json 细节。Adapter 的 `prompt_complete` 只表示原生 CLI 已结束输出；Host 完成 journal、FSM 和原生 session id 落盘后，再发送 `turn_settled` 更新会话元数据。

### 4.4 Runtime Adapter 接口（Host 侧）

```rust
// 概念伪代码 — 实现时再落到具体 crate 结构
#[async_trait]
trait AgentRuntime: Send + Sync {
    fn id(&self) -> &str;                 // "grok" | "claude" | "codex" | "kimi"
    fn display_name(&self) -> &str;
    fn capabilities(&self) -> Capabilities;

    async fn probe(&self) -> ProbeResult; // path/version/auth
    async fn connect(&self, opts: ConnectOpts) -> Result<Box<dyn LiveSession>>;
}

#[async_trait]
trait LiveSession: Send + Sync {
    async fn prompt(&self, input: PromptInput) -> Result<()>;
    async fn cancel(&self) -> Result<()>;
    async fn respond_permission(&self, decision: PermissionDecision) -> Result<()>;
    async fn set_model(&self, model: &str) -> Result<()>;
    async fn shutdown(&self) -> Result<()>;
    // events 通过 channel 上抛 HostEvent
}

struct Capabilities {
    streaming: bool,
    thoughts: bool,
    tools: bool,
    permission_gate: bool,   // 是否会向 Host 请求审批
    session_resume: bool,
    multi_turn: bool,
    models_list: bool,
    plan_mode: bool,
    slash_commands: bool,
    images_in: bool,
    images_out: bool,
}
```

### 4.5 各 Runtime 接入策略（基于本机实测 CLI）

#### A. Grok Build — **一等公民 ACP**

- 命令：`grok agent stdio`
- 协议：JSON-RPC over stdio（见 grok-app `SPIKE-ACP.md`）
- 复用：几乎可直接移植 `AcpClient` + permission 映射
- 注意：`GROK_HOME` 隔离；自定义中转与 OAuth 不要混

#### B. Kimi Code — **一等公民 ACP**

- 命令：`kimi acp`
- 协议：官方标明 **Agent Client Protocol over stdio**
- 策略：与 Grok **共享同一套通用 AcpTransport**，差异仅在：
  - spawn 命令与参数
  - 初始化 `clientInfo` / 可选 auth method
  - 模型列表与 config 路径
- 这是「多 Agent 最低成本第二引擎」

#### C. Codex — **官方 App Server（非 ACP，但是结构化）**

- 命令：`codex app-server --stdio`（或 `--listen stdio://`）
- 协议：Codex 自有 App Server protocol（可用 `generate-json-schema` / `generate-ts` 导出）
- 策略：
  1. **P0：** SPIKE 导出 schema，写 `CodexAppServerAdapter` → `HostEvent`
  2. **不要**用 `codex exec` 当主循环（无持久双向权限流，体验会退化成脚本）
  3. 会话 resume 走 Codex 原生 session id，App journal 另存一份镜像
- 风险：协议标 experimental，版本升级要做兼容矩阵

#### D. Claude Code — **stream-json 适配（能力次一等但可日用）**

- 主路径建议：
  ```bash
  claude -p --output-format stream-json --input-format stream-json \
    --permission-mode default \
    --include-partial-messages
  ```
- 或：多轮时用 `--continue` / `--resume` + 项目 cwd
- 策略：
  1. 实现 `ClaudeStreamAdapter`：解析 stream-json 事件 → `HostEvent`
  2. 权限：优先依赖 Claude 自己的 permission-mode；若 CLI 在非 TTY 下跳过信任对话框，**Host 必须在项目信任层补闸**
  3. 能力矩阵中：`permission_gate` 可能部分为 false → UI 提示「该引擎使用 CLI 侧权限策略」
- 风险：不是 ACP，工具生命周期细节不如 Grok/Kimi 干净；要做好降级

#### 接入优先级（已拍板）

```
P0-1  Grok ACP（可抄 grok-app）
P0-2  Codex App Server（用户高频；协议 SPIKE 后接真客户端）
P1    Claude stream-json / Kimi ACP
P2    编排 / 多 Agent 流水线
```

> **说明：** 原方案曾建议 Grok+Kimi（双 ACP）验证抽象；用户确认日常主力为 **Grok+Codex**，故 P0 按使用频率调整。Adapter 抽象仍先落地，Codex 走异构协议路径。

---

## 5. 产品信息架构与交互

### 5.1 主界面（继承 grok-app 三栏，增强 Runtime）

```
┌──────────┬─────────────────────────────┬────────────────┐
│ Projects │  Chat / Timeline / Plan     │ Resources      │
│ Sessions │                             │ Files / Diff   │
│          │  [Grok|Claude|Codex|Kimi]   │ Preview        │
│ ● Grok   │  messages...                │                │
│ ● Claude │                             │                │
│ ○ Codex  │  ─────────────────────      │                │
│          │  Composer                   │                │
│ Workflows│  runtime · model · perm     │                │
└──────────┴─────────────────────────────┴────────────────┘
```

### 5.2 会话模型

| 字段 | 说明 |
|------|------|
| `session_id` | App 层 UUID（权威） |
| `runtime_id` | `grok` / `claude` / `codex` / `kimi` |
| `runtime_session_id` | 各 CLI 原生 session id（可空） |
| `project_path` | 工作目录 |
| `title` | 可改 |
| `model_id` | 当前模型 |
| `permission_policy` | ask / accept_edits / yolo…（映射到各 runtime） |
| `journal` | App 统一消息日志（Markdown 友好） |

**规则：**

1. **一个会话绑定一个 runtime**（切换引擎 = 新建会话或「用另一引擎继续」fork）  
2. 禁止在同一 live 进程中途热切换 runtime（状态/工具/权限语义不一致）  
3. `journal` 是统一展示和崩溃恢复镜像；Codex thread、Claude session 等原生上下文仍由各 CLI 管理，正常多轮发送不重放 journal
4. 「用 Claude 继续这个 Grok 会话」= **fork**：把 journal 摘要 bootstrap 进新 runtime

### 5.3 三种使用模式（分阶段交付）

#### Mode A · 单窗口多引擎切换（P0 必须）

- 用户像切浏览器标签一样切会话
- 每会话固定引擎
- 解决「不用开四个 CLI」的 80% 需求

#### Mode B · 同项目并行多会话（P0/P1）

- 同 cwd 下 Claude 写代码 + Codex review 可同时存在
- Host 进程上限默认 **3**（对齐 grok-app）
- 文件冲突：提示「另一会话可能在改同一文件」；不做复杂 OT

#### Mode C · 多 Agent 任务编排（P1/P2）

用户可定义工作流模板，例如：

```yaml
# 示例：code-review-pipeline
name: implement-and-review
steps:
  - id: plan
    runtime: claude
    role: planner
    prompt: |
      阅读仓库，给出实现计划（仅 plan，不改文件）
    outputs: [plan.md]

  - id: implement
    runtime: grok
    role: implementer
    depends_on: [plan]
    prompt: |
      按以下计划实现：
      {{steps.plan.output}}
    permission: ask

  - id: review
    runtime: codex
    role: reviewer
    depends_on: [implement]
    prompt: |
      Review 最近改动，输出问题列表与建议 patch。
```

编排器职责：

1. 创建多个 App 会话（或复用）  
2. 按 DAG 调度 `prompt`  
3. 把上一步 `journal` / 产物路径注入下一步  
4. 每步独立权限策略  
5. 任一步失败：暂停流水线，UI 可重试 / 跳过 / 换引擎  

**最佳实践：** 编排层只调用 `SessionManager.prompt()`，**禁止**编排器直接 spawn CLI。

---

## 6. 权限与安全（多引擎最容易翻车的点）

### 6.1 统一权限策略（Host 层）

| 策略 | 行为 |
|------|------|
| `ask`（默认） | 写文件 / 执行命令需用户确认 |
| `allow_once` | 仅本次 |
| `allow_session` | 本会话同类操作放行（scope key） |
| `deny` | 拒绝并回传 runtime |
| `yolo` | 会话级全自动（需二次确认开启） |

### 6.2 跨 Runtime 原则

1. **Host 是最后一道闸**，即使 Claude 在非 TTY 下可能跳过信任提示  
2. **项目信任**与 **工具审批** 分离：未信任项目禁止 spawn 可写 Agent  
3. **scope key** 建议包含：`runtime + tool + path/command 归一化`  
4. 不同 runtime 的「Allow for session」**不互通**（Grok 放行 ≠ Claude 放行）  
5. 日志强制 redact API Key / token  
6. 各 CLI 配置目录只读探测为主；写入仅发生在 App 自己的 `agent-homes/<runtime>/`（若需要隔离 profile）

### 6.3 进程隔离

| 项 | 建议 |
|----|------|
| 并发活跃进程 | 默认 3，可设置 1–6 |
| 闲置回收 | 30 min（元数据保留） |
| 崩溃 | Disconnected + 重新附着；错误码分类 |
| cwd | 强制 session 绑定的 project_path |
| env | 最小注入；按 runtime 设置 `HOME`/`GROK_HOME`/`CODEX_HOME` 等隔离变量（需 SPIKE 验证各 CLI 是否尊重） |

---

## 7. 数据与配置布局

```
%APPDATA%/agent-workbench/          # 或 ~/.agent-workbench
  config.toml                       # App 设置
  projects.json                     # 信任项目列表
  sessions/
    <session_id>/
      meta.json                     # runtime、model、路径、原生 session id
      journal.jsonl                 # 统一消息
  workflows/
    templates/
    runs/
  agent-homes/                      # 可选：隔离各 CLI 配置
    grok/
    kimi/
    codex/
    claude/
  logs/
  cache/
```

**会话数据模式：**

| 模式 | 含义 |
|------|------|
| `independent`（默认） | 只用 App journal；runtime home 用隔离目录 |
| `shared_per_runtime` | 尽量读写各 CLI 默认 session 存储（高级，需锁） |

**禁止：** 无提示混读 independent 与 shared。

---

## 8. 错误模型（直接继承 grok-app 四分类并扩展）

| Code | 含义 | UI 动作 |
|------|------|---------|
| `CLI_NOT_FOUND` | 二进制不存在 | 打开安装引导 / 选路径 |
| `AUTH_FAILED` | 未登录或 Key 无效 | 跳转该 runtime 登录说明 |
| `NETWORK_PROVIDER` | 中转/API 网络错误 | 显示可重试 + Doctor ping |
| `AGENT_CRASHED` | 子进程异常退出 | 重新附着 |
| `PROTOCOL_MISMATCH` | CLI 过旧/协议不兼容 | 提示升级 CLI |
| `CAPABILITY_MISSING` | 当前引擎不支持该操作 | 灰显 / 建议换引擎 |
| `ORCHESTRATION_FAILED` | 流水线某步失败 | 停在该步，可换 runtime 重跑 |

---

## 9. 分期路线图（可执行）

### Phase 0 · 文档与 SPIKE（3–5 天）

- [ ] 确认产品名与 D1–D8  
- [ ] SPIKE：`kimi acp` handshake + prompt + permission  
- [ ] SPIKE：`claude -p --output-format stream-json` 多轮与权限行为  
- [ ] SPIKE：`codex app-server` schema 导出与最小会话  
- [ ] 输出 `CAPABILITY-MATRIX.md`（四引擎 × 能力）

### Phase 1 · MVP 日用（对标 grok-app P0 子集 + 双引擎）

**目标：一个 App 里稳定用 Grok + Kimi（都是 ACP）**

- 壳：三栏、主题、中英（可选先中文）  
- Runtime Registry + 通用 AcpTransport  
- Session CRUD、流式、Stop、权限条  
- Doctor：探测四 CLI（即使暂未接入也显示安装状态）  
- 项目信任  
- **不做**编排、不做 Codex/Claude 完美权限

### Phase 2 · 四引擎日用

- Claude Stream Adapter  
- Codex App Server Adapter  
- 会话 fork（跨引擎继续）  
- 能力矩阵驱动 UI 降级  
- 并发上限 / 闲置回收打磨  

### Phase 3 · 编排

- Workflow 模板  
- 串行流水线 + 简单 DAG  
- 步骤产物注入  
- 运行历史与失败重试  
- （可选）Best-of-N：同一任务丢给 2 个引擎对比（后置）

### Phase 4 · 体验增强

- Diff 面板、外部编辑器打开  
- MCP / Skills 状态（按 runtime 展示）  
- 托盘、自动更新  
- 会话导出 Markdown / 工作流报告  

---

## 10. 仓库与工程结构建议

```
X:\1_2026_project\work\
  README.md
  docs/
    MULTI-AGENT-WORKBENCH-方案.md    # 本文
    CAPABILITY-MATRIX.md             # SPIKE 后补
    SPIKE-kimi-acp.md
    SPIKE-claude-stream.md
    SPIKE-codex-app-server.md
    P0-能力矩阵.md
  apps/
    desktop/                         # Tauri 应用根
      package.json
      src/                           # React UI
      src-tauri/
        src/
          main.rs
          lib.rs
          host/
            session_fsm.rs
            session_manager.rs
            permission.rs
            orchestrator.rs
          runtime/
            mod.rs                   # Registry + trait
            capabilities.rs
            acp/
              transport.rs           # 通用 ACP
              grok.rs
              kimi.rs
            codex/
              app_server.rs
            claude/
              stream_json.rs
          probe/
            cli_probe.rs
          store/
          commands.rs
  packages/                          # 可选 monorepo
    shared-types/                    # TS 类型与 HostEvent
```

**工程原则：**

1. **通用 ACP 只写一次**（Grok/Kimi 共享）  
2. 异构 Adapter 隔离目录，禁止 if-else 污染 SessionManager  
3. UI 组件不 import 任何 runtime 私有类型  
4. 每个 Adapter 自带 mock，CI 不依赖真 CLI 账号  

---

## 11. 与「直接改 grok-app」的三种路径对比

| 路径 | 做法 | 优点 | 缺点 | 推荐 |
|------|------|------|------|------|
| **A. 新仓库 Workbench** | 抄 Host 思想重写多 runtime | 边界清晰、无单品牌包袱 | 前期多写壳 | **推荐** |
| **B. Fork grok-app** | 在 AcpClient 旁加 Adapter | 起步快 | 品牌/假设/数据目录纠缠 | 仅个人实验 |
| **C. 插件化 grok-app** | 上游 PR 多引擎 | 可回馈社区 | 产品目标不同，难合并 | 长期可讨论 |

**建议走路径 A**，在 `work` 下 greenfield；需要时从 grok-app **复制** FSM/permission/UI 模式，而不是 git fork 整仓。

---

## 12. 风险清单与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Codex App Server 协议变更 | Adapter 碎 | 版本矩阵 + schema 快照测试 |
| Claude 非 TTY 权限行为不一致 | 安全漏洞感 | Host 项目信任 + 文档诚实 + 能力降级 |
| 四引擎同时开发 | 永远做不完 | 严格 Phase：先 ACP 双引擎 |
| 会话上下文跨引擎丢失 | 编排鸡肋 | fork bootstrap + 产物文件传递（plan.md/diff） |
| 并发改同一仓库 | 冲突 | 活跃会话提示；编排默认串行写步骤 |
| 用户期望「一个大脑自动选 Agent」 | 范围膨胀 | P0 不做自动路由；P2 再做规则/手动模板 |

---

## 13. 成功指标（Dogfood）

| 指标 | 目标 |
|------|------|
| 日常是否还开多个 Agent CLI | 一周后 ≤1 个终端（仅调试） |
| 切换引擎成本 | ≤2 次点击新建/切换会话 |
| 权限误放行事故 | 默认 Ask 下为 0 次无提示写盘 |
| 双引擎稳定会话 | Grok + Kimi 连续 30 min 无崩溃 |
| 编排最小闭环 | 1 条「实现→Review」流水线可跑通 |

---

## 14. 建议的下一步（你拍板后我可以直接做）

1. **确认产品名 + D1–D8**（尤其是：P0 先做哪两个引擎）  
2. 在 `work` 下落地仓库骨架（Tauri + 空三栏 + Runtime Registry）  
3. 做 **Kimi ACP SPIKE**（最快验证多引擎抽象）  
4. 移植/重写 **通用 AcpTransport**，接通 Grok  
5. 写 `P0-能力矩阵.md` 并开始垂直切片  

---

## 附录 A · grok-app 可复用清单（思想 / 代码级）

| 模块 | 复用方式 |
|------|----------|
| `session_fsm.rs` | 几乎可原样迁入 Host |
| `permission.rs` + scope_key | 迁入后加 `runtime_id` 维度 |
| `acp_client.rs` | 泛化为 `runtime/acp/transport.rs` |
| `cli_probe.rs` | 扩展为多二进制探测表 |
| `SessionSnapshot` 事件投影 | 增加 `runtimeId` / `capabilities` |
| 三栏 UI / Composer / 权限条 | 交互模式复用，组件可重写以去品牌 |
| Doctor / Setup Wizard | 改为「多 CLI 健康面板」 |
| providers（中转） | 仅挂到支持 OpenAI-compatible 的 runtime（Grok 等） |

## 附录 B · 本机 CLI 探测结果（2026-07-24）

```
grok.exe   D:\tools\grok\bin\grok.exe          → agent stdio (ACP)
claude     D:\Nvm\node\node_global\claude      → stream-json / print
codex.exe  D:\codex\codex.exe                  → app-server --stdio
kimi.exe   D:\tools\kimi-code\bin\kimi.exe     → acp (ACP)
```

## 附录 C · 非目标（明确不做，避免做成大而无当）

- 云端 Agent 集群 / 自动 best-of-n 农场  
- 飞书/钉钉 IM 桥  
- 完整内嵌终端  
- 重写各家 Agent 工具系统  
- 企业 SSO / 多人实时协作  
- 「一个超级 Agent 自动决定用谁」作为 P0  

---

**结论：**  
最佳实践不是「四个 CLI 的标签页终端」，而是 **Host 权威 + Runtime Adapter + 统一会话/权限 + 可选编排**。  
以 grok-app 为单引擎指挥台范本，在 `work` 新建多引擎 Workbench；P0 用 **Grok + Kimi（双 ACP）** 验证架构，再扩 Claude / Codex，最后做流水线编排。
