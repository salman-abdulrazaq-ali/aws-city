import Phaser from 'phaser';
import { useCity } from '@/state/store';
import { FRAME_H, FRAME_W, PIVOT } from '../assets';
import { sfx } from '../audio';
import { crisp } from '../SpeechBubble';
import { FISH, type Fish, type StorageClass } from '@/world/minigames';
import { KAI_SHEET } from '@/world/culture';
import { syncClock } from './games/clock';
import { mixCatch } from './games/fishDeck';
import { growthLine, growthOf } from '@/state/growth';
import { dealRound, expert, expertOpen, pace, relaxed, setExpert } from '../pace';
import { onSceneEnd } from './lifecycle';
import { countRound, fishingStars, FULL_ROUNDS_A_DAY, HALF_ROUNDS_A_DAY } from '@/learning/gameStars';
import { weeklyChallenge, WEEKLY_BONUS } from '@/state/events';
import { reducedMotion } from '../motion';
import { COLOR, CSS, GAME_PAL as PAL, GAME_PILL } from '../theme';
import { keysBelongToUi } from '../keys';
import { fishingKey } from './games/gameKeys';
import { fitParent } from './games/column';
import { TXT } from './games/MiniGame';
import { answerPop, playScale } from './games/stageFx';
import { endKeysLine, fishLine, growthSaid } from './games/say';
import { announce } from '@/state/announce';
import { firstSteps } from '@/state/firstSteps';
import { fishingEnd, pathEndKey, verdictLine } from '../firstStepsGame';

/** Clicks are ignored this long after the line is reset, so the click that answered doesn't cast at once. */
const CALM_MS = 300;
/**
 * The quiz card's buttons wait this long, and then answer only on a press that starts and ends on the same button: an
 * excited click (or a held button) from the hook can't answer unread.
 */
const QUIZ_CALM_MS = 800;
/** The bite window: longer for the round's first bite, while the player learns the rhythm (both through pace()). */
const FIRST_BITE_MS = 1800;
const BITE_MS = 1100;

/**
 * S3 Lake mini-game: every fish is an object. Hook one, then drop it in the right storage-class
 * bucket based on how often it's accessed. Teaches Standard vs Standard-IA vs the S3 Glacier archive classes.
 */

type ClassId = StorageClass;
const CLASSES: { id: ClassId; label: string; color: number; note: string }[] = [
  { id: 'standard', label: 'S3 Standard', color: 0x3f9b4f, note: 'hot · read often' },
  { id: 'ia', label: 'Standard-IA', color: 0x3a6fd8, note: 'warm · monthly' },
  // The S3 Glacier storage classes as one archive bucket (Flexible Retrieval, Deep Archive); the cards explain each.
  { id: 'glacier', label: 'S3 Glacier', color: 0x7dd3fc, note: 'cold · archive' },
];

const ROUND = 5;
/** The pier, the buckets, Kai and the fish at 1× (the side panel); a big tab draws them at 2× (stageFx.playScale). */
const BASE_W = 480;
const BASE_H = 400;
type State = 'ready' | 'casting' | 'waiting' | 'bite' | 'reeling' | 'quiz' | 'summary';

export class FishingScene extends Phaser.Scene {
  private state: State = 'ready';
  private deck: Fish[] = [];
  private caught = 0;
  private correct = 0;
  private waterY = 0;
  /** The play group's whole-number scale, the pier's length and each bucket's middle and size (build). */
  private k = 1;
  private pierW = 0;
  private buckets: { x: number; y: number; w: number; h: number }[] = [];
  private bobber!: Phaser.GameObjects.Arc;
  private line!: Phaser.GameObjects.Graphics;
  private rodTip = new Phaser.Math.Vector2();
  private player!: Phaser.GameObjects.Sprite;
  private hud!: Phaser.GameObjects.Text;
  private info!: Phaser.GameObjects.Text;
  private swimmers: Phaser.GameObjects.Container[] = [];
  private card?: Phaser.GameObjects.Container;
  private biteTimer?: Phaser.Time.TimerEvent;
  private hooked?: Phaser.GameObjects.Container;
  private bites = 0;
  private calmUntil = 0;
  /** The quiz's answers, so a number key can give one (the buttons call the same thing). */
  private choose: ((i: number) => void) | undefined;
  private again: (() => void) | undefined;
  private expertRound: (() => void) | undefined;
  private leave: (() => void) | undefined;
  /** This round is played on the first steps: its end card leads back to the city (src/game/firstStepsGame.ts fishingEnd). */
  private onPath = false;

