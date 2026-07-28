export type UiFontSize = "small" | "default" | "large" | "xlarge";

export type UiFontSizeOption = {
  value: UiFontSize;
  label: string;
  scale: number;
};

export const UI_FONT_SIZE_OPTIONS: UiFontSizeOption[] = [
  { value: "small", label: "小", scale: 0.94 },
  { value: "default", label: "标准", scale: 1 },
  { value: "large", label: "大", scale: 1.08 },
  { value: "xlarge", label: "特大", scale: 1.16 },
];

const STORAGE_KEY = "workbench.uiFontSize";
const DEFAULT_FONT_SIZE: UiFontSize = "default";

function isUiFontSize(value: string | null | undefined): value is UiFontSize {
  return UI_FONT_SIZE_OPTIONS.some((option) => option.value === value);
}

export function loadUiFontSize(): UiFontSize {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (isUiFontSize(value)) return value;
  } catch {
    /* ignore */
  }
  return DEFAULT_FONT_SIZE;
}

export function applyUiFontSize(value: UiFontSize): void {
  const option =
    UI_FONT_SIZE_OPTIONS.find((item) => item.value === value) ??
    UI_FONT_SIZE_OPTIONS.find((item) => item.value === DEFAULT_FONT_SIZE)!;
  const root = document.documentElement;
  const scale = option.scale;
  root.style.setProperty("--ui-font-scale", String(scale));
  root.style.setProperty("--ui-text-2xs", `${roundPx(10 * scale)}px`);
  root.style.setProperty("--ui-text-xs", `${roundPx(11 * scale)}px`);
  root.style.setProperty("--ui-text-sm", `${roundPx(12 * scale)}px`);
  root.style.setProperty("--ui-text-md", `${roundPx(13 * scale)}px`);
  root.style.setProperty("--ui-text-base", `${roundPx(14 * scale)}px`);
  root.style.setProperty("--ui-text-lg", `${roundPx(16 * scale)}px`);
  root.style.setProperty("--text-xs", `${roundPx(12 * scale)}px`);
  root.style.setProperty("--text-sm", `${roundPx(13 * scale)}px`);
  root.style.setProperty("--text-md", `${roundPx(14 * scale)}px`);
  root.style.setProperty("--text-lg", `${roundPx(16 * scale)}px`);
}

export function saveUiFontSize(value: UiFontSize): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* ignore */
  }
  applyUiFontSize(value);
}

function roundPx(value: number): number {
  return Math.round(value * 100) / 100;
}
