// The accent-as-TEXT derivation, without a browser.
//
// The reported defect was not a contrast failure — the old derived colour cleared AA on every
// preset — it was that the colour had been washed into the BODY TEXT's hue family, so the
// accent words stopped standing out (「左边那些字颜色不是很明显」). So the assertions here are
// about BOTH: the contrast floor, and that the derivation still looks like the operator's own
// colour. The last check deliberately runs the OLD rule and requires it to FAIL, so the suite
// cannot pass on an implementation that only satisfies the contrast half.
//
//   npx tsx scripts/qa/accent-text.mts
import { accentTextColor, contrastRatio } from "../../packages/web/src/theme";

const PANELS = { dark: "#121a22", light: "#ffffff" } as const;
// The presets the settings page offers (SettingsPage.tsx → ACCENTS).
const PRESETS = ["#ffb454", "#76bbdf", "#4ec9a0", "#8f7bd7", "#ff6b9d"];
const FLOOR = 4.8;

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
const mixOld = (a: string, b: string, t: number): string => {
  const A = rgb(a); const B = rgb(b);
  return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
};
/** absolute chroma: 0 = a grey, whatever its hue claims */
const chroma = (h: string): number => {
  const v = rgb(h);
  return (Math.max(...v) - Math.min(...v)) / 255;
};
// The rule this round replaced: linear mix toward white (dark) / black (light).
const oldRule = (accent: string, dark: boolean): string =>
  dark ? mixOld(accent, "#ffffff", 0.18) : mixOld(accent, "#000000", 0.42);

console.log("== the floor holds on every preset, both palettes ==");
for (const a of PRESETS) {
  for (const [mode, panel] of Object.entries(PANELS)) {
    const got = accentTextColor(a, panel);
    const cr = contrastRatio(got, panel);
    check(cr >= FLOOR, `${a} on ${mode}`, `${got} = ${cr.toFixed(2)}:1`);
  }
}

console.log("== a colour that already clears the floor is used UNCHANGED (no washing) ==");
for (const a of PRESETS) {
  const own = contrastRatio(a, PANELS.dark);
  const got = accentTextColor(a, PANELS.dark);
  check(got === a, `${a} (own ratio ${own.toFixed(2)}:1)`, got);
}

console.log("== and the derivation keeps the accent's SATURATION (this is the reported bug) ==");
for (const a of PRESETS) {
  const got = accentTextColor(a, PANELS.dark);
  const kept = hsvS(got) / hsvS(a);
  check(kept >= 0.95, `${a} saturation kept`, `${(kept * 100).toFixed(0)}% (${hsvS(a).toFixed(2)} -> ${hsvS(got).toFixed(2)})`);
}

console.log("== the hand-tuned built-in palette agrees with the derivation ==");
// theme.css dark `--accent-text` for the built-in amber IS `--accent`; the derivation must do
// the same thing rather than invent a neighbour.
check(accentTextColor("#ffb454", PANELS.dark) === "#ffb454", "amber/dark == the accent itself");
const amberLight = accentTextColor("#ffb454", PANELS.light);
check(contrastRatio(amberLight, PANELS.light) >= FLOOR, "amber/light clears the floor", `${amberLight} = ${contrastRatio(amberLight, PANELS.light).toFixed(2)}:1`);
check(contrastRatio(amberLight, "#ffffff") < contrastRatio("#9c5a08", "#ffffff") * 1.6,
  "amber/light stays in the same neighbourhood as the hand-tuned #9c5a08", `${amberLight}`);

console.log("== a light surface must not yield a label WEAKER than the body text ==");
// The light palette's body text is #1c2735 (15.1:1 on white). The old rule's blue was 5.66:1 —
// an accent label that reads fainter than the thing it is meant to stand out from.
for (const a of PRESETS) {
  const got = accentTextColor(a, PANELS.light);
  check(contrastRatio(got, PANELS.light) >= FLOOR, `${a} on light is readable`, `${got} = ${contrastRatio(got, PANELS.light).toFixed(2)}:1`);
}

console.log("== the OLD rule FAILS these (an assertion the wrong implementation also passes is not evidence) ==");
{
  // dark: the old mix washed the colour toward the body text's hue family
  const old = oldRule("#76bbdf", true);
  check(hsvS(old) / hsvS("#76bbdf") < 0.95, "old rule loses saturation (dark blue)",
    `${old}: ${(hsvS(old) / hsvS("#76bbdf") * 100).toFixed(0)}% kept`);
  // light: the old mix produced a slate that reads as grey at the same lightness
  const oldBlue = oldRule("#76bbdf", false);
  const newBlue = accentTextColor("#76bbdf", PANELS.light);
  check(chroma(newBlue) > chroma(oldBlue) * 1.5, "the derivation keeps visibly more colour than the old mix",
    `chroma ${chroma(oldBlue).toFixed(2)} -> ${chroma(newBlue).toFixed(2)} (${oldBlue} -> ${newBlue})`);
}

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
