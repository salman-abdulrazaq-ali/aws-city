import Phaser from 'phaser';
import { FEEDBACK, MiniGame, pace, PAL, TXT } from './MiniGame';
import { POINTS, SWING, swingReady } from './scoring';
import { cast, districtColor, fitScale, landmarkFrame, person, prop } from './cast';
import { CITY_ATLAS, hasSprite } from '../../assets';
import { reducedMotion } from '../../motion';
import { crisp } from '../../SpeechBubble';
import { COLOR, CSS, LABEL_BG } from '../../theme';
import { useCity } from '@/state/store';
import { SHIELD, tierFor, type Attack, type WafRule } from '@/world/minigames';

type Kind = 'good' | 'flood' | 'l7';
/** A new wave every this many seconds: traffic comes faster and moves quicker. */
const WAVE_S = 15;
/** The key under the road: what each colour is and what Space does, said once (the title says what to do). */
const LEGEND = '🔵 flood: Shield absorbs it · 🔴 L7 attack: click it · 🟢 user: let them in · Space: strike the nearest';
/**
 * The play group at 1×, px: your app (its landmark, 100 wide) and the wall, then the road; the sky over the road
 * (room for the top walkers' heads and tags), the road (it may grow to `roadMax` on a tall stage) and the verge.
 */
const NATURAL = { w: 380, sky: 80, road: 150, roadMax: 240, verge: 10 };
/** A crowd citizen's head, px above the feet at 1× (36×54 frame, feet at 50). */
const HEAD = 50;
/**
 * The wall's pieces (art/tiles/games_art.py) at 1×, px: the battlements on top, a 16 px course of masonry stacked as
 * high as the road needs, the gateway at its foot. A flood is a 40×28 swarm of packets in three jitter frames.
 */
const WALL = { w: 32, top: 14, course: 16, gate: 56 };
const FLOOD = { frames: ['game:shield:flood0', 'game:shield:flood1', 'game:shield:flood2'], h: 28, anim: 'game:shield:flood' };

/**
 * Shield Wall: Shield Standard absorbs volumetric floods (L3/L4) automatically, so you don't click those.
 * Application-layer (L7) attacks need AWS WAF rules: click them before they reach the wall. Never block real users.
 * Each block names the rule that would catch it; the lesson at the end counts what you stopped. Space strikes whatever
 * is nearest the wall (a real user too), once per cooldown, and a swing at an empty road costs: mashing doesn't win.
 * The stage: your app is Shield's landmark behind a security-red wall, Shield's agent on guard by the gate, users and
 * L7 attackers are citizens walking up the road with their request on a tag, and a flood is a swarm of packets. The
 * wall and the swarm are the art generator's (art/tiles/games_art.py), at the play group's whole-number scale.
 */
export class ShieldGame extends MiniGame {
  private attacks: Attack[] = [];
  private stopped: Partial<Record<WafRule, number>> = {};
  private wave = 0;
  private started = 0;
  /** This round's walkers (crowd-size citizen sheets, src/game/scenes/games/cast.ts) and how many have come. */
  private crowd: string[] = [];
  private dealt = 0;
  /**
   * The road: its top and bottom, where arrivals stop (at the wall), the gate's foot, and the play group's
   * whole-number scale (people 2× in the tab, 1× in the 400 px panel).
   */
  private road = { y0: 0, y1: 0, end: 0, gateX: 0, gateY: 0, s: 1 };

  constructor() {
    super('game:shield', 'shield', 'shield', '🛡️ Shield Wall — click red L7 attacks before they reach the wall; let users in');
    this.keysHelp = 'Space strikes whatever is nearest the wall, a real user too: press it only when a red one leads.';
  }

