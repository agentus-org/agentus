// The accent-as-TEXT derivation and the neutral text tokens, without a browser.
//
// Two reported defects, both filed from looking at the left rail under a blue accent:
//   ① 「左边那些字颜色不是很明显，不是很突出」 — the accent-as-text colour had been washed into the
//      neutral text's hue family. The old rule mixed toward white/black, which both greys the
//      colour AND lands it at the body text's hue; every contrast checker passed while the
//      operator's report stood. The rule now holds the hue and insists on a real CHROMA.
//   ② 「看不太清」 — the secondary text token (`--text-dim`) was 5.25:1 on the dark panel
//      (4.71:1 on a hovered row, under AA) *and* blue-grey like the body text, so a chromatic
//      accent had nothing to separate against. The token is now lighter/less blue.
//
// So this suite judges three things: the contrast floor, the CHROMA of the accent-as-text, and
// the neutral tokens read straight out of theme.css (including that the theme file's two copies
// of the light palette agree — an easy edit to miss). The last block runs the OLD rule and
// requires it to FAIL: an assertion the wrong implementation also passes is not evidence.
//
//   npx tsx scripts/qa/accent-text.mts
import { readFileSync } from "node:fs";
import { accentTextColor, contrastRatio } from "../../packages/web/src/theme";

const PANELS = { dark: "#121a22", light: "#ffffff" } as const;
// The presets the settings page offers (SettingsPage.tsx → ACCENTS).
const PRESETS = ["#ffb454", "#76bbdf", "#4ec9a0", "#8f7bd7", "#ff6b9d"];
const FLOOR = 4.8;
/** Saturation an accent-as-text colour must carry. */
const SAT_FLOOR = 0.72;
/** How far the accent must sit from the neutral secondary text, in saturation. */
const SEPARATION = 0.4;
/** A secondary text token must clear this on the surface it is drawn on. */
const DIM_FLOOR = 7.0;

let pass = 0;
let fail = 0;
const check = (ok: boolean, what: string, detail = ""): void => {
  if (ok) { pass += 1; console.log(`  ok   ${what}${detail ? `  — ${detail}` : ""}`); }
  else { fail += 1; console.log(`  FAIL ${what}${detail ? `  — ${detail}` : ""}`); }
};

