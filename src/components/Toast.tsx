import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";

import { TOAST_EVENT, type ToastPayload, type ToastTone } from "../lib/toast";

type ToastState = ToastPayload & {
  id: number;
  phase: "open" | "closing";
};

const EXIT_MS = 180;
const DEFAULT_DURATION = 1800;

function toastToneClassName(tone: ToastTone) {
  switch (tone) {
    case "success":
      return "app-toast--success";
    case "danger":
      return "app-toast--danger";
    default:
      return "app-toast--neutral";
  }
}

export function ToastViewport() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const nextIdRef = useRef(1);

  useEffect(() => {
    setPortalHost(document.querySelector(".app-shell") as HTMLElement | null);
  }, []);

  useEffect(() => {
    const clearTimers = () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };

    const close = () => {
      setToast((current) => {
        if (!current || current.phase === "closing") return current;
        return { ...current, phase: "closing" };
      });
      exitTimerRef.current = window.setTimeout(() => {
        setToast(null);
        exitTimerRef.current = null;
      }, EXIT_MS);
    };

    const onToast = (event: Event) => {
      const custom = event as CustomEvent<ToastPayload>;
      const payload = custom.detail;
      const tone = payload.tone ?? "success";
      const duration = payload.duration ?? DEFAULT_DURATION;
      clearTimers();
      setToast({
        id: nextIdRef.current,
        message: payload.message,
        tone,
        duration,
        phase: "open",
      });
      nextIdRef.current += 1;
      hideTimerRef.current = window.setTimeout(close, duration);
    };

    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      clearTimers();
    };
  }, []);

  if (!toast || !portalHost) return null;

  return createPortal(
    <div
      key={toast.id}
      className={`app-toast ${toastToneClassName(toast.tone ?? "success")}`}
      data-state={toast.phase}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {toast.message}
    </div>,
    portalHost,
  );
}