  protected setup() {
    this.onRoad = [];
    this.lastSwing = -Infinity;
    this.crowd = cast(16);
    this.dealt = 0;
    this.onKeys((k) => (k === ' ' || k.startsWith('Arrow')) && this.strikeNearest());
    const { width: w, height: h } = this.scale;
    // A composed scene in a centred column (MiniGame.column): sky, your app and its wall at the left, the road to the
    // right edge, the verge, and the legend right under it. The play group is drawn at a whole-number scale that fits
    // the room (cast.ts fitScale), and the road's height is capped, so a tall tab doesn't stretch it.
    const legend = crisp(this.add.text(w / 2, 0, LEGEND, { ...TXT(14, CSS.ink), backgroundColor: LABEL_BG, padding: { x: 6, y: 2 }, align: 'center', wordWrap: { width: Math.min(w, 760) - 24 } }))
      .setOrigin(0.5, 0)
      .setDepth(5);
    const room = this.column();
    const below = 12 + legend.height;
    const s = Math.min(fitScale(room.w, NATURAL.w, 2), fitScale(room.h - below, NATURAL.sky + NATURAL.road + NATURAL.verge, 2));
    const roadH = Math.round(Phaser.Math.Clamp(room.h - below - (NATURAL.sky + NATURAL.verge) * s, NATURAL.road * s, NATURAL.roadMax * s));
    const col = this.column((NATURAL.sky + NATURAL.verge) * s + roadH + below);
    const y0 = col.y + NATURAL.sky * s;
    const y1 = y0 + roadH;
    legend.setY(y1 + NATURAL.verge * s + 12);
    // your app (x col.x to wallX), the wall, then the road; arrivals stop just past the shield, at the wall
    const wallX = col.x + 100 * s;
    const wallW = WALL.w * s;
    const wallTop = y0 - 22 * s;
    const base = y1 + 6 * s;
    const gateW = 14 * s;
    const gateH = Math.round(Math.min(40 * s, roadH * 0.4));
    const gateX = wallX + (wallW - gateW) / 2;
    const end = wallX + wallW + 14 * s;
    this.road = { y0, y1, end, gateX: gateX + gateW / 2, gateY: base, s };
    const g = this.add.graphics();
    // night sky in graphite bands, a few stars
    const sky = [COLOR.bgDeep, COLOR.bg, COLOR.panel];
    sky.forEach((c, i) => g.fillStyle(c, 1).fillRect(0, (i * y0) / sky.length, w, y0 / sky.length + 1));
    for (let i = 0; i < 18; i++) g.fillStyle(COLOR.inkHi, 0.25 + (i % 3) * 0.2).fillRect((i * 97) % w, this.top + ((i * 53) % Math.max(1, y0 - this.top - 6)), 2, 2);
    // your app's ground, the internet road the traffic travels along, its kerb and centre line, the verge
    g.fillStyle(COLOR.panel, 1).fillRect(0, y0, wallX, roadH);
    g.fillStyle(COLOR.panelHi, 1).fillRect(wallX, y0, w - wallX, roadH);
    g.fillStyle(COLOR.bgDeep, 1).fillRect(wallX, y0, w - wallX, 2 * s);
    for (let x = end + 30 * s; x < w; x += 40 * s) g.fillStyle(COLOR.muted, 0.45).fillRect(x, Math.round((y0 + y1) / 2), 20 * s, 2 * s);
    g.fillStyle(COLOR.good, 0.5).fillRect(0, y1, w, 4 * s);
    g.fillStyle(COLOR.bgDeep, 1).fillRect(0, y1 + 4 * s, w, h - y1 - 4 * s);
    // your app: Shield's own landmark at its level in this city (the security HQ when the atlas has none)
    const lmX = col.x + 50 * s;
    const lm = prop(this, landmarkFrame('shield') ?? 'hq:security', lmX, y1 + 2 * s, s).setOrigin(0.5, 1).setDepth(10);
    const tag = crisp(this.add.text(lmX, 0, 'your app', { ...TXT(14, CSS.inkHi), backgroundColor: LABEL_BG, padding: { x: 5, y: 1 } })).setOrigin(0.5, 1).setDepth(15);
    tag.setY(Math.max(this.top + tag.height + 2, y1 + 2 * s - lm.displayHeight - 4));
    // the wall in the security district's red (art/tiles/games_art.py): battlements, courses of masonry stacked down to
    // the gateway with its portcullis half up. Drawn in the same red when the atlas hasn't got the pieces.
    if (hasSprite('game:shield:gate')) {
      const top = wallTop - 8 * s;
      for (let y = top + WALL.top * s; y < base - WALL.gate * s; y += WALL.course * s) prop(this, 'game:shield:wall', wallX, y, s).setDepth(12);
      prop(this, 'game:shield:wall-top', wallX, top, s).setDepth(12);
      prop(this, 'game:shield:gate', wallX + wallW / 2, base, s).setDepth(12);
    } else {
      const wall = this.add.graphics().setDepth(12);
      wall.fillStyle(districtColor('shield'), 1).fillRect(wallX, wallTop, wallW, base - wallTop);
      for (let x = wallX; x < wallX + wallW; x += 9 * s) wall.fillRect(x, wallTop - 6 * s, 5 * s, 6 * s);
      for (let y = wallTop + 6 * s, row = 0; y < base - s; y += 8 * s, row++)
        for (let x = wallX + (row % 2) * 5 * s; x < wallX + wallW; x += 10 * s) wall.fillStyle(COLOR.bgDeep, 0.35).fillRect(x, y, Math.min(7 * s, wallX + wallW - x), s);
      wall.fillStyle(COLOR.bgDeep, 1).fillRect(gateX, base - gateH, gateW, gateH);
      wall.lineStyle(s, PAL.black, 1).strokeRect(gateX, base - gateH, gateW, gateH);
      wall.fillStyle(PAL.black, 1).fillRect(wallX, wallTop - 6 * s, s, base - wallTop + 6 * s);
    }
    // the shield (Shield Standard): always on, absorbs floods
    this.add.ellipse(wallX + wallW + 6 * s, (wallTop + y1) / 2, 40 * s, y1 - wallTop + 24 * s, COLOR.info, 0.14).setStrokeStyle(2 * s, COLOR.info, 0.7).setDepth(13);
    // Shield's agent on guard by the gate, facing the road
    person(this, 'shield', wallX + wallW + 18 * s, base, s, 'guard', 'SE').setDepth(this.depthAt(base));
    const plays = useCity.getState().progress.games?.shield?.plays ?? 0;
    this.attacks = SHIELD.attacks.filter((a) => a.tier <= tierFor(plays));
    this.stopped = {};
    this.wave = 0;
    this.started = this.time.now;
    this.scheduleSpawn();
  }

