// The game's colours and text sizes: the UI's tokens (src/app/styles/00-base.css) mirrored for Phaser, so the canvas
// and the panels read as one warm-graphite-and-amber look. New canvas text and colours come from here.
import type Phaser from 'phaser';

/** CSS colours (Phaser text styles take strings). Same names as the CSS custom properties. */
export const CSS = {
  bg: '#15171b',
  bgDeep: '#0f1114',
  panel: '#1e2126',
  panelHi: '#2c3138',
  line: '#2c3038',
  ink: '#e6e2d8',
  inkHi: '#fff8ee',
  inkSoft: '#c9c4b8',
  muted: '#969aa3',
  accent: '#f0a63a',
  accentInk: '#2a1a04',
  good: '#5db39e',
  goodInk: '#bfe8dc',
  warn: '#e8c15a',
  bad: '#e5676b',
  badInk: '#f6c9ca',
  info: '#8fb8e8',
  infoInk: '#d6e4f5',
  highlight: '#f6e7c1',
  quote: '#f3dfb5',
  quoteInk: '#1f1608',
  gold: '#ffc233',
  goldHi: '#fff1b8',
  paper: '#d9cfba',
  paperInk: '#1b1200',
  paperMeta: '#92400e',
  /** The flashcard's small print on paper (10-flashcards.css overrides --paper-meta / --paper-hint): 6:1 on `paper`. */
  cardMeta: '#7c2d12',
  cardHint: '#4a4540',
  bubble: '#ffffff',
  bubbleInk: '#111111',
  roleOk: '#047857',
} as const;

export type ThemeColor = keyof typeof CSS;

/** `#rrggbb` → 0xrrggbb, for Graphics fills and tints. */
export const hex = (css: string) => parseInt(css.replace('#', '').slice(0, 6), 16);

/** The same tokens as numbers. */
export const COLOR = Object.fromEntries(Object.entries(CSS).map(([k, v]) => [k, hex(v)])) as Record<ThemeColor, number>;

/** A token with an alpha byte, for text backgrounds (`'#15171bd9'`). */
export const withAlpha = (c: ThemeColor, alpha: number) => `${CSS[c]}${Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0')}`;

/** Text sizes on the canvas: small labels, body (bubbles), headings / rewards. */
export const FONT_SIZE = { sm: '11px', md: '13px', lg: '16px' } as const;

/** The smallest text the canvas draws, px (the UI's `--fs-xs`): nothing a player reads is smaller, at any text size. */
export const MIN_TEXT_PX = 11;

/** A canvas font size in px: `px` times the player's text size (⋯ → Text size: 1, 1.25 or 1.5), never under 11. */
export const textPx = (px: number, scale = 1) => Math.max(MIN_TEXT_PX, Math.round(px * scale));

/**
 * The mini-games' chrome (MiniGame's `PAL`): the desk's graphite and amber, and the flashcards' paper for the end card,
 * so a game reads as part of the desk beside the city. Numbers fill shapes, strings colour text.
 */
export const GAME_PAL = {
  /** The stage and the title bar. */
  bg: COLOR.bg,
  /** The hint strip. */
  panel: COLOR.panel,
  /** Stat chips and the quiet button (← City). */
  chip: COLOR.panelHi,
  chipCss: CSS.panelHi,
  line: COLOR.line,
  /** Hard pixel borders and shadows. */
  black: 0x000000,
  /** The one amber primary. */
  accent: COLOR.accent,
  accentCss: CSS.accent,
  accentInk: CSS.accentInk,
  /** Expert: the city's pale gold, set apart from the amber primary. */
  expert: COLOR.goldHi,
  expertCss: CSS.goldHi,
  paper: COLOR.paper,
  paperInk: CSS.paperInk,
  paperMeta: CSS.cardMeta,
  paperHint: CSS.cardHint,
  /** Text on the dark stage and the chips, each 4.5:1 or better there (the desk's red text is `bad-ink`: `bad` is 4:1 on a chip). */
  ink: CSS.inkHi,
  good: CSS.good,
  bad: CSS.badInk,
  muted: CSS.muted,
} as const;

/** The dark pill behind an answer's verdict (MiniGame.verdict): graphite, nearly opaque. */
export const GAME_PILL = withAlpha('bg', 0.95);

/**
 * The boot screen's loading tip: the panel's small text size (`--fs-sm`, 12 px) in ink-soft on a solid graphite chip,
 * so it reads on whatever the stage shows behind it (never small muted text straight on the stage).
 */
export const TIP_STYLE = { fontSize: '12px', color: CSS.inkSoft, backgroundColor: CSS.bg, padding: { x: 8, y: 4 } } as const;

/** Every sign and tag on the map: ink on a translucent graphite chip. */
export const LABEL_BG = withAlpha('bg', 0.85);

/** Speech bubble tones: paper-white for speech, parchment for steps, the semantic colours for done and alert, gold for a find. */
export const BUBBLE_TONES = {
  speech: { fill: COLOR.bubble, stroke: COLOR.bg, text: CSS.bubbleInk, name: CSS.paperMeta },
  step: { fill: COLOR.highlight, stroke: COLOR.bg, text: CSS.quoteInk, name: CSS.paperMeta },
  done: { fill: COLOR.goodInk, stroke: COLOR.roleOk, text: CSS.bubbleInk, name: CSS.roleOk },
  alert: { fill: COLOR.badInk, stroke: 0x8f2a2e, text: CSS.bubbleInk, name: '#a32d31' },
  /** A golden token found: the city's gold, short and bright. */
  gold: { fill: COLOR.goldHi, stroke: COLOR.gold, text: CSS.paperInk, name: CSS.paperMeta },
} as const;

/** The common label style: 11 px, heavy, on the label chip. */
export const labelStyle = (font: string, color: string = CSS.inkHi, size: string = FONT_SIZE.sm): Phaser.Types.GameObjects.Text.TextStyle => ({
  fontFamily: font,
  fontSize: size,
  fontStyle: '800',
  align: 'center',
  color,
  backgroundColor: LABEL_BG,
  padding: { x: 5, y: 2 },
});
