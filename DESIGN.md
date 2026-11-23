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
  muted: "#969aa3"
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
    fontSize: "11px"
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
stepped like sprite frames, and a big moment in the city plays in order, one thing at a time. Every visual setting a player can change (text size, contrast, font, motion) is a token
override, never a second stylesheet.

**Key Characteristics:**
- Warm graphite surfaces layered by tone (bg → panel → panel-2 → panel-hi), with hairline borders instead of shadows.
- One amber primary per screen; district colours only as small identity marks.
- Nunito for everything readable; Press Start 2P only for the wordmark and a few game labels, on its 8 px grid.
- The pixel city is the only hard-edged, saturated thing on screen; the UI recedes around it.
- The side panel (400 px) is the design's first surface; the tab adds a wide stage, not a different UI.
- The canvas wears the same tokens: the mini-games' chrome is the desk's graphite and amber, and its text follows
  Text size.

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
- **Night strip** (`--night-sky-*`, `--window-*`, `--rarity-*`): the City Lights strip and the Daily Supply Drop's rarity
  rims. They are named tokens with the same values as the canvas's windows, so the strip and the city glow alike.

### Neutral
- **Night Graphite** (`bg`): the app background and the side column.
- **Deep Graphite** (`bg-deep`): the stage behind the canvas.
- **Desk Graphite** (`panel`), **Raised Graphite** (`panel-2`), **Lit Graphite** (`panel-hi`): cards, rows and
  menus; hover and pressed states step one tone up.
- **Hairline** (`line`, `line-strong`): every border and divider.
- **Parchment Ink** (`ink`, `ink-hi`, `ink-soft`): body text, headings, secondary text.
- **Fog** (`muted`): metadata and section labels. Measured 6.4:1 on `bg`, 5.7:1 on `panel`, 5.3:1 on `panel-2` and
  4.6:1 on `panel-hi`: AA on every graphite surface. High contrast swaps in its own lighter value.
- **Semantic**: `good` (teal-green, done and linked), `warn` (straw, rush hour and "updating"), `bad` (coral, destructive
  and errors, always paired with `bad-ink` text on `bad-soft`), `info` (sky, links and notes), `code` (mint, inline code).

### On the canvas
Phaser takes the same tokens from `src/game/theme.ts` (`CSS` strings and `COLOR` numbers, under the CSS names).
- **Game chrome** (`GAME_PAL`, the mini-games' `PAL`): the stage and title bar `bg`, the hint strip `panel`, stat chips
  and the quiet "← City" button `panel-hi`, borders `line`, the one primary `accent` with `accent-ink` text, the Expert
  chip `gold-hi` (kept apart from the amber), the end card on flashcard `paper` with `paper-ink` and the flashcard's
  darker small print (meta `#7c2d12`, hint `#4a4540`, 6:1 on paper). Text on the stage is `ink-hi`, `good`, `muted`, and
  `bad-ink` for red (never `bad`: 4:1 on a chip). A verdict sits on `GAME_PILL`, `bg` at 95 %.
- **Label chip** (`LABEL_BG`, `bg` at 85 %): every sign and tag on the map, the world map's city names (`gold-hi`) and
  link arrows (`ink-hi`).
- **Scene art keeps its own colours**: skies, the lake and its fish, the factory's brick, the storage classes' buckets, and
  a game's district colour as its place (the Dance Hall's violet floor, the Shield Wall's security red). The world map's
  land, sea, city gold and data-link colours are its art, and the links match the city's.

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
- **Display** (Press Start 2P 400, 15 px; 11 px for small pixel labels): the wordmark and a few pixel badges. Only the
  8 px-grid sizes (10, 11, 15 px) stay crisp. The mini-games' titles are Nunito 800 in amber, drawn on the canvas.
- **Headline** (800, 17 px, `--fs-xl`): the few big numbers and celebration lines.
- **Title** (800, 15 px, `--fs-lg`): card titles, a building's name, the flashcard question.
- **Body** (400–700, 13 px, `--fs-md`, line-height about 1.45): running text in cards, the menu, the shift.
- **Label** (800, 12 px, `--fs-sm`, muted, sentence case): the single section-label style ("Today's shift", "Blueprints").
- **Caption** (700, 11 px, `--fs-xs`): tab labels, tab badges, chips' counts and the connection word; 11 px is reserved
  for non-essential labels.

Every font size in the stylesheets is a `--fs-*` token (or an `em` of one), so ⋯ → Text size reaches it. Emoji and icon glyphs scale the same
way, as `calc(var(--fs-md) * N / 13)` (N px at 100 %). The one raw value is the panel HUD rank chip's icon-only
`font-size: 0`. SVG text in the diagrams is in viewBox units and scales with the drawing.

On the canvas, every size goes through `textPx` (`src/game/theme.ts`): the design size times ⋯ → Text size (1, 1.25 or
1.5), never under `MIN_TEXT_PX` 11. The mini-games' `TXT` draws 85 % of the design size (Nunito sets large: the 17 px
title draws 14 px, the 14 px hint strip 12 px); the world map's `worldText` sets its title at 14 px and its Region line,
city names and link arrows at 11 px; an HQ room's title is 12 px and its tags 11 px. The city's signs and tags are 11 px
heavy on the label chip, counter-scaled by the zoom. Layouts measure their text, so bigger text takes room instead of
overlapping: the end card lays its buttons out by measured width and wraps them inside the card.

