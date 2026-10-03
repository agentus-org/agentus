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

/** row overflow — the per-session settings menu (studio's "outline" affordance) */
export const IconDotsV = (p: IconProps = {}): JSX.Element =>
  svg(<><circle cx="12" cy="5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="19" r="1.4" /></>, p);

/** rename — pencil on a line */
export const IconPencil = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4z" /></>, p);

/** copy-to-clipboard — two sheets (same shape studio uses on a message bubble) */
export const IconCopy = (p: IconProps = {}): JSX.Element =>
  svg(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>, p);

/** export a session — arrow into a tray */
export const IconDownload = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M12 3v11" /><path d="M7 10l5 5 5-5" /><path d="M4 20h16" /></>, p);

/** archive — a box with a lid line (the close action's real meaning: keep the record) */
export const IconArchive = (p: IconProps = {}): JSX.Element =>
  svg(<><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M3 11h18" /><path d="M9 3h6" /></>, p);

/** copied */
export const IconCheck = (p: IconProps = {}): JSX.Element => svg(<path d="m4 12.5 5 5L20 6.5" />, p);

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

/** the workspace panel: a rectangle split by a divider (file manager / terminal) */
export const IconPanel = (p: IconProps = {}): JSX.Element =>
  svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>, p);

/** one shell: a prompt inside a window */
export const IconTerminal = (p: IconProps = {}): JSX.Element =>
  svg(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>, p);

export const IconFile = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v4h4" /></>, p);

/** dictate a prompt */
export const IconMic = (p: IconProps = {}): JSX.Element =>
  svg(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></>, p);

/** read a reply aloud */
export const IconVolume = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></>, p);

export const IconVolumeOff = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M11 5 6 9H3v6h3l5 4z" /><path d="m16 9 5 6M21 9l-5 6" /></>, p);

export const IconPause = (p: IconProps = {}): JSX.Element =>
  svg(<><rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" /></>, p);

/** attach a file to the prompt */
export const IconPaperclip = (p: IconProps = {}): JSX.Element =>
  svg(<path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />, p);

/** chat settings (mode, depth, voice) live behind this */
export const IconSettings = (p: IconProps = {}): JSX.Element =>
  svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.2V4a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11h.2a2 2 0 1 1 0 4H21z" /></>, p);

/** "go up one directory" — the panel's back button */
export const IconArrowLeft = (p: IconProps = {}): JSX.Element => svg(<path d="M19 12H5M11 6l-6 6 6 6" />, p);

/** re-run / reconnect the terminal */
export const IconRefresh = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M20 11a8 8 0 1 0-2 6" /><path d="M20 5v6h-6" /></>, p);

/** pick the workspace this slot works in */
export const IconSwap = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M4 8h13l-3-3M20 16H7l3 3" /></>, p);

/** pick the model this slot talks to — a chip (the studio model button's idea) */
export const IconChip = (p: IconProps = {}): JSX.Element =>
  svg(<><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" /></>, p);

/** thinking depth/brain, used as the reasoning-effort button icon */
export const IconBrain = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M9.5 4a2.5 2.5 0 0 1 2.5 2.5v11a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 2.26-4.9A2.5 2.5 0 0 1 9.5 4Z" /><path d="M14.5 4A2.5 2.5 0 0 0 12 6.5v11a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-2.26-4.9A2.5 2.5 0 0 0 14.5 4Z" /></>, p);

/** fork a session: the branch glyph */
export const IconFork = (p: IconProps = {}): JSX.Element =>
  svg(<><circle cx="7" cy="5" r="2" /><circle cx="7" cy="19" r="2" /><circle cx="17" cy="9" r="2" /><path d="M7 7v10M17 11c0 3-3 4-6 4H9" /></>, p);

/** password reveal — an eye; the slash variant is "hide" */
export const IconEye = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.6" /></>, p);

export const IconEyeOff = (p: IconProps = {}): JSX.Element =>
  svg(<><path d="M3 3l18 18" /><path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-2.8 3.3" /><path d="M6.3 7.9A16.5 16.5 0 0 0 2 12s3.6 6 10 6c1.5 0 2.8-.3 4-.8" /></>, p);

/** devices signed in — a monitor-ish badge, used by the sessions card */
export const IconDevice = (p: IconProps = {}): JSX.Element =>
  svg(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>, p);

/** a lock: the login-lockout card */
export const IconLock = (p: IconProps = {}): JSX.Element =>
  svg(<><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>, p);
