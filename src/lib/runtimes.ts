/**
 * Runtime display metadata, sourced from the Host's manifest registry.
 *
 * The frontend must not carry its own list of CLIs: adding one is supposed to
 * be a JSON manifest on the Host, so anything hardcoded here would silently
 * make new runtimes render as blanks. `hydrate()` is called once at startup and
 * again after a settings change; every lookup falls back to the raw id.
 */
import type { PermissionMode, RuntimeId, RuntimeInfo } from "./types";

let registry: RuntimeInfo[] = [];

/** Replace the cached registry. Returns the list for convenient chaining. */
export function hydrateRuntimes(runtimes: RuntimeInfo[]): RuntimeInfo[] {
  registry = runtimes;
  return runtimes;
}

export function allRuntimes(): RuntimeInfo[] {
  return registry;
}

export function enabledRuntimes(): RuntimeInfo[] {
  return registry.filter((r) => r.enabled);
}

export function runtimeInfo(id: RuntimeId | null | undefined) {
  if (!id) return undefined;
  return registry.find((r) => r.id === id);
}

/** Human label for a runtime; falls back to the id so nothing renders empty. */
export function runtimeLabel(id: RuntimeId | null | undefined): string {
  if (!id) return "Agent";
  return runtimeInfo(id)?.displayName ?? id;
}

export function runtimeSupportsPermissionMode(
  id: RuntimeId | null | undefined,
  mode: PermissionMode,
): boolean {
  const info = runtimeInfo(id);
  if (!info) return true;
  return info.permissionModes.length === 0 || info.permissionModes.includes(mode);
}

/**
 * True when the runtime can actually gate tool calls. Used to decide whether an
 * approval bar is worth showing at all, rather than assuming every CLI can.
 */
export function runtimeHasPermissionGate(
  id: RuntimeId | null | undefined,
): boolean {
  return runtimeInfo(id)?.capabilities.permissionGate ?? false;
}

/**
 * Bundled avatars. Optional by design: a runtime added through a user manifest
 * has no artwork here and falls back to the initial-dot treatment instead of a
 * broken image.
 */
export const runtimeAvatarSrc: Partial<Record<RuntimeId, string>> = {
  grok: "/runtime-icons/grok.webp",
  codex: "/runtime-icons/codex.png",
  claude: "/runtime-icons/claude.png",
};

export function runtimeAvatarLabel(id: RuntimeId): string {
  return `${runtimeLabel(id)} avatar`;
}
