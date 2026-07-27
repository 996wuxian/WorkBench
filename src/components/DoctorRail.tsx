import { IconDoctor, IconRefresh } from "./icons";
import { runtimeLabel } from "../lib/runtimes";
import type { ProbeResult } from "../lib/types";
import type { ReactNode } from "react";

type Props = {
  hidden: boolean;
  probes: ProbeResult[];
  routeDiagnosticsPanel: ReactNode;
  statusLine: string;
  onToggleMaximize: () => void;
  onRefresh: () => void;
};

export function DoctorRail({
  hidden,
  probes,
  routeDiagnosticsPanel,
  statusLine,
  onToggleMaximize,
  onRefresh,
}: Props) {
  return (
    <aside className={"aside" + (hidden ? " aside--hidden" : "")} aria-hidden={hidden}>
      <div className="aside__chrome" data-tauri-drag-region onDoubleClick={onToggleMaximize}>
        <span className="aside__chrome-title">
          <IconDoctor size={14} /> Doctor
        </span>
      </div>
      <div className="aside__body">
        <button
          type="button"
          className="btn btn--block"
          style={{ marginBottom: 12 }}
          onClick={onRefresh}
        >
          <IconRefresh size={15} />
          重新探测
        </button>
        {probes.map((probe) => (
          <div key={probe.runtimeId} className="probe-card">
            <div className="probe-card__row">
              <strong>{runtimeLabel(probe.runtimeId)}</strong>
              <span
                style={{
                  color: probe.found ? "var(--success)" : "var(--danger)",
                  fontSize: 11,
                }}
              >
                {probe.found ? "found" : "missing"}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6, wordBreak: "break-all" }}>
              {probe.path ?? "—"}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              {probe.version ?? probe.detail ?? ""}
            </div>
          </div>
        ))}
        <div className="sidebar__section-label" style={{ marginTop: 8 }}>
          路由
        </div>
        {routeDiagnosticsPanel}
        <div className="sidebar__section-label" style={{ marginTop: 8 }}>
          Host
        </div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
          {statusLine}
        </div>
      </div>
    </aside>
  );
}
