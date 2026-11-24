// Persona fixes (Lena, Jay; 22 Nov 2026), checked from the source (a Phaser scene is not practical to run in a test,
// as in tests/game-say.test.ts): the five games that only drew each thing to answer now say it, the sorting office's
// hot-key button is in plain words, Decorate's chips are big enough to press, and the Disconnect dialog's text has
// contrast in the dark theme and in high contrast.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
const game = (f: string) => read(`src/game/scenes/games/${f}`);
/** The body of a scene's method, from its signature to the next method at the same indent. */
const method = (src: string, sig: string) => {
  const at = src.indexOf(sig);
  expect(at, sig).toBeGreaterThan(-1);
  const rest = src.slice(at + sig.length);
  const end = rest.search(/\n {2}(private|protected|override|public) /);
  return end < 0 ? rest : rest.slice(0, end);
};

describe('each game says each thing to answer as it comes, like fishing and the sorting office', () => {
  it('the Lambda Food Stall says each order, the chef that takes it and how it ended', () => {
    const src = game('KitchenGame.ts');
    expect(method(src, '  private spawn() {')).toMatch(/this\.speak\(`New order: \$\{source\}\. \$\{this\.orders\.length\} waiting\.`, true\)/);
    const invoke = method(src, '  private invoke(o: Order) {');
    expect(invoke).toMatch(/this\.speak\('Throttled: every chef is busy\.'\)/);
    expect(invoke).toMatch(/this\.speak\(`Served \$\{o\.source\}/);
    expect(invoke).toMatch(/this\.speak\(`\$\{o\.source\} expired/);
    expect(method(src, '  override update(')).toMatch(/this\.speak\(`\$\{o\.source\} waited too long and expired/);
    expect(method(src, '  private provision() {')).toMatch(/this\.speak\(/);
  });

  it('the Shield wall says each arrival on the road and what striking it did', () => {
    const src = game('ShieldGame.ts');
    const spawn = method(src, '  private spawn() {');
    expect(spawn).toMatch(/this\.speak\(`On the road: \$\{label\}\.`, true\)/);
    expect(spawn).toMatch(/this\.speak\(`Breach!/);
    expect(spawn).toMatch(/this\.speak\(`Stopped by/);
    expect(spawn).toMatch(/this\.speak\(`Blocked a real user/);
    expect(spawn).toMatch(/this\.speak\('Shield had this one/);
  });

  it('the Queue Juggler says each message (poison by name) and each call', () => {
    const src = game('QueueGame.ts');
    expect(method(src, '  private spawn(poison: boolean) {')).toMatch(/this\.speak\(`\$\{poison \? 'Poison message' : 'Message'\}: \$\{label\}\.`, true\)/);
    const decide = method(src, '  private decide(e: Live, toDlq: boolean) {');
    expect(decide.match(/this\.speak\(/g)?.length).toBe(4);
    expect(method(src, '  private arrive(').match(/this\.speak\(/g)?.length).toBe(2);
  });

  it('Edge Cache says each miss, each file cached, each change at the origin and each stale copy', () => {
    const src = game('EdgeGame.ts');
    expect(method(src, '  private addFeed(city: string, name: string) {')).toMatch(/this\.speak\(`Miss: \$\{city\} asked for \$\{name\}/);
    expect(method(src, '  private request() {')).toMatch(/this\.speak\(`Stale:/);
    expect(method(src, '  private store(name: string')).toMatch(/this\.speak\(`Cached \$\{name\}/);
    expect(method(src, '  private change() {')).toMatch(/this\.speak\(`\$\{c\.name\} changed at the origin/);
  });

  it('the Red Team Range says each request', () => {
    expect(method(game('RedTeamGame.ts'), '  private spawn() {')).toMatch(/this\.speak\(`Request: \$\{r\.line\}`, true\)/);
  });
});

describe('the sorting office in plain words', () => {
  it('its hot-moment button says what it does (no “Spread the 🍎 keys”)', () => {
    const src = game('SortGame.ts').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/Spread the|spread the keys|Keys spread/);
    expect(src).toMatch(/`🔀 Share \$\{SORT\.hotKey\} over every shelf`/);
  });
});

describe('Decorate’s chips are big enough to press', () => {
  it('its tool switch and category chips are at least 24×24 px (WCAG 2.5.8)', () => {
    const css = read('src/app/styles/26-build.css');
    const rule = /\.bd-tools \.seg button,\s*\.bd-cats \.chip \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(Number(/min-height:\s*(\d+)px/.exec(rule)?.[1])).toBeGreaterThanOrEqual(24);
    expect(Number(/min-width:\s*(\d+)px/.exec(rule)?.[1])).toBeGreaterThanOrEqual(24);
  });
});

describe('the Disconnect dialog’s text has contrast', () => {
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (rgb: number[]) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const token = (css: string, name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6}|rgba\\([^)]*\\))`, 'i').exec(css)?.[1] ?? '';

  it('.confirm’s explanation is --ink-soft, 4.5:1 or more on its red tint over every panel, dark and high contrast', () => {
    const deploy = read('src/app/styles/13-deploy.css');
    expect(/\.confirm > span,\s*\.confirm > \.muted \{\s*color: var\(--ink-soft\);/.test(deploy)).toBe(true);
    const base = read('src/app/styles/00-base.css');
    const high = read('src/app/styles/22-access.css').split(":root[data-contrast='high'] {")[1] ?? '';
    const [r, g, b, a] = token(base, '--bad-soft').match(/[\d.]+/g)!.map(Number);
    for (const ink of [token(base, '--ink-soft'), token(high, '--ink-soft')]) {
      expect(ink).toMatch(/^#/);
      for (const panel of ['--bg-deep', '--bg', '--panel', '--panel-2', '--panel-3', '--panel-hi']) {
        const under = hex(token(base, panel));
        const tinted = under.map((c, i) => [r, g, b][i] * a + c * (1 - a));
        expect(ratio(hex(ink), tinted), `${ink} on ${panel}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
