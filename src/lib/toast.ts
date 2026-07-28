export type ToastTone = "neutral" | "success" | "danger";

export type ToastPayload = {
  message: string;
  tone?: ToastTone;
  duration?: number;
};

export const TOAST_EVENT = "workbench-toast";

export function emitToast(payload: string | ToastPayload): void {
  if (typeof window === "undefined") return;
  const detail = typeof payload === "string" ? { message: payload } : payload;
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail }));
}