  constructor() {
    super('fishing');
  }

  create() {
    syncClock(this);
    // Lay out at the parent's size now: the side panel's stage has just grown for the game (games/column.ts fitParent).
    fitParent(this.scale);
    this.state = 'ready';
    this.caught = 0;
    this.correct = 0;
    this.bites = 0;
    this.calmUntil = 0;
    this.swimmers = [];
    this.choose = this.again = this.expertRound = this.leave = undefined;
    this.summaryCard = undefined;
    this.lastVerdict = '';
    this.onPath = firstSteps(useCity.getState().progress, useCity.getState().prefs).active;
    // A mix of storage classes each round (at most two of a kind), so the answer isn't "Standard" four times.
    this.deck = mixCatch(dealRound(FISH, useCity.getState().progress.games?.fishing?.plays ?? 0, ROUND), FISH);
    this.build();
    // Screen readers: the canvas is named for the game while it runs, and the goal and keys are said first.
    const canvas = this.game.canvas as HTMLCanvasElement | undefined;
    const cityLabel = canvas?.getAttribute('aria-label');
    canvas?.setAttribute('aria-label', 'S3 Lake fishing: mini-game');
    onSceneEnd(this, () => cityLabel && canvas?.setAttribute('aria-label', cityLabel));
    announce(
      `S3 Lake fishing. Each fish is an S3 object: drop it in the right storage class. Press Space to cast, and Space again when a fish bites. Then press 1 to ${CLASSES.length} for a bucket: ${CLASSES.map((c, i) => `${i + 1} ${c.label}`).join(', ')}. ${ROUND} fish a round.`,
    );
    this.scale.on('resize', this.relayout, this);
    onSceneEnd(this, () => this.scale.off('resize', this.relayout, this));
    this.input.on('pointerdown', (p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => !over.length && this.onClick(p));
    this.input.keyboard?.on('keydown', this.onKey, this);
    onSceneEnd(this, () => this.input.keyboard?.off('keydown', this.onKey, this));
  }

  /** Keyboard play (src/game/scenes/games/gameKeys.ts): the same actions as the pointer, unless a UI control has focus. */
  private onKey(e: KeyboardEvent) {
    if (e.repeat || keysBelongToUi(document.activeElement, this.game.canvas)) return;
    // On the first steps the end card's primary is "Back to the city": Enter or Escape goes back, Space plays again.
    if (this.state === 'summary' && this.onPath) {
      const end = pathEndKey(e.key);
      return void (end === 'leave' ? this.leave?.() : end === 'again' ? this.again?.() : undefined);
    }
    const a = fishingKey(this.state, e.key, CLASSES.length);
    if (!a) return;
    if (a.kind === 'bucket') return this.choose?.(a.index);
    if (a.kind === 'again') return this.again?.();
    if (a.kind === 'expert') return this.expertRound?.();
    if (a.kind === 'leave') return this.leave?.();
    if (this.time.now < this.calmUntil) return;
    // Past the pier's end, so the bobber never lands under the planks on a narrow view.
    if (a.kind === 'cast') return this.cast(Math.min(this.scale.width - 30, Math.max(this.pierW + 40 * this.k, this.scale.width * 0.6)), this.waterY + 60);
    this.hook();
  }

  /**
   * Re-lay out by restarting, but only before the first cast: mid-round the catch count would reset, and on the summary
   * the result would be lost, so there the result card just moves to the new centre ("Play again" picks up the size).
   */
  private relayout() {
    if (this.state === 'summary') return this.fitSummary();
    if (this.state === 'ready' && this.caught === 0) this.scene.restart();
  }

  /** The round's result card (centred on its middle) and its natural size, so a resize can move and fit it. */
  private summaryCard?: { c: Phaser.GameObjects.Container; shade: Phaser.GameObjects.Rectangle; w: number; h: number };

  /** Centres the result card and shrinks it to fit a short or narrow view, like MiniGame's end card. */
  private fitSummary() {
    if (!this.summaryCard) return;
    const { width: w, height: h } = this.scale;
    const { c, shade, w: cw, h: ch } = this.summaryCard;
    shade.setSize(w, h);
    c.setPosition(Math.round(w / 2), Math.round(18 + (h - 18) / 2)).setScale(Math.min(1, (h - 52) / (ch + 6), (w - 8) / cw));
  }

  private build() {
    const { width: w, height: h } = this.scale;
    // The pier, its buckets, Kai and the fish are drawn at a whole-number scale k (stageFx.playScale): 1× in the side
    // panel, 2× in a big tab, so the play no longer sits in the left quarter of the lake at 1×.
    const k = (this.k = playScale(w, h, BASE_W, BASE_H));
    this.waterY = Math.round(h * 0.45);
    const g = this.add.graphics();
    // sky + far hills
    g.fillGradientStyle(0x7dd3fc, 0x7dd3fc, 0xe0f2fe, 0xe0f2fe, 1).fillRect(0, 0, w, this.waterY);
    g.fillStyle(0x4caf50, 1).fillEllipse(w * 0.75, this.waterY + 10, w * 0.9, 90 * k);
    g.fillStyle(0x3f9b4f, 1).fillEllipse(w * 0.2, this.waterY + 16, w * 0.7, 70 * k);
    // water
    g.fillGradientStyle(0x3b82f6, 0x3b82f6, 0x1e3a8a, 0x1e3a8a, 1).fillRect(0, this.waterY, w, h - this.waterY);
    for (let i = 0; i < 14; i++) g.fillStyle(0xffffff, 0.15).fillRect(Math.random() * w, this.waterY + 10 + Math.random() * (h - this.waterY - 20), 30 + Math.random() * 40, 2 * k);

    // pier
    // Wide enough for three buckets and Kai side by side on the narrow panel too (his sprite never covers a label); at
    // 2× it reaches about half way across the lake.
    const pierW = (this.pierW = k === 1 ? Math.min(340, Math.max(250, w * 0.42), w - 110) : Math.round(Math.min(w * 0.52, 300 * k)));
    g.fillStyle(0x8b5a2b, 1).fillRect(0, this.waterY - 18 * k, pierW, 18 * k);
    g.fillStyle(0x6b4423, 1);
    for (let x = 12 * k; x < pierW; x += 48 * k) g.fillRect(x, this.waterY, 10 * k, 60 * k);

    // buckets on the pier
    const [bw, bh] = [30 * k, 26 * k];
    const spacing = (pierW - 90 * k) / 3;
    this.buckets = [];
    CLASSES.forEach((c, i) => {
      const bx = 22 * k + i * spacing;
      const top = this.waterY - 18 * k - bh;
      g.fillStyle(c.color, 1).fillRect(bx, top, bw, bh);
      g.fillStyle(COLOR.bgDeep, 1).fillRect(bx - 2 * k, top - 2 * k, bw + 4 * k, 4 * k);
      this.buckets.push({ x: bx + bw / 2, y: top + bh / 2, w: bw, h: bh });
      // Labels on dark plates, staggered when neighbours are close enough to overlap (the narrow panel).
      const label = crisp(this.add.text(bx + bw / 2, top - 6, c.label.replace('S3 ', ''), { ...TXT(14, PAL.ink), backgroundColor: GAME_PILL, padding: { x: 5, y: 2 } })).setOrigin(0.5, 1);
      if (spacing < label.width + 8) label.setY(label.y - (i % 2) * (label.height + 2));
    });

    // Kai, the player, fishing (team sprite, one size up from the play group's scale for the close-up)
    const ks = k + 1;
    this.player = this.add.sprite(pierW - 40 * k, this.waterY - 18 * k, `char:${KAI_SHEET}`, 0).setOrigin(PIVOT.x / FRAME_W, PIVOT.y / FRAME_H).setScale(ks);
    this.player.play(`${KAI_SHEET}:idle:SE`);
    this.rodTip.set(this.player.x + 13 * ks, this.player.y - 31 * ks);

    this.line = this.add.graphics().setDepth(5);
    this.bobber = this.add.circle(0, 0, 5 + k, 0xef4444).setStrokeStyle(2, 0xffffff).setVisible(false).setDepth(6);

    for (let i = 0; i < 6; i++) this.spawnSwimmer(i);

    // The same title bar as the other mini-games (MiniGame.chrome): graphite plate, amber title, stat chip; its text
    // follows ⋯ → Text size through TXT.
    this.add.rectangle(0, 0, w, 34, PAL.bg, 0.94).setOrigin(0).setDepth(19);
    this.add.rectangle(0, 34, w, 2, PAL.black).setOrigin(0).setDepth(19);
    crisp(this.add.text(12, 17, '🎣 S3 Lake', TXT(17, PAL.accentCss))).setOrigin(0, 0.5).setDepth(20);
    this.hud = crisp(this.add.text(w - 12, 17, '', { ...TXT(16, PAL.ink), backgroundColor: PAL.chipCss, padding: { x: 8, y: 3 } })).setOrigin(1, 0.5).setDepth(20);
    this.info = this.add
      .text(w / 2, 46, '', { ...TXT(16, PAL.ink), fontStyle: '700', backgroundColor: GAME_PILL, padding: { x: 10, y: 6 }, align: 'center', wordWrap: { width: Math.min(520, w - 40) } })
      .setOrigin(0.5, 0)
      .setDepth(20);
    this.updateHud();
    this.setInfo('Click the water (or press Space) to cast. Each fish is an S3 object — choose the right storage class!');
  }

  private spawnSwimmer(i: number) {
    const { width: w, height: h } = this.scale;
    const k = this.k;
    const y = this.waterY + 70 * k + ((h - this.waterY - 100 * k) * (i + 0.5)) / 6;
    const c = this.add.container(Math.random() * w, y);
    const body = this.add.ellipse(0, 0, 34, 16, [0xfbbf24, 0xf472b6, 0xa3e635, 0xfb923c][i % 4]);
    const tail = this.add.triangle(-20, 0, 0, -8, 0, 8, 10, 0, 0xf59e0b);
    const eye = this.add.circle(10, -2, 2, 0x111827);
    c.add([tail, body, eye]).setDepth(3).setAlpha(0.9);
    const dir = Math.random() < 0.5 ? 1 : -1;
    c.setScale(dir * k, k);
    c.setData('dir', dir);
    c.setData('speed', (30 + Math.random() * 40) * k);
    c.setData('lane', i);
    c.setData('laneY', y);
    this.swimmers.push(c);
  }

  /** A new fish takes the first lane no fish swims in, so the lake stays spread out. */
  private freeLane() {
    const used = new Set(this.swimmers.map((f) => f.getData('lane') as number));
    return [0, 1, 2, 3, 4, 5].find((i) => !used.has(i)) ?? Math.floor(Math.random() * 6);
  }

  override update(_t: number, dt: number) {
    const w = this.scale.width;
    for (const f of this.swimmers) {
      if (f === this.hooked || f.getData('target')) continue;
      f.x += (f.getData('dir') * f.getData('speed') * dt) / 1000;
      if (f.x > w + 30) f.x = -30;
      if (f.x < -30) f.x = w + 30;
    }
    this.line.clear();
    if (this.bobber.visible) {
      this.line.lineStyle(1.5, COLOR.inkHi, 0.9).lineBetween(this.rodTip.x, this.rodTip.y, this.bobber.x, this.bobber.y);
    }
  }

  private onClick(p: Phaser.Input.Pointer) {
    if (this.time.now < this.calmUntil) return;
    if (this.state === 'ready' && p.y > this.waterY + 10) return this.cast(p.x, p.y);
    if (this.state === 'bite') return this.hook();
  }

  private cast(x: number, y: number) {
    this.state = 'casting';
    this.player.play(`${KAI_SHEET}:fish:SE`);
    sfx('whoosh', { own: true });
    this.bobber.setPosition(this.rodTip.x, this.rodTip.y).setVisible(true);
    this.tweens.add({
      targets: this.bobber,
      x,
      y: this.waterY + 12,
      duration: 500,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.state = 'waiting';
        // The last answer's verdict stays up until the next bite: a quick cast never hides it.
        this.setInfo(this.lastVerdict ? `${this.lastVerdict}\nWaiting for a bite…` : 'Waiting for a bite…');
        announce('Waiting for a bite.');
        this.tweens.add({ targets: this.bobber, y: '+=3', yoyo: true, repeat: -1, duration: 600 });
        this.time.delayedCall(900 + Math.random() * 1600, () => this.approach(x, y));
      },
    });
  }

