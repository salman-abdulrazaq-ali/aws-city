// Queue Juggler and Permission Gate are scenes, not forms (batch B3a): the city's own sprites on an integer-scaled play
// group in the play column, the desk's colour tokens only, and the same rules, keys and spoken lines as before. Checked
// from the source: a Phaser scene is not practical to run in a test (as in tests/a11y-games.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { QUEUE } from '@/world/minigames';

// The scenes' pure layout helpers are imported for real (batch B8); everything Phaser-bound under them is stubbed.
vi.mock('phaser', () => ({ default: {} }));
vi.mock('@/game/scenes/games/MiniGame', () => ({ MiniGame: class {}, FEEDBACK: {}, PAL: {}, pace: (n: number) => n, TXT: () => ({}) }));
vi.mock('@/game/scenes/games/cast', () => ({ act: () => {}, cast: () => [], districtColor: () => 0, fitScale: () => 1, landmarkFrame: () => undefined, person: () => {}, prop: () => {} }));
vi.mock('@/game/assets', () => ({ CITY_ATLAS: 'city', hasSprite: () => false, spriteAnchor: () => undefined }));
vi.mock('@/game/SpeechBubble', () => ({ crisp: <T>(t: T) => t }));
vi.mock('@/game/motion', () => ({ reducedMotion: () => false }));

const { gateRows, liftReach, turnedBox, LIFT } = await import('@/game/scenes/games/IamGateGame');
const { QueueGame, stackChips } = await import('@/game/scenes/games/QueueGame');

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
/** Code without its comments: comments may name old colours. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** The body of a scene's method, from its signature to the next method at the same indent. */
const method = (src: string, sig: string) => {
  const at = src.indexOf(sig);
  expect(at, sig).toBeGreaterThan(-1);
  const rest = src.slice(at + sig.length);
  const end = rest.search(/\n {2}(private|protected|override|public) /);
  return end < 0 ? rest : rest.slice(0, end);
};
const queue = read('src/game/scenes/games/QueueGame.ts');
const gate = read('src/game/scenes/games/IamGateGame.ts');

describe('no colour of their own: theme tokens, PAL and the district colour', () => {
  for (const [name, src] of [
    ['QueueGame.ts', queue],
    ['IamGateGame.ts', gate],
  ] as const) {
    it(`${name} names no hex colour (pixel borders are PAL.black)`, () => {
      const c = code(src);
      expect(c, name).not.toMatch(/'#[0-9a-f]{3,8}'/i);
      expect(c, name).not.toMatch(/0x[0-9a-f]{6}/i);
      expect(c).toMatch(/from '\.\.\/\.\.\/theme'/);
      expect(c).toMatch(/districtColor\('(sqs|iam)'\)/);
    });
  }
});

