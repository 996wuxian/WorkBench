# Workbench P0 改进路线

状态：P0-1 / P0-2 / P0-3 / P0-4 / P0-5 已完成  
更新时间：2026-08-17  
范围：不接入 deepseek-harness，只吸收其对 Workbench 有价值的架构思路。

## 原则

- Workbench 继续保持 Rust Host 权威、runtime adapter 隔离、UI 只消费统一事件。
- 不引入大型插件内核，不把 workflow 或权限策略塞进单个 runtime adapter。
- 每个 P0 都必须是可验证的垂直切片，避免一次性重构多个边界。

## P0-1 会话事件日志收敛

状态：已完成。

目标：`journal.jsonl` 从“UI 聊天消息镜像”升级为“会话事实日志”，同时继续兼容旧的裸消息行。

验收标准：

- 新写入的 journal 行使用版本化事件封套：`schemaVersion`、`event`、`sessionId`、`timestamp`。
- transcript 消息仍可由 journal replay 得到，旧 journal 不需要迁移。
- 非 transcript 事实可以进入 journal，但不会显示成聊天消息。
- 权限决策至少作为独立 fact 落盘，不记录 permission preview。

## P0-2 工具与权限策略管线

状态：已完成。

目标：各 runtime 只上报工具意图，Host 统一执行 project trust、permission mode、scope key、风险标签和日志记录。

验收标准：

- 引入统一 `ToolIntent` / `ToolPolicyDecision`。
- Grok、Codex、Claude、Kimi 的审批入口都经过同一 `PermissionBroker` 策略。
- UI 审批卡展示 Host 归一化的 intent / risk / scope。
- `read_only` 模式下，Host 自动拒绝明显非只读意图。

## P0-3 能力矩阵驱动 UI

状态：已完成。

目标：UI 按 manifest capabilities 渲染和降级，不按 runtime 名称特判。

验收标准：

- Doctor 展示安装、协议、权限、恢复、工具流、模型列表、推理档位等能力矩阵。
- Inspector 详情页展示当前会话 runtime 的能力和首个降级原因。
- Composer 推理档位按 `reasoningEffort` capability 启用，不按 runtime 名称判断。
- 缺失能力显示明确原因。

## P0-5 最小 Workflow 闭环

状态：已完成。

目标：先做一个固定但真实可用的跨会话流水线。

验收标准：

- 固定模板：实现 -> Review -> 修复建议。
- 每一步都是普通 Workbench session。
- 编排器只调用 `SessionManager.prompt()`，不直接调用 runtime adapter。
- 失败时暂停，可重试或换 runtime。

实现说明：

- 新建编排默认生成 `implement -> review -> fix` 固定链路。
- 前端编排器通过现有 `session_create` / `session_send` 创建和驱动普通会话，等待 `session://turn_settled` 后取回 transcript 作为下一步输入。
- 节点记录 `running/done/failed`、绑定 session id、最近执行时间和失败原因；运行失败时链路停在失败节点。

## P0-4 运行模式

状态：已撤回，暂不启用。

目标：把常用 runtime/model/permission 组合成可复用模式，减少每次新建会话的手动配置。

产品决策：

- 不在左侧栏或设置页暴露全局“运行模式 / Profile”。
- 权限仍是当前会话级设置，入口保留在聊天输入区的权限下拉框。
- 模型、推理档位和权限仍使用 runtime catalog 控制可选项；不支持多权限模式的 CLI 不显示不可用选项。

实现说明：

- 运行模式入口已从主 UI 断开；新建会话只按当前选择的 runtime 创建。
- 会话创建后，用户可在输入区直接调整模型、推理档位和权限。
- `runProfiles` 实验代码暂未删除；删除源码文件需单独确认。