// --- local helpers, deliberately NOT imported, so a bug in the module under test cannot
//     rewrite the judge -------------------------------------------------------------------
const rgb = (h: string): number[] => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const hsvS = (h: string): number => {
  const [r, g, b] = rgb(h).map((v) => v / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
};
/** absolute chroma: 0 = a grey, whatever its hue claims */
const chroma = (h: string): number => {
  const v = rgb(h);
  return (Math.max(...v) - Math.min(...v)) / 255;
};
/** HSL hue in degrees, for "did the hue survive" */
const hue = (h: string): number => {
  const [r0, g0, b0] = rgb(h).map((v) => v / 255);
  const mx = Math.max(r0, g0, b0);
  const mn = Math.min(r0, g0, b0);
  const d = mx - mn;
  if (d === 0) return 0;
  const hh = mx === r0 ? ((g0 - b0) / d + (g0 < b0 ? 6 : 0)) : mx === g0 ? ((b0 - r0) / d + 2) : ((r0 - g0) / d + 4);
  return (hh / 6) * 360;
};
const hueDelta = (a: string, b: string): number => {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
};
const mixOld = (a: string, b: string, t: number): string => {
  const A = rgb(a); const B = rgb(b);
  return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
};
// The rule this round replaced: linear mix toward white (dark) / black (light).
const oldRule = (accent: string, dark: boolean): string =>
  dark ? mixOld(accent, "#ffffff", 0.18) : mixOld(accent, "#000000", 0.42);

console.log("== ① the floor holds on every preset, both palettes ==");
for (const a of PRESETS) {
  for (const [mode, panel] of Object.entries(PANELS)) {
    const got = accentTextColor(a, panel);
    const cr = contrastRatio(got, panel);
    check(cr >= FLOOR, `${a} on ${mode}`, `${got} = ${cr.toFixed(2)}:1`);
  }
}

console.log("== ①b the derivation keeps the operator's HUE (it may only change how vivid) ==");
for (const a of PRESETS) {
  for (const [mode, panel] of Object.entries(PANELS)) {
    const got = accentTextColor(a, panel);
    check(hueDelta(got, a) <= 4, `${a} hue on ${mode}`, `${hue(a).toFixed(1)}° -> ${hue(got).toFixed(1)}°`);
  }
}

console.log("== ①c the derivation never makes the accent LESS colourful than the operator's own ==");
for (const a of PRESETS) {
  for (const [mode, panel] of Object.entries(PANELS)) {
    const got = accentTextColor(a, panel);
    check(hsvS(got) >= hsvS(a) - 0.01, `${a} on ${mode} keeps or gains chroma`,
      `${got}: hsv-saturation ${hsvS(a).toFixed(2)} -> ${hsvS(got).toFixed(2)}`);
  }
}
console.log("== ①c2 the reported case: the operator's blue reaches the chroma floor on both panels ==");
for (const [mode, panel] of Object.entries(PANELS)) {
  const got = accentTextColor("#76bbdf", panel);
  check(hsvS(got) >= 0.66, `#76bbdf on ${mode} is a real blue, not a brighter grey`,
    `${got} = hsv-saturation ${hsvS(got).toFixed(2)} (was ${hsvS("#76bbdf").toFixed(2)})`);
}
console.log("== ①c3 a saturated violet cannot clear both floors: contrast wins, chroma is not spent ==");
// Measured: #8f7bd7 at the chroma floor is ~3.0:1 on #121a22 — no lightness that
// keeps the floor is readable there. The rule must then prefer readability and NOT slip below
// the operator's own saturation (i.e. it must not wash the colour out to buy contrast).
{
  const got = accentTextColor("#8f7bd7", PANELS.dark);
  check(contrastRatio(got, PANELS.dark) >= FLOOR, "violet/dark is readable", `${got} = ${contrastRatio(got, PANELS.dark).toFixed(2)}:1`);
  check(hsvS(got) >= hsvS("#8f7bd7") - 0.01, "…and it did not buy that with desaturation",
    `hsv-saturation ${hsvS("#8f7bd7").toFixed(2)} -> ${hsvS(got).toFixed(2)}`);
}

console.log("== ①d a deliberately ACHROMATIC accent is left alone (saturating a grey invents red) ==");
for (const grey of ["#888888", "#a0a0a0", "#666666"]) {
  const got = accentTextColor(grey, PANELS.dark);
  check(chroma(got) <= chroma(grey) + 0.02, `${grey} stays grey`,
    `${got}, chroma ${chroma(grey).toFixed(3)} -> ${chroma(got).toFixed(3)}`);
}

console.log("== ①e the hand-tuned built-in amber still agrees with the derivation ==");
check(accentTextColor("#ffb454", PANELS.dark) === "#ffb454", "amber/dark == the accent itself");
const amberLight = accentTextColor("#ffb454", PANELS.light);
check(contrastRatio(amberLight, PANELS.light) >= FLOOR, "amber/light clears the floor",
  `${amberLight} = ${contrastRatio(amberLight, PANELS.light).toFixed(2)}:1`);
check(contrastRatio(amberLight, "#ffffff") < contrastRatio("#9c5a08", "#ffffff") * 1.6,
  "amber/light stays in the same neighbourhood as the hand-tuned #9c5a08", `${amberLight}`);

console.log("== ② the neutral tokens in theme.css (read out of the file, not assumed) ==");
const css = readFileSync(new URL("../../packages/web/src/theme.css", import.meta.url), "utf8")
  // comments are stripped first: they carry no braces, so a block's "selector" would otherwise
  // swallow the comment that precedes it and no lookup would ever match.
  .replace(/\/\*[\s\S]*?\*\//g, "");
/** every block in the stylesheet, keyed by its selector text */
const blocks = new Map<string, Map<string, string>>();
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].trim().replace(/\s+/g, " ");
  const toks = new Map<string, string>();
  for (const t of m[2].matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) toks.set(t[1], t[2].trim());
  if (toks.size) blocks.set(sel, toks);
}
const dark = blocks.get(":root");
const light = blocks.get(':root[data-theme="light"]');
const sysLight = blocks.get(':root[data-theme="system"]');
check(Boolean(dark && light && sysLight), "all three palette blocks are present",
  [...blocks.keys()].filter((k) => k.startsWith(":root")).join(" | "));