describe('a scene with the city’s people and props, at a whole-number scale in the play column', () => {
  it('Queue Juggler: Eddie at the bench, the SQS agent by the tray, parcels and a dead-letter chute', () => {
    const c = code(queue);
    expect(c).toMatch(/import \{[^}]*\bact\b[^}]*\bfitScale\b[^}]*\bperson\b[^}]*\bprop\b[^}]*\} from '\.\/cast'/);
    expect(c).toMatch(/person\(this, 'ec2'/);
    expect(c).toMatch(/person\(this, 'sqs'/);
    expect(c).toMatch(/'pack:data_box_SE'/);
    expect(c).toMatch(/'combo:mail-chute'/);
    // Eddie hammers while busy and idles when free; his chip says which in words, not colour alone.
    expect(method(c, '  private showWorker(free: boolean) {')).toMatch(/act\(this\.worker, free \? 'idle' : 'hammer'/);
    expect(c).toMatch(/'worker · free'/);
    expect(c).toMatch(/'worker · busy'/);
    // Poison is marked ☠, never only by its red chip.
    expect(method(c, '  private parcel(')).toMatch(/poison \? `☠ \$\{text\}` : text/);
    expect(c).toMatch(/this\.s = Math\.min\(fitScale\(/);
    expect(method(c, '  protected setup() {')).toMatch(/this\.column\(/);
  });

  it('Permission Gate: the IAM landmark, a paper notice board, IAM checking at the boom, citizens with tickets', () => {
    const c = code(gate);
    expect(c).toMatch(/import \{[^}]*\bcast\b[^}]*\bfitScale\b[^}]*\blandmarkFrame\b[^}]*\bperson\b[^}]*\bprop\b[^}]*\} from '\.\/cast'/);
    expect(c).toMatch(/landmarkFrame\('iam'\)/);
    expect(c).toMatch(/person\(this, 'iam', [^)]*'check', 'SW'\)/);
    expect(c).toMatch(/this\.crowd = cast\(/);
    expect(c).toMatch(/PAL\.paper\b/);
    expect(c).toMatch(/'Policy', TXT\(14, PAL\.paperMeta\)/);
    // The ticket is paper, the boom lifts for an Allow (set, not tweened, under reduced motion).
    expect(method(c, '  private next() {')).toMatch(/backgroundColor: CSS\.paper/);
    const send = method(c, '  private send(through: boolean) {');
    expect(send).toMatch(/if \(reducedMotion\(\)\) \{[\s\S]*setRotation/);
    // The biggest whole-number scale whose layout (the boom's whole lift included) fits the view, else 1.
    expect(c).toMatch(/let k = fitScale\(cw, 380\);\s*while \(k > 1 && contentAt\(k\) > h - this\.top\) k--;\s*this\.s = k;/);
    expect(method(c, '  protected setup() {')).toMatch(/this\.column\(/);
  });
});

