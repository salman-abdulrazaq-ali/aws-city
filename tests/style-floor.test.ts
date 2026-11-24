// The stylesheet's floor: tokens that ⋯ → Text size and High contrast can reach, text that passes AA on every surface,
// disclosure rows big enough to press, and entrances that never hide what they bring in.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSS, TIP_STYLE } from '@/game/theme';

const dir = path.resolve(__dirname, '../src/app/styles');
const css = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
const file = (prefix: string) => fs.readdirSync(dir).find((f) => f.startsWith(`${prefix}-`))!;
const token = (src: string, name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(src)?.[1];
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// Comments say "12 px" and "#hex" freely; only declarations count.
const rules = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');
const SURFACES = ['--bg-deep', '--bg', '--panel', '--panel-2', '--panel-3', '--panel-hi'];

describe('the style floor', () => {
  it('--muted reads at 4.5:1 or better on every graphite surface, dark and high contrast', () => {
    const base = css('00-base.css');
    const high = css('22-access.css').split(":root[data-contrast='high'] {")[1] ?? '';
    for (const muted of [token(base, '--muted')!, token(high, '--muted')!])
      for (const surface of SURFACES)
        expect(contrast(muted, token(base, surface)!), `${muted} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });

  // The HUD's rank chip in Decorate's panel shows only its icon (`font-size: 0`: its name stays its accessible name).
  const EXEMPT: Record<string, RegExp> = { '26': /\.hud \.rank-chip \{\s*font-size: 0;\s*\}/ };

  it('font sizes come from the --fs-* tokens (or follow one), so the text-size setting reaches them', () => {
    for (const prefix of ['00', '02', '04', '10', '12', '15', '18', '20', '21', '22', '23', '24', '25', '26', '27', '29', '30']) {
      const f = file(prefix);
      const src = EXEMPT[prefix] ? rules(css(f)).replace(EXEMPT[prefix], '') : rules(css(f));
      if (EXEMPT[prefix]) expect(src, `${f}: the exemption still matches`).not.toBe(rules(css(f)));
      for (const [, value] of src.matchAll(/(?<![-\w])font-size:\s*([^;]+);/g))
        expect(/var\(--fs-|^[\d.]+em$|^inherit$/.test(value.trim()), `${f}: font-size: ${value}`).toBe(true);
    }
  });

  it('every disclosure row is at least 24 px tall', () => {
    const rule = /(?:^|\n)summary \{([^}]*)\}/.exec(rules(css('00-base.css')))?.[1] ?? '';
    expect(Number(/min-height:\s*(\d+)px/.exec(rule)?.[1])).toBeGreaterThanOrEqual(24);
  });

  it('disclosures share one look: ink-soft and bold (Show the CloudFormation, Deploy’s “What the role can do”)', () => {
    for (const [f, selector] of [['23', '.template-view summary'], ['13', '.why summary']]) {
      const body = rules(css(file(f))).split(`\n${selector} {`)[1]?.split('}')[0] ?? '';
      expect(body, selector).toMatch(/color:\s*var\(--ink-soft\)/);
      expect(body, selector).toMatch(/font-weight:\s*700/);
    }
  });

  it('the loading tip reads at --fs-sm on a solid chip (BootScene)', () => {
    expect(TIP_STYLE.fontSize).toBe(/--fs-sm:\s*(\d+px)/.exec(css('00-base.css'))![1]);
    expect(TIP_STYLE.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(TIP_STYLE.color, TIP_STYLE.backgroundColor)).toBeGreaterThanOrEqual(4.5);
    expect(TIP_STYLE.color).not.toBe(CSS.muted);
    expect(fs.readFileSync(path.resolve(__dirname, '../src/game/scenes/BootScene.ts'), 'utf8')).toMatch(/\.\.\.TIP_STYLE/);
  });

  it('the shared entrance starts readable (opacity 0.6 or more), however slowly the panel draws', () => {
    const frames = /@keyframes enter \{([\s\S]*?)\n\}/.exec(css(file('04')))![1];
    for (const [, o] of frames.matchAll(/opacity:\s*([\d.]+)/g)) expect(Number(o)).toBeGreaterThanOrEqual(0.6);
  });

  it('workshops, clients, stations and loops take spacing, radii and colours from the tokens', () => {
    for (const prefix of ['23', '24', '25', '27']) {
      const f = file(prefix);
      const src = rules(css(f));
      for (const [, prop, value] of src.matchAll(/(?<![-\w])((?:padding|margin)(?:-[a-z]+)*|gap|row-gap|column-gap|border(?:-[a-z]+)*-radius)\s*:\s*([^;]+);/g))
        expect(/\b\d+px\b/.test(value), `${f}: ${prop}: ${value}`).toBe(false);
      if (prefix === '27') expect(src.match(/#[0-9a-f]{3,8}\b/gi) ?? [], `${f}: raw colours`).toEqual([]);
    }
  });
});