  /** The next arrival: sooner each wave (900 ms apart at first, 500 ms by the third wave). */
  private scheduleSpawn() {
    if (this.over) return;
    const wave = Math.floor((this.time.now - this.started) / 1000 / WAVE_S);
    if (wave > this.wave) {
      this.wave = wave;
      // High in the sky, clear of the walkers' tags.
      this.floater(this.scale.width / 2, Math.max(this.top + 16, this.road.y0 - NATURAL.sky * this.road.s + 16), `Wave ${wave + 1}: they're getting faster`, FEEDBACK.gold);
      this.speak(`Wave ${wave + 1}: they're getting faster.`);
    }
    this.time.delayedCall(pace(Math.max(500, 900 - this.wave * 200)), () => {
      if (this.over) return;
      this.spawn();
      this.scheduleSpawn();
    });
  }

  /** Everything on the road now (Space strikes the one nearest the wall, whatever it is): a walker or a swarm with its tag. */
  private onRoad: Phaser.GameObjects.Container[] = [];
  /** When Space last swung (one swing per SWING.cooldownMs). */
  private lastSwing = -Infinity;

  /**
   * Space or an arrow key: strike whatever is closest to the wall, as a click on it would: a real user or a flood
   * too, so the key is for reading the road, not holding down. A swing at an empty road costs (src/game/scenes/games/scoring.ts).
   */
  private strikeNearest() {
    const now = this.time.now;
    if (!swingReady(this.lastSwing, now)) return;
    this.lastSwing = now;
    const t = this.onRoad.reduce<Phaser.GameObjects.Container | undefined>((a, b) => (!a || b.x < a.x ? b : a), undefined);
    if (t) return void t.emit('pointerdown');
    this.wrong();
    this.addScore(SWING.blank);
    this.floater(this.road.end + 40 * this.road.s, (this.road.y0 + this.road.y1) / 2, `nothing to stop ${SWING.blank}`, FEEDBACK.wrong);
    this.speak('Nothing on the road to stop.');
  }