  private approach(x: number, _y: number) {
    if (this.state !== 'waiting') return;
    const fish = this.swimmers.reduce((a, b) => (Math.abs(a.x - x) < Math.abs(b.x - x) ? a : b));
    fish.setData('target', true);
    this.tweens.add({
      targets: fish,
      x: this.bobber.x,
      y: this.bobber.y + 18 * this.k,
      duration: 700,
      onComplete: () => {
        this.state = 'bite';
        this.hooked = fish;
        this.tweens.killTweensOf(this.bobber);
        this.tweens.add({ targets: this.bobber, y: this.waterY + 22, yoyo: true, repeat: 3, duration: 110 });
        this.setInfo('❗ BITE! Click now (or Space)!');
        announce('Bite! Press Space now!', { replace: true });
        this.splash();
        if (this.bites === 0) this.firstBite();
        this.biteTimer = this.time.delayedCall(pace(this.bites++ === 0 ? FIRST_BITE_MS : BITE_MS, 3), () => this.miss());
      },
    });
  }

  /**
   * The round's first bite: a big "Click now!" across the water and a soft white flash (no flash under reduced motion),
   * so a new player sees that this is the moment. Gone with the bite.
   */
  private firstBite() {
    const { width: w } = this.scale;
    const t = crisp(this.add.text(w / 2, this.waterY - 70, '👆 Click now! (Space)', { ...TXT(40, CSS.gold), fontStyle: '900', stroke: CSS.bg, strokeThickness: 7 }))
      .setOrigin(0.5)
      .setDepth(30);
    const gone = () => t.active && t.destroy();
    this.time.delayedCall(pace(FIRST_BITE_MS, 3), gone);
    this.input.once('pointerdown', gone);
    if (reducedMotion()) return;
    this.cameras.main.flash(160, 255, 255, 255);
    this.tweens.add({ targets: t, scale: { from: 0.6, to: 1.1 }, yoyo: true, repeat: 2, duration: 200 });
  }

