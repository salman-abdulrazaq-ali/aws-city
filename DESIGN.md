---
name: AWS City
description: An isometric pixel-art AWS city per Region, with a warm-graphite control desk beside it.
colors:
  bg: "#15171b"
  bg-deep: "#0f1114"
  panel: "#1e2126"
  panel-2: "#24282e"
  panel-3: "#191c20"
  panel-hi: "#2c3138"
  line: "#2c3038"
  line-strong: "#3a3f48"
  scrim: "rgba(8, 9, 11, 0.66)"
  ink: "#e6e2d8"
  ink-hi: "#fff8ee"
  ink-soft: "#c9c4b8"
  muted: "#8b8f98"
  accent: "#f0a63a"
  accent-hover: "#f5b75a"
  accent-ink: "#2a1a04"
  accent-soft: "rgba(240, 166, 58, 0.13)"
  accent-line: "rgba(240, 166, 58, 0.45)"
  good: "#5db39e"
  good-ink: "#bfe8dc"
  warn: "#e8c15a"
  bad: "#e5676b"
  bad-ink: "#f6c9ca"
  bad-soft: "rgba(229, 103, 107, 0.13)"
  bad-line: "rgba(229, 103, 107, 0.5)"
  info: "#8fb8e8"
  info-ink: "#d6e4f5"
  code: "#9fd4c6"
  highlight: "#f6e7c1"
  quote: "#f3dfb5"
  quote-ink: "#1f1608"
  paper: "#d9cfba"
  paper-back: "#d2c7b0"
  paper-ink: "#1b1200"
  paper-meta: "#92400e"
  bubble: "#ffffff"
  bubble-ink: "#111111"
  gold: "#ffc233"
  gold-hi: "#fff1b8"
  gold-deep: "#b7791f"
  role-ok: "#047857"
  map-sea: "#0b2440"
  map-land: "#2f6f4f"
  aws-compute: "#ed7100"
  aws-storage: "#7aa116"
  aws-database: "#c925d1"
  aws-networking: "#8c4fff"
  aws-security: "#dd344c"
  aws-aiml: "#01a88d"
  aws-management: "#e7157b"
typography:
  display:
    fontFamily: "'Press Start 2P', 'Nunito', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.4
  headline:
    fontFamily: "'Nunito', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "17px"
    fontWeight: 800
    lineHeight: 1.3
  title:
    fontFamily: "'Nunito', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "15px"
    fontWeight: 800
    lineHeight: 1.3
  body:
    fontFamily: "'Nunito', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "'Nunito', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "12px"
    fontWeight: 800
    lineHeight: 1.3
  caption:
    fontFamily: "'Nunito', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.3
  wordmark:
    fontFamily: "'Press Start 2P', 'Nunito', sans-serif"
    fontSize: "10px"
    fontWeight: 400
    letterSpacing: "0.5px"
  mono:
    fontFamily: "ui-monospace, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
rounded:
  sm: "2px"
  md: "4px"
  lg: "6px"
  pill: "999px"
spacing:
  s-1: "2px"
  s-2: "4px"
  s-3: "6px"
  s-4: "8px"
  s-5: "12px"
  s-6: "16px"
components:
  button:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.panel-hi}"
    textColor: "{colors.ink-hi}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.accent-ink}"
  button-warn:
    backgroundColor: "transparent"
    textColor: "{colors.bad-ink}"
    rounded: "{rounded.md}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
  button-tiny:
    padding: "0 8px"
    height: "26px"
    typography: "{typography.label}"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
    padding: "4px 8px"
    typography: "{typography.label}"
  card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px"
  todo-row:
    backgroundColor: "{colors.panel-2}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  sheet:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.lg}"
    padding: "12px"
  toast:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "8px 12px 8px 16px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
    height: "34px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.caption}"
  tab-active:
    textColor: "{colors.ink-hi}"
  flashcard:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.paper-ink}"
    rounded: "{rounded.lg}"
    padding: "16px 12px"
  speech-bubble:
    backgroundColor: "{colors.bubble}"
    textColor: "{colors.bubble-ink}"
---

# Design System: AWS City

## Overview

**Creative North Star: "The Lamplit Desk Beside the City"**

AWS City is two things side by side: a bright, generated pixel-art city (one per AWS Region, drawn on a 32×16
isometric grid) and a quiet warm-graphite desk where the player reads, decides and approves. The desk exists to let
the city carry the colour. Its surfaces are near-black graphite with a warm cast, its text is parchment-white rather
than pure white, and a single amber lamp (the accent) marks the one thing to do next. Paper (cream flashcards, white
speech bubbles, the gold of a found token) appears only where the city "speaks" into the desk.

