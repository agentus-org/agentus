/** The terminal's ANSI palettes — one per theme, because a palette is judged against ITS OWN
 *  background and the two themes have opposite ones.
 *
 *  Until now the panel had a single Tango palette shared by both. On the dark theme's
 *  `--bg-1` (#0e1518) that put `black` #2e3436 at **1.5:1** and `brightBlack` #555753 at ~2.3:1 —
 *  several common writers (shell `dircolors`, diagnostics, diff context lines) use them, so
 *  their output disappeared into the panel (operator: 深色主题下「黑成一片」). `blue` #3465a4
 *  sat at 3.1:1 for the same reason.
 *
 *  Dark theme uses a One-Half-Dark-shaped ladder (a palette designed for a dark terminal
 *  background, with its two greys lifted so they clear the panel): black lands at ~3:1 so it
 *  stays visibly subordinate to `white` rather than shouting, brightBlack at ~6:1. Light theme
 *  keeps Tango's deep colours, which are exactly right on white.
 *
 *  Kept as data in its own module so contrast is assertable without a browser
 *  (scripts/qa/terminal-palette.mts). */
export interface Ansi16 {
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

/** Tango, unchanged — read on a light background (black is 12.6:1 on #ffffff). */
export const ANSI_LIGHT: Ansi16 = {
  black: "#2e3436", red: "#cc0000", green: "#4e9a06", yellow: "#c4a000",
  blue: "#3465a4", magenta: "#75507b", cyan: "#06989a", white: "#d3d7cf",
  brightBlack: "#555753", brightRed: "#ef2929", brightGreen: "#8ae234", brightYellow: "#fce94f",
  brightBlue: "#729fcf", brightMagenta: "#ad7fa8", brightCyan: "#34e2e2", brightWhite: "#eeeeec",
};

/** One Half Dark's hues, with both greys lifted off the panel background. */
export const ANSI_DARK: Ansi16 = {
  black: "#5c6370", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
  blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#dcdfe4",
  brightBlack: "#8b949e", brightRed: "#ff7b86", brightGreen: "#b5e08f", brightYellow: "#ffd580",
  brightBlue: "#82c4ff", brightMagenta: "#e0a0f0", brightCyan: "#7fd8e0", brightWhite: "#ffffff",
};

export function ansi16(dark: boolean): Ansi16 {
  return dark ? ANSI_DARK : ANSI_LIGHT;
}

/** The 256-colour palette's tail (indices 16–255) for the emulator's `extendedAnsi`.
 *
 *  16–231 is the 6×6×6 cube, left at the standard values: its dark end is a real black, which is
 *  what a program asking for it wants, and no shell keys readable output off it.
 *
 *  232–255 is the greyscale ramp, and that one is theme-dependent. The standard ramp runs
 *  #080808 → #eeeeee; on the dark panel its first third is invisible, which is the same defect as
 *  the shared `black` above. Dark theme lifts the ramp's floor to just above the panel background;
 *  light keeps the standard ramp, where a near-black grey is exactly the wanted end. */
export function ansiExtended(dark: boolean): string[] {
  const out: string[] = [];
  const steps = [0, 95, 135, 175, 215, 255];
  for (const r of steps) {
    for (const g of steps) {
      for (const b of steps) out.push(hex(r, g, b));
    }
  }
  const floor = dark ? 72 : 8;
  const ceil = dark ? 242 : 238;
  for (let i = 0; i < 24; i += 1) {
    const c = Math.round(floor + (i * (ceil - floor)) / 23);
    out.push(hex(c, c, c));
  }
  return out;
}

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