  /** A big "!" over the bobber and a ring on the water: the bite is the moment to click. */
  private splash() {
    const { x, y } = this.bobber;
    const bang = crisp(this.add.text(x, y - 34, '!', { ...TXT(47, CSS.gold), fontStyle: '900', stroke: CSS.bg, strokeThickness: 6 })).setOrigin(0.5).setDepth(25);
    const ring = this.add.ellipse(x, y + 2, 20 * this.k, 8 * this.k).setStrokeStyle(2, 0xffffff, 0.9).setDepth(4);
    const done = () => (bang.destroy(), ring.destroy());
    if (reducedMotion()) return void this.time.delayedCall(pace(BITE_MS, 3), done);
    this.tweens.add({ targets: bang, scale: { from: 0.4, to: 1.2 }, yoyo: true, duration: 180, repeat: 1 });
    this.tweens.add({ targets: ring, scaleX: 3, scaleY: 3, alpha: 0, duration: 700, onComplete: () => this.time.delayedCall(300, done) });
  }

  private miss() {
    if (this.state !== 'bite') return;
    const fish = this.hooked;
    this.hooked = undefined;
    // The one that got away swims back down to its own lane (not along the surface).
    if (fish) this.tweens.add({ targets: fish, y: fish.getData('laneY') as number, duration: 600, ease: 'Quad.easeOut', onComplete: () => fish.setData('target', false) });
    this.reset('It got away! Click the water or press Space to cast again.');
    announce('It got away. Press Space to cast again.', { replace: true });
  }