Density is high but small: 13 px body text, 8 px and 12 px gaps, 6 px corners, everything sized to work first in a
400 px browser side panel and then reused unchanged as the right-hand column of the full tab. Motion is short and
stepped like sprite frames. Every visual setting a player can change (text size, contrast, font, motion) is a token
override, never a second stylesheet.

**Key Characteristics:**
- Warm graphite surfaces layered by tone (bg → panel → panel-2 → panel-hi), with hairline borders instead of shadows.
- One amber primary per screen; district colours only as small identity marks.
- Nunito for everything readable; Press Start 2P only for the wordmark and a few game labels, on its 8 px grid.
- The pixel city is the only hard-edged, saturated thing on screen; the UI recedes around it.
- The side panel (400 px) is the design's first surface; the tab adds a wide stage, not a different UI.

## Colors

A warm-graphite neutral ramp with parchment ink, one amber accent, soft semantic tones and the official AWS
Architecture Icon category colours reserved for districts.

### Primary
- **Lantern Amber** (`accent`): the one filled button per screen (the shift's next action, Approve & deploy, Start in
  Oregon), the active tab's underline and icon, focus rings, the coin count, switches that are on. Its tints
  (`accent-soft`, `accent-line`) mark a selected chip, the toast's left bar and an input's focus halo.

### Secondary
- **District colours** (`aws-compute` … `aws-management`): the exact category colours of the AWS Architecture Icon
  package. They identify a district or service: an 8 px square before a quest or district title, a quest's progress
  segments, the building eyebrow. Never a fill for buttons or large areas.
- **City Gold** (`gold`, `gold-hi`, `gold-deep`): golden tokens, crowns, Kai's jacket and the high-contrast focus ring.

### Tertiary
- **Paper** (`paper`, `paper-back`, `paper-ink`, `paper-meta`): flashcards and the agent's "say" bubble on the shift; the
  card's small print uses burnt-sienna meta text (overridden darker inside `.flash-face` so both faces pass 4.5:1).
- **Speech white** (`bubble`, `bubble-ink`): in-world speech bubbles drawn by Phaser.

### Neutral
- **Night Graphite** (`bg`): the app background and the side column.
- **Deep Graphite** (`bg-deep`): the stage behind the canvas.
- **Desk Graphite** (`panel`), **Raised Graphite** (`panel-2`), **Lit Graphite** (`panel-hi`): cards, rows and
  menus; hover and pressed states step one tone up.
- **Hairline** (`line`, `line-strong`): every border and divider.
- **Parchment Ink** (`ink`, `ink-hi`, `ink-soft`): body text, headings, secondary text.
- **Fog** (`muted`): metadata and section labels. Measured 5.5:1 on `bg`, 5.0:1 on `panel`, 4.6:1 on `panel-2` and only 4.0:1 on `panel-hi` (the token comment says 5.3:1 on `panel`).
- **Semantic**: `good` (teal-green, done and linked), `warn` (straw, rush hour and "updating"), `bad` (coral, destructive
  and errors, always paired with `bad-ink` text on `bad-soft`), `info` (sky, links and notes), `code` (mint, inline code).

### Named Rules
**The One Lamp Rule.** One amber-filled button per screen (the smoke test counts them on the City tab). Everything else
is a quiet graphite button, a ghost or a chip.

**The District Square Rule.** A district's colour appears as a small mark (an 8 px square, a 4 px progress segment,
an eyebrow word), never as a background.

**The Token-Only Rule.** Colours come from `:root` in `src/app/styles/00-base.css` (and `src/game/theme.ts` mirrors
them for Phaser under the same names). Accessibility modes work by overriding these tokens, so a raw hex in a
component escapes them.

## Typography

**Display Font:** Press Start 2P (with Nunito fallback)
**Body Font:** Nunito, variable 200–1000 (with -apple-system, BlinkMacSystemFont, sans-serif)
**Label/Mono Font:** ui-monospace, Menlo, monospace (inline code, the practice terminal)

**Character:** Nunito's rounded terminals keep a dense, information-heavy desk friendly to a teenager; the pixel face is
a seasoning that ties the desk to the city. Both fonts are bundled and loaded with `font-display: block`, because Phaser
draws them into the canvas too.

