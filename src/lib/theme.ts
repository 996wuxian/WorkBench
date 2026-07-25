import { invoke } from "@tauri-apps/api/core";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "workbench.theme";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return "dark";
}

/** CSS theme + native window fill (avoids dark corners under border-radius). */
export function applyTheme(theme: ThemeMode): void {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
  // Match --bg-app so body flash / corner bleed matches shell
  document.documentElement.style.background =
    theme === "light" ? "#f4f4f5" : "#0d0d0d";
  if (document.body) {
    document.body.style.background =
      theme === "light" ? "#f4f4f5" : "#0d0d0d";
  }
  if (isTauri()) {
    void invoke("window_set_theme", { theme }).catch(() => {
      /* host not ready */
    });
  }
}

export function saveTheme(theme: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  applyTheme(theme);
}

export function toggleTheme(current: ThemeMode): ThemeMode {
  const next: ThemeMode = current === "dark" ? "light" : "dark";
  saveTheme(next);
  return next;
}