  private hook() {
    this.biteTimer?.remove();
    const fish = this.hooked!;
    const item = this.deck[this.caught];
    this.state = 'reeling';
    this.setInfo(`Reeling in ${item.name}…`);
    this.tweens.add({ targets: [fish, this.bobber], x: this.rodTip.x + 20 * this.k, y: this.waterY - 60 * this.k, duration: 700, ease: 'Back.easeIn', onComplete: () => this.quiz(item) });
  }

  private quiz(item: (typeof FISH)[number]) {
    this.state = 'quiz';
    this.calmUntil = this.time.now + QUIZ_CALM_MS;
    const { width: w } = this.scale;
    const cw = Math.min(420, w - 24);
    // The card stands in the sky, above the water where the player was clicking to cast and hook, so a click still
    // going there lands on the lake, not on a bucket. The info line steps aside while it's up.
    this.info.setVisible(false);
    // A paper card like the other games' (GAME_PAL), sized by its text, so a bigger Text size grows it instead of
    // spilling out of it.
    const card = this.add.container(w / 2, 0).setDepth(30);
    const t1 = crisp(this.add.text(0, 12, `📄 ${item.name}`, TXT(19, PAL.paperInk))).setOrigin(0.5, 0);
    const t2 = crisp(this.add.text(0, t1.y + t1.height + 6, `“${item.hint}”\nWhich bucket (storage class)? Click one, or press 1–${CLASSES.length}.`, { ...TXT(16, PAL.paperHint), fontStyle: '600', align: 'center', wordWrap: { width: cw - 24 } })).setOrigin(0.5, 0);
    const by = Math.round(t2.y + t2.height + 12);
    const bw = (cw - 40) / 3;
    const labels = CLASSES.map((c) =>
      crisp(this.add.text(0, by + 8, `${c.label}\n${c.note}`, { ...TXT(w < 420 ? 14 : 16, PAL.ink), fontStyle: '700', align: 'center', stroke: CSS.bgDeep, strokeThickness: 3, wordWrap: { width: bw - 6 } })).setOrigin(0.5, 0),
    );
    const bh = Math.max(56, ...labels.map((l) => Math.ceil(l.height) + 16));
    const ch = by + bh + 14;
    const bg = this.add.rectangle(0, 0, cw, ch, PAL.paper).setStrokeStyle(3, PAL.black).setOrigin(0.5, 0);
    card.add([bg, t1, t2]).setY(Math.max(40, this.waterY - ch - 10));
    announce(fishLine(item, CLASSES));
    // A number key answers like a press that was armed (after the same calm).
    this.choose = (i) => this.time.now >= this.calmUntil && this.state === 'quiz' && this.answer(item, CLASSES[i].id);
    CLASSES.forEach((c, i) => {
      const x = -cw / 2 + 12 + bw / 2 + i * (bw + 8);
      const b = this.add.rectangle(x, by, bw, bh, c.color).setStrokeStyle(2, PAL.black).setOrigin(0.5, 0).setInteractive({ useHandCursor: true });
      const l = labels[i].setX(x);
      // Armed by a press that starts on this button after the calm; answered when that press ends on it.
      let armed = false;
      b.on('pointerdown', () => (armed = this.time.now >= this.calmUntil))
        .on('pointerout', () => (armed = false))
        .on('pointerup', () => armed && this.state === 'quiz' && this.answer(item, c.id));
      card.add([b, l]);
    });
    this.card = card;
  }

