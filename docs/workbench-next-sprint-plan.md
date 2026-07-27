# Workbench 下一阶段方案

状态：等待确认
更新时间：2026-07-27
下一步：等待 wuxian 确认后进入 `X:\WorkBench` 实施。
阻塞：无

## 目标

把 Workbench 从“已能稳定接入 Grok / Codex”继续推进到“对更多原生 CLI 也能兜底使用”。

这一阶段的第一目标是：

1. 让不支持现有结构化协议的 CLI 也能在 Workbench 里继续同一个会话。
2. 保持会话列表、历史、权限、模型设置和现有原生会话存储不回退。
3. 把当前已经验证稳定的主链路保住，不做破坏性重构。

## 建议范围

### 第一优先级

- `X:\WorkBench\src-tauri\src\runtime\pty.rs`
- `X:\WorkBench\src-tauri\src\runtime\registry.rs`
- `X:\WorkBench\src-tauri\src\runtime\traits.rs`
- `X:\WorkBench\src-tauri\src\commands.rs`
- `X:\WorkBench\src\lib\types.ts`
- `X:\WorkBench\src\lib\api.ts`
- `X:\WorkBench\src\App.tsx`
- `X:\WorkBench\src\components\*`
- `X:\WorkBench\src\styles\app.css`

### 第二优先级

- `X:\WorkBench\src-tauri\src\settings.rs`
- `X:\WorkBench\src-tauri\src\session_manager.rs`
- `X:\WorkBench\src-tauri\src\session_store.rs`
- `X:\WorkBench\docs\*`

### 暂不碰

- 不改用户本机 `~\.codex` / `~\.grok`
- 不删现有 session journal
- 不做大规模目录搬迁
- 不新增无必要依赖

## 实施建议

### Phase 1：PTY Runtime 兜底

目标：把无法走 ACP / app-server 的 CLI 先接进来，保证它们至少能在 Workbench 里继续同一个会话。

要点：

1. 新增 `Pty` runtime。
2. 统一 session 生命周期和 UI event。
3. 让终端型 CLI 具备最小会话保存与恢复能力。
4. 保留现有 Grok / Codex 逻辑，不回退它们的协议接入。

### Phase 2：托盘 / 热键 / 通知

目标：把 Workbench 从“打开窗口才工作”补成真正常驻指挥台。

要点：

1. 托盘入口。
2. 全局热键唤起。
3. 会话结束/出错通知。

### Phase 3：项目工作区

目标：把会话和项目绑定起来，方便按项目查看、继承默认模型/权限/引擎。

要点：

1. 项目级分组。
2. 项目级默认 runtime / 模型 / 权限。
3. 项目信任列表与工作目录记忆。

### Phase 4：效率功能

目标：补 Workbench 相对终端的差异化能力。

要点：

1. Diff 审阅。
2. 跨引擎接力 / fork。
3. 全局搜索。
4. 命令面板。
5. 导出。

## 验证方法

- `cargo check`
- `cargo test session_fsm`
- `pnpm typecheck`
- `pnpm build:ui`
- `git diff --check`

人工验收：

- 新 runtime 能正常创建、连接、重连、关闭。
- 会话列表不丢历史。
- 原有 Grok / Codex 会话不受影响。
- 重启后会话仍可恢复。

## 回滚 / 清理

- 回滚本次新增的 runtime、UI、settings 和 session 相关改动。
- 不恢复或删除用户本机 CLI 数据。
- 不删除已有会话目录。

## 风险

- PTY runtime 的实现边界最宽，最容易把 UI 和 Host 的责任混在一起。
- 如果先做太多扩展功能，容易冲掉当前已经稳定的主线。
- 新增依赖前需要先确认是否真的必要。

## 需要确认

是否按这个顺序推进下一阶段：先做 PTY runtime 兜底，再做托盘/热键，然后再上项目工作区和效率功能？
