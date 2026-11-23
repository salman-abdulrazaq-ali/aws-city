import Phaser from 'phaser';
import { FEEDBACK, MiniGame, pace, PAL, TXT } from './MiniGame';
import { reducedMotion } from '../../motion';
import { crisp } from '../../SpeechBubble';
import { hasSprite, spriteAnchor } from '../../assets';
import { COLOR, CSS, LABEL_BG } from '../../theme';
import { QUEUE } from '@/world/minigames';
import { POINTS } from './scoring';
import { act, districtColor, fitScale, person, prop } from './cast';

const WORK_MS = 800;
/** The parcel every message rides in, and the dead-letter chute when the atlas has no bin (city atlas props). */
const BOX = 'pack:data_box_SE';
const CHUTE = 'combo:mail-chute';
/**
 * The shed's own props (art/tiles/games_art.py) at 1×, px: the belt's near side (its edge, the violet rail, rollers and
 * legs) tiled under the belt, the worker's bench, the dead-letter bin with its plate, the queue's roller rack.
 */
const BELT = { name: 'game:queue:belt', w: 32, h: 24, edge: 4 };
const BENCH = 'game:queue:bench';
const DLQ_BIN = 'game:queue:dlq';
const TRAY = { name: 'game:queue:tray', w: 32, h: 16 };
/** A parcel's box at 1×, px (the atlas canvas): the play group scales it by a whole number. */
const BOX_W = 37;
const BOX_H = 47;