  private answer(item: (typeof FISH)[number], choice: ClassId) {
    this.card?.destroy();
    this.card = undefined;
    this.choose = undefined;
    this.caught++;
    const right = choice === item.answer;
    if (right) {
      this.correct++;
      sfx('correct', { own: true });
      this.player.play(`${KAI_SHEET}:jump:SE`);
      this.time.delayedCall(700, () => this.player.play(`${KAI_SHEET}:idle:SE`));
    }
    // The catch drops into the bucket picked, framed green (with sparks) when right and red when not, so a number key
    // shows where the answer went as a click does (stageFx.answerPop). Under reduced motion it's just put away.
    const fish = this.hooked;
    const spot = this.buckets[CLASSES.findIndex((c) => c.id === choice)];
    if (fish && spot && !reducedMotion())
      this.tweens.add({ targets: fish, x: spot.x, y: spot.y, scaleX: fish.scaleX * 0.4, scaleY: fish.scaleY * 0.4, duration: 320, ease: 'Quad.easeIn', onComplete: () => fish.destroy() });
    else fish?.destroy();
    if (spot) answerPop(this, spot.x, spot.y, spot.w, spot.h, right, 26);
    this.swimmers = this.swimmers.filter((f) => f !== this.hooked);
    this.hooked = undefined;
    this.spawnSwimmer(this.freeLane());
    this.updateHud();
    if (!right) sfx('wrong', { own: true });
    const label = CLASSES.find((c) => c.id === item.answer)?.label;
    // The end card on the first steps keeps the last verdict and drops its tip (CloudFront, lifecycle rules).
    const tips = this.caught < ROUND || fishingEnd(this.onPath, false).tips;
    const verdict = verdictLine(right, label, item.why, tips);
    this.lastVerdict = verdict;
    // Screen readers: the verdict in words (no ✅ / ❌), the catch so far, and what to do next.
    const said = `${right ? 'Right!' : `Wrong: it’s ${label}.`}${tips ? ` ${item.why}` : ''} Catches ${this.caught} of ${ROUND}, ${this.correct} right.`;
    if (this.caught >= ROUND) return this.summary(verdict, said);
    this.reset(`${verdict}\nClick the water or press Space to cast again.`);
    announce(`${said} Press Space to cast again.`);
  }