### Hierarchy
- **Display** (Press Start 2P 400, 15 px; 11 px for small pixel labels): mini-game titles and pixel badges. Only the
  8 px-grid sizes (10, 11, 15 px) stay crisp.
- **Headline** (800, 17 px, `--fs-xl`): the few big numbers and celebration lines.
- **Title** (800, 15 px, `--fs-lg`): card titles, a building's name, the flashcard question.
- **Body** (400–700, 13 px, `--fs-md`, line-height about 1.45): running text in cards, the menu, the shift.
- **Label** (800, 12 px, `--fs-sm`, muted, sentence case): the single section-label style ("Today's shift", "Blueprints").
- **Caption** (700, 11 px, `--fs-xs`): tab labels, chips' counts and the connection word; 11 px is reserved for
  non-essential labels.

### Named Rules
**The 12 px Floor Rule.** 12 px is the floor for body text; 11 px only for non-essential labels. (Shipped exceptions:
10 px tab badges and the wordmark.)

**The Pixel Grid Rule.** Press Start 2P only at 10, 11 or 15 px (19 px at 150 % text). Never scale it by a fraction.

**The Heavy-Weight Rule.** Emphasis is weight (700/800), not colour or italics; most labels and buttons are 700–800.

## Layout

The app is one CSS grid with two surfaces:

- **Side panel** (`.app-panel`, about 400 px wide): rows `hud / stage / side`. The stage (the city) gets
  `minmax(150px, 34%)` of the height (54 % when the player asks for a taller map); the side column below takes the rest.
  A mini-game takes the whole height under the HUD.
- **Full tab** (`.app-full`, 1400 × 880 reference): `hud` across the top, then the stage (`1fr`) beside a fixed
  400 px side column with a 1 px left hairline. The side column's content is the same as the panel's.

The side column stacks: tabs (City · Learn · Jobs · Deploy, opened by the unlock ladder), a scrolling `.tab-body`
(12 px sides, 16 px bottom, a stable scrollbar gutter), then the prompt bar with its AI note. Spacing is a 2/4/6/8/12/16
px scale (`--s-1` … `--s-6`); gaps between cards are 8 px, card padding 12 px. Breakpoints are narrow-surface
adjustments only: `max-width: 480px` hides the connection word, `max-width: 420px` hides the City Lights count and the
rush-hour word.

In the canvas, the camera zoom is always an integer (the largest that fits the core; the panel falls back to zoom 1
on the Town Square), and in-world text is counter-scaled by the zoom so it stays readable at 400 px.

## Elevation & Depth