/** A label chip's rectangle, px: its left and top edges and its size. */
export interface ChipBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the belt's label chips stand so that every one shown can be read (pure: tests bunch parcels with it). `chips`
 * come front first (nearest the worker), each wanting its home over its box (`x` its middle, `bottom` its bottom edge).
 * Slid inside x0..x1, a chip rises a level at a time until it clears every chip placed before it and every `fixed` box
 * (Eddie's chip) by `gap` px, never above `ceiling`. The levels are one grid, `step` px apart up from `base` (the back
 * row's home), so a front-row chip lifted a little never blocks two of the back row's levels. A chip whose box hasn't
 * reached the belt yet (`x` < 0), or that finds no room, isn't shown. The front chip goes first, so the message Space and
 * D act on keeps its label over its box.
 */
export function stackChips(
  chips: { x: number; bottom: number; w: number; h: number }[],
  fixed: ChipBox[],
  { x0, x1, ceiling, step, base, gap = 2 }: { x0: number; x1: number; ceiling: number; step: number; base: number; gap?: number },
) {
  const taken = [...fixed];
  const clear = (b: ChipBox) => taken.every((t) => b.x + b.w + gap <= t.x || t.x + t.w + gap <= b.x || b.y + b.h + gap <= t.y || t.y + t.h + gap <= b.y);
  return chips.map((c) => {
    const x = Math.max(x0, Math.min(x1 - c.w, c.x - c.w / 2));
    const levels = [c.bottom];
    for (let bottom = base; bottom - c.h >= ceiling; bottom -= step) if (bottom < c.bottom) levels.push(bottom);
    for (const bottom of levels) {
      if (c.x < 0 || bottom - c.h < ceiling) break;
      const b = { x, y: bottom - c.h, w: c.w, h: c.h };
      if (clear(b)) {
        taken.push(b);
        return { x: x + c.w / 2, bottom, shown: true };
      }
    }
    return { x: x + c.w / 2, bottom: c.bottom, shown: false };
  });
}

/**
 * A message on the belt or in the tray: its box with the label as a chip, one Container (dragged as one). `home` is the
 * chip's bottom over the box, from the Container's middle (placeChips may lift the chip clear of others).
 */
interface Parcel {
  c: Phaser.GameObjects.Container;
  chip: Phaser.GameObjects.Text;
  home: number;
}
interface Live extends Parcel {
  poison: boolean;
  tw: Phaser.Tweens.Tween;
}

/**
 * Queue Juggler (SQS): a sorting shed in the Network Junction's colours. Parcels (messages) ride a conveyor to Eddie's
 * workbench; he takes one at a time (the conveyor's side, the bench, the queue's rack and the dead-letter bin are the
 * art generator's, art/tiles/games_art.py). Click a parcel (or Space for the front one) to park it in the queue tray, where
 * the SQS agent keeps it: Eddie pulls from the queue whenever he's free. A parcel that reaches him while he's busy is
 * lost. Poison parcels (☠, red chip) fail every time: drag them to the dead-letter chute (or D for the front one)
 * instead. Poison put in the queue, or a good message thrown in the DLQ, costs more than a right call pays, so clicking
 * everything doesn't win (src/game/scenes/games/scoring.ts). Labels over a bunch of parcels lift clear of each other on
 * strings to their boxes (stackChips), so every label shown can be read; the parcels themselves never wait.
 */
export class QueueGame extends MiniGame {
  private queued: Parcel[] = [];
  private live: Live[] = [];
  private busyUntil = 0;
  private waves = 0;
  /** The tray's left end (the first queued box's left edge) and its floor. */
  private qx = 0;
  private qy = 0;
  /** The tray's width, for the queued boxes' spacing. */
  private trayW = 0;
  private beltY = 0;
  /** The belt's front edge (the floaters for a parcel at the worker sit just under it). */
  private beltBottom = 0;
  /** Half the gap between the belt's two rows: a burst's parcels sit side by side, their chips clear of each other. */
  private rowOff = 0;
  /** How far a label chip rises at a time when it would overlap another (a chip's height and 2 px). */
  private chipStep = 20;
  /** Where a parcel meets the worker. */
  private beltEnd = 0;
  /** The tray's heading top (the DLQ floaters sit above it). */
  private headY = 0;
  private spawned = 0;
  private dlq = 0;
  /** The play group's whole-number scale: 1 in the side panel, 2 in the tab. */
  private s = 1;
  /** How far the belt's near side hangs under the belt, px (0 without the atlas's pieces). */
  private skirt = 0;
  private dlqText?: Phaser.GameObjects.Text;
  private dlqZone = new Phaser.Geom.Rectangle();
  private worker?: Phaser.GameObjects.Sprite;
  private workerChip?: Phaser.GameObjects.Text;
  private workerFree?: boolean;
  private keeper?: Phaser.GameObjects.Sprite;
  private keeperCarries?: boolean;
  /** The strings lifted labels hang on to their boxes: under every parcel, so a string never crosses a label. */
  private strings?: Phaser.GameObjects.Graphics;

  constructor() {
    super('game:queue', 'queue', 'sqs', '📬 Queue Juggler — click a message (or Space) to queue it; drag red poison to the DLQ (or D)');
  }

  protected setup() {
    this.queued = [];
    this.live = [];
    this.busyUntil = 0;
    this.waves = 0;
    this.dlq = 0;
    this.workerFree = this.keeperCarries = undefined;
    this.strings = this.add.graphics().setDepth(19);
    this.onKeys((k) => {
      const f = this.front();
      if (!f) return;
      if (k === ' ') this.decide(f, false);
      else if (k === 'd' || k === 'D') this.decide(f, true);
    });
    const { width: w, height: h } = this.scale;
    // The shed is laid out top-down in a centred column (MiniGame.column): Eddie's bench at the end of the belt, a gap
    // for the floaters, the queue tray with the SQS agent and the dead-letter chute, and the key right under the tray.
    // The belt still runs in from the canvas's left edge. People and props share one whole-number scale (cast.ts).
    const cw = Math.min(w, 760);
    const label = (str: string, color: string = PAL.ink, size = 13) => crisp(this.add.text(0, 0, str, { ...TXT(size, color), backgroundColor: LABEL_BG, padding: { x: 5, y: 2 } }));
    const legend = crisp(
      this.add.text(w / 2, 0, '☠ = poison: it fails every time, so it goes to the dead-letter queue (DLQ)', {
        ...TXT(13, CSS.inkSoft),
        backgroundColor: LABEL_BG,
        padding: { x: 6, y: 2 },
        align: 'center',
        wordWrap: { width: cw - 24 },
      }),
    )
      .setOrigin(0.5, 0)
      .setDepth(5);
    const probe = label('worker · busy');
    const chipH = probe.height;
    probe.destroy();
    this.chipStep = chipH + 2;
    // The tray's heading wraps inside the tray's width at 1× (bigger text in the side panel), so it never reaches the chute.
    const heading = label('SQS queue: the worker pulls when free', CSS.ink)
      .setWordWrapWidth(Math.max(120, cw - 140))
      .setDepth(6);
    const headH = heading.height;
    this.rowOff = Math.ceil(chipH / 2) + 2;
    // The shed's props when the atlas has them: the belt's near side hangs under the belt, the rack is the tray's floor.
    const props = hasSprite(BELT.name) && hasSprite(BENCH) && hasSprite(TRAY.name);
    const skirtH = props ? BELT.h - BELT.edge : 0;
    const trayH = props ? TRAY.h : 8;
    // Height the play group needs at scale 1 (Eddie and his chip over the belt, the bench, a box and its heading over
    // the tray, the tray), and the text that doesn't scale.
    const fixed = chipH + 6 + this.rowOff * 2 + headH + 6 + 10 + legend.height;
    this.s = Math.min(fitScale(cw, 380), fitScale(h - this.top - fixed - 96, 67 + 10 + skirtH + BOX_H + trayH));
    const s = this.s;
    const above = this.rowOff + 67 * s + chipH + 6;
    const below = this.rowOff + 10 * s;
    const skirt = (this.skirt = skirtH * s);
    const trayPart = BOX_H * s + headH + 6 + trayH * s + 10 + legend.height;
    // Room between the belt (its near side included) and the tray for the floaters ("worker busy: lost!", "✓ to the DLQ").
    const gap = Phaser.Math.Clamp(h - this.top - above - below - skirt - trayPart, 96, 170) + skirt;
    const col = this.column(above + below + gap + trayPart);
    const r = col.r;
    this.beltY = col.y + above;
    this.beltBottom = this.beltY + below;
    this.qy = this.beltBottom + gap + headH + 6 + BOX_H * s;
    this.headY = this.qy - BOX_H * s - headH - 4;
    legend.setY(this.qy + trayH * s + 10);
    const accent = districtColor('sqs');
    const g = this.add.graphics();
    // The shed: graphite walls with the Network Junction's violet trim, plank lines, and a concrete floor from the belt down.
    g.fillStyle(PAL.bg, 1).fillRect(0, this.top, w, h - this.top);
    g.fillStyle(COLOR.panel, 1).fillRect(0, this.top, w, this.beltY - this.rowOff - this.top);
    for (let x = 0; x < w; x += 24 * s) g.fillStyle(PAL.line, 1).fillRect(x, this.top, s, this.beltY - this.rowOff - this.top);
    g.fillStyle(accent, 0.55).fillRect(0, this.top, w, 3 * s);
    g.fillStyle(COLOR.bgDeep, 1).fillRect(0, this.beltBottom, w, h - this.beltBottom);
    g.fillStyle(accent, 0.08).fillRect(0, this.beltBottom + gap / 2, w, h);
    if (col.x > 40 * s) {
      prop(this, 'deco:banner-networking', col.x - 22 * s, this.beltY - this.rowOff - 40 * s, s);
      prop(this, 'deco:banner-networking', r + 4 * s, this.beltY - this.rowOff - 40 * s, s);
    }
    // The conveyor (left to right) into Eddie's bench: a black-edged belt with rollers, two rows of parcels on it.
    const benchW = 64 * s;
    this.beltEnd = r - benchW;
    const beltTop = this.beltY - this.rowOff - 6 * s;
    g.fillStyle(PAL.black, 1).fillRect(0, beltTop - 2, this.beltEnd + 2, this.beltBottom - beltTop + 4);
    g.fillStyle(COLOR.panelHi, 1).fillRect(0, beltTop, this.beltEnd, this.beltBottom - beltTop);
    for (let x = 8; x < this.beltEnd - 8; x += 22 * s) g.fillStyle(PAL.line, 1).fillRect(x, beltTop, 4 * s, this.beltBottom - beltTop);
    // Its near side tiled along it (the last piece cut at the bench), or a violet edge without the atlas.
    if (props) this.tile(BELT.name, BELT.w, 0, this.beltEnd, this.beltBottom - BELT.edge * s, 3);
    else g.fillStyle(accent, 1).fillRect(0, this.beltBottom - 2 * s, this.beltEnd, 2 * s);
    // Eddie (EC2, the worker) stands behind his bench facing the belt; his chip says free or busy in words.
    const ex = r - benchW / 2;
    // On the shed floor (the belt's legs stand on it) Eddie works behind his bench, which hides his legs.
    const floor = this.beltBottom + skirt;
    const feet = props ? floor - 18 * s : this.beltY - this.rowOff + 2 * s;
    this.worker = person(this, 'ec2', ex, feet, s, 'idle', 'SW').setDepth(8);
    this.workerChip = label('worker · free', PAL.good).setOrigin(0.5, 1).setDepth(9);
    // Over his head, kept inside the stage in the narrow panel.
    this.workerChip.setPosition(Math.min(ex, w - 4 - this.workerChip.width / 2), feet - 67 * s - 2);
    if (props) prop(this, BENCH, ex, floor, s).setDepth(9);
    else {
      const benchTop = this.beltY - this.rowOff - 2 * s;
      const bench = this.add.graphics().setDepth(9);
      bench.fillStyle(PAL.black, 1).fillRect(this.beltEnd, benchTop - 2, benchW, this.beltBottom - benchTop + 4);
      bench.fillStyle(COLOR.accent, 1).fillRect(this.beltEnd + 2, benchTop, benchW - 4, 5 * s);
      bench.fillStyle(COLOR.panelHi, 1).fillRect(this.beltEnd + 2, benchTop + 5 * s, benchW - 4, this.beltBottom - benchTop - 5 * s);
    }
    // The tray, the SQS agent who keeps it at its left end, and the dead-letter chute at the right.
    const sx = col.x + 22 * s;
    this.keeper = person(this, 'sqs', sx, this.qy + 4 * s, s, 'idle', 'SE').setDepth(30);
    const BIN = hasSprite(DLQ_BIN) ? DLQ_BIN : CHUTE;
    const binA = spriteAnchor(BIN);
    const dlqText = (this.dlqText = label('DLQ 0', FEEDBACK.wrong, 14).setOrigin(0.5, 1).setDepth(13));
    // The drop zone: the chute and its counter, wide enough for the counter at any text size.
    const binW = Math.max(56 * s, Math.ceil(dlqText.width) + 12);
    const binX = r - binW / 2 - 4;
    this.qx = sx + 26 * s;
    this.trayW = Math.max(BOX_W * s, binX - binW / 2 - 12 - this.qx);
    heading.setPosition(this.qx, this.headY);
    // The tray: the queue's roller rack the boxes stand on (a black-edged shelf without the atlas), in a violet frame.
    if (props) this.tile(TRAY.name, TRAY.w, this.qx - 6, this.qx + this.trayW + 6, this.qy - s, 3);
    else {
      g.fillStyle(PAL.black, 1).fillRect(this.qx - 6, this.qy - 2 * s, this.trayW + 12, 10 * s);
      g.fillStyle(COLOR.panel, 1).fillRect(this.qx - 4, this.qy, this.trayW + 8, 6 * s);
    }
    g.lineStyle(2, accent, 1).strokeRect(this.qx - 6, this.qy - BOX_H * s - 4, this.trayW + 12, BOX_H * s + 4 + trayH * s);
    const binBottom = this.qy + trayH * s;
    if (binA) prop(this, BIN, binX, binBottom - (binA.h - binA.ay) * s, s).setDepth(12);
    dlqText.setPosition(binX, binBottom - (binA?.h ?? 70) * s - 2);
    const zoneTop = dlqText.y - dlqText.height - 4;
    this.dlqZone.setTo(binX - binW / 2, zoneTop, binW, binBottom + 4 - zoneTop);
    g.fillStyle(COLOR.bad, 0.16).fillRect(this.dlqZone.x, this.dlqZone.y, this.dlqZone.width, this.dlqZone.height);
    g.lineStyle(2, COLOR.bad, 1).strokeRect(this.dlqZone.x, this.dlqZone.y, this.dlqZone.width, this.dlqZone.height);
    // The chute is a button too: tap it to send the front message there.
    this.add
      .zone(this.dlqZone.centerX, this.dlqZone.centerY, this.dlqZone.width, this.dlqZone.height)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        const f = this.front();
        if (f) this.decide(f, true);
      });
    this.input.on('drag', (_p: Phaser.Input.Pointer, o: Phaser.GameObjects.GameObject, x: number, y: number) => {
      if (this.live.some((e) => e.c === o)) (o as Phaser.GameObjects.Container).setPosition(x, y);
    });
    this.time.addEvent({ delay: 120, loop: true, callback: () => this.work() });
    this.scheduleWave();
  }

  /**
   * A tileable atlas piece (its anchor its top-left corner) repeated from x0 to x1 at the play scale, its top at `top`;
   * the last piece is cut where the run ends.
   */
  private tile(name: string, w: number, x0: number, x1: number, top: number, depth: number) {
    const step = w * this.s;
    for (let x = x0; x < x1; x += step) {
      const piece = prop(this, name, x, top, this.s).setDepth(depth);
      if (x + step > x1) piece.setCrop(0, 0, Math.ceil((x1 - x) / this.s), piece.height);
    }
  }

  /** The message nearest the worker. */
  private front() {
    return this.live.reduce<Live | undefined>((a, b) => (!a || b.c.x > a.c.x ? b : a), undefined);
  }

  /** Bursts: a few quiet messages, then a rush that a single worker can't keep up with. */
  private scheduleWave() {
    if (this.over) return;
    this.waves++;
    const burst = this.waves % 3 === 0;
    const n = burst ? 6 + Math.min(4, this.waves) : 2;
    for (let i = 0; i < n; i++) this.time.delayedCall(pace(i * (burst ? 260 : 900)), () => !this.over && this.spawn(Math.random() < 0.15 + Math.min(0.1, this.waves * 0.01)));
    this.time.delayedCall(pace(burst ? 4200 : 2600), () => this.scheduleWave());
  }

  /**
   * A parcel: the box with its label as a chip on top (poison: ☠ on a red chip, so it's never colour alone). The
   * Container's middle is its origin (its hit area is centred there), so its box stands on `bottom`.
   */
  private parcel(text: string, poison: boolean, x: number, bottom: number): Parcel {
    const s = this.s;
    const chip = crisp(
      this.add.text(0, 0, poison ? `☠ ${text}` : text, { ...TXT(13, poison ? PAL.paperInk : PAL.ink), backgroundColor: poison ? CSS.bad : LABEL_BG, padding: { x: 5, y: 2 } }),
    ).setOrigin(0.5, 1);
    const ph = chip.height + (BOX_H - 6) * s;
    const a = spriteAnchor(BOX);
    const box = prop(this, BOX, 0, ph / 2 - ((a?.h ?? BOX_H) - (a?.ay ?? 20)) * s, s);
    const home = -ph / 2 + chip.height;
    chip.setY(home);
    const c = this.add.container(x, bottom - ph / 2, [box, chip]).setSize(Math.max(chip.width, BOX_W * s), ph);
    return { c, chip, home };
  }

  /**
   * A press at (x, y), in the hit test's frame (the Container's size, its top-left at 0, 0), lands on the parcel: on its
   * box, or on its label wherever placeChips put it.
   */
  private pressed({ c, chip, home }: Parcel, x: number, y: number) {
    const dx = x - c.width / 2;
    const dy = y - c.height / 2;
    const onBox = Math.abs(dx) <= (BOX_W * this.s) / 2 && dy >= home && dy <= c.height / 2;
    const onChip = chip.visible && Math.abs(dx - chip.x) <= chip.width / 2 && dy >= chip.y - chip.height && dy <= chip.y;
    return onBox || onChip;
  }

  override update(t: number, dt: number) {
    super.update(t, dt);
    this.placeChips();
  }

  /**
   * Every label on the belt where it can be read (stackChips): a chip over a bunch of parcels rises clear of the others
   * and of Eddie's chip, and stays inside the stage; a lifted one hangs on a string to its box (poison's red like its
   * chip). A dragged parcel keeps its chip as it was.
   */
  private placeChips() {
    const belt = this.live.filter((e) => !e.tw.isPaused()).sort((a, b) => b.c.x - a.c.x);
    const wc = this.workerChip;
    const fixed = wc ? [{ x: wc.x - wc.width / 2, y: wc.y - wc.height, w: wc.width, h: wc.height }] : [];
    const spots = stackChips(
      belt.map(({ c, chip, home }) => ({ x: c.x, bottom: c.y + home, w: chip.width, h: chip.height })),
      fixed,
      // The back row's labels sit over boxes standing on beltY - rowOff (parcel()).
      { x0: 4, x1: this.scale.width - 4, ceiling: this.top + 3 * this.s + 2, step: this.chipStep, base: this.beltY - this.rowOff - (BOX_H - 6) * this.s },
    );
    belt.forEach(({ c, chip }, i) => chip.setVisible(spots[i].shown).setPosition(spots[i].x - c.x, spots[i].bottom - c.y));
    // Each string runs from a lifted chip down into the top of its box.
    const g = this.strings?.clear();
    const s = this.s;
    for (const { c, chip, home, poison } of this.live)
      if (g && chip.visible && chip.y < home) g.fillStyle(poison ? COLOR.bad : COLOR.muted, 1).fillRect(Math.round(c.x - s / 2), c.y + chip.y, s, home - chip.y + 2 * s);
  }

  private spawn(poison: boolean) {
    const pool = poison ? QUEUE.poison : QUEUE.messages;
    const label = pool[Math.floor(Math.random() * pool.length)];
    // Two rows on the belt, so a burst's messages sit side by side instead of on top of each other (the front row on top).
    const row = this.spawned++ % 2;
    const p = this.parcel(label, poison, 0, this.beltY + (row ? this.rowOff : -this.rowOff));
    const { c } = p;
    c.setX(-c.width / 2 - 10)
      .setDepth(20 + row)
      .setInteractive({ hitArea: new Phaser.Geom.Rectangle(0, 0, c.width, c.height), hitAreaCallback: (_r: unknown, x: number, y: number) => this.pressed(p, x, y), useHandCursor: true, draggable: true });
    const tw = this.tweens.add({
      targets: c,
      x: this.beltEnd - c.width / 2,
      duration: pace(4200 - Math.min(1500, this.waves * 60)),
      onComplete: () => this.arrive(c, poison),
    });
    const entry: Live = { ...p, poison, tw };
    this.live.push(entry);
    // Each message is said as it comes on the belt (the belt is only drawn), poison by name.
    this.speak(`${poison ? 'Poison message' : 'Message'}: ${label}.`, true);
    // A tap queues it; a drag that ends on the DLQ chute sends it there (Phaser starts a drag on press).
    c.on('dragstart', () => (tw.pause(), c.setDepth(40)));
    c.on('dragend', (ptr: Phaser.Input.Pointer) => {
      if (!this.live.includes(entry)) return;
      this.decide(entry, this.dlqZone.contains(ptr.x, ptr.y));
    });
  }

  /** The player's call on a message: the queue, or the dead-letter queue. */
  private decide(e: Live, toDlq: boolean) {
    if (this.over || !this.live.includes(e)) return;
    e.tw.stop();
    this.live = this.live.filter((x) => x !== e);
    const { c, poison } = e;
    c.disableInteractive();
    const floatY = this.headY - 14;
    if (toDlq && poison) {
      this.hit();
      this.dlq++;
      this.dlqText?.setText(`DLQ ${this.dlq}`);
      this.addScore(POINTS.queue.dlq);
      this.floater(this.dlqZone.centerX, floatY, '✓ to the DLQ', FEEDBACK.right);
      this.speak('Right: poison to the dead-letter queue.');
      c.destroy();
    } else if (toDlq) {
      this.wrong();
      this.addScore(POINTS.queue.wrong);
      this.floater(this.dlqZone.centerX, floatY, '✗ a good message thrown away', FEEDBACK.wrong);
      this.speak('Wrong: a good message thrown away.');
      c.destroy();
    } else if (poison) {
      this.wrong();
      this.addScore(POINTS.queue.wrong);
      this.floater(this.qx + (this.dlqZone.x - this.qx) / 2, floatY, '✗ poison fails over and over: drag it to the DLQ', FEEDBACK.wrong);
      this.speak('Wrong: poison fails over and over. Send poison to the dead-letter queue with D.');
      c.destroy();
    } else {
      this.hit();
      this.enqueue(e);
      this.speak(`Queued. ${this.queued.length} in the queue.`);
    }
  }

  private enqueue(p: Parcel) {
    this.queued.push({ c: p.c, chip: p.chip, home: p.home });
    this.layoutQueue();
    if (this.queued.length > 12) {
      // A queue holds a lot, but a round's tray holds 12: the oldest waits too long here.
      const old = this.queued.shift()!;
      this.addScore(POINTS.queue.overflow, 'soft');
      old.c.destroy();
      this.layoutQueue();
    }
  }

  /** Queued parcels stand in the tray left to right, oldest first, as boxes (their labels put away). */
  private layoutQueue() {
    const bw = BOX_W * this.s;
    const step = Math.min(bw + 2, (this.trayW - bw) / 11);
    this.queued.forEach(({ c, chip }, i) => {
      chip.setVisible(false);
      const x = this.qx + bw / 2 + i * step;
      const y = this.qy - c.height / 2;
      if (reducedMotion()) c.setPosition(x, y);
      else this.tweens.add({ targets: c, x, y, duration: 160 });
      c.setDepth(10 + i);
    });
    // The SQS agent carries while there's something in the queue.
    const carries = this.queued.length > 0;
    if (this.keeper && carries !== this.keeperCarries) {
      this.keeperCarries = carries;
      act(this.keeper, carries ? 'carry' : 'idle', 'SE');
    }
  }

  private arrive(c: Phaser.GameObjects.Container, poison: boolean) {
    this.live = this.live.filter((x) => x.c !== c);
    if (this.over) return c.destroy();
    // Floaters for the bench sit in the gap under the belt (and its near side), never on the parcels still riding it.
    const fy = this.beltBottom + this.skirt + 22;
    if (poison) {
      this.wrong();
      this.addScore(POINTS.queue.poisoned, 'soft');
      this.floater(c.x - 60, fy, 'poison: fails forever', FEEDBACK.wrong);
      this.speak(`Poison reached the worker and fails forever. Score ${this.score}.`);
    } else if (this.time.now < this.busyUntil) {
      this.addScore(POINTS.queue.lost, 'soft');
      this.floater(c.x - 60, fy, 'worker busy: lost!', FEEDBACK.wrong);
      this.speak(`Lost: the worker was busy and it wasn't queued. Score ${this.score}.`);
      if (!reducedMotion()) this.cameras.main.shake(90, 0.003);
    } else {
      this.busyUntil = this.time.now + pace(WORK_MS);
      this.addScore(POINTS.queue.direct, 'none');
    }
    c.destroy();
  }

  /** Eddie hammers while he works and waits idle when free; his chip says which in words (never colour alone). */
  private showWorker(free: boolean) {
    if (free === this.workerFree || !this.worker) return;
    this.workerFree = free;
    act(this.worker, free ? 'idle' : 'hammer', 'SW');
    this.workerChip?.setText(free ? 'worker · free' : 'worker · busy').setColor(free ? PAL.good : PAL.accentCss);
  }

  /** A free worker pulls the oldest message from the queue. */
  private work() {
    if (this.over) return;
    const free = this.time.now >= this.busyUntil;
    if (!free || !this.queued.length) return this.showWorker(free);
    const q = this.queued.shift()!;
    this.busyUntil = this.time.now + pace(WORK_MS);
    this.showWorker(false);
    this.addScore(POINTS.queue.worked, 'none');
    q.c.destroy();
    this.layoutQueue();
  }

  protected lesson() {
    return this.dlq ? `${this.dlq} poison message${this.dlq === 1 ? '' : 's'} parked safely. ${QUEUE.lesson}` : QUEUE.lesson;
  }
}