  private spawn() {
    const FLOODS = ['SYN SYN SYN', 'UDP UDP UDP', 'ACK ACK ACK', 'DNS reflect'];
    const { width: w } = this.scale;
    const { end, y0, y1, s } = this.road;
    const r = Math.random();
    const kind: Kind = r < 0.4 ? 'good' : r < 0.6 ? 'flood' : 'l7';
    // Feet on the road, low enough that the top walkers' tags stay in the sky band.
    const y = Math.round(y0 + (y1 - y0) * (0.18 + Math.random() * 0.7));
    const attack = kind === 'l7' ? this.attacks[Math.floor(Math.random() * this.attacks.length)] : undefined;
    // Floods are network and transport layer (layer 3/4) attacks, which Shield Standard absorbs; layer 7 is WAF's job.
    const label = kind === 'good' ? SHIELD.good[Math.floor(Math.random() * SHIELD.good.length)] : attack ? attack.label : FLOODS[Math.floor(Math.random() * FLOODS.length)];
    // The tag keeps the colours' meaning: green real users, red L7 attacks, blue floods (ink on a graphite chip, a stripe under it).
    const ink = kind === 'good' ? CSS.goodInk : kind === 'l7' ? CSS.badInk : CSS.infoInk;
    const tint = kind === 'good' ? COLOR.good : kind === 'l7' ? COLOR.bad : COLOR.info;
    // People walk up the road (left, SW); a flood is no one: a swarm of packets travelling as one.
    const body: Phaser.GameObjects.GameObject[] = kind === 'flood' ? this.packets(s) : [person(this, this.crowd[this.dealt++ % this.crowd.length], 0, 0, s, 'walk', 'SW')];
    const headY = (kind === 'flood' ? -FLOOD.h : -HEAD) * s - 4;
    const chip = crisp(this.add.text(0, headY - 3, label, { ...TXT(16, ink), backgroundColor: CSS.bg, padding: { x: 5, y: 2 } })).setOrigin(0.5, 1);
    const stripe = this.add.rectangle(0, headY - 3, chip.width, 3, tint).setOrigin(0.5, 0);
    const t = this.add.container(w + 10 + chip.width / 2, y, [...body, stripe, chip]).setDepth(this.depthAt(y));
    const chipY = y + headY - chip.height / 2;
    // The walker (or the swarm) and their tag are one target: a press on either is a press on the arrival.
    const targets = [body[0], chip];
    for (const o of targets) o.setInteractive({ useHandCursor: true }).on('pointerdown', () => t.emit('pointerdown'));
    this.onRoad.push(t);
    t.once('destroy', () => (this.onRoad = this.onRoad.filter((x) => x !== t)));
    /** Off the road: neither Space nor a click can strike it now. */
    const leave = () => {
      this.onRoad = this.onRoad.filter((x) => x !== t);
      targets.forEach((o) => o.disableInteractive());
    };
    // Each arrival is said as it comes on the road (the road is only drawn): the player reads it and decides.
    this.speak(`On the road: ${label}.`, true);
    const quicken = 1 - Math.min(0.35, this.wave * 0.15);
    const speed = (kind === 'flood' ? 5200 : 6500 + Math.random() * 1500) * quicken;
    const tw = this.tweens.add({
      targets: t,
      x: end,
      duration: pace(speed),
      onComplete: () => {
        if (this.over) return t.destroy();
        leave();
        if (kind === 'flood') {
          this.floater(end + 30 * s, chipY, 'absorbed by Shield', FEEDBACK.note);
          this.tweens.add({ targets: t, x: end + (w - end) * 0.4, alpha: 0, duration: 400, onComplete: () => t.destroy() });
          return;
        }
        if (kind === 'good') {
          this.hit();
          this.addScore(POINTS.shield.passed, 'none');
        } else {
          this.wrong();
          this.addScore(POINTS.shield.breach, 'soft');
          this.floater(end + 30 * s, chipY, 'breach!', FEEDBACK.wrong);
          this.speak(`Breach! ${label} got in. Score ${this.score}.`);
          if (!reducedMotion()) this.cameras.main.shake(120, 0.004);
        }
        this.walkIn(t);
      },
    });
    t.on('pointerdown', () => {
      if (this.over || !this.onRoad.includes(t)) return;
      tw.stop();
      leave();
      if (kind === 'l7' && attack) {
        this.hit();
        this.addScore(POINTS.shield.block);
        this.stopped[attack.rule] = (this.stopped[attack.rule] ?? 0) + 1;
        this.floater(t.x, chipY, `${SHIELD.rules[attack.rule].name} ✓`, FEEDBACK.gold);
        this.speak(`Stopped by ${SHIELD.rules[attack.rule].name}.`);
      } else if (kind === 'good') {
        this.wrong();
        this.addScore(POINTS.shield.blockedUser);
        this.floater(t.x, chipY, 'blocked a real user!', FEEDBACK.wrong);
        this.speak(`Blocked a real user: ${label}.`);
      } else {
        // A flood is Shield's: clicking it wastes the defender's time (the lesson is "let Shield absorb it").
        this.wrong();
        this.addScore(POINTS.shield.flood);
        this.floater(t.x, chipY, 'Shield had this one: let floods through', FEEDBACK.note);
        this.speak('Shield had this one: let floods through.');
      }
      this.knock(t);
    });
  }

