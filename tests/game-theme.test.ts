// The mini-games wear the desk's tokens (src/game/theme.ts GAME_PAL, GAME_PILL), and their text follows ⋯ → Text size
// and never draws under 11 px (theme.ts textPx, MiniGame's TXT). Checked from the source: a Phaser scene is not
// practical to run in a test (as in tests/game-say.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COLOR, CSS, GAME_PAL, GAME_PILL, MIN_TEXT_PX, textPx } from '@/game/theme';
import { FEEDBACK, PILL } from '@/game/scenes/games/scoring';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const css = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
/** Code without its comments: comments may name old colours. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('mini-game text', () => {
  it('never draws under 11 px, at any design size the games use and any text size', () => {
    for (const size of [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 24])
      for (const scale of [1, 1.25, 1.5]) expect(textPx(size * 0.85, scale), `${size} at ${scale}`).toBeGreaterThanOrEqual(MIN_TEXT_PX);
    expect(MIN_TEXT_PX).toBe(11);
  });

  it('grows with the player’s text size and keeps today’s sizes at 100 %', () => {
    expect(textPx(16 * 0.85)).toBe(14);
    expect(textPx(16 * 0.85, 1.25)).toBe(17);
    expect(textPx(16 * 0.85, 1.5)).toBe(20);
    expect(textPx(12 * 0.85)).toBe(11); // was 10 px
  });

  it('TXT reads prefs.textSize through textPx', () => {
    const mini = code(read('src/game/scenes/games/MiniGame.ts'));
    expect(mini).toMatch(/const textScale = \(\) => \(useCity\.getState\(\)\.prefs\.textSize \?\? 100\) \/ 100/);
    expect(mini).toMatch(/fontSize: `\$\{textPx\(size \* 0\.85, textScale\(\)\)\}px`/);
  });
});

describe('the mini-games’ chrome is the desk’s', () => {
  it('PAL is theme.ts GAME_PAL, PILL is GAME_PILL, and MiniGame names no colour of its own', () => {
    const mini = code(read('src/game/scenes/games/MiniGame.ts'));
    expect(mini).toMatch(/export const PAL = GAME_PAL;/);
    expect(code(read('src/game/scenes/games/scoring.ts'))).toMatch(/export const PILL = GAME_PILL;/);
    expect(PILL).toBe(GAME_PILL);
    expect(mini).not.toMatch(/'#[0-9a-f]{3,8}'/i);
    expect(mini).not.toMatch(/0x(?!000000\b)[0-9a-f]{6}/i);
  });

  it('every GAME_PAL colour is a theme token (black aside), and the theme mirrors the stylesheet', () => {
    const tokens = new Set<string | number>([...Object.values(CSS), ...Object.values(COLOR)]);
    for (const [k, v] of Object.entries(GAME_PAL)) if (k !== 'black') expect(tokens.has(v), k).toBe(true);
    const base = read('src/app/styles/00-base.css');
    for (const [name, token] of [['--bg', CSS.bg], ['--panel', CSS.panel], ['--panel-hi', CSS.panelHi], ['--accent', CSS.accent], ['--paper', CSS.paper], ['--paper-ink', CSS.paperInk]])
      expect(new RegExp(`${name}:\\s*${token}`, 'i').test(base), name).toBe(true);
    const card = read('src/app/styles/10-flashcards.css');
    expect(card).toContain(`--paper-meta: ${CSS.cardMeta}`);
    expect(card).toContain(`--paper-hint: ${CSS.cardHint}`);
  });

  it('text on each chrome surface reads at 4.5:1 or better', () => {
    const pairs: [string, string, string][] = [
      ['ink on the stage', GAME_PAL.ink, css(GAME_PAL.bg)],
      ['ink on a chip', GAME_PAL.ink, css(GAME_PAL.chip)],
      ['red score/timer on a chip', GAME_PAL.bad, css(GAME_PAL.chip)],
      ['good on the stage', GAME_PAL.good, css(GAME_PAL.bg)],
      ['muted on the stage', GAME_PAL.muted, css(GAME_PAL.bg)],
      ['the hint on its strip', CSS.inkSoft, css(GAME_PAL.panel)],
      ['the title', GAME_PAL.accentCss, css(GAME_PAL.bg)],
      ['the primary button', GAME_PAL.accentInk, css(GAME_PAL.accent)],
      ['Expert', GAME_PAL.paperInk, GAME_PAL.expertCss],
      ['the board link', GAME_PAL.paperMeta, GAME_PAL.expertCss],
      ['paper ink', GAME_PAL.paperInk, css(GAME_PAL.paper)],
      ['paper meta (the floor line)', GAME_PAL.paperMeta, css(GAME_PAL.paper)],
      ['paper hint (lesson, growth, pay notes)', GAME_PAL.paperHint, css(GAME_PAL.paper)],
    ];
    for (const [what, fg, bg] of pairs) expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(4.5);
    for (const [k, c] of Object.entries(FEEDBACK)) expect(contrast(c, css(GAME_PAL.bg)), `${k} on the stage`).toBeGreaterThanOrEqual(4.5);
  });

  it('the end card still leads with the next try, and its buttons wrap rather than overlap at a bigger text size', () => {
    const finish = code(read('src/game/scenes/games/MiniGame.ts')).split('  protected finish() {')[1];
    expect(finish.indexOf('nextTryLine(short)')).toBeLessThan(finish.indexOf('const score = text('));
    expect(finish).toMatch(/buttonRows\(\s*buttons\.map\(\(b\) => b\.width\),\s*cw - 24,?\s*\)/);
  });
});