### Named Rules
**The 12 px Floor Rule.** 12 px is the floor for body text; 11 px only for non-essential labels. No shipped exceptions:
tab badges are 11 px and the wordmark is `--fs-pixel`.

**The 11 px Canvas Floor Rule.** Nothing a player reads on the canvas is under 11 px, at any text size or zoom. A line
too long for its place shrinks to the floor, then wraps (the Red Team Range's log lines); it never shrinks further.

**The Pixel Grid Rule.** Press Start 2P only at its two tokens, `--fs-pixel` 11 px and `--fs-pixel-lg` 15 px (15 and 19 px at the bigger text sizes). Never scale it by a fraction.

**The Heavy-Weight Rule.** Emphasis is weight (700/800), not colour or italics; most labels and buttons are 700–800.

## Layout

The app is one CSS grid with two surfaces:

- **Side panel** (`.app-panel`, about 400 px wide): rows `hud / stage / side`. The stage (the city) gets
  `minmax(150px, 34%)` of the height (54 % when the player asks for a taller map); the side column below takes the rest.
  While the player scrolls the side column, the compact map slides to its 150 px floor; it grows back at the top, on a
  tab change or on a view change. A mini-game takes the whole height under the HUD.
- **Full tab** (`.app-full`, 1400 × 880 reference): `hud` across the top, then the stage (`1fr`) beside the side
  column (`--side-w`) with a 1 px left hairline. The column is 400 px on a laptop and gives way before the map does:
  it narrows to 320 px (the panel's own narrowest) between ~1270 and ~910 px wide, and past 2000 px grows to 20 %
  (480 px at most). A 760 px window's map is 422 px, not 342. The side column's content is the same as the panel's.
  Under 720 px wide the tab stacks like the panel instead (the map `minmax(220px, 45%)`, the side column below with a
  top hairline, a mini-game the whole height), so a narrow window never squeezes the map to nothing.
- **Minimap** (168 × 92, bottom right over the stage): on in the tab when its map has room (600 × 400 px or more);
  on a smaller map, as in the panel, it waits behind its 🗺 button (M toggles it). The player's choice wins.

The side column stacks: tabs (City · Learn · Jobs · Deploy, opened by the unlock ladder), a scrolling `.tab-body`
(12 px sides, 16 px bottom, a stable scrollbar gutter), then the footer: one row, the prompt bar. Its AI note shows
above the box while the box has focus or words in it; the rest of the time it is visually hidden but stays the box's
`aria-describedby`. In the panel, the Console Copilot switch joins the footer only on the City tab, beside an AWS
console page, or while it is on. Spacing is a 2/4/6/8/12/16
px scale (`--s-1` … `--s-6`), and corners the `--r-*` scale, in every sheet (the workshop, clients and station styles
included); gaps between cards are 8 px, card padding 12 px. Breakpoints are narrow-surface
adjustments only: `max-width: 480px` hides the connection word, `max-width: 420px` hides the City Lights count and the
rush-hour word.

In the canvas, the camera zoom is always an integer. The city starts at the zoom its map's size gives (the largest
that still shows 720 × 400 world px: 2 on a 1920 × 1080 window's map, 1 up to a 1536 px window and in the panel), on
the whole core when it fits, else on the Town Square, so a big screen shows about as much city as a laptop, bigger,
instead of more sea. A resized tab keeps the view's centre and takes that zoom again, until the player zooms (+/−, the
wheel) during that visit. In-world text is counter-scaled by the zoom so it stays readable at 400 px. Sprites keep whole
numbers too: a mini-game lays its play group out at 1× and draws it at the biggest whole-number scale that fits
(`playScale`, `fitScale`): 1× in the 400 px panel, 2× in the tab, never 1.5×. Its props, people and 9-slice frames take
that scale, its text does not (text follows Text size alone), and the group sits in a centred column (`column`) so the
tab's stage has no empty sky beside a small scene.

### Named Rules
**The Whole Pixel Rule.** Pixel art moves and scales on whole pixels: integer zoom at rest, whole-number sprite scales,
positions rounded, confetti turning in quarter turns. A fractional zoom is allowed only mid-tween.

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
- **Goal chips** (Today's shift): a round mark leads each one, an open ring that fills with `good` (a conic fill) as the
  goal moves and turns solid when it's done; never a ◻️/✅ swatch that reads as a checkbox. A counted chip drops its
  number while the count shows beside it ("Review cards 0/5").

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
Over the stage, centred, below the news ticker, one at a time from the store's queue. `panel` fill, a 4 px amber inset
bar on the left, 700 text, a drain bar on hover, entering with a 3-step "pop". Errors swap the bar to coral. In the
panel a toast is a step smaller (12 px text, tighter padding) and the news ticker steps aside while it shows. The
one-time coins note hangs under the ticker on the tab's map; on a short one (the panel's, the narrow tab's) it is one
line in the ticker's place at the top-left, under the coins, and the ticker steps aside meanwhile. It steps aside for a
toast too. In a narrow window the ticker is one compact line (24 px).

### Disclosures
Every `<summary>` row is at least 24 px tall, its words centred. The folds share one look: `ink-soft`, bold, no
underline ("For AWS learners", "Tell me more", Deploy's "What the role can do", "Show the CloudFormation").

### Inputs / Fields
- **Style:** `panel` fill, 1 px `line-strong`, 4 px corners, 34 px tall; selects draw their own two-triangle chevron.
- **Focus:** the border turns amber with a 3 px `accent-soft` halo.
- **Error / Disabled:** coral `field-error` text under the field; disabled at 50 % opacity with a not-allowed cursor.

### Navigation
- **HUD:** the pixel wordmark, then ⭐ stars · 🪙 coins (a pixel coin icon, never the emoji) · 💡 City Lights ("N
  windows lit" in the tab, a 24 px target), the rank chip, a connection dot with one word ("Demo"), and the ⋯ menu. In
  Simple mode the HUD is only ⭐ · coins · To do · Decorate · ⋯. The panel's city HUD drops the wordmark (the browser's
  panel header already names AWS City) to keep "🌳 Decorate" in words; at a bigger text size Decorate goes back to its icon.
- **Tabs:** line icons over 11 px labels, muted until active; the active tab turns `ink-hi` with an amber icon and
  underline. A 7 px amber dot or a small 11 px count badge marks news.
- **Segmented switch** (Learn: Cards · Puzzles · Drawing board; Decorate's Place · Move · Remove): a `panel` track, the
  pressed segment raised to `panel-hi`.
- **⋯ menu:** a 240 px floating list in labelled groups (small-caps muted labels): Account first when hosted, then
  Sound & view, Accessibility, How you play, Your city, and Privacy and Credits last. Toggles are drawn as 28 × 16
  switches; Decorate is a plain item ("🌳 Decorate" / "🌳 Done decorating").
- **Back:** a top-left ghost row with the back icon ("‹ Today's shift", "← All businesses"), never a centred button at
  the bottom.

### Flashcard (signature)
A cream paper card (`paper`, min 160 px tall) that flips in 3D; the question uses glossary terms that only mark the
word, the answer side repeats the question small in sienna. It is the one place the desk turns to paper.

### Approval card (signature)
A waiting approval leads its own Deploy section, "Waiting for your OK", after the account card and above Blueprints and
My builds. Under the title, a bordered line says where it writes first ("Changes AWS account 0474-6343-8585 ·
us-west-2", the id and Region never split; the demo names the practice account, on fix cards too). Then one plain line
per resource ("+ Add S3 bucket", its logical ID second in muted mono), one "For AWS learners" fold for the types
and the price, and the amber "Approve & deploy" in plain words.

### Places list
Each district folds to one row: its 8 px square, its name, "N ready to upgrade" in `good-ink` when any, and found/total.
Inside, the ready buildings come first.

### Decorate drawer
The tool is the shared segmented switch (Place · Move · Remove, 360 px at most) with "✔ Here" as a small button beside
it: a mode, then an action. The categories are one chip row that scrolls sideways with faded edges. Counts and prices
are Nunito with tabular figures, never mono.

### Puzzle board
The diagram's spot labels never draw below `--fs-xs`: the board keeps its natural size at the player's text size, so a
wide puzzle scrolls sideways in the 400 px column. Check design sits on its own row under the message, and the legend is
in words. In the tab, Bigger board turns the same board into a dialog over the city (brief and cards left, the diagram
right), with nothing lost.

### The city stage (signature)
The Phaser canvas: generated isometric pixel art on a 32 × 16 grid, integer zoom, a seven-colour district map, AWS
Health storms, agents' white speech bubbles, label chips (11 px heavy text on a dark chip). Its colours come from
`src/game/theme.ts`, which mirrors the CSS tokens. The art is generated (`npm run art`), never hand-edited.
- **Bubbles:** one at a time in the panel (a new line fades the one before), and none held past 5 s there or 8 s in the
  tab. A bubble's caption names who it's for in words ("Cody · to you").
- **Signs (the label budget):** names show on hover or from zoom 2; technical labels only with ⋯ → Show the map
  details. From zoom 2 a view holds at most 10 building signs, 6 from zoom 3 on the tab's map and a share of that on a
  smaller one (3 in the panel), never under 3; the picked or hovered building doesn't count. They go picked first, then
  standing in view, ready to upgrade, nearest Kai. A sign is the building's name (and cards due); "· Lv N" shows only
  while it's picked or hovered. The service icon above it keeps one on-screen size at every zoom (16 px × text size).
- **Tags:** one overlap pass over everything on the map, in order: Kai's tag, the "E · …" hint, signs, working agents'
  tags, then citizens'; a tag that would cover one kept before it hides (hovering a walker shows its tag). While
  decorating, no building names show.
- **Night:** the player's buildings lift out of the night's tint (a copy added over each, at 55 % of the night at zoom 1,
  half at zoom 2, none from zoom 3), so a grown city never flattens into one dark field; closer in, lit windows carry it.
- **Motion:** one moment at a time, in order. A tier-up: the camera lands while the building waits on its ground floor,
  the tower rises floor by floor, one payoff (one burst, the banner, the fanfare, the cheer), then a push-in of one
  integer zoom step 250 ms later; the labels stay at the resting zoom meanwhile. A camera flight takes 300 ms plus the
  screen distance at 2.5 px a ms, 350–1000 ms, slowing into the arrival (`Cubic.easeOut`); further than 1.5 views it
  cuts through a sea-blue fade (140 ms out, 220 ms in), like the world map's dive. A business's level-up flies there
  first, then the site stands up with a small settle (`Back.easeOut`, overshoot 1) and 16 dark-outlined confetti pieces
  of 7–9 px fall in quarter turns. A right answer's beam (a 3 px gold core, a 1 px pale-gold glint, one 7 px halo step,
  normal blend) lands in 40 % of 600 ms, then a tile-shaped ring pulses on the building. The first-courier tip waits
  while a toast or the coins note is up.
- **Reduced motion:** every flight and dive is a cut; a tier-up shows its banner and cheer at once, still; no rise,
  push-in, confetti, beam or coin flight; traffic parks at the kerb; citizens, workers, visitors, landmark agents and
  patrols stand where they are, still tappable (a task's walk, a walk to work and a finding's visit still go).
- **Loading tip:** 12 px `ink-soft` on a solid graphite chip, never small muted text straight on the stage.

### The world map
The Region picker wears the city's tokens: the title in `ink-hi` (14 px), the Region line in `ink` on a graphite chip,
"Facts ›" in amber, city names in `gold-hi` on the label chip; nothing under 11 px. Each skyline lights by its own
Region's night. Picking a dot, or the first run's "Start in <city>", dives: the map's words fade in 180 ms, the land
zooms and fades to the sea blue, and the city fades in from the same sea. The first run's card waits for the map to be
drawn (the boot bar stands alone before it), and on a press it steps aside at once,
keeping its place, and the minimap's box shows only once the city answers.

### HQ rooms
A district's HQ is one room: six desks and a wall of racks. The first six of its staff sit at the desks, the rest (up
to five) stand on the grate by the racks, every other row, at their city activity, so a full district of 11 fits. Each
starts at its own spot and idles on its own patch of floor, never in front of the door, so the staff never stand in a
knot. The room's sign is pinned to the top of the view (12 px `ink-hi` on graphite); names and bubbles follow Text size.

### Mini-game stage (signature)
A game is a small scene with people in it, never a form of text tags on empty lanes: the service's agent at work, crowd
citizens as the requesters and attackers (holding their ticket or log line on a chip, or waiting their turn in a
line), the landmark at its level in
this city where the game has a place, and generated props (`game:<game>:<prop>`, side views drawn at 1×).
- **Chrome:** a `bg` title bar with the title in amber, stat chips on `panel-hi`, the hint strip on `panel` in
  `ink-soft`, one amber primary (✓ Done), Expert as a pale-gold chip; verdicts on the near-opaque graphite pill.
- **Layout:** a centred column; the play group laid out at 1× and drawn at the whole-number scale that fits (1× in the
  panel, 2× in the tab). A tiled or 9-slice prop (a conveyor, a notice board, a counter) is sized by its text, in whole
  multiples of that scale. What the player picks keeps its height at the play scale, and a note about it gets its own
  line under its label (Edge Cache's counters), never a floater across a label.
- **Feedback:** an answer shows where it went, for a pointer and a key alike: a 3 px frame round its target for 420 ms
  (green with eight pixel sparks when right, red when not, amber for a plain action), the button a key pressed sinks
  like a click, and a right answer's sparks burst at the answer, never at a pointer left elsewhere. Buttons name their
  keys ("+ server (↑)").
- **End card:** a round that didn't count leads with the next try in ink ("Next try: take your time and make surer
  calls"); the accuracy floor and its numbers come second in sienna, never red. The card is flashcard paper.
- **Reduced motion:** frames show still for the same time, nothing flies, and people hold their first frame.

## Do's and Don'ts

### Do:
- **Do** take every colour, size, gap and radius from the tokens in `00-base.css` (and `theme.ts` for the canvas), so
  the text-size, high-contrast and easy-read modes in `22-access.css` reach it.
- **Do** keep one amber primary per screen and say exactly what it does ("Review 5 cards", "Walk to S3 Lake").
- **Do** design for the 400 px side panel first, then check the 1400 × 880 tab.
- **Do** keep district colours to small marks (an 8 px square, a 4 px segment).
- **Do** draw coins with the pixel `Coin` icon and stars as ⭐; never show "XP".
- **Do** give every animation a reduced-motion state: CSS durations collapse to 0.01 ms under
  `prefers-reduced-motion`, and the canvas parks its ambient motion (cars at the kerb, walkers and agents where they
  stand) and cuts its camera moves.
- **Do** play a big moment in order, one thing at a time (land, rise, payoff, push-in), and time a camera flight by its
  distance.
- **Do** start entrances from opacity 0.6 (the shared `enter`), never 0: the side panel can draw at a few frames a
  second, and content must show before the entrance ends.
- **Do** keep one overlay at a time on the panel's map: one line on its top edge (a toast, else the coins note, else
  the ticker), one speech bubble.
- **Do** render in-world text with `crisp()` and counter-scale it by `1/zoom`; keep camera zoom and sprite scales on
  whole numbers, and size canvas text through `textPx` (a mini-game's through `TXT`).

### Don't:
- **Don't** set font sizes in raw px outside the token scale: they ignore ⋯ → Text size.
- **Don't** use Press Start 2P for running text or at sizes off its 8 px grid.
- **Don't** fill large areas with a district colour or with amber.
- **Don't** add a second filled button beside the primary; use a graphite or ghost button.
- **Don't** hand-edit or regenerate the city's sprites in a UI change; they come from `npm run art`.
- **Don't** start a moment's effects in the same frame, or let a celebration's zoom pop the labels on and off.
- **Don't** give a mini-game's chrome a hex of its own: chrome is `GAME_PAL`; only its scene art (skies, the lake, the
  factory's brick, a district's colour) keeps colours of its own.
