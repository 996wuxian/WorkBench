import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  WindowControls,
  toggleMaximizeFromTitlebar,
} from "./components/WindowControls";
import { RuntimeSelect } from "./components/RuntimeSelect";
import {
  IconChat,
  IconDoctor,
  IconNewChat,
  IconPanel,
  IconPanelRight,
  IconPlug,
  IconRefresh,
  IconRobot,
  IconSearch,
  IconSend,
  IconSettings,
  IconStop,
  IconThemeMoon,
  IconThemeSun,
} from "./components/icons";
import { api, isTauri } from "./lib/api";
import { applyTheme, loadTheme, toggleTheme, type ThemeMode } from "./lib/theme";
import type {
  ChatMessage,
  ProbeResult,
  RuntimeId,
  SessionMeta,
  SessionSnapshot,
  SessionState,
} from "./lib/types";
import { P0_RUNTIMES, RUNTIME_LABEL } from "./lib/types";

function stateDotClass(state: SessionState): string {
  if (state === "ready" || state === "streaming") return "status-dot--ok";
  if (state === "connecting" || state === "awaiting_permission")
    return "status-dot--warn";
  if (state === "disconnected") return "status-dot--err";
  return "status-dot--idle";
}

function uid(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const runtimeAvatarSrc: Partial<Record<RuntimeId, string>> = {
  grok: "/runtime-icons/grok.webp",
  codex: "/runtime-icons/codex.png",
};

function runtimeAvatarLabel(runtimeId: RuntimeId): string {
  return `${RUNTIME_LABEL[runtimeId]} avatar`;
}

/** Browser-only fallback so `pnpm dev:ui` works without Tauri. */
function mockSessions(): SessionMeta[] {
  const t = nowIso();
  return [
    {
      id: "sess_demo_grok",
      title: "Grok · 示例会话",
      runtimeId: "grok",
      projectPath: "X:\\1_2026_project\\work",
      modelId: "grok-4.5",
      createdAt: t,
      updatedAt: t,
    },
    {
      id: "sess_demo_codex",
      title: "Codex · 示例会话",
      runtimeId: "codex",
      projectPath: "X:\\1_2026_project\\work",
      modelId: "default",
      createdAt: t,
      updatedAt: t,
    },
  ];
}

const idleSnapshot = (session?: SessionMeta | null): SessionSnapshot => ({
  sessionId: session?.id ?? null,
  runtimeId: session?.runtimeId ?? null,
  state: "idle",
  lastError: null,
  backend: session ? `${session.runtimeId}_stub` : "none",
  modelId: session?.modelId ?? null,
  projectPath: session?.projectPath ?? null,
  title: session?.title ?? "Workbench",
});

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(idleSnapshot());
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [messagesBySession, setMessagesBySession] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [draft, setDraft] = useState("");
  const [runtimePick, setRuntimePick] = useState<RuntimeId>("grok");
  const [busy, setBusy] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [asideHidden, setAsideHidden] = useState(false);
  const [sessionFilter, setSessionFilter] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());
  const [statusLine, setStatusLine] = useState(
    isTauri() ? "Connecting Host…" : "UI preview mode (no Tauri)",
  );

  // Keep native window fill in sync (boot + theme toggles already call applyTheme).
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );
  const messages = activeId ? (messagesBySession[activeId] ?? []) : [];
  const activeIdRef = useRef<string | null>(null);
  const mockReplyTimerRef = useRef<number | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    return () => {
      if (mockReplyTimerRef.current !== null) {
        window.clearTimeout(mockReplyTimerRef.current);
      }
    };
  }, []);

  const updateSessionMessages = useCallback(
    (sessionId: string, updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      setMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: updater(prev[sessionId] ?? []),
      }));
    },
    [],
  );

  // Host → UI stream / state events (real ACP path)
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unsubs: Array<() => void> = [];

    void (async () => {
      const u1 = await listen<{
        sessionId: string;
        kind: string;
        text: string;
        done: boolean;
      }>("session://stream", (ev) => {
        if (cancelled) return;
        const p = ev.payload;
        if (p.kind === "thought") {
          updateSessionMessages(p.sessionId, (m) => {
            const last = m[m.length - 1];
            if (last?.role === "thought" && last.streaming) {
              return [
                ...m.slice(0, -1),
                { ...last, content: last.content + p.text },
              ];
            }
            return [
              ...m,
              {
                id: uid("th"),
                role: "thought",
                content: p.text,
                streaming: true,
              },
            ];
          });
          return;
        }
        // assistant
        updateSessionMessages(p.sessionId, (m) => {
          const last = m[m.length - 1];
          if (last?.role === "assistant" && last.streaming) {
            const next = {
              ...last,
              content: last.content + (p.text || ""),
              streaming: !p.done,
            };
            return [...m.slice(0, -1), next];
          }
          if (p.text || !p.done) {
            return [
              ...m,
              {
                id: uid("a"),
                role: "assistant",
                content: p.text || "",
                streaming: !p.done,
              },
            ];
          }
          // done with empty text — close open assistant bubble
          if (last?.role === "assistant" && last.streaming) {
            return [...m.slice(0, -1), { ...last, streaming: false }];
          }
          return m;
        });
      });
      if (!cancelled) unsubs.push(u1);

      const u2 = await listen<SessionSnapshot>("session://state", (ev) => {
        if (cancelled) return;
        const snap = ev.payload;
        if (snap.sessionId && snap.sessionId === activeIdRef.current) {
          setSnapshot(snap);
        }
      });
      if (!cancelled) unsubs.push(u2);

      const u3 = await listen<{
        sessionId: string;
        title: string;
        name: string;
        status: string;
      }>("session://tool", (ev) => {
        if (cancelled) return;
        updateSessionMessages(ev.payload.sessionId, (m) => [
          ...m,
          {
            id: uid("tool"),
            role: "tool",
            content: `⚙ ${ev.payload.title || ev.payload.name} · ${ev.payload.status}`,
          },
        ]);
      });
      if (!cancelled) unsubs.push(u3);

      const u4 = await listen<{
        sessionId: string;
        code: string;
        message: string;
      }>("session://error", (ev) => {
        if (cancelled) return;
        updateSessionMessages(ev.payload.sessionId, (m) => [
          ...m,
          {
            id: uid("sys"),
            role: "system",
            content: `error ${ev.payload.code}: ${ev.payload.message}`,
          },
        ]);
      });
      if (!cancelled) unsubs.push(u4);

      const u5 = await listen<{ sessionId: string; stopReason: string }>(
        "session://prompt_complete",
        (ev) => {
          if (cancelled) return;
          updateSessionMessages(ev.payload.sessionId, (m) =>
            m.map((msg) =>
              msg.streaming ? { ...msg, streaming: false } : msg,
            ),
          );
        },
      );
      if (!cancelled) unsubs.push(u5);
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [updateSessionMessages]);

  const refreshProbes = useCallback(async () => {
    if (!isTauri()) {
      setProbes([
        {
          runtimeId: "grok",
          found: true,
          path: "D:\\tools\\grok\\bin\\grok.exe",
          version: "0.2.111",
          detail: "browser mock",
        },
        {
          runtimeId: "codex",
          found: true,
          path: "D:\\codex\\codex.exe",
          version: "0.144.4",
          detail: "browser mock",
        },
      ]);
      return;
    }
    try {
      const list = await api.probeAll();
      setProbes(list);
    } catch (e) {
      setStatusLine(`probe failed: ${String(e)}`);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    if (!isTauri()) {
      const list = mockSessions();
      setSessions(list);
      setActiveId(list[0]?.id ?? null);
      setSnapshot(idleSnapshot(list[0]));
      if (list[0]) {
        setMessagesBySession({
          [list[0].id]: [
            {
              id: uid("sys"),
              role: "system",
              content:
                "Workbench 骨架已就绪。当前为浏览器预览；`pnpm dev`（Tauri）后走真实 Host 命令。P0 引擎：Grok + Codex。",
            },
          ],
        });
      }
      setStatusLine("UI preview · mock sessions");
      return;
    }

    try {
      const info = await api.appInfo();
      setStatusLine(`${info.name} ${info.version} · ${info.dataDir}`);
      const list = await api.listSessions();
      setSessions(list);
      if (list.length > 0) {
        const first = list[0];
        setActiveId(first.id);
        const snap = await api.getSnapshot(first.id);
        setSnapshot(snap);
      } else {
        setActiveId(null);
        setSnapshot(idleSnapshot());
      }
    } catch (e) {
      setStatusLine(`host error: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    void refreshProbes();
  }, [loadSessions, refreshProbes]);

  async function selectSession(id: string) {
    setActiveId(id);
    const meta = sessions.find((s) => s.id === id);
    if (!isTauri()) {
      setSnapshot(idleSnapshot(meta));
      return;
    }
    try {
      const snap = await api.getSnapshot(id);
      setSnapshot(snap);
    } catch (e) {
      setStatusLine(String(e));
    }
  }

  async function createSession() {
    setBusy(true);
    try {
      if (!isTauri()) {
        const meta: SessionMeta = {
          id: uid("sess"),
          title: `${RUNTIME_LABEL[runtimePick]} · 新会话`,
          runtimeId: runtimePick,
          projectPath: "X:\\1_2026_project\\work",
          modelId: runtimePick === "grok" ? "grok-4.5" : "default",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        setSessions((prev) => [meta, ...prev]);
        setActiveId(meta.id);
        setSnapshot(idleSnapshot(meta));
        updateSessionMessages(meta.id, () => [
          {
            id: uid("sys"),
            role: "system",
            content: `已创建 ${RUNTIME_LABEL[runtimePick]} 会话（预览）。`,
          },
        ]);
        return;
      }
      const meta = await api.createSession(runtimePick, null);
      setSessions((prev) => [meta, ...prev]);
      setActiveId(meta.id);
      const snap = await api.getSnapshot(meta.id);
      setSnapshot(snap);
      updateSessionMessages(meta.id, () => [
        {
          id: uid("sys"),
          role: "system",
          content: `Session created · runtime=${meta.runtimeId}`,
        },
      ]);
    } catch (e) {
      setStatusLine(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function connectActive() {
    if (!active) return;
    setBusy(true);
    try {
      if (!isTauri()) {
        setSnapshot({
          ...idleSnapshot(active),
          state: "ready",
          backend: `${active.runtimeId}_mock`,
        });
        updateSessionMessages(active.id, (m) => [
          ...m,
          {
            id: uid("sys"),
            role: "system",
            content: `Connected (mock) · ${active.runtimeId}`,
          },
        ]);
        return;
      }
      const snap = await api.connect(active.id);
      setSnapshot(snap);
    } catch (e) {
      setStatusLine(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !active) return;
    const session = active;
    setDraft("");
    const userMsg: ChatMessage = {
      id: uid("u"),
      role: "user",
      content: text,
      runtimeId: session.runtimeId,
    };
    updateSessionMessages(session.id, (m) => [...m, userMsg]);

    if (!isTauri()) {
      setSnapshot((s) => ({ ...s, state: "streaming" }));
      mockReplyTimerRef.current = window.setTimeout(() => {
        updateSessionMessages(session.id, (m) => [
          ...m,
          {
            id: uid("a"),
            role: "assistant",
            content: `[${RUNTIME_LABEL[session.runtimeId]} stub]\n收到：${text}\n\n下一步会接入真实 Adapter（Grok ACP / Codex App Server）。`,
            runtimeId: session.runtimeId,
          },
        ]);
        if (activeIdRef.current === session.id) {
          setSnapshot((s) => ({ ...s, state: "ready" }));
        }
        mockReplyTimerRef.current = null;
      }, 400);
      return;
    }

    try {
      setBusy(true);
      // Open an assistant bubble; stream chunks append via session://stream.
      updateSessionMessages(session.id, (m) => [
        ...m,
        {
          id: uid("a"),
          role: "assistant",
          content: "",
          runtimeId: session.runtimeId,
          streaming: true,
        },
      ]);
      setSnapshot((s) => ({ ...s, state: "streaming" }));
      await api.send(session.id, text);
    } catch (e) {
      updateSessionMessages(session.id, (m) => [
        ...m.filter((msg) => !(msg.role === "assistant" && msg.streaming && !msg.content)),
        {
          id: uid("sys"),
          role: "system",
          content: `send failed: ${String(e)}`,
        },
      ]);
      if (activeIdRef.current === session.id) {
        setSnapshot((s) => ({ ...s, state: "disconnected" }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function stopActive() {
    if (!active) return;

    if (!isTauri() && mockReplyTimerRef.current !== null) {
      window.clearTimeout(mockReplyTimerRef.current);
      mockReplyTimerRef.current = null;
    }

    const sessionId = active.id;
    updateSessionMessages(sessionId, (m) =>
      m.map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg)),
    );
    setSnapshot((s) =>
      s.state === "streaming" || s.state === "awaiting_permission"
        ? { ...s, state: "ready" }
        : s,
    );
    setBusy(false);

    if (!isTauri()) return;

    try {
      await api.stop(active.id);
      const snap = await api.getSnapshot(active.id);
      setSnapshot(snap);
    } catch (e) {
      setStatusLine(`stop failed: ${String(e)}`);
    }
  }

  const filteredSessions = useMemo(() => {
    const q = sessionFilter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.runtimeId.includes(q) ||
        (s.modelId ?? "").toLowerCase().includes(q),
    );
  }, [sessions, sessionFilter]);

  const streaming = snapshot.state === "streaming";

  return (
    <div
      className="app-shell platform-win has-custom-chrome"
      data-theme={theme}
    >
      <WindowControls visible={isTauri()} />

      <div className="workbench">
        {/* ── Left rail ── */}
        <aside
          className={"sidebar" + (sidebarHidden ? " sidebar--hidden" : "")}
          aria-hidden={sidebarHidden}
        >
          <div
            className="sidebar-chrome"
            data-tauri-drag-region
            onDoubleClick={() => void toggleMaximizeFromTitlebar()}
          >
            <button
              type="button"
              className="chrome-btn chrome-btn--traffic is-on"
              title="隐藏侧栏"
              onClick={() => setSidebarHidden(true)}
            >
              <IconPanel size={16} />
            </button>
            <div className="sidebar-chrome__drag" data-tauri-drag-region />
          </div>

          <div className="sidebar-brand-row">
            <div className="sidebar-brand-row__left">
              <img
                className="app-logo"
                src="/logo.png"
                alt=""
                width={28}
                height={28}
                draggable={false}
              />
              <span>Workbench</span>
            </div>
          </div>

          <div className="sidebar-nav">
            <div className="sidebar-runtime-pick">
              <RuntimeSelect
                value={runtimePick}
                onChange={setRuntimePick}
                aria-label="默认引擎"
                title="新建会话使用的引擎"
                options={(
                  [
                    { id: "grok", label: "Grok Build", hint: "ACP · 真连接" },
                    { id: "codex", label: "Codex", hint: "App Server · stub" },
                  ] as const
                ).filter((o) => P0_RUNTIMES.includes(o.id))}
              />
            </div>
            <div className="sidebar-nav__new-row">
              <button
                type="button"
                className="nav-new"
                disabled={busy}
                onClick={() => void createSession()}
              >
                <span className="nav-item__icon">
                  <IconNewChat size={16} />
                </span>
                新建会话
              </button>
              <button
                type="button"
                className={"chrome-btn" + (showSearch ? " is-on" : "")}
                title="搜索会话"
                onClick={() => {
                  setShowSearch((v) => !v);
                  if (showSearch) setSessionFilter("");
                }}
              >
                <IconSearch size={16} />
              </button>
            </div>
          </div>

          {showSearch && (
            <div className="session-filter">
              <input
                className="session-filter__input"
                aria-label="过滤会话"
                placeholder="过滤会话…"
                value={sessionFilter}
                onChange={(e) => setSessionFilter(e.target.value)}
                autoFocus
              />
            </div>
          )}

          <div className="sidebar__scroll">
            <div className="sidebar__section-label">Sessions</div>
            {filteredSessions.length === 0 && (
              <div className="sidebar-empty">
                {sessions.length === 0
                  ? "还没有会话。点上方「新建会话」。"
                  : "没有匹配的会话。"}
              </div>
            )}
            {filteredSessions.map((s) => (
              <button
                type="button"
                key={s.id}
                className={
                  "session-item" + (activeId === s.id ? " session-item--active" : "")
                }
                onClick={() => void selectSession(s.id)}
              >
                <span className={`runtime-dot runtime-dot--${s.runtimeId}`} />
                <span className="session-item__body">
                  <span className="session-item__title">{s.title}</span>
                  <span className="session-item__meta">
                    {RUNTIME_LABEL[s.runtimeId]}
                    {s.modelId ? ` · ${s.modelId}` : ""}
                  </span>
                </span>
                <span className="session-item__actions">
                  <span className="nav-item__icon" title={s.runtimeId}>
                    {s.runtimeId === "grok" ? (
                      <IconRobot size={14} />
                    ) : (
                      <IconPlug size={14} />
                    )}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <button type="button" className="sidebar__footer" title="设置（占位）">
            <IconSettings size={16} />
            <span className="sidebar__footer-meta">
              <span className="sidebar__footer-name">设置</span>
              <span className="sidebar__footer-sub">主题 · 引擎 · 权限</span>
            </span>
          </button>
        </aside>

        {/* ── Main ── */}
        <main className={"main" + (asideHidden ? " main--aside-hidden" : "")}>
          <div
            className="main__top"
            data-tauri-drag-region
            onDoubleClick={() => void toggleMaximizeFromTitlebar()}
          >
            <div className="main__title-row" data-tauri-drag-region>
              {sidebarHidden && (
                <button
                  type="button"
                  className="chrome-btn chrome-btn--traffic"
                  title="显示侧栏"
                  onClick={() => setSidebarHidden(false)}
                >
                  <IconPanel size={16} />
                </button>
              )}
              {active ? (
                <>
                  <h1 className="main__title" data-tauri-drag-region>
                    {active.title}
                  </h1>
                  <span className={`status-dot ${stateDotClass(snapshot.state)}`} />
                  <span className="main__sub">
                    {snapshot.state} · {snapshot.backend}
                  </span>
                </>
              ) : (
                <>
                  <IconChat size={16} />
                  <h1 className="main__title">Workbench</h1>
                  <span className="main__sub">{statusLine}</span>
                </>
              )}
            </div>
            <div className="main__top-actions">
              {active && (
                <button
                  type="button"
                  className="chrome-btn"
                  title="Connect / 重新附着"
                  disabled={busy}
                  onClick={() => void connectActive()}
                >
                  <IconPlug size={16} />
                </button>
              )}
              <button
                type="button"
                className="chrome-btn"
                title={theme === "dark" ? "切换亮色" : "切换暗色"}
                onClick={() => setTheme((t) => toggleTheme(t))}
              >
                {theme === "dark" ? (
                  <IconThemeSun size={16} />
                ) : (
                  <IconThemeMoon size={16} />
                )}
              </button>
              <button
                type="button"
                className={"chrome-btn" + (!asideHidden ? " is-on" : "")}
                title={asideHidden ? "显示 Doctor" : "隐藏 Doctor"}
                onClick={() => setAsideHidden((v) => !v)}
              >
                <IconPanelRight size={16} />
              </button>
            </div>
          </div>

          {!active ? (
            <div className="empty-state">
              <div>
                <div className="empty-state__icon">
                  <img
                    className="app-logo app-logo--lg"
                    src="/logo.png"
                    alt=""
                    width={48}
                    height={48}
                    draggable={false}
                  />
                </div>
                <div className="empty-state__title">Workbench</div>
                <div>本机多 Agent 指挥台</div>
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  左侧选择引擎并新建会话 · Grok 已接真 ACP
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="message-list">
                {messages.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-state__icon">
                      <IconChat size={28} />
                    </div>
                    直接输入发送。Grok 走真 ACP；Codex 仍为 stub。
                  </div>
                ) : (
                  messages.map((m) => {
                    const visualRole =
                      m.role === "thought" || m.role === "tool" ? "system" : m.role;
                    const messageRuntime =
                      m.runtimeId ?? active.runtimeId ?? snapshot.runtimeId ?? "grok";
                    const avatarSrc =
                      m.role === "assistant" ? runtimeAvatarSrc[messageRuntime] : null;
                    const messageContent = (
                      <>
                        {m.content || (m.streaming ? "…" : "")}
                        {m.streaming ? (
                          <span className="muted" style={{ marginLeft: 6 }}>
                            ▍
                          </span>
                        ) : null}
                      </>
                    );

                    if (!avatarSrc) {
                      return (
                        <div
                          key={m.id}
                          className={`message message--${visualRole}`}
                          style={
                            m.role === "thought"
                              ? { opacity: 0.75, fontStyle: "italic" }
                              : undefined
                          }
                        >
                          {messageContent}
                        </div>
                      );
                    }

                    return (
                      <div key={m.id} className="message-row message-row--assistant">
                        <img
                          className={`message-avatar message-avatar--${messageRuntime}`}
                          src={avatarSrc}
                          alt=""
                          title={runtimeAvatarLabel(messageRuntime)}
                          width={30}
                          height={30}
                          draggable={false}
                        />
                        <div className="message message--assistant">
                          {messageContent}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="composer">
                <div className="composer__shell">
                  <div className="composer__toolbar">
                    <span className="chip chip--active">
                      <span className={`runtime-dot runtime-dot--${active.runtimeId}`} />
                      {RUNTIME_LABEL[active.runtimeId]}
                    </span>
                    <span className="chip">
                      {active.modelId ?? "default"}
                    </span>
                    <span className="chip">perm: auto</span>
                  </div>
                  <textarea
                    className="composer__input"
                    placeholder={`Message ${RUNTIME_LABEL[active.runtimeId]}…`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void sendMessage();
                      }
                    }}
                  />
                  <div className="composer__footer">
                    <span className="muted" style={{ fontSize: 12 }}>
                      Enter 发送 · Shift+Enter 换行
                    </span>
                    {streaming ? (
                      <button
                        type="button"
                        className="composer__send is-stop"
                        title="停止"
                        onClick={() => void stopActive()}
                      >
                        <IconStop size={16} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="composer__send"
                        title="发送"
                        disabled={!draft.trim() || busy}
                        onClick={() => void sendMessage()}
                      >
                        <IconSend size={16} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </main>

        {/* ── Right Doctor rail ── */}
        <aside
          className={"aside" + (asideHidden ? " aside--hidden" : "")}
          aria-hidden={asideHidden}
        >
          <div
            className="aside__chrome"
            data-tauri-drag-region
            onDoubleClick={() => void toggleMaximizeFromTitlebar()}
          >
            <span className="aside__chrome-title">
              <IconDoctor size={14} /> Doctor
            </span>
          </div>
          <div className="aside__body">
            <button
              type="button"
              className="btn btn--block"
              style={{ marginBottom: 12 }}
              onClick={() => void refreshProbes()}
            >
              <IconRefresh size={15} />
              重新探测
            </button>
            {probes.map((p) => (
              <div key={p.runtimeId} className="probe-card">
                <div className="probe-card__row">
                  <strong>{RUNTIME_LABEL[p.runtimeId]}</strong>
                  <span
                    style={{
                      color: p.found ? "var(--success)" : "var(--danger)",
                      fontSize: 11,
                    }}
                  >
                    {p.found ? "found" : "missing"}
                  </span>
                </div>
                <div
                  className="muted"
                  style={{ fontSize: 11, marginTop: 6, wordBreak: "break-all" }}
                >
                  {p.path ?? "—"}
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {p.version ?? p.detail ?? ""}
                </div>
              </div>
            ))}
            <div className="sidebar__section-label" style={{ marginTop: 8 }}>
              Host
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
              {statusLine}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
