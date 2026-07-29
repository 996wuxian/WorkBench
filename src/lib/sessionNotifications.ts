import { isTauri } from "./api";
import type { SessionUnreadKind } from "./types";

export async function notifySessionResult(
  message: string,
  kind: SessionUnreadKind,
  windowIsBackground: boolean,
): Promise<void> {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification("Workbench", { body: message });
    } catch {
      // Some WebViews expose Notification but reject construction.
    }
  }

  if (!isTauri() || !windowIsBackground) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import(
      "@tauri-apps/api/window"
    );
    await getCurrentWindow().requestUserAttention(
      kind === "completed"
        ? UserAttentionType.Informational
        : UserAttentionType.Critical,
    );
  } catch {
    // The unread badge remains the durable fallback when native attention fails.
  }
}
