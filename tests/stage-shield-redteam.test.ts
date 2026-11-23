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

describe('the art generator’s props (batch B6: art/tiles/games_art.py)', () => {
  type Anchor = { ax: number; ay: number; w: number; h: number };
  const atlas = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/assets/city/sprites.json'), 'utf8')) as { sprites: Record<string, Anchor> }).sprites;

  it('the atlas has the wall’s pieces at one width, the flood’s three frames on one canvas, five numbered lane booths and the scanner', () => {
    for (const n of ['game:shield:wall-top', 'game:shield:wall', 'game:shield:gate']) expect(atlas[n]?.w, n).toBe(32);
    // A course of masonry stacks: anchored at its top-left corner, 16 px tall.
    expect(atlas['game:shield:wall']).toMatchObject({ ax: 0, ay: 0, h: 16 });
    // The gate stands on the road: anchored at the middle of its foot.
    expect(atlas['game:shield:gate']).toMatchObject({ ax: 16, ay: 56 });
    const floods = [0, 1, 2].map((f) => atlas[`game:shield:flood${f}`]);
    expect(new Set(floods.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(floods[0]).toMatchObject({ w: 40, h: 28, ax: 20, ay: 28 });
    for (let n = 1; n <= 5; n++) expect(atlas[`game:redteam:lane${n}`], `lane${n}`).toMatchObject({ w: 36, h: 48, ax: 18, ay: 48 });
    expect(atlas['game:redteam:scanner']).toMatchObject({ w: 36, h: 70, ax: 18, ay: 70 });
  });

  it('Shield Wall builds its wall from the pieces (a course per 16 px down to the gate) and plays the swarm’s frames, still under reduced motion', () => {
    const setup = code(method(read('ShieldGame.ts'), '  protected setup() {'));
    expect(setup).toMatch(/if \(hasSprite\('game:shield:gate'\)\) \{/);
    expect(setup).toMatch(/y \+= WALL\.course \* s\) prop\(this, 'game:shield:wall', wallX, y, s\)/);
    expect(setup).toMatch(/prop\(this, 'game:shield:wall-top'/);
    expect(setup).toMatch(/prop\(this, 'game:shield:gate', wallX \+ wallW \/ 2, base, s\)/);
    // The drawn wall stays for an atlas without the pieces.
    expect(setup).toMatch(/\} else \{[\s\S]*districtColor\('shield'\)/);
    const packets = method(read('ShieldGame.ts'), '  private packets(s: number)');
    expect(packets).toMatch(/hasSprite\(FLOOD\.frames\[0\]\)/);
    expect(packets).toMatch(/if \(!reducedMotion\(\)\) swarm\.play\(FLOOD\.anim\)/);
    expect(packets).toMatch(/\.setScale\(s\)/);
  });

  it('Red Team Range: a numbered booth ends each lane, behind the requests; the agent scans at its console when the atlas has one', () => {
    const setup = code(method(read('RedTeamGame.ts'), '  protected setup() {'));
    expect(setup).toMatch(/prop\(this, `game:redteam:lane\$\{i \+ 1\}`, [^;]*\.setDepth\(19\)/);
    expect(setup).toMatch(/if \(hasSprite\('game:redteam:scanner'\)\) \{\s*prop\(this, 'game:redteam:scanner'/);
    // Requests stand in front of the booths (their depth is 20 + lane).
    expect(method(read('RedTeamGame.ts'), '  private spawn() {')).toMatch(/\.setDepth\(20 \+ lane\)/);
  });
});

describe('Red Team Range’s lanes hold people, not empty floor (batch B9a)', () => {
  const src = read('RedTeamGame.ts');
  /** The file's numeric top-level constants (`const NAME = <expression>;`), worked out in order. */
  const c: Record<string, number> = {};
  for (const [, name, expr] of src.matchAll(/^const ([A-Z][A-Z0-9_]*) = ([^;\r\n]+);\r?$/gm)) {
    const value: unknown = Function(...Object.keys(c), `return (${expr});`)(...Object.values(c));
    if (typeof value === 'number') c[name] = value;
  }

  it('each lane is as tall as what stands in it: a tall tab never stretches it', () => {
    const setup = code(method(src, '  protected setup() {'));
    expect(setup).toMatch(/this\.laneH = laneMin;/);
    expect(setup).not.toMatch(/Math\.floor\(free \/ 5\)/);
  });

  it('a short line of requesters waits behind each lane’s booth, facing the range, clear of the booth and inside the range', () => {
    const setup = code(method(src, '  protected setup() {'));
    expect(setup).toMatch(/prop\(this, `game:redteam:lane\$\{i \+ 1\}`, col\.r - \(QUEUE_W \+ BOOTH_W \/ 2\) \* s, /);
    // Behind every request (20 + lane), in front of the booths (19).
    expect(setup).toMatch(/Array\.from\(\{ length: QUEUE \}, \(_, k\) => person\(this, this\.nextInLine\(\), col\.r - \(QUEUE_W - 12 - k \* QUEUE_STEP\) \* s, feet, s, 'idle', 'SW'\)\.setDepth\(19\.5\)\)/);
    expect(c.QUEUE).toBeGreaterThanOrEqual(1);
    // At 1× a crowd citizen's body is about 18 px wide: the first in line stands ≥ 10 px right of the booth's side, the
    // last ≥ 9 px inside the range's end, and a request steps on ≥ 9 px left of the booth.
    const front = c.QUEUE_W - 12;
    const back = front - (c.QUEUE - 1) * c.QUEUE_STEP;
    expect(c.QUEUE_W - front).toBeGreaterThanOrEqual(10);
    expect(back).toBeGreaterThanOrEqual(9);
    expect(c.DOOR_GAP).toBeGreaterThanOrEqual(9);
  });

  it('a request is the first in its lane’s line: it steps through the booth and the line moves up (sheets swap in place)', () => {
    const spawn = method(src, '  private spawn() {');
    expect(spawn).toMatch(/const sheet = queue\[0\] \? sheetOf\(queue\[0\]\) : this\.nextInLine\(\);/);
    expect(spawn).toMatch(/queue\.forEach\(\(q, k\) => act\(q\.setTexture\(/);
    expect(spawn).toMatch(/person\(this, sheet, 0, 0, s, 'walk', 'SW'\)/);
    expect(spawn).toMatch(/c\.setX\(Math\.max\(end, Math\.min\(door, x1 - 6 - t\.width \+ 10 \* s\)\)\)/);
    // Nothing in the line knows the request's flaw: it's dealt before the request is read.
    expect(spawn.slice(0, spawn.indexOf('const tw ='))).not.toMatch(/flaw/);
  });
});
