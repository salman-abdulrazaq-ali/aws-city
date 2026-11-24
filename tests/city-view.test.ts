// Impeccable game pass, batch B4: the city's labels give way in one pass and are capped per view, flights take a time
// that fits their distance, a tier-up plays in order, and the player's buildings stay legible at night.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CROWN_DROP_MS, FLIGHT, flightPlan, nightLift, NIGHT_LIFT, PUSH_AFTER_MS, PUSH_TOTAL_MS, riseMs, tierUpTimeline } from '@/game/cityView';
import { keepTags, signCap, signRank, TAG_ORDER, type MapTag } from '@/game/labels';

// labels.ts's pass is plain geometry; Phaser (its other helpers) needs a canvas this test has no use for.
vi.mock('phaser', () => ({ default: {} }));

const read = (f: string) => readFileSync(path.join(__dirname, '..', f), 'utf8');
const box = (x: number, y = 0, width = 40, height = 10) => ({ x, y, width, height });
const slice = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from) + 1));

describe('one overlap pass over every tag', () => {
  it('keeps Kai, then the hint, signs, working agents and citizens, whatever order they arrive in', () => {
    expect(TAG_ORDER).toEqual(['kai', 'hint', 'sign', 'working', 'citizen']);
    const tags: MapTag<string>[] = [
      { kind: 'citizen', box: box(0), item: 'citizen' },
      { kind: 'working', box: box(5), item: 'working' },
      { kind: 'sign', box: box(10), item: 'sign' },
      { kind: 'hint', box: box(15), item: 'hint' },
      { kind: 'kai', box: box(20), item: 'kai' },
    ];
    expect([...keepTags(tags)]).toEqual(['kai']);
    // Apart, every one stays.
    expect(keepTags(tags.map((t, i) => ({ ...t, box: box(i * 100) }))).size).toBe(5);
    // A citizen's tag gives way to a working agent's, and that to a sign.
    expect([...keepTags(tags.slice(0, 3))]).toEqual(['sign']);
    expect([...keepTags(tags.slice(0, 2))]).toEqual(['working']);
  });

  it('within signs: the picked one first, then one in view, ready to upgrade, nearest Kai', () => {
    const near = { kind: 'sign' as const, rank: signRank({ inView: true, ready: false, toKai: 10 }), box: box(0), item: 'near' };
    const ready = { kind: 'sign' as const, rank: signRank({ inView: true, ready: true, toKai: 300 }), box: box(20), item: 'ready' };
    const off = { kind: 'sign' as const, rank: signRank({ inView: false, ready: true, toKai: 1 }), box: box(25), item: 'off' };
    expect([...keepTags([near, off, ready])]).toEqual(['ready']);
    expect([...keepTags([near, off])]).toEqual(['near']);
    expect([...keepTags([near, ready, { ...off, must: true }])]).toEqual(['off']);
  });

  it('caps building signs per view (the picked ones aside), and a tag not wanted takes no room', () => {
    const signs = Array.from({ length: 8 }, (_, i) => ({ kind: 'sign' as const, capped: true, rank: [i], box: box(i * 100), item: `s${i}` }));
    expect([...keepTags(signs, 3)]).toEqual(['s0', 's1', 's2']);
    expect([...keepTags([...signs, { kind: 'sign', capped: true, must: true, box: box(2000), item: 'picked' }], 3)]).toContain('picked');
    // Plot and district signs aren't building signs: they don't count.
    expect(keepTags([...signs, { kind: 'sign', box: box(3000), item: 'plot' }], 3).has('plot')).toBe(true);
    // A sign that gave way to an overlap doesn't use up the cap.
    const covered = { kind: 'sign' as const, capped: true, rank: [0], box: box(5), item: 'covered' };
    expect(keepTags([{ kind: 'kai', box: box(0), item: 'kai' }, covered, ...signs.slice(1)], 2)).toEqual(new Set(['kai', 's1', 's2']));
    expect(keepTags([{ kind: 'kai', box: undefined, item: 'kai' }, covered], 2).has('covered')).toBe(true);
  });

  it('holds 10 signs at zoom 2 and 6 from zoom 3 on the tab, fewer on a smaller map, never under 3; all at zoom 1', () => {
    expect(signCap(1, 982, 814)).toBe(Infinity);
    expect(signCap(2, 982, 814)).toBe(10);
    expect(signCap(3, 982, 814)).toBe(6);
    expect(signCap(4, 1920, 1080)).toBe(6);
    expect(signCap(2, 382, 282)).toBe(3);
    expect(signCap(2, 700, 600)).toBeLessThan(10);
  });

  it('CityScene runs the pass over every tag it shows, and the hovered walker always shows its tag', () => {
    const scene = read('src/game/scenes/CityScene.ts');
    const place = slice(scene, '  private placeSigns(', '  /** The plot a landmark stands in');
    expect(place).toMatch(/keepInView\(view, inset\)[\s\S]*keepTags\(tags, signCap\(this\.labelZoom\(\)/);
    for (const kind of TAG_ORDER) expect(place).toContain(`'${kind}'`);
    expect(place).toMatch(/this\.workers\?\.list[\s\S]*this\.citizens\?\.list[\s\S]*this\.visitors\?\.list/);
    expect(scene).toMatch(/this\.time\.now - this\.tagsAt >= TAG_PASS_MS/);
    expect(read('src/game/Agent.ts')).toContain('this.tag.setVisible(this.hovered || (this.tagWanted() && !this.tagMuted));');
  });
});

describe('signs and their icons', () => {
  const lm = read('src/game/Landmark.ts');

  it('say "· Lv N" only for the picked or hovered building', () => {
    expect(lm).toMatch(/const lv = this\.detailed && this\.spec\.showStars/);
    expect(lm).not.toMatch(/const stars = spec\.showStars/);
    expect(slice(read('src/game/scenes/CityScene.ts'), '  private syncLabels() {', '  private labelZoom()')).toContain('lm.setDetailed(must(id));');
  });

  it('scale the service icon with the sign (one on-screen size at every zoom), and count it in the sign’s room', () => {
    expect(lm).toMatch(/this\.icon\?\.setScale\(s\)\.setPosition/);
    expect(lm).toMatch(/const iconH = this\.icon \? \(this\.icon\.height \+ 1\) \* s : 0;/);
    expect(lm).toMatch(/labelBounds\(\) \{[\s\S]*Rectangle\.Union/);
  });
});

describe('camera flights', () => {
  it('take a time that fits the distance, decelerate on arrival, and cut under reduced motion', () => {
    expect(FLIGHT.ease).toMatch(/\.easeOut$/);
    expect(flightPlan(400, 0, 1, 982, 814, true)).toEqual({ kind: 'cut', ms: 0 });
    expect(flightPlan(0, 0, 2, 982, 814, false)).toEqual({ kind: 'cut', ms: 0 });
    const short = flightPlan(20, 10, 1, 982, 814, false);
    const long = flightPlan(700, 300, 1, 982, 814, false);
    expect(short).toEqual({ kind: 'pan', ms: FLIGHT.minMs });
    expect(long.kind).toBe('pan');
    expect(long.ms).toBeGreaterThan(short.ms);
    expect(long.ms).toBeLessThanOrEqual(FLIGHT.maxMs);
    // The same world distance is twice as far on screen at zoom 2.
    expect(flightPlan(300, 0, 2, 982, 814, false).ms).toBeGreaterThan(flightPlan(300, 0, 1, 982, 814, false).ms);
  });

  it('cut through a short sea-blue fade beyond 1.5 views', () => {
    expect(flightPlan(1500, 0, 1, 982, 814, false)).toEqual({ kind: 'fade', ms: FLIGHT.fadeOutMs + FLIGHT.fadeInMs });
    expect(flightPlan(0, 900, 2, 982, 814, false).kind).toBe('fade');
  });

  it('every camera move in the city goes through glide (no fixed 700 ms ease-in-out pans left)', () => {
    const scene = read('src/game/scenes/CityScene.ts');
    expect(scene).not.toMatch(/cam\.pan\([^)]*700, 'Sine\.easeInOut'\)/);
    expect(scene).toMatch(/cam\.pan\(x, y, f\.ms, FLIGHT\.ease, true\)/);
    expect(slice(scene, '  private glide(', '  private flyTo(')).toMatch(/cam\.fadeOut\(FLIGHT\.fadeOutMs, \.\.\.SEA_RGB\)/);
  });
});

describe('a tier-up, in order', () => {
  it('the camera lands, the tower rises, one payoff, then the push-in', () => {
    const t = tierUpTimeline(600, riseMs(160), false);
    expect(t.rise).toBe(600);
    expect(t.payoff).toBe(600 + riseMs(160));
    expect(t.push).toBe(t.payoff + PUSH_AFTER_MS);
    expect(t.pushEnd).toBe(t.push! + PUSH_TOTAL_MS);
    // Without a flight the rise starts at once.
    expect(tierUpTimeline(0, CROWN_DROP_MS, false)).toMatchObject({ rise: 0, payoff: CROWN_DROP_MS });
  });

  it('under reduced motion: no flight, rise or push-in; the banner and the cheer at once', () => {
    expect(tierUpTimeline(0, riseMs(160), true)).toEqual({ rise: 0, payoff: 0, pushEnd: 0 });
  });

  it('a rise lasts as long as Landmark.rise takes (8 px floors, 30 ms each over 300 ms, at most 1.4 s)', () => {
    expect(riseMs(8)).toBe(0);
    expect(riseMs(64)).toBe(300 + 8 * 30);
    expect(riseMs(4000)).toBe(1400);
  });

  it('CityScene plays it from the timeline: one burst, no fixed-time push-in, labels at the resting zoom meanwhile', () => {
    const scene = read('src/game/scenes/CityScene.ts');
    const tier = slice(scene, '  private celebrateTier(', '  /** Back in the city');
    expect(tier).toMatch(/tierUpTimeline\(flight,/);
    expect(tier.match(/this\.burst\(serviceId\)/g)).toHaveLength(1);
    expect(tier.match(/this\.cheer\(/g)).toHaveLength(1);
    expect(tier).toMatch(/lm\?\.rise\(undefined, t\.rise\)/);
    expect(scene).not.toMatch(/delayedCall\(1_100, \(\) => this\.sys\.isActive\(\) && pushIn/);
    expect(scene).toMatch(/this\.pushRest !== undefined && this\.time\.now < this\.pushUntil \? this\.pushRest : this\.cameras\.main\.zoom/);
    expect(slice(scene, '  private syncLabels() {', '  private labelZoom()')).toMatch(/const zoom = this\.labelZoom\(\);/);
  });

  it('a client level-up flies there first and grows the site on arrival', () => {
    const scene = read('src/game/scenes/CityScene.ts');
    const h = slice(scene, "bus.on('clientLevelUp'", "bus.on('workshopDone'");
    expect(h).toMatch(/this\.flyTo\(`client:\$\{clientId\}`\)[\s\S]*delayedCall\(ms,[\s\S]*this\.clients\?\.grow\(clientId\)/);
  });
});

describe('overlays over the map, and the night', () => {
  it('the courier tip waits while a toast or the coins note shows', () => {
    const scene = read('src/game/scenes/CityScene.ts');
    const hint = slice(scene, '  private courierHint(', '  /** A toast or the HUD');
    expect(hint).toMatch(/if \(this\.overlayUp\(\)\) return;\s*writePref\(COURIER_HINT_KEY/);
    expect(scene).toMatch(/s\.toasts\.some\(\(t\) => !t\.leaving\) \|\| \(readPref\(TIP_COINS_KEY\) !== '1' && coins\(s\.progress\) > 0\)/);
  });

  it('lifts the player’s buildings out of the dark at zoom 1, less at zoom 2, none from zoom 3 or by day', () => {
    expect(nightLift(0, 1)).toBe(0);
    expect(nightLift(1, 1)).toBe(NIGHT_LIFT);
    expect(nightLift(1, 2)).toBeCloseTo(NIGHT_LIFT / 2);
    expect(nightLift(1, 3)).toBe(0);
    expect(nightLift(1, 4)).toBe(0);
    expect(nightLift(0.5, 1)).toBeLessThan(nightLift(1, 1));
    const lm = read('src/game/Landmark.ts');
    // Just above the building's own depth (whatever stands in front still covers it), additive, off for a lot not built.
    expect(lm).toMatch(/\.setDepth\(this\.img\.depth \+ 0\.25\)\s*\.setBlendMode\(Phaser\.BlendModes\.ADD\)/);
    expect(lm).toMatch(/this\.spec\.tier < 1 \|\| !!this\.closed/);
  });
});