  private summary(last: string, said: string) {
    this.state = 'summary';
    this.bobber.setVisible(false);
    const perfect = this.correct === ROUND;
    const s = useCity.getState();
    const best = s.progress.games?.fishing?.best ?? 0;
    // Paid once, like the other games: full for the first rounds of the day or a new best, half after
    // (src/learning/gameStars.ts). The next round deals harder catches (dealRound) and the best score is kept.
    // The weekly challenge's game pays half as many stars again (src/state/events.ts), as in MiniGame.finish.
    const weekly = weeklyChallenge().game === 'fishing';
    const roundsBefore = countRound('fishing');
    const stars = Math.round(fishingStars(this.correct, perfect, roundsBefore, this.correct > best) * (weekly ? WEEKLY_BONUS : 1));
    // The stars land before the round is recorded: the first steps' fishing step ends there, and its ✓ line says what
    // the round grew (src/state/store.ts pathGrowth).
    if (stars > 0) s.addXp('s3', stars);
    // A round that caught something pays City Coins too (store.recordGame, contract v2.14).
    const coins = s.recordGame('fishing', this.correct, { timed: !relaxed() });
    const halved = this.correct > 0 && this.correct <= best && roundsBefore >= FULL_ROUNDS_A_DAY;
    if (this.correct > 0) s.noteLearning('games');
    const record = this.correct > best && best > 0 ? ' New best!' : '';
    // On the first steps: no tips, no Expert round, no coins (they wait for graduation), and "Back to the city" leads.
    const end = fishingEnd(this.onPath, expertOpen('s3'));
    // The building the round grew, and how far (src/state/growth.ts), like the other games' end card.
    const g = growthOf(useCity.getState().progress, 's3', useCity.getState().cityRegion);
    // A paper card in the middle, like the other games' end card (MiniGame.finish): the last answer, the result, the
    // building it grew, a tip, and the buttons, all in one place on any size of view.
    this.info.setVisible(false);
    const { width: w, height: h } = this.scale;
    const cw = Math.min(440, Math.max(300, w - 24));
    const items: Phaser.GameObjects.GameObject[] = [];
    let y = 18;
    const text = (str: string, size: number, color: string, weight = '800') => {
      // `size` is TXT's design size (85 %, times ⋯ → Text size, 11 px at least), as on MiniGame's end card.
      const t = crisp(this.add.text(0, y, str, { ...TXT(size, color), fontStyle: weight, align: 'center', wordWrap: { width: cw - 40 }, lineSpacing: 2 })).setOrigin(0.5, 0);
      items.push(t);
      y += t.height + 8;
      return t;
    };
    text(record ? '🏆 New best!' : 'Round over', 19, PAL.paperMeta);
    text(`${this.correct}/${ROUND} objects in the right bucket${perfect ? ' — perfect!' : ''}${stars ? `   ·   +${stars} ⭐${coins && end.coins ? `  +${coins} City Coins` : ''}${weekly ? ' ⚡ weekly' : ''}` : ''}`, 16, PAL.paperInk);
    if (halved)
      text(
        stars
          ? `Half stars after ${FULL_ROUNDS_A_DAY} rounds a day, none after ${FULL_ROUNDS_A_DAY + HALF_ROUNDS_A_DAY}. Full stars again tomorrow, or beat your best!`
          : "That's all the stars this game pays today. Full stars again tomorrow, or beat your best!",
        14,
        PAL.paperMeta,
        '600',
      );
    text(last, 15, PAL.paperHint, '600');
    text(`🏗️ ${growthLine(g)}`, 15, PAL.paperHint);
    const barW = Math.min(260, cw - 60);
    items.push(this.add.rectangle(0, y, barW, 8, PAL.black, 0.15), this.add.rectangle(-barW / 2, y, Math.max(4, barW * g.pct), 8, COLOR.roleOk).setOrigin(0, 0.5));
    y += 16;
    if (end.tips) text('Tip: Lifecycle rules can move files to cheaper shelves for you.', 15, PAL.paperHint, '600');
    const buttons: Phaser.GameObjects.Text[] = [];
    const button = (label: string, color: string, bg: string, run: () => void) =>
      buttons.push(
        crisp(this.add.text(0, 0, label, { ...TXT(16, color), backgroundColor: bg, padding: { x: 14, y: 8 } }))
          .setOrigin(0.5)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', run),
      );
    const leave = () => (setExpert(false), useCity.getState().setView({ name: 'city' }));
    const again = () => (setExpert(false), this.scene.restart());
    this.leave = leave;
    this.again = again;
    const expertRound = () => (setExpert(true), this.scene.restart());
    // S3 Lake at level 3: an Expert round with the harder catches and a shorter bite (never on the first steps).
    this.expertRound = end.buttons.some((b) => b.action === 'expert') ? expertRound : undefined;
    // The desk's buttons: amber for the one primary (the next try; "Back to the city" on the first steps), pale gold for
    // Expert, graphite for the rest.
    const run = { again, expert: expertRound, leave };
    for (const b of end.buttons)
      if (b.primary) button(b.label, PAL.accentInk, PAL.accentCss, run[b.action]);
      else if (b.action === 'expert') button(b.label, PAL.paperInk, PAL.expertCss, run[b.action]);
      else button(b.label, PAL.ink, PAL.chipCss, run[b.action]);
    // Laid out by measured width, wrapping inside the card (bigger text in the 400 px panel would overlap at fixed steps).
    const gap = 10;
    const rows: Phaser.GameObjects.Text[][] = [[]];
    let rowW = 0;
    for (const b of buttons) {
      const row = rows[rows.length - 1];
      if (row.length && rowW + gap + b.width > cw - 24) {
        rows.push([b]);
        rowW = b.width;
      } else {
        row.push(b);
        rowW += (row.length > 1 ? gap : 0) + b.width;
      }
    }
    let by = y + 8;
    for (const row of rows) {
      const rh = Math.max(...row.map((b) => b.height));
      let x = -(row.reduce((n, b) => n + b.width, 0) + gap * (row.length - 1)) / 2;
      for (const b of row) {
        b.setPosition(Math.round(x + b.width / 2), Math.round(by + rh / 2));
        x += b.width + gap;
      }
      by += rh + 8;
    }
    const ch = by + 8;
    const shade = this.add.rectangle(0, 0, w, h, PAL.bg, 0.72).setOrigin(0).setDepth(28);
    const c = this.add.container(0, 0).setDepth(30);
    c.add([this.add.rectangle(0, ch / 2 + 5, cw, ch, PAL.black), this.add.rectangle(0, ch / 2, cw, ch, PAL.paper).setStrokeStyle(3, PAL.black), ...items, ...buttons]);
    for (const o of c.list as unknown as Phaser.GameObjects.Components.Transform[]) o.y -= ch / 2;
    this.summaryCard = { c, shade, w: cw, h: ch };
    this.fitSummary();
    // The result card in words, and its keys (gameKeys.ts fishingKey), for screen readers: its buttons are on the canvas.
    announce(
      [
        said,
        record ? 'New best!' : 'Round over.',
        `${this.correct} of ${ROUND} objects in the right bucket${perfect ? ', perfect!' : '.'}`,
        stars ? `You earned ${stars} ${stars === 1 ? 'star' : 'stars'}${coins && end.coins ? ` and ${coins} City Coins` : ''}.` : '',
        halved ? (stars ? `Half stars after ${FULL_ROUNDS_A_DAY} rounds a day.` : "That's all the stars this game pays today.") : '',
        growthSaid(g),
        end.tips ? 'Tip: Lifecycle rules can move files to cheaper shelves for you.' : '',
        end.keysLine ?? endKeysLine(!!this.expertRound).replace('Press Enter', 'Press Space or Enter'),
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  /** The last answer's verdict, shown until the next bite. */
  private lastVerdict = '';

  private reset(msg: string) {
    this.info.setVisible(true);
    this.player.play(`${KAI_SHEET}:idle:SE`);
    this.tweens.killTweensOf(this.bobber);
    this.bobber.setVisible(false);
    this.state = 'ready';
    this.calmUntil = this.time.now + CALM_MS;
    this.setInfo(msg);
  }

  private setInfo(t: string) {
    this.info.setText(t);
  }

  private updateHud() {
    this.hud.setText(`${expert() ? '⚡ Expert · ' : ''}Catches ${this.caught}/${ROUND} · Correct ${this.correct}`);
  }
}
