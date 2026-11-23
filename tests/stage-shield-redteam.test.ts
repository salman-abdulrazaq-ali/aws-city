// Shield Wall and Red Team Range as scenes (batch B3a: findings 2, 3, 8 and 11), checked from the source as
// tests/a11y-games.test.ts does (a Phaser scene is not practical to run in a test): the city's own sprites on the stage
// (the service's landmark as your app, its agent at work, citizens as the traffic), theme tokens only, a whole-number
// play group in a centred column, Shield's how-to said once, and every spoken line still in its method.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src/game/scenes/games', f), 'utf8');
/** The source without its comments (a comment may name an old colour). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** The body of a scene's method, from its signature to the next method at the same indent. */
const method = (src: string, sig: string) => {
  const at = src.indexOf(sig);
  expect(at, sig).toBeGreaterThan(-1);
  const rest = src.slice(at + sig.length);
  const end = rest.search(/\n {2}(private|protected|override|public) /);
  return end < 0 ? rest : rest.slice(0, end);
};
const FILES = ['ShieldGame.ts', 'RedTeamGame.ts'];

describe('Shield Wall and Red Team Range wear the desk’s tokens (finding 3)', () => {
  const RETIRED = ['0f172a', '1e293b', '334155', '475569', '94a3b8', 'cbd5e1', 'e2e8f0', '140d1f', '161021', '1d1530', '221938', '2d2144', 'fde047', 'fde2e6', 'ffb84d', '86efac', 'fca5a5', '93c5fd', 'dd344c', 'b02a3d'];
  for (const f of FILES)
    it(`${f} has no colour literal of its own`, () => {
      const src = code(read(f));
      for (const hex of RETIRED) expect(src.toLowerCase(), `${f}: ${hex}`).not.toMatch(new RegExp(`(#|0x)${hex}`));
      // Theme tokens, FEEDBACK and the district colour only; pixel borders use PAL.black, never a literal.
      expect(src.match(/['"`]#[0-9a-fA-F]{3,8}\b/g), f).toBeNull();
      expect(src.match(/\b0x[0-9a-fA-F]{6}\b/g), f).toBeNull();
    });
});

describe('a scene with the city’s sprites, not a form (finding 2)', () => {
  it('Shield Wall: Shield’s landmark is your app behind a wall in the district’s red, its agent on guard, citizens on the road', () => {
    const src = read('ShieldGame.ts');
    expect(src).toMatch(/from '\.\/cast'/);
    expect(src).toMatch(/landmarkFrame\('shield'\) \?\? 'hq:security'/);
    expect(src).toMatch(/districtColor\('shield'\)/);
    expect(src).toMatch(/person\(this, 'shield', [^)]*'guard'/);
    expect(src).toMatch(/cast\(\d+\)/);
    // Walkers walk up the road to the left; Shield Standard is an info-blue ellipse.
    expect(method(src, '  private spawn() {')).toMatch(/'walk', 'SW'\)/);
    expect(src).toMatch(/this\.add\.ellipse\([^;]*COLOR\.info/);
  });

  it('Red Team Range: Security Agent’s landmark at the end of the lanes, the agent scanning, citizens holding their log line', () => {
    const src = read('RedTeamGame.ts');
    expect(src).toMatch(/from '\.\/cast'/);
    expect(src).toMatch(/landmarkFrame\('securityagent'\)/);
    expect(src).toMatch(/districtColor\('securityagent'\)/);
    expect(src).toMatch(/person\(this, 'securityagent', [^)]*'scan'/);
    expect(src).toMatch(/cast\(\d+\)/);
    expect(method(src, '  private spawn() {')).toMatch(/'walk', 'SW'\)/);
  });

  it('the person and their tag are one target: a press on either (or Space) is a press on the arrival', () => {
    const shield = method(read('ShieldGame.ts'), '  private spawn() {');
    expect(shield).toMatch(/\.on\('pointerdown', \(\) => t\.emit\('pointerdown'\)\)/);
    expect(shield).toMatch(/this\.add\.container\(/);
    const red = method(read('RedTeamGame.ts'), '  private spawn() {');
    expect(red).toMatch(/\.on\('pointerdown', \(\) => c\.emit\('pointerdown'\)\)/);
    expect(red).toMatch(/this\.add\.container\(/);
    // Space still finds the nearest by x and presses it.
    expect(method(read('ShieldGame.ts'), '  private strikeNearest() {')).toMatch(/b\.x < a\.x[\s\S]*t\.emit\('pointerdown'\)/);
    expect(method(read('RedTeamGame.ts'), '  private flagNearest() {')).toMatch(/b\.x < a\.x[\s\S]*t\?\.emit\('pointerdown'\)/);
  });
});

describe('the tab’s stage is used (finding 8)', () => {
  for (const f of FILES)
    it(`${f} sizes its play group by a whole-number scale and lays it out in a centred column`, () => {
      const src = code(read(f));
      expect(src).toMatch(/fitScale\(/);
      expect(src).toMatch(/this\.column\([^)]/);
      // No sprite at a half scale (it drops pixels).
      expect(src).not.toMatch(/\.setScale\(\d+\.5\)/);
    });
});

describe('Shield Wall says how to play once (finding 11)', () => {
  const src = read('ShieldGame.ts');
  const title = /super\('[^']+', '[^']+', '[^']+', '([^']+)'\)/.exec(src)?.[1] ?? '';
  const how = title.split(' — ')[1] ?? '';
  const legend = /const LEGEND = '([^']+)'/.exec(src)?.[1] ?? '';

  it('a short title that says what to do; Space is in keysHelp, not the title', () => {
    expect(how.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title).not.toMatch(/Space/);
    expect(src).toMatch(/this\.keysHelp = '[^']*Space[^']*\.'/);
  });

  it('the legend is a key only: no four words of the title’s how-to come back in it', () => {
    expect(legend).toMatch(/Space/);
    const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const h = words(how);
    const l = ` ${words(legend).join(' ')} `;
    expect(h.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i + 4 <= h.length; i++) {
      const run = h.slice(i, i + 4).join(' ');
      expect(l, run).not.toContain(` ${run} `);
    }
  });
});

describe('every spoken line is still in its method, and the rules are unchanged', () => {
  it('Shield Wall', () => {
    const src = read('ShieldGame.ts');
    const spawn = method(src, '  private spawn() {');
    for (const re of [
      /this\.speak\(`On the road: \$\{label\}\.`, true\)/,
      /this\.speak\(`Breach! \$\{label\} got in\. Score \$\{this\.score\}\.`\)/,
      /this\.speak\(`Stopped by \$\{SHIELD\.rules\[attack\.rule\]\.name\}\.`\)/,
      /this\.speak\(`Blocked a real user: \$\{label\}\.`\)/,
      /this\.speak\('Shield had this one: let floods through\.'\)/,
    ])
      expect(spawn).toMatch(re);
    for (const p of ['POINTS.shield.passed', 'POINTS.shield.breach', 'POINTS.shield.block', 'POINTS.shield.blockedUser', 'POINTS.shield.flood']) expect(spawn).toContain(p);
    expect(spawn).toMatch(/duration: pace\(speed\)/);
    const strike = method(src, '  private strikeNearest() {');
    expect(strike).toMatch(/this\.speak\('Nothing on the road to stop\.'\)/);
    expect(strike).toMatch(/swingReady\(this\.lastSwing, now\)/);
    expect(strike).toMatch(/this\.addScore\(SWING\.blank\)/);
    expect(method(src, '  private scheduleSpawn() {')).toMatch(/this\.speak\(`Wave \$\{wave \+ 1\}: they're getting faster\.`\)/);
  });

  it('Red Team Range: every request looks alike until it’s read, and a long line shrinks to TXT’s floor, then wraps', () => {
    const src = read('RedTeamGame.ts');
    const spawn = method(src, '  private spawn() {');
    expect(spawn).toMatch(/this\.speak\(`Request: \$\{r\.line\}`, true\)/);
    expect(spawn).toMatch(/freeLane\(this\.busy\)/);
    for (const p of ['POINTS.redteam.missed', 'POINTS.redteam.passed', 'POINTS.redteam.flag', 'POINTS.redteam.falseFlag']) expect(spawn).toContain(p);
    // Nothing about how a request looks depends on its flaw before the player decides.
    const before = spawn.indexOf('const tw =');
    expect(before).toBeGreaterThan(-1);
    expect(spawn.slice(0, before)).not.toMatch(/r\.flaw/);
    // The narrow-panel fallback is TXT's size (never under 11 px), never a fixed pixel size.
    expect(src).not.toMatch(/setFontSize\(\d/);
    expect(src).toMatch(/setFontSize\(TXT\(/);
    // A missed flaw still shakes the stage (not under reduced motion).
    expect(spawn).toMatch(/if \(!reducedMotion\(\)\) this\.cameras\.main\.shake\(/);
  });
});