for (const [label, toks, panel, raised] of [
  ["dark", dark, "#121a22", "#182430"],
  ["light", light, "#ffffff", "#eaeef4"],
] as const) {
  if (!toks) { check(false, `${label} block readable`); continue; }
  const dim = toks.get("--text-dim") ?? "";
  const text = toks.get("--text") ?? "";
  check(contrastRatio(dim, panel) >= DIM_FLOOR, `${label} --text-dim on the panel`,
    `${dim} = ${contrastRatio(dim, panel).toFixed(2)}:1`);
  check(contrastRatio(dim, raised) >= DIM_FLOOR - 1.2, `${label} --text-dim on a hovered row`,
    `${dim} = ${contrastRatio(dim, raised).toFixed(2)}:1`);
  check(contrastRatio(text, panel) > contrastRatio(dim, panel) * 1.4, `${label} hierarchy: --text reads above --text-dim`,
    `${text} ${contrastRatio(text, panel).toFixed(1)}:1 vs ${dim} ${contrastRatio(dim, panel).toFixed(1)}:1`);
  // ②b the accent must be separable from the secondary text by CHROMA, not only by brightness.
  // 0.40 is demanded of the operator's own blue (①c2, the reported case); the universal bar is
  // 0.30 because a saturated violet cannot clear both floors on a near-black panel and contrast
  // wins there — 0.30 is still 2.5x the neutral's own saturation.
  for (const a of PRESETS) {
    const got = accentTextColor(a, panel);
    const gap = hsvS(got) - hsvS(dim);
    check(gap >= 0.30, `${a} separates from ${label} --text-dim by saturation`,
      `${hsvS(got).toFixed(2)} - ${hsvS(dim).toFixed(2)} = ${gap.toFixed(2)}`);
  }
}
// the @media copy of the light palette is hand-synced; a fix applied to one copy only is a bug
if (light && sysLight) {
  const keys = ["--bg", "--bg-panel", "--bg-raised", "--line", "--text", "--text-dim", "--accent-text"];
  check(keys.every((k) => light.get(k) === sysLight.get(k)), "the two light-palette copies agree",
    keys.filter((k) => light.get(k) !== sysLight.get(k)).map((k) => `${k}: ${light.get(k)} vs ${sysLight.get(k)}`).join("; ") || "all equal");
}

console.log("== the OLD rule FAILS these (an assertion the wrong implementation also passes is not evidence) ==");
{
  // dark: the old mix washed the colour toward the body text's hue family
  const old = oldRule("#76bbdf", true);
  check(hsvS(old) / hsvS("#76bbdf") < 0.95, "old rule loses saturation (dark blue)",
    `${old}: ${(hsvS(old) / hsvS("#76bbdf") * 100).toFixed(0)}% kept`);
  // and it would fail the new separation rule against the new neutral
  check(hsvS(old) - hsvS("#9eaab3") < SEPARATION, "old rule's colour would sit too close to the neutral",
    `gap ${(hsvS(old) - hsvS("#9eaab3")).toFixed(2)}`);
  // light: the old mix produced a slate that reads as grey at the same lightness
  const oldBlue = oldRule("#76bbdf", false);
  const newBlue = accentTextColor("#76bbdf", PANELS.light);
  check(chroma(newBlue) > chroma(oldBlue) * 1.5, "the derivation keeps visibly more colour than the old mix",
    `chroma ${chroma(oldBlue).toFixed(2)} -> ${chroma(newBlue).toFixed(2)} (${oldBlue} -> ${newBlue})`);
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
