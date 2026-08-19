import {
  IconChat,
  IconGitFork,
  IconPanel,
  IconPlus,
} from "./icons";
import { runtimeLabel } from "../lib/runtimes";
import type { OrchestrationTask } from "../lib/orchestration";

function taskStatusLabel(status: OrchestrationTask["status"]): string {
  if (status === "running") return "运行";
  if (status === "done") return "完成";
  if (status === "failed") return "失败";
  if (status === "ready") return "就绪";
  if (status === "blocked") return "等待";
  return "草稿";
}

export function OrchestrationSidebar({
  hidden,
  tasks,
  activeTaskId,
  onSelectTask,
  onCreateTask,
  onBackToChat,
  onHideSidebar,
  onToggleMaximize,
  onOpenAbout,
}: {
  hidden: boolean;
  tasks: OrchestrationTask[];
  activeTaskId: string;
  onSelectTask: (taskId: string) => void;
  onCreateTask: () => void;
  onBackToChat: () => void;
  onHideSidebar: () => void;
  onToggleMaximize: () => void;
  onOpenAbout: () => void;
}) {
  return (
    <aside
      className={"sidebar orchestration-sidebar" + (hidden ? " sidebar--hidden" : "")}
      aria-hidden={hidden}
    >
      <div
        className="sidebar-chrome"
        data-tauri-drag-region
        onDoubleClick={onToggleMaximize}
      >
        <button
          type="button"
          className="chrome-btn chrome-btn--traffic is-on"
          title="隐藏侧栏"
          onClick={onHideSidebar}
        >
          <IconPanel size={16} />
        </button>
        <button
          type="button"
          className="sidebar-brand-row__title-button sidebar-brand-row__title-button--compact"
          onClick={onOpenAbout}
          aria-label="查看 Workbench 应用信息"
          title="关于 Workbench"
        >
          Workbench
        </button>
        <div className="sidebar-chrome__drag" data-tauri-drag-region />
      </div>

      <div className="orchestration-sidebar__head">
        <div className="orchestration-sidebar__title">
          <span className="orchestration-sidebar__mark">
            <IconGitFork size={16} />
          </span>
          <div>
            <strong>编排任务</strong>
            <span>{tasks.length} 个本地任务</span>
          </div>
        </div>
        <button
          type="button"
          className="btn btn--ghost orchestration-sidebar__new"
          title="新建编排"
          onClick={onCreateTask}
        >
          <IconPlus size={15} />
          新建编排
        </button>
      </div>

      <div className="orchestration-sidebar__list" aria-label="编排任务列表">
        {tasks.length === 0 ? (
          <div className="sidebar-empty">还没有编排任务。</div>
        ) : null}
        {tasks.map((task) => {
          const runtimeIds = [...new Set(task.nodes.map((node) => node.runtimeId))];
          return (
            <button
              type="button"
              key={task.id}
              className={
                "orchestration-task-item" +
                (task.id === activeTaskId ? " is-active" : "")
              }
              onClick={() => onSelectTask(task.id)}
            >
              <span className="orchestration-task-item__top">
                <span className="orchestration-task-item__title">{task.title}</span>
                <span className={`orchestration-task-item__status is-${task.status}`}>
                  {taskStatusLabel(task.status)}
                </span>
              </span>
              <span className="orchestration-task-item__summary">{task.summary}</span>
              <span className="orchestration-task-item__meta">
                <span>{task.nodes.length} 节点</span>
                <span>{task.updatedAt}</span>
              </span>
              <span className="orchestration-task-item__runtimes">
                {runtimeIds.map((runtimeId) => (
                  <span key={runtimeId}>
                    <span className={`runtime-dot runtime-dot--${runtimeId}`} />
                    {runtimeLabel(runtimeId)}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="sidebar__footer orchestration-sidebar__back"
        title="返回聊天"
        onClick={onBackToChat}
      >
        <IconChat size={16} />
        <span className="sidebar__footer-name">返回聊天</span>
      </button>
    </aside>
  );
}