  /**
   * A flood's look: a swarm of packets in the shield's blue streaking in through a haze (art/tiles/games_art.py, three
   * jitter frames; still under reduced motion). The whole swarm is what a press lands on. Drawn as dots without the atlas.
   */
  private packets(s: number): Phaser.GameObjects.GameObject[] {
    if (hasSprite(FLOOD.frames[0])) {
      if (!this.anims.exists(FLOOD.anim)) this.anims.create({ key: FLOOD.anim, frames: FLOOD.frames.map((frame) => ({ key: CITY_ATLAS, frame })), frameRate: 8, repeat: -1 });
      const swarm = this.add.sprite(0, 0, CITY_ATLAS, FLOOD.frames[0]).setOrigin(0.5, 1).setScale(s);
      if (!reducedMotion()) swarm.play(FLOOD.anim);
      return [swarm];
    }
    const haze = this.add.ellipse(0, -12 * s, 40 * s, 24 * s, COLOR.info, 0.16);
    const dots = [
      [-12, -6],
      [-4, -14],
      [4, -8],
      [12, -16],
      [-8, -20],
      [8, -2],
      [0, -22],
      [14, -6],
    ].map(([dx, dy]) => this.add.rectangle(dx * s, dy * s, 4 * s, 4 * s, COLOR.info).setStrokeStyle(1, PAL.black));
    return [haze, ...dots];
  }

  /** Lower on the road is nearer: drawn in front (always under the floaters, verdicts and chrome). */
  private depthAt(y: number) {
    const { y0, y1 } = this.road;
    return 20 + Phaser.Math.Clamp((y - y0) / Math.max(1, y1 - y0), 0, 1.2) * 20;
  }

  /** In through the gate: a user let in (or an attack that got through). Gone at once under reduced motion. */
  private walkIn(t: Phaser.GameObjects.Container) {
    if (reducedMotion()) return void t.destroy();
    const { gateX, gateY } = this.road;
    this.tweens.add({ targets: t, x: gateX, y: gateY, alpha: 0, duration: 450, onComplete: () => t.destroy() });
  }

  /** Struck: stopped where it stood and knocked back off the road. Gone at once under reduced motion. */
  private knock(t: Phaser.GameObjects.Container) {
    if (reducedMotion()) return void t.destroy();
    const { s } = this.road;
    this.tweens.add({ targets: t, x: t.x + 50 * s, y: t.y - 14 * s, angle: 24, alpha: 0, duration: 320, ease: 'Quad.easeOut', onComplete: () => t.destroy() });
  }

  protected lesson() {
    // One line a kid can read. Shield Standard, WAF and Shield Advanced are in the Shield flashcards.
    const caught = Object.values(this.stopped).reduce((a, n) => a + (n ?? 0), 0);
    const tally = caught ? `You stopped ${caught} sneaky attack${caught === 1 ? '' : 's'}! ` : '';
    return `${tally}Shield blocks big floods for free; WAF rules catch the sneaky ones.`;
  }
}
