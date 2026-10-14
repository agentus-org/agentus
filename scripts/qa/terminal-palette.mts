// The terminal panel's ANSI palettes, checked against the BACKGROUND they are read on.
//
// The defect this pins (operator: 深色主题下输出黑成一片): one Tango palette served both themes,
// so on the dark panel (#0e1518) `black` rendered 1.5:1 and was invisible. A palette is only
// meaningful relative to its own background, which is why this suite computes contrast instead of
// comparing hex strings — a colour can be "changed" and still be unreadable, and it can be left
// alone and be perfectly fine (Tango's black on white is 12.6:1).
//
// Run: npx tsx scripts/qa/terminal-palette.mts
import { ANSI_DARK, ANSI_LIGHT, ansi16, ansiExtended, type Ansi16 } from "../../packages/web/src/terminalPalette.ts";

let ok = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { ok += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ---- WCAG relative luminance / contrast ratio ---------------------------------------------------
function lum(hexColor: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hexColor);
  if (!m) throw new Error(`not a hex colour: ${hexColor}`);
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// The two backgrounds the panel actually paints (`terminalTheme` reads these same tokens).
const BG_DARK = "#0e1518";
const BG_LIGHT = "#ffffff";

const KEYS = Object.keys(ANSI_DARK) as (keyof Ansi16)[];

// ---- every colour of the dark palette clears the dark panel -------------------------------------
// Floor 3.0:1 for the two greys (black is *meant* to be the quiet one, and this is what makes it
// visible at all — it was 1.5:1), 4.5:1 for the chromatic colours, which carry real information.
{
  const grey = new Set<keyof Ansi16>(["black", "brightBlack"]);
  let worst = { k: "", r: Infinity };
  for (const k of KEYS) {
    const r = contrast(ANSI_DARK[k], BG_DARK);
    if (r < worst.r) worst = { k, r };
    const floor = grey.has(k) ? 3.0 : 4.5;
    check(`dark ${k} (${ANSI_DARK[k]}) clears ${floor}:1 on ${BG_DARK}`,
      r >= floor, `${r.toFixed(2)}:1`);
  }
  check("the grey pair keeps its two steps (black dimmer than brightBlack, both visible)",
    contrast(ANSI_DARK.black, BG_DARK) < contrast(ANSI_DARK.brightBlack, BG_DARK)
    && contrast(ANSI_DARK.black, BG_DARK) >= 3.0);
  check("…and the worst dark colour is still readable", worst.r >= 3.0, `${worst.k} ${worst.r.toFixed(2)}:1`);
}

// ---- the old shared palette is recorded as the counterexample ------------------------------------
// The pre-fix values, asserted so a revert to "one palette for both" fails loudly.
{
  const OLD = { black: "#2e3436", brightBlack: "#555753", blue: "#3465a4" };
  check("the old black really was invisible on the dark panel",
    contrast(OLD.black, BG_DARK) < 2.0, `${contrast(OLD.black, BG_DARK).toFixed(2)}:1`);
  check("…and the new one is not", contrast(ANSI_DARK.black, BG_DARK) >= 3.0);
  check("the old brightBlack was too", contrast(OLD.brightBlack, BG_DARK) < 3.0,
    `${contrast(OLD.brightBlack, BG_DARK).toFixed(2)}:1`);
  check("the old blue was low too", contrast(OLD.blue, BG_DARK) < 4.5,
    `${contrast(OLD.blue, BG_DARK).toFixed(2)}:1`);
}

// ---- the LIGHT palette is untouched, and is judged on white --------------------------------------
{
  check("light theme's dark end reads on white (black ≥ 10:1, blue ≥ 4.5:1)",
    contrast(ANSI_LIGHT.black, BG_LIGHT) >= 10 && contrast(ANSI_LIGHT.blue, BG_LIGHT) >= 4.5,
    `black ${contrast(ANSI_LIGHT.black, BG_LIGHT).toFixed(2)}:1, blue ${contrast(ANSI_LIGHT.blue, BG_LIGHT).toFixed(2)}:1`);
  // White and brightWhite are near-white BY DESIGN in Tango — a program painting on the light
  // theme's own background is asking to disappear, the same way dark-theme black was. Recorded so
  // it is not "fixed" by someone reading a contrast checker without its theme.
  check("light theme's white/brightWhite are near-white by design (Tango, unchanged)",
    contrast(ANSI_LIGHT.white, BG_LIGHT) < 2 && contrast(ANSI_LIGHT.brightWhite, BG_LIGHT) < 1.5);
  check("Tango is what the light theme still ships (no accidental cross-wiring)",
    ANSI_LIGHT.black === "#2e3436" && ANSI_LIGHT.blue === "#3465a4");
  check("the two palettes are genuinely different objects",
    JSON.stringify(ANSI_LIGHT) !== JSON.stringify(ANSI_DARK));
}

// ---- ansi16() picks the right one ---------------------------------------------------------------
check("ansi16(true) is the dark ladder", ansi16(true) === ANSI_DARK);
check("ansi16(false) is Tango", ansi16(false) === ANSI_LIGHT);

// ---- the 256-colour tail ---------------------------------------------------------------------------
{
  for (const dark of [true, false]) {
    const ext = ansiExtended(dark);
    check(`${dark ? "dark" : "light"} extendedAnsi has exactly the 240 entries xterm expects (16–255)`,
      ext.length === 240, `got ${ext.length}`);
    check(`${dark ? "dark" : "light"} cube starts at the standard black and ends at white`,
      ext[0] === "#000000" && ext[6 * 36 - 1] === "#ffffff");
    check(`${dark ? "dark" : "light"} ramp is monotonically increasing`,
      ext.slice(216).every((c, i, a) => i === 0 || c >= a[i - 1]));
    // the whole point of overriding the ramp
    const rampFloor = ext[216];
    const floorContrast = contrast(rampFloor, dark ? BG_DARK : BG_LIGHT);
    if (dark) {
      check("dark ramp's darkest grey is visible on the panel (standard #080808 is not)",
        floorContrast >= 1.9, `${floorContrast.toFixed(2)}:1`);
      check("…and the standard ramp really was the problem",
        contrast("#080808", BG_DARK) < 1.2, `${contrast("#080808", BG_DARK).toFixed(2)}:1`);
    } else {
      check("light ramp keeps the standard near-black end (#080808)",
        rampFloor === "#080808", `got ${rampFloor}`);
    }
  }
}

console.log(`\n${ok} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
