/**
 * The approval bar for a pending tool call.
 *
 * It is an `alertdialog` and not a modal on purpose: the agent is blocked on
 * this answer, but the user still needs to read the transcript above it to
 * decide. `aria-live="assertive"` covers the announcement the modal would give.
 */
import type { PermissionDecision, PermissionRequestEvent } from "../lib/types";

export interface PermissionBarProps {
  request: PermissionRequestEvent;
  /** Total queued requests, including this one. */
  pendingCount: number;
  disabled: boolean;
  onRespond: (request: PermissionRequestEvent, decision: PermissionDecision) => void;
}

export function PermissionBar({
  request,
  pendingCount,
  disabled,
  onRespond,
}: PermissionBarProps) {
  const title = request.title || request.toolName || "工具调用";
  const preview = request.preview.trim();

  return (
    <div
      className="permission-bar"
      role="alertdialog"
      aria-live="assertive"
      aria-label={`权限请求：${title}`}
    >
      <div className="permission-bar__text">
        <div className="permission-bar__head">
          <span className="permission-bar__badge">需要授权</span>
          <span className="permission-bar__title">{title}</span>
          <span className="permission-bar__question">是否允许？</span>
          {pendingCount > 1 ? (
            <span className="permission-bar__count">
              还有 {pendingCount - 1} 个待处理
            </span>
          ) : null}
        </div>
        {preview ? (
          <code className="permission-bar__preview">{preview}</code>
        ) : null}
      </div>
      <div className="permission-bar__actions">
        <button
          type="button"
          className="permission-btn permission-btn--allow"
          disabled={disabled}
          title="允许执行一次"
          onClick={() => onRespond(request, "allow_once")}
        >
          确认
        </button>
        <button
          type="button"
          className="permission-btn"
          disabled={disabled}
          title={`本次会话内始终允许 ${request.toolName}`}
          onClick={() => onRespond(request, "allow_always")}
        >
          本会话允许
        </button>
        <button
          type="button"
          className="permission-btn permission-btn--deny"
          disabled={disabled}
          onClick={() => onRespond(request, "deny")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}