Depth is tonal first: a surface one step lighter (`panel` → `panel-2` → `panel-hi`) with a hairline border reads as
raised. Shadows are kept for things that float over the city.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5)`): menus, toasts and bottom sheets over the city.
- **Pixel** (`box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35)`): small lifted chips on the map.
- **Pixel small** (`box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3)`): pressed-in details.
- **Primary bevel** (`box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.18)`): the amber button's bottom lip, inverted when
  pressed, a nod to pixel-art buttons.
- **Scrim** (`rgba(8, 9, 11, 0.66)`): behind every card that takes over the stage or the column.

### Named Rules
**The Flat Desk Rule.** Cards in the side column are flat (tone and hairline). Only what floats over the city (menus,
toasts, sheets, the coin note) gets the float shadow.

## Shapes

Tight corners so panels read as tiles of the pixel city: 2 px for small marks and tips, 4 px for buttons and inputs,
6 px for cards, sheets, toasts and the stage frame, and full pills for chips, switches and badges. Borders are 1 px
hairlines; a 2 px amber line marks the active tab (inset 22 % from each side) and a 4 px inset amber bar marks a toast.
The stage has a black 1 px border plus a `line-strong` outer ring, like a monitor bezel around the city.

## Components

### Buttons
- **Shape:** gently squared (4 px), 32 px tall (26 px for `tiny`, 32 × 32 for icon buttons), 700 weight, an icon and
  a label 6 px apart.
- **Primary:** Lantern Amber fill, amber-ink text at 800, a 2 px dark bottom lip. Disabled primaries fall back to the
  graphite button, never a faded amber.
- **Hover / Focus:** one tone up (`panel-hi`), border to `muted`; a 1 px press-down on `:active`; the global focus ring
  is a 2 px amber outline 2 px out (3 px gold in high contrast).
- **Secondary / Ghost / Warn:** graphite with a `line-strong` border; ghost is borderless muted text; warn is coral
  text on a coral hairline, filled `bad-soft` on hover. Destructive steps also carry a typed confirmation.

### Chips
- **Style:** a pill outline (`line-strong`), 12 px 700 text in `ink-soft`, no fill; scrolling chip rows fade their edges
  with a mask.
- **State:** hover fills with `panel`; a selected or counted chip uses `accent-soft` with amber text.

### Cards / Containers
- **Corner Style:** 6 px.
- **Background:** `panel` (cards, quests, blueprints); `panel-2` for Simple mode's To-do rows.
- **Shadow Strategy:** flat (see the Flat Desk Rule).
- **Border:** 1 px `line`.
- **Internal Padding:** 12 px; 8 px between stacked cards.

### Sheets and dialogs
A full-cover scrim with the card aligned to the bottom (it rises from the bottom edge of the stage or column), `panel`
background, `line-strong` border, float shadow, 12 px padding, a close ✕. Findings and the account card use it; the other
full-screen cards (My City, the Workshop dialog) sit on the same scrim. Escape closes.

### Toasts
Over the stage, centred, at most two in the panel and three in the tab, newest last, below the news ticker. `panel`
fill, a 4 px amber inset bar on the left, 700 text, a drain bar on hover, entering with a 3-step "pop". Errors swap the
bar to coral.

### Inputs / Fields
- **Style:** `panel` fill, 1 px `line-strong`, 4 px corners, 34 px tall; selects draw their own two-triangle chevron.
- **Focus:** the border turns amber with a 3 px `accent-soft` halo.
- **Error / Disabled:** coral `field-error` text under the field; disabled at 50 % opacity with a not-allowed cursor.

### Navigation
- **HUD:** the pixel wordmark, then ⭐ stars · 🪙 coins (a pixel coin icon, never the emoji) · 💡 City Lights, the rank
  chip, a connection dot with one word ("Demo"), and the ⋯ menu. In Simple mode the HUD is only ⭐ · coins · To do ·
  Decorate · ⋯.
- **Tabs:** line icons over 11 px labels, muted until active; the active tab turns `ink-hi` with an amber icon and
  underline. A 7 px amber dot or a small count badge marks news.
- **Segmented switch** (Learn: Cards · Puzzles · Drawing board): a `panel` track, the pressed segment raised to `panel-hi`.
- **⋯ menu:** a 240 px floating list with labelled groups (small-caps muted labels), toggles drawn as 28 × 16 switches.

### Flashcard (signature)
A cream paper card (`paper`, min 160 px tall) that flips in 3D; the question uses glossary terms that only mark the
word, the answer side repeats the question small in sienna. It is the one place the desk turns to paper.

### The city stage (signature)
The Phaser canvas: generated isometric pixel art on a 32 × 16 grid, integer zoom, a seven-colour district map, AWS
Health storms, agents' white speech bubbles, label chips (11 px heavy text on a dark chip). Its colours come from
`src/game/theme.ts`, which mirrors the CSS tokens. The art is generated (`npm run art`), never hand-edited.

## Do's and Don'ts

### Do:
- **Do** take every colour, size, gap and radius from the tokens in `00-base.css` (and `theme.ts` for the canvas), so
  the text-size, high-contrast and easy-read modes in `22-access.css` reach it.
- **Do** keep one amber primary per screen and say exactly what it does ("Review 5 cards", "Walk to S3 Lake").
- **Do** design for the 400 px side panel first, then check the 1400 × 880 tab.
- **Do** keep district colours to small marks (an 8 px square, a 4 px segment).
- **Do** draw coins with the pixel `Coin` icon and stars as ⭐; never show "XP".
- **Do** give every animation a reduced-motion state: CSS durations collapse to 0.01 ms under
  `prefers-reduced-motion`, and the canvas parks its ambient motion.
- **Do** render in-world text with `crisp()` and counter-scale it by `1/zoom`; keep camera zoom on integers.

### Don't:
- **Don't** set font sizes in raw px outside the token scale: they ignore ⋯ → Text size.
- **Don't** use Press Start 2P for running text or at sizes off its 8 px grid.
- **Don't** put `muted` text on `panel-hi` (4.0:1, under AA).
- **Don't** fill large areas with a district colour or with amber.
- **Don't** add a second filled button beside the primary; use a graphite or ghost button.
- **Don't** hand-edit or regenerate the city's sprites in a UI change; they come from `npm run art`.
