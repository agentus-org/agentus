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

/** "system" + the OS preference resolved: which palette is actually on screen. */
function resolveDark(cfg: ThemeConfig): boolean {
  return cfg.mode === "dark"
    || (cfg.mode === "system" && typeof window !== "undefined"
        && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** Blend two #rrggbb colours, t = how much of `toward`. */
function mixHex(from: string, toward: string, t: number): string {
  const parse = (h: string) => {
    let s = h.replace("#", "");
    if (s.length === 3) s = s.split("").map((c) => c + c).join("");
    const n = Number.parseInt(s.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = parse(from);
  const b = parse(toward);
  const out = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Relative luminance, sRGB — used to decide whether a label on top of the accent
 *  needs to be dark or light, and (below) how far an accent has to move to be readable. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two #rrggbb colours (1 = identical, 21 = black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The floor an accent-as-TEXT colour must clear. 4.8 is WCAG AA for normal text; the extra
 *  0.3 is headroom, because these labels are 11–13.5px and are read as a *distinction* from
 *  the body text rather than as body text. */
const ACCENT_TEXT_FLOOR = 4.8;

/** The CHROMA an accent-as-TEXT colour must carry — measured in HSV saturation,
 *  `(max-min)/max`, because that is the "how far from grey is this" axis a reader sees and
 *  because HSL saturation is a poor proxy for it at high lightness (a pale blue and a vivid
 *  blue can share an HSL saturation and look nothing alike).
 *
 *  Contrast alone does not make an accent label read as the accent. This palette's neutral text
 *  is a blue-grey (`--text` #d7e2ea, `--text-dim` #9eaab3), so a pale, low-chroma accent drawn
 *  among it looks like "the same colour, slightly brighter" — the operator's report
 *  「左边那些字颜色不是很明显，不是很突出」, filed twice, and the measurement agreed with him: his
 *  #76bbdf sits at HSV 0.47 saturation, ~20 points below the neutral-adjacent greys it has to
 *  beat, while the built-in amber palette never showed the problem (it is authored at 0.67).
 *  So a chromatic accent is re-issued at this floor with hue held; the built-in amber is already
 *  above it and therefore untouched. */
const ACCENT_TEXT_SAT = 0.66;

/** Below this saturation the accent is not "a colour" at all — a deliberately grey accent
 *  (studio ships one) must stay grey, and re-saturating #888888 would invent red. */
const ACCENT_TEXT_SAT_MIN = 0.18;

/** HSV saturation of a #rrggbb colour: 0 for any grey, whatever its hue claims. */
function hsvSaturation(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(r, g, b);
  if (max === 0) return 0;
  return (max - Math.min(r, g, b)) / max;
}

/** The same colour at `target` HSV saturation (hue and value held), or the colour itself when it
 *  is already at least that vivid. Used to hold the operator's hue while insisting on chroma. */
function raiseHsvSaturation(hex: string, target: number): string {
  const [r0, g0, b0] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r0, g0, b0);
  const min = Math.min(r0, g0, b0);
  const d = max - min;
  if (max === 0 || d === 0) return hex; // a pure grey has no hue to hold
  if (d / max >= target) return hex;
  // +0.01 because the channels come back as integers: asking for exactly the floor can land a
  // hair under it (a sweep asserted >= 0.66 and measured 0.6599), and the floor is a floor.
  const want = Math.min(1, target + 0.01);
  // hue in turns, the same formula hexToHsl uses, then HSV -> RGB with the value held
  const hue = max === r0 ? ((g0 - b0) / d + (g0 < b0 ? 6 : 0)) / 6 : max === g0 ? ((b0 - r0) / d + 2) / 6 : ((r0 - g0) / d + 4) / 6;
  const c = max * want;
  const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
  const m = max - c;
  const seg = Math.floor(hue * 6) % 6;
  const parts: [number, number, number][] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  const [rr, gg, bb] = parts[seg];
  const to = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(rr)}${to(gg)}${to(bb)}`;
}

/** #rrggbb -> [hue, saturation, lightness] with all three in 0..1 (hue in turns). */
function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number): number => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The accent as TEXT: the operator's own colour, moved only as far as it must be.
 *
 *  Why this exists (measured 2026-10-09): the previous rule was a linear mix toward white
 *  (dark) / black (light). Mixing washes the saturation out, and the result landed in the
 *  SAME hue family as the body text — with the blue preset the wordmark became `#8fc7e5`, a
 *  pale blue-grey next to a `#d7e2ea` body text (9.6:1 contrast, so every contrast checker
 *  passed while the operator's report stood: 「左边那些字颜色不是很明显，不是很突出」), and on the
 *  light surface it came out WEAKER than the body text (5.7:1 vs 15.1:1) — an accent label
 *  cannot stand out by being the faintest thing on the screen.
 *
 *  So: hold the operator's hue, insist on a real CHROMA (a pale accent among a blue-grey palette
 *  reads as "the same colour, brighter"), and then move only LIGHTNESS as far as readability
 *  requires — never toward grey. Also read the floor against the surface the label is actually
 *  drawn on, so a light panel gets a darker label and a dark one a lighter one. */
export function accentTextColor(accent: string, panel: string): string {
  if (!hexToRgbTriplet(accent)) return accent;
  const [h, s, l0] = hexToHsl(accent);
  const dir = luminance(panel) > 0.5 ? -1 : 1; // a light surface needs a darker label, a dark one a lighter
  const readable = (hex: string): boolean => contrastRatio(hex, panel) >= ACCENT_TEXT_FLOOR;
  const chromatic = hsvSaturation(accent) >= ACCENT_TEXT_SAT_MIN;
  // Walk lightness outward from the operator's own, and at each stop take the VIVID candidate
  // whenever it is readable — that is the colour that reads as the accent rather than as grey.
  // When both are readable the vivid one wins; when only the untouched one is (a saturated violet
  // cannot clear the floor on a near-black panel at all) readability wins, and the saturation
  // still never drops below what the operator picked. Compare against the hex we started from,
  // so a fully-saturated accent is returned byte-identical.
  for (let step = 0; step <= 100; step += 1) {
    const ll = l0 + dir * step * 0.01;
    if (step > 0 && (ll <= 0 || ll >= 1)) break;
    const plain = step === 0 ? accent : hslToHex(h, s, ll);
    const vivid = chromatic ? raiseHsvSaturation(plain, ACCENT_TEXT_SAT) : plain;
    if (readable(vivid)) return vivid;
    if (readable(plain)) return plain;
  }
  return accent;
}

/** The surface an accent-coloured LABEL sits on — `.sidebar`'s wordmark, `+ new session`, the
 *  active tab, links, permission badges: all of them are drawn on `--bg-panel`. Read from the
 *  live stylesheet instead of duplicating the palette, so editing theme.css cannot leave this
 *  behind; the fallback covers a call before the stylesheet is applied (and any non-DOM call). */
function panelSurface(fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue("--bg-panel").trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
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
    // The palette hand-tunes three neighbours of the accent — the text variant (amber on a
    // light surface is ~2.7:1), the dim/border variant and the label colour on fills. Left
    // alone they keep the built-in amber, so a custom accent renders half-applied (blue
    // buttons with amber labels, which is exactly what the brand blue exposed). Derive them.
    const dark = resolveDark(config);
    // `--accent-text` is derived against the surface it is actually drawn on, read from the
    // stylesheet AFTER data-theme is set, so "system" resolves to the palette really in use.
    root.style.setProperty(
      "--accent-text",
      accentTextColor(config.accent, panelSurface(dark ? "#121a22" : "#ffffff")),
    );
    root.style.setProperty("--accent-dim", dark ? mixHex(config.accent, "#000000", 0.45) : mixHex(config.accent, "#ffffff", 0.45));
    root.style.setProperty("--on-accent", luminance(config.accent) > 0.45 ? "#101820" : "#f2f6fa");
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-text");
    root.style.removeProperty("--accent-dim");
    root.style.removeProperty("--on-accent");
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
  // The CSS flips its palette by itself when the OS theme changes, but the accent's derived
  // neighbours are set inline and would keep the other mode's values. Nudge them too.
  if (typeof window !== "undefined") {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(current));
  }
}

/** Which palette is actually on screen right now, system preference resolved.
 *  CSS switches itself with prefers-color-scheme, but an asset that cannot be recoloured
 *  in CSS (the brand mark ships as an <img> so the traced SVG stays one file) has to ask. */
export function useResolvedDark(): boolean {
  const cfg = useTheme();
  const systemDark = useSyncExternalStore(
    (fn) => {
      const mq = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
      mq?.addEventListener("change", fn);
      return () => mq?.removeEventListener("change", fn);
    },
    () => (typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)").matches : false),
  );
  return cfg.mode === "dark" || (cfg.mode === "system" && systemDark);
}