describe('the rules, keys and spoken lines are unchanged', () => {
  it('Queue Juggler: Space queues, D dead-letters, the chute is a tap target, drags end on it; same timing and tray', () => {
    const c = code(queue);
    expect(c).toMatch(/const WORK_MS = 800;/);
    expect(c).toMatch(/if \(k === ' '\) this\.decide\(f, false\);\s*else if \(k === 'd' \|\| k === 'D'\) this\.decide\(f, true\);/);
    expect(c).toMatch(/\.zone\([^)]*\)\s*\.setInteractive\(\{ useHandCursor: true \}\)/);
    // A parcel takes a press on its box or on its label wherever the label stands (batch B8: labels lift clear).
    expect(c).toMatch(/setInteractive\(\{ hitArea: new Phaser\.Geom\.Rectangle\(0, 0, c\.width, c\.height\), hitAreaCallback: [^;]*this\.pressed\(p, x, y\), useHandCursor: true, draggable: true \}\)/);
    expect(c).toMatch(/c\.on\('dragstart', \(\) => \(tw\.pause\(\)/);
    expect(c).toMatch(/this\.decide\(entry, this\.dlqZone\.contains\(ptr\.x, ptr\.y\)\)/);
    expect(method(c, '  private enqueue(')).toMatch(/this\.queued\.length > 12/);
    expect(method(c, '  private spawn(poison: boolean) {')).toMatch(/this\.speak\(`\$\{poison \? 'Poison message' : 'Message'\}: \$\{label\}\.`, true\)/);
    const decide = method(c, '  private decide(e: Live, toDlq: boolean) {');
    expect(decide.match(/this\.speak\(/g)?.length).toBe(4);
    for (const line of ["'Right: poison to the dead-letter queue.'", "'Wrong: a good message thrown away.'", "'Wrong: poison fails over and over. Send poison to the dead-letter queue with D.'", '`Queued. ${this.queued.length} in the queue.`'])
      expect(decide).toContain(`this.speak(${line})`);
    const arrive = method(c, '  private arrive(');
    expect(arrive.match(/this\.speak\(/g)?.length).toBe(2);
    expect(arrive).toContain('this.speak(`Poison reached the worker and fails forever. Score ${this.score}.`)');
    expect(arrive).toContain("this.speak(`Lost: the worker was busy and it wasn't queued. Score ${this.score}.`)");
    for (const k of ['dlq', 'wrong', 'poisoned', 'lost', 'direct', 'worked', 'overflow']) expect(c).toContain(`POINTS.queue.${k}`);
  });

  it('Permission Gate: A or ← allows, D or → denies, the clock with pace, the verdict under the boom, the same lines', () => {
    const c = code(gate);
    expect(c).toMatch(/if \(k === 'a' \|\| k === 'A' \|\| k === 'ArrowLeft'\) this\.answer\(true\);/);
    expect(c).toMatch(/if \(k === 'd' \|\| k === 'D' \|\| k === 'ArrowRight'\) this\.answer\(false\);/);
    expect(c).toMatch(/'✅ Allow \(A\)', \(\) => this\.answer\(true\)/);
    expect(c).toMatch(/'⛔ Deny \(D\)', \(\) => this\.answer\(false\)/);
    expect(method(c, '  private next() {')).toMatch(/this\.time\.delayedCall\(pace\(Math\.max\(2600, 5200 - this\.wave \* 400\)\), \(\) => this\.answer\(undefined\)\)/);
    expect(method(c, '  private next() {')).toContain('this.speak(`Request: ${this.current.text}. A allows, D denies.`, true)');
    expect(method(c, '  private nextWave() {')).toContain("this.speak(`New role: ${wv.role}. Its policy: ${wv.policy.join('. ')}.`, true)");
    const answer = method(c, '  private answer(allow: boolean | undefined) {');
    expect(answer).toMatch(/this\.verdict\(x, y, `✓ \$\{c\.why\}`, FEEDBACK\.right/);
    expect(answer).toMatch(/this\.verdict\(x, y, `✗ \$\{allow === undefined \? 'Too slow\. ' : ''\}\$\{c\.why\}`, FEEDBACK\.wrong/);
    expect(answer).toMatch(/const y = this\.verdictY;/);
    for (const k of ['right', 'wrong', 'slow']) expect(answer).toContain(`POINTS.iamgate.${k}`);
    // The board is as tall as the longest policy, so the gate never moves between roles; the verdict sits below the boom.
    const setup = method(c, '  protected setup() {');
    expect(setup).toMatch(/IAM_GATE\.waves\.map\(\(wv\) => this\.policyLines\(wv\.policy\)\)/);
    expect(setup).toMatch(/this\.verdictY = boomY \+/);
    expect(setup).toMatch(/this\.cardAt = yardTop \+/);
  });
});

describe('the art generator’s props (batch B6: art/tiles/games_art.py)', () => {
  type Anchor = { ax: number; ay: number; w: number; h: number };
  const atlas = (JSON.parse(read('public/assets/city/sprites.json')) as { sprites: Record<string, Anchor> }).sprites;

  it('the atlas has the shed’s and the checkpoint’s props at their 1× sizes and anchors', () => {
    expect(atlas['game:queue:belt']).toMatchObject({ w: 32, h: 24, ax: 0, ay: 0 });
    expect(atlas['game:queue:tray']).toMatchObject({ w: 32, h: 16, ax: 0, ay: 0 });
    expect(atlas['game:queue:bench']).toMatchObject({ w: 64, h: 28, ax: 32, ay: 28 });
    expect(atlas['game:queue:dlq']).toMatchObject({ w: 40, h: 56, ax: 20, ay: 56 });
    expect(atlas['game:iamgate:post']).toMatchObject({ w: 8, h: 40, ax: 4, ay: 40 });
    // The arm's anchor is its pivot, on the left post.
    expect(atlas['game:iamgate:arm']).toMatchObject({ w: 160, h: 8, ax: 4, ay: 4 });
    expect(atlas['game:iamgate:board']).toMatchObject({ w: 48, h: 48, ax: 0, ay: 0 });
    expect(atlas['game:iamgate:booth']).toMatchObject({ w: 36, h: 60, ax: 18, ay: 60 });
  });

  it('a tiled or 9-slice piece is never trimmed in the atlas (Phaser’s NineSlice can’t take a trimmed frame)', () => {
    const pages = (JSON.parse(read('public/assets/city/atlas.json')) as { textures: { frames: { filename: string; trimmed: boolean }[] }[] }).textures;
    const frames = pages.flatMap((t) => t.frames);
    for (const n of ['game:iamgate:board', 'game:edge:counter', 'game:queue:belt', 'game:queue:tray', 'game:shield:wall']) expect(frames.find((f) => f.filename === n)?.trimmed, n).toBe(false);
  });

  it('Queue Juggler: the belt’s near side and the tray’s rack tile at the play scale; the bench and the bin stand on the floor', () => {
    const c = code(queue);
    const setup = method(c, '  protected setup() {');
    expect(setup).toMatch(/const props = hasSprite\(BELT\.name\) && hasSprite\(BENCH\) && hasSprite\(TRAY\.name\)/);
    expect(setup).toMatch(/if \(props\) this\.tile\(BELT\.name/);
    expect(setup).toMatch(/if \(props\) this\.tile\(TRAY\.name/);
    expect(setup).toMatch(/if \(props\) prop\(this, BENCH, ex, floor, s\)/);
    expect(setup).toMatch(/const BIN = hasSprite\(DLQ_BIN\) \? DLQ_BIN : CHUTE/);
    // The last piece of a run is cut where the run ends, in the frame's own pixels.
    expect(method(c, '  private tile(')).toMatch(/setCrop\(0, 0, Math\.ceil\(\(x1 - x\) \/ this\.s\)/);
  });

  it('Permission Gate: the posts and the striped arm (the boom lifts as before), the board’s 9-slice only on WebGL, the booth behind IAM', () => {
    const c = code(gate);
    const setup = method(c, '  protected setup() {');
    expect(setup).toMatch(/const framed = hasSprite\(BOARD\.frame\) && this\.game\.renderer\.type === Phaser\.WEBGL/);
    expect(setup).toMatch(/\.nineslice\([^;]*BOARD\.frame[^;]*\.setScale\(s\)/);
    expect(setup).toMatch(/bar = \[prop\(this, GATE\.arm, 0, 0, s\)\]/);
    expect(setup).toMatch(/this\.boom = this\.add\.container\(col\.cx - half - postW \/ 2, boomY, bar\)/);
    expect(setup).toMatch(/prop\(this, GATE\.booth, [^;]*\.setDepth\(28\)/);
    expect(setup).toMatch(/person\(this, 'iam', guardX, [^)]*'check', 'SW'\)\.setDepth\(29\)/);
  });
});

describe('Permission Gate: the lifted boom never covers the policy (batch B8)', () => {
  type Anchor = { ax: number; ay: number; w: number; h: number };
  const arm = (JSON.parse(read('public/assets/city/sprites.json')) as { sprites: Record<string, Anchor> }).sprites['game:iamgate:arm'];
  /** The generator's arm about its pivot at scale s, and drawn bars as long as a column's room (4 + 4s thick). */
  const bars = (s: number) => [
    { x0: -arm.ax * s, x1: (arm.w - arm.ax) * s, y0: -arm.ay * s, y1: (arm.h - arm.ay) * s },
    ...[30, 76, 120, 200].map((half) => ({ x0: 0, x1: half * 2, y0: -(2 + 2 * s), y1: 2 + 2 * s })),
  ];
  /** The board frame's bottom edge; its black shadow hangs 4 px lower. */
  const frame = 300;

  it('at every angle from down to lifted, at 1×, 2× and 3×, under any ticket, the whole arm stays below the board and its shadow', () => {
    for (const s of [1, 2, 3])
      for (const ticketH of [24, 38, 62, 90, 140])
        for (const bar of bars(s)) {
          const { boomY } = gateRows(frame, ticketH, s, liftReach(bar));
          for (let i = 0; i <= 360; i++) {
            const box = turnedBox(bar, (LIFT * i) / 360);
            // Vertical clearance alone proves no crossing, whatever the board's width.
            expect(boomY + box.top, `s ${s}, ticket ${ticketH}, bar to ${bar.x1}, step ${i}`).toBeGreaterThan(frame + 4);
          }
        }
  });

  it('the arm still lifts all the way (81°): its far end clears the requester’s head, so they walk under it', () => {
    expect(LIFT).toBeCloseTo(-Math.PI * 0.45);
    for (const s of [1, 2, 3]) {
      const [sprite] = bars(s);
      // The requester (54 px at 1×) stands 6 px over the pivot, centred 76 px along the arm at 1×.
      expect(turnedBox(sprite, LIFT).top).toBeLessThan(-(54 + 6) * s);
      expect(Math.tan(-LIFT) * 76 * s).toBeGreaterThan((54 + 6) * s);
    }
  });

  it('the back wall grows only as much as the lift needs: 9 px when the yard already clears it, else 3 px a scale step to spare', () => {
    expect(gateRows(frame, 400, 1, 100).yardTop).toBe(frame + 9);
    for (const s of [1, 2, 3]) {
      const reach = liftReach(bars(s)[0]);
      const rows = gateRows(frame, 40, s, reach);
      expect(rows.boomY - reach - (frame + 4)).toBe(3 * s);
      // The yard's rows keep their order: the ticket, the requester, the pivot, the ground in front.
      expect(rows.boomY - rows.yardTop).toBe(40 + 6 + 60 * s);
      expect(rows.end - rows.boomY).toBe(22 * s);
    }
  });

  it('setup lays the board, the yard and the boom out with them; Allow lifts the boom to LIFT, tweened or set', () => {
    const c = code(gate);
    const setup = method(c, '  protected setup() {');
    expect(setup).toMatch(/const rows = gateRows\(boardTop \+ boardH \+ rim, ticketH, s, boom\.reach\);/);
    expect(setup).toMatch(/reach: liftReach\(bar\)/);
    expect(setup).toMatch(/gateRows\(0, ticketH, k, boomAt\(k\)\.reach\)\.end/);
    const send = method(c, '  private send(through: boolean) {');
    expect(send).toMatch(/this\.boom\?\.setRotation\(through \? LIFT : 0\)/);
    expect(send).toMatch(/rotation: LIFT, duration: 160, yoyo: true, hold: pace\(380\)/);
    // One lift angle, LIFT's own.
    expect(c.match(/Math\.PI \* 0\.45/g)?.length).toBe(1);
  });
});

describe('Queue Juggler: the belt’s label chips never pile up (batch B8)', () => {
  const labels = [...QUEUE.messages, ...QUEUE.poison.map((p) => `☠ ${p}`)];
  /** A chip at a text size: ~7 px a character at 1× (13 px × 0.85, bold) and 5 px padding a side; 19 px tall at 1×. */
  const chipOf = (t: string, text = 1) => ({ w: Math.ceil(t.length * 7 * text + 10), h: Math.ceil(15 * text + 4) });
  type Spot = { x: number; bottom: number; shown: boolean };
  type Rect = { x: number; y: number; w: number; h: number };
  const rect = (s: Spot, c: { w: number; h: number }): Rect => ({ x: s.x - c.w / 2, y: s.bottom - c.h, w: c.w, h: c.h });
  const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  /**
   * `n` parcels bunched `gap` px apart at the belt's end (the side panel: a 400 px stage, the belt ending at 336), front
   * first, alternating rows like spawn() (the back row's labels home at 300, the front row's `2 × rowOff` lower), the
   * widest labels first.
   */
  const bunch = (n: number, gap: number, text = 1) => {
    const order = [...labels].sort((a, b) => b.length - a.length);
    const h = chipOf('x', text).h;
    const rowOff = Math.ceil(h / 2) + 2;
    return Array.from({ length: n }, (_, i) => {
      const c = chipOf(order[i % order.length], text);
      return { ...c, x: 336 - Math.max(c.w, 37) / 2 - i * gap, bottom: 300 + (i % 2) * 2 * rowOff };
    });
  };
  const check = (chips: ReturnType<typeof bunch>, spots: Spot[], fixed: Rect[], ceiling: number) => {
    const shown = spots.map((s, i) => (s.shown ? rect(s, chips[i]) : undefined));
    shown.forEach((a, i) => {
      if (!a) return;
      expect(a.x, `chip ${i} left`).toBeGreaterThanOrEqual(4);
      expect(a.x + a.w, `chip ${i} right`).toBeLessThanOrEqual(396);
      expect(a.y, `chip ${i} top`).toBeGreaterThanOrEqual(ceiling);
      // Never lower than its home, and still over its box unless slid in from the stage's edge.
      expect(spots[i].bottom).toBeLessThanOrEqual(chips[i].bottom);
      if (a.x > 4 && a.x + a.w < 396) expect(Math.abs(spots[i].x - chips[i].x)).toBeLessThanOrEqual(0.5);
      for (const f of fixed) expect(overlap(a, f), `chip ${i} on Eddie's chip`).toBe(false);
      shown.forEach((b, j) => {
        if (b && j > i) expect(overlap(a, b), `chips ${i} and ${j}`).toBe(false);
      });
    });
  };

  it('a burst bunched at the belt’s end in the side panel: every chip shown, none overlapping, all inside the stage', () => {
    // The fastest belt spaces a burst ~33 px apart in the panel (346 px in 2.7 s, 260 ms apart); 24 is tighter.
    for (const n of [3, 6, 10, 12]) {
      const chips = bunch(n, 24);
      const spots = stackChips(chips, [], { x0: 4, x1: 396, ceiling: 160, step: chips[0].h + 2, base: 300 });
      expect(spots.every((s) => s.shown), `${n} parcels`).toBe(true);
      check(chips, spots, [], 160);
      // The front message (the one Space and D act on) keeps its label home over its box.
      expect(spots[0]).toMatchObject({ bottom: chips[0].bottom, shown: true });
      expect(Math.abs(spots[0].x - chips[0].x)).toBeLessThanOrEqual(0.5);
    }
  });

  it('Eddie’s chip at the bench is never covered; a chip short of room is hidden, never piled on another', () => {
    const eddie = { x: 296, y: 281, w: 92, h: 19 };
    for (const text of [1, 1.25, 1.5])
      for (const ceiling of [160, 230, 270]) {
        const chips = bunch(12, 24, text);
        check(chips, stackChips(chips, [eddie], { x0: 4, x1: 396, ceiling, step: chips[0].h + 2, base: 300 }), [eddie], ceiling);
      }
  });

  it('a chip entering from the left shows only once its box is on the belt, slid inside the stage (never cut off)', () => {
    const c = chipOf('☠ corrupt image');
    const [on, half, off] = stackChips(
      [200, 10, -30].map((x, i) => ({ ...c, x, bottom: 300 - i * 40 })),
      [],
      { x0: 4, x1: 396, ceiling: 100, step: c.h + 2, base: 300 },
    );
    expect(on).toMatchObject({ shown: true, x: 200, bottom: 300 });
    expect(half).toMatchObject({ shown: true, x: 4 + c.w / 2 });
    expect(off.shown).toBe(false);
  });

  it('random bunches at every text size: what shows never overlaps and stays inside the stage', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 300; run++) {
      const text = [1, 1.25, 1.5][run % 3];
      const n = 1 + Math.floor(rnd() * 14);
      const chips = bunch(n, Math.floor(rnd() * 60), text)
        .map((c) => ({ ...c, x: c.x - Math.floor(rnd() * 40) }))
        .sort((a, b) => b.x - a.x);
      const ceiling = 120 + Math.floor(rnd() * 150);
      check(chips, stackChips(chips, [], { x0: 4, x1: 396, ceiling, step: chips[0].h + 2, base: 300 }), [], ceiling);
    }
  });

  it('a press lands on the box, or on the label wherever it stands, never on a lifted label’s empty home', () => {
    type Fake = { c: { width: number; height: number }; chip: { visible: boolean; x: number; y: number; width: number; height: number }; home: number };
    const pressed = (QueueGame.prototype as unknown as { pressed: (p: Fake, x: number, y: number) => boolean }).pressed;
    // A parcel 120 × 60 at 1×: a 120 px label (19 tall) over a 37 px box; its home bottom 11 px above the middle.
    const p: Fake = { c: { width: 120, height: 60 }, chip: { visible: true, x: 0, y: -11, width: 120, height: 19 }, home: -11 };
    // Phaser's hit test measures from the Container's top-left; these are from its middle.
    const at = (x: number, y: number) => pressed.call({ s: 1 }, p, x + 60, y + 30);
    expect(at(0, 20)).toBe(true);
    expect(at(50, -20)).toBe(true);
    expect(at(30, 20)).toBe(false);
    p.chip.y = -60;
    expect(at(50, -70)).toBe(true);
    expect(at(50, -20)).toBe(false);
    p.chip.visible = false;
    expect(at(50, -70)).toBe(false);
    expect(at(0, 20)).toBe(true);
  });

  it('the scene places them every frame, front first, clear of Eddie’s chip, under the stage top; a dragged parcel keeps its own', () => {
    const c = code(queue);
    expect(method(c, '  override update(t: number, dt: number) {')).toMatch(/super\.update\(t, dt\);\s*this\.placeChips\(\);/);
    const place = method(c, '  private placeChips() {');
    expect(place).toMatch(/this\.live\.filter\(\(e\) => !e\.tw\.isPaused\(\)\)\.sort\(\(a, b\) => b\.c\.x - a\.c\.x\)/);
    expect(place).toMatch(/const wc = this\.workerChip;/);
    expect(place).toMatch(/stackChips\(/);
    expect(place).toMatch(/ceiling: this\.top \+ 3 \* this\.s \+ 2/);
    expect(place).toMatch(/base: this\.beltY - this\.rowOff - \(BOX_H - 6\) \* this\.s/);
    expect(place).toMatch(/chip\.setVisible\(spots\[i\]\.shown\)\.setPosition\(spots\[i\]\.x - c\.x, spots\[i\]\.bottom - c\.y\)/);
    // The strings are one Graphics under every parcel (depth 19; parcels ride at 20 and 21), so none crosses a label.
    expect(method(c, '  protected setup() {')).toMatch(/this\.strings = this\.add\.graphics\(\)\.setDepth\(19\);/);
    expect(method(c, '  private spawn(poison: boolean) {')).toMatch(/\.setDepth\(20 \+ row\)/);
    expect(place).toMatch(/this\.strings\?\.clear\(\)/);
    // Queued parcels put their labels away.
    expect(method(c, '  private layoutQueue() {')).toMatch(/chip\.setVisible\(false\);/);
    // The belt's timing is the tween's own: placing labels never moves a parcel.
    expect(place).not.toMatch(/\bc\.set(X|Y|Position)\(|\.c\.x =|\.c\.y =/);
    expect(method(c, '  private spawn(poison: boolean) {')).toMatch(/x: this\.beltEnd - c\.width \/ 2,\s*duration: pace\(4200 - Math\.min\(1500, this\.waves \* 60\)\)/);
  });
});
