// Theme: the palette choice, in one place.
//
// Why a module and not a useState in App:
//  * it has to paint before React mounts — the login card is part of the app, and a
//    white flash on a dark screen (or the reverse) is the first thing an operator sees;
//  * the choice is a config item: it is mirrored to the server (settings.ts) so the same
//    operator lands on the same palette from another device or browser.
// The localStorage copy is what makes the FIRST frame right; the server copy is the
// source of truth once it answers (/api/settings).
import { useSyncExternalStore } from "react";

export interface ThemeConfig {
  /** "system" = follow the OS. The CSS does the switching (prefers-color-scheme), so a
   *  system flip repaints even without a click. */
  mode: "system" | "light" | "dark";
  /** "" = the built-in amber; otherwise a #hex colour that retints the whole cockpit */
  accent: string;
}

export const THEME_DEFAULT: ThemeConfig = { mode: "system", accent: "" };
const KEY = "agentus.theme";
const ACCENT_FALLBACK = "#ffb454";

const listeners = new Set<() => void>();
let current: ThemeConfig = readCache();

function readCache(): ThemeConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...THEME_DEFAULT };
    return normalizeTheme(JSON.parse(raw));
  } catch {
    return { ...THEME_DEFAULT };
  }
}

export function normalizeTheme(raw: unknown): ThemeConfig {
  const o = (raw ?? {}) as Partial<ThemeConfig>;
  const mode = o.mode === "light" || o.mode === "dark" ? o.mode : "system";
  const accent = typeof o.accent === "string" && hexToRgbTriplet(o.accent) ? o.accent : "";
  return { mode, accent };
}

/** "#ffb454" -> "255, 180, 84" (for rgba() in the stylesheet), or null when not a hex. */
export function hexToRgbTriplet(hex: string): string | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(String(hex ?? "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = Number.parseInt(h.slice(0, 6), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

export function themeConfig(): ThemeConfig {
  return current;
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTheme(): ThemeConfig {
  return useSyncExternalStore(subscribeTheme, themeConfig);
}

/** Write the choice onto <html>: data-theme drives the palette, the two custom
 *  properties drive the accent (and every rgba() that is derived from it). */
export function applyTheme(config: ThemeConfig): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const rgb = config.accent ? hexToRgbTriplet(config.accent) : null;
  root.dataset.theme = config.mode;
  if (config.accent && rgb) {
    root.style.setProperty("--accent", config.accent);
    root.style.setProperty("--accent-rgb", rgb);
  } else {
    root.style.removeProperty("--accent");
    root.style.setProperty("--accent-rgb", hexToRgbTriplet(ACCENT_FALLBACK) ?? "255, 180, 84");
  }
  // native widgets (scrollbars, form controls, the caret) follow this
  root.style.colorScheme = config.mode === "system" ? "" : config.mode;
}

export function setThemeLocal(next: ThemeConfig): void {
  current = normalizeTheme(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode: the choice just does not persist */
  }
  applyTheme(current);
  for (const fn of listeners) fn();
}

/** Adopt what the server says without pushing it back (used at boot / after login). */
export function adoptServerTheme(raw: unknown): void {
  const next = normalizeTheme(raw);
  if (next.mode === current.mode && next.accent === current.accent) return;
  setThemeLocal(next);
}

/** Persist to the server. Failure is reported, not thrown: the local choice already
 *  applied, and losing it should not block the settings page. */
export async function pushTheme(next: ThemeConfig): Promise<string> {
  setThemeLocal(next);
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: current }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return data.error ?? `save failed (${res.status})`;
    }
    const data = (await res.json()) as { theme?: unknown };
    adoptServerTheme(data.theme);
    return "";
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

/** Ask the server for the operator's saved palette and adopt it. */
export async function loadServerTheme(): Promise<void> {
  try {
    const res = await fetch("/api/settings", { credentials: "same-origin" });
    if (!res.ok) return;
    const data = (await res.json()) as { theme?: unknown };
    adoptServerTheme(data.theme);
  } catch {
    /* offline / not logged in: the cached choice stands */
  }
}

/** Paint the cached choice now — call once, before the first render. */
export function bootstrapTheme(): void {
  applyTheme(current);
}
