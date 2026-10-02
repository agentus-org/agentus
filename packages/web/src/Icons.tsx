// Inline icon set — no icon dependency, 16px stroke icons in the hermes-studio
// lineage (that UI is icon-first with tooltips; text pills everywhere is what made
// our chat head feel cramped). Everything inherits `currentColor` so the theme
// keeps control of colour, and each icon is aria-hidden: the *button* carries the
// label via title/aria-label.
import type { JSX } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function svg(path: JSX.Element, { size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {path}
    </svg>
  );
}

export const IconMenu = (p: IconProps = {}): JSX.Element => svg(<><path d="M3 6h18M3 12h18M3 18h18" /></>, p);

export const IconFolder = (p: IconProps = {}): JSX.Element =>
  svg(<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, p);

export const IconHome = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>, p);

/** permission mode — a shield: "what is this session allowed to do" */
export const IconShield = (p: IconProps = {}): JSX.Element =>
  svg(<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />, p);

/** thinking depth — a gauge: 7 levels, not a word */
export const IconGauge = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M4 17a8 8 0 1 1 16 0" /><path d="M12 17l4-5" /></>, p);

/** context window — concentric rings, fills by percent (see ContextGauge) */
export const IconStop = (p: IconProps = {}): JSX.Element => svg(<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />, p);

export const IconClose = (p: IconProps = {}): JSX.Element => svg(<path d="M6 6l12 12M18 6L6 18" />, p);

export const IconChevronDown = (p: IconProps = {}): JSX.Element => svg(<path d="M6 9l6 6 6-6" />, p);

export const IconChevronRight = (p: IconProps = {}): JSX.Element => svg(<path d="M9 6l6 6-6 6" />, p);

export const IconArrowUp = (p: IconProps = {}): JSX.Element => svg(<path d="M12 19V5M6 11l6-6 6 6" />, p);

export const IconArrowDown = (p: IconProps = {}): JSX.Element => svg(<path d="M12 5v14M6 13l6 6 6-6" />, p);

export const IconSend = (p: IconProps = {}): JSX.Element => svg(<path d="M4 12l16-8-6 8 6 8z" />, p);

export const IconPlus = (p: IconProps = {}): JSX.Element => svg(<path d="M12 5v14M5 12h14" />, p);

export const IconSearch = (p: IconProps = {}): JSX.Element =>
  svg(<><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></>, p);

/** sign out — the rail footer action */
export const IconPower = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M12 4v8" /><path d="M7.5 7a7 7 0 1 0 9 0" /></>, p);

/** a slot's terminal/output — used for the cold-slot resume affordance */
export const IconResume = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v4h4" /></>, p);

export const IconDot = (p: IconProps = {}): JSX.Element => svg(<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />, p);
