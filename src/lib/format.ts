/** Small presentation helpers shared across the UI. No app state, no I/O. */

/** Local-only id for messages the UI creates before the Host assigns one. */
export function uid(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function formatElapsedSeconds(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remain = seconds - minutes * 60;
    return `${minutes}m ${remain.toFixed(remain >= 10 ? 1 : 2)}s`;
  }
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
}

export function compactLabel(value: string, maxChars: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function formatSessionTime(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Copy via the async clipboard API, falling back to the legacy path: the Tauri
 * webview does not always expose `navigator.clipboard` on an insecure origin.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (!text.trim()) {
    throw new Error("empty content");
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "true");
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(el);
  if (!ok) {
    throw new Error("clipboard unavailable");
  }
}
