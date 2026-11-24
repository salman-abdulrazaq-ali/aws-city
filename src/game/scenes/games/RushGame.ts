import Phaser from 'phaser';
import { FRAME_H, FRAME_W, PIVOT, citizenIds } from '../../assets';
import { sfx } from '../../audio';
import { crisp } from '../../SpeechBubble';
import { COLOR, CSS } from '../../theme';
import { FEEDBACK, MiniGame, PAL, TXT } from './MiniGame';
import { PILL } from './scoring';
import { answerPop, playScale, pressLook } from './stageFx';
import { addServer, arrivals, newRush, PHASES, phaseAt, removeServer, RUSH, RUSH_LESSON, rushStars, rushVerdict, serverCount, tick, type Phase, type RushState } from './rushHour';

interface Slot {
  body: Phaser.GameObjects.Rectangle;
  leds: Phaser.GameObjects.Rectangle[];
  label: Phaser.GameObjects.Text;
  /** The slot's middle and size, for the frame a press puts round it (stageFx.answerPop). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The sky by phase: day blues, then a dusk navy (the retired purple is gone). */
const SKY: Record<Phase, number> = { morning: 0x3b5b8c, lunch: 0x2f7fbf, evening: 0x22305a };
/** Customers drawn in the line; more show as "+N". */
const SHOWN = 10;
/** The street scene's size at 1× (the side panel); a big tab draws it at 2× (stageFx.playScale). */
const BASE_W = 380;
const BASE_H = 300;
/** A slot's state in words, and in short words when its slot is too narrow for them. */
const WORDS = { busy: 'busy', idle: 'idle 💤', boot: 'starting', off: '' };
const SHORT_WORDS = { busy: 'busy', idle: '💤', boot: '⏳', off: '' };
/** The buttons name their keys (+ and − work too: the labels start with them). */
export const RUSH_BUTTONS = { remove: '− server (↓)', add: '+ server (↑)' } as const;

/**
 * EC2 Rush Hour: customers come in waves (quiet morning, lunch rush, calm evening). Add servers when the
 * line grows and remove them when they sit idle. That's the job Auto Scaling does for you.
 */
export class RushGame extends MiniGame {
  private s: RushState = newRush();
  private phase: Phase = 'morning';
  private wasLong = false;
  private wasIdle = false;
  private slots: Slot[] = [];
  private line: Phaser.GameObjects.Sprite[] = [];
  private lineText!: Phaser.GameObjects.Text;
  private moreText!: Phaser.GameObjects.Text;
  private serversText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  /** Each second's sum: "+4 served −1 idle". */
  private ticker!: Phaser.GameObjects.Text;
  private sky!: Phaser.GameObjects.Rectangle;
  private sun!: Phaser.GameObjects.Rectangle;
  private eddie!: Phaser.GameObjects.Sprite;
  private words: Record<'busy' | 'idle' | 'boot' | 'off', string> = WORDS;
  private plusBtn?: Phaser.GameObjects.Container;
  private minusBtn?: Phaser.GameObjects.Container;
  /** The scene's column: the factory's left edge, the column's left, right and middle, the street, the top, the controls, the phase label and the scale. */
  private geo = { fx: 0, left: 0, right: 0, mid: 0, groundY: 0, top: 0, by: 0, labels: 0, k: 1 };

  constructor() {
    super('game:ec2', 'ec2', 'ec2', '🏭 EC2 Rush Hour — tap + when the line grows, − when servers sit idle');
    this.duration = RUSH.seconds;
    this.clockIsTheGame = true;
    // The running total shows its debt (an idle morning can go below 0); the paid score never does, and a finished day pays 1 ⭐.
    this.allowDebt = true;
    this.minStars = 1;
    this.keysHelp = 'Press + or the up arrow to add a server, − or the down arrow to turn one off.';
  }

  protected setup() {
    this.s = newRush();
    this.phase = 'morning';
    this.wasLong = this.wasIdle = false;
    this.slots = [];
    this.line = [];
    const { width: w, height: h } = this.scale;
    const room = h - this.top;
    // The street scene is drawn at a whole-number scale k (stageFx.playScale): 1× in the side panel, 2× in a big tab,
    // so the factory, Eddie and the line fill the stage instead of standing at 1× under ~60 % empty sky. It sits in
    // the centred play column (MiniGame.column); the sky and the street run on to the canvas's edges.
    const k = playScale(Math.min(w, 760), room, BASE_W, BASE_H);
    const stageH = Math.min(room, Math.max(BASE_H * k, 520));
    const col = this.column(stageH);
    const top = col.y;
    const groundY = Math.round(top + stageH * 0.74);
    this.sky = this.add.rectangle(0, 0, w, groundY, SKY.morning).setOrigin(0);
    this.sun = this.add.rectangle(col.x + col.w * 0.14, top + 40 * k, 18 * k, 18 * k, 0xfde047).setStrokeStyle(2, PAL.black);
    const g = this.add.graphics();
    // street and sidewalk
    g.fillStyle(0x6b7280, 1).fillRect(0, groundY - 6, w, 8);
    g.fillStyle(0x374151, 1).fillRect(0, groundY + 2, w, h - groundY);
    for (let x = 10; x < w; x += 40 * k) g.fillStyle(0x4b5563, 1).fillRect(x, groundY + 30 * k, 20 * k, 3 * k);
    // the factory: orange walls, a roof sign, eight server slots and a door, standing on the street
    const fx = Math.round(col.x + col.w * 0.44);
    const fw = col.r - fx - 8;
    const cols = 4;
    const gap = 6 * k;
    const [roof, door, headroom] = [30 * k, 44 * k, 34 * k];
    const sw = Math.floor((fw - 16 * k - gap * (cols - 1)) / cols);
    const sh = Math.max(24 * k, Math.min(60 * k, Math.floor((groundY - 6 - top - headroom - roof - door - gap) / 2)));
    const fh = roof + 2 * sh + gap + door;
    const fy = groundY - 6 - fh;
    this.geo = { fx, left: col.x, right: col.r, mid: col.cx, groundY, top, by: 0, labels: 0, k };
    g.fillStyle(PAL.black, 1).fillRect(fx - 2, fy - 2, fw + 4, fh + 4);
    g.fillStyle(0xb45309, 1).fillRect(fx, fy, fw, fh);
    g.fillStyle(0xed7100, 1).fillRect(fx, fy, fw, 6 * k);
    g.fillStyle(0x7c2d12, 1).fillRect(fx + 10 * k, fy - 14 * k, 10 * k, 14 * k).fillRect(fx + fw - 22 * k, fy - 18 * k, 10 * k, 18 * k); // chimneys
    crisp(this.add.text(fx + fw / 2, fy + 16 * k, 'EC2 FACTORY', TXT(14 + 4 * (k - 1), PAL.ink))).setOrigin(0.5);
    // the door Eddie stands by
    g.fillStyle(0x7c2d12, 1).fillRect(fx + fw / 2 - 18 * k, groundY - 6 - 34 * k, 36 * k, 34 * k);
    for (let i = 0; i < RUSH.maxServers; i++) {
      const x = fx + 8 * k + (i % cols) * (sw + gap);
      const y = fy + roof + Math.floor(i / cols) * (sh + gap);
      this.add.rectangle(x, y, sw, sh, COLOR.panel).setOrigin(0).setStrokeStyle(2, PAL.black);
      const body = this.add.rectangle(x + 4 * k, y + 4 * k, sw - 8 * k, sh - 22 * k, COLOR.bg).setOrigin(0);
      const leds = [0, 1, 2].map((j) => this.add.rectangle(x + 9 * k + j * 9 * k, y + 10 * k, 5 * k, 5 * k, COLOR.panelHi).setOrigin(0));
      const label = crisp(this.add.text(x + sw / 2, y + sh - 9 * k, '', TXT(12 + 3 * (k - 1), PAL.muted))).setOrigin(0.5);
      this.slots.push({ body, leds, label, x: x + sw / 2, y: y + sh / 2, w: sw, h: sh });
    }
    // A narrow slot (the panel, or a big Text size) says its state in short words; the LEDs say it too.
    const probe = this.add.text(0, 0, 'starting', TXT(12 + 3 * (k - 1)));
    this.words = probe.width > sw - 6 ? SHORT_WORDS : WORDS;
    probe.destroy();
    // Eddie at the door, and the line of customers waiting outside (whole-number scales: the pixel art stays crisp)
    // His right side at the factory's wall: at (k+1)× he'd cover the first slots' labels from fx.
    this.eddie = this.add.sprite(fx - 12 * (k + 1), groundY, 'char:ec2', 0).setOrigin(PIVOT.x / FRAME_W, PIVOT.y / FRAME_H).setScale(k + 1).setFlipX(true);
    this.eddie.play('ec2:idle:SE');
    const ids = citizenIds();
    const first = this.eddie.x - 22 * k;
    const step = Math.min(18 * k, (first - col.x - 14 * k) / SHOWN);
    for (let i = 0; i < SHOWN; i++) {
      const id = ids[(i * 3) % ids.length];
      const sp = this.add.sprite(first - i * step, groundY + 2, `char:${id}`, 0).setOrigin(PIVOT.x / FRAME_W, PIVOT.y / FRAME_H).setScale(k).setVisible(false);
      sp.play(`${id}:idle:SE`);
      this.line.push(sp);
    }
    const plate = { backgroundColor: PILL, padding: { x: 6, y: 2 } };
    this.moreText = crisp(this.add.text(col.x + 8, groundY - 60 * k, '', { ...TXT(14, PAL.ink), ...plate, padding: { x: 4, y: 1 } })).setOrigin(0, 0.5);
    // The phase, the last second's sum and the line length stand over the line, just above the customers' heads.
    const lx = (col.x + fx) / 2;
    const lineY = Math.round(groundY - 70 * k - 12);
    this.lineText = crisp(this.add.text(lx, lineY, '', { ...TXT(15, PAL.ink), ...plate })).setOrigin(0.5);
    this.ticker = crisp(this.add.text(lx, lineY - 32, '', { ...TXT(14, PAL.ink), ...plate, align: 'center', wordWrap: { width: fx - col.x - 12 } })).setOrigin(0.5);
    this.phaseText = crisp(this.add.text(lx, lineY - 64, PHASES[0].label, { ...TXT(15, CSS.gold), ...plate })).setOrigin(0.5);
    this.geo.labels = lineY - 64;
    // Controls: − servers +, each button naming its key (finding 11: the keys were only spoken), laid out by width.
    const by = top + stageH - 24;
    this.geo.by = by;
    this.minusBtn = this.pxButton(0, by, RUSH_BUTTONS.remove, () => this.remove(), PAL.chip, PAL.ink);
    this.serversText = crisp(this.add.text(col.cx, by, `Servers ${RUSH.maxServers}/${RUSH.maxServers}`, TXT(15, PAL.ink))).setOrigin(0.5);
    this.plusBtn = this.pxButton(0, by, RUSH_BUTTONS.add, () => this.add1(), PAL.accent, PAL.accentInk);
    const gapX = 14;
    const [mw, pw, tw] = [this.minusBtn.width, this.plusBtn.width, this.serversText.width];
    if (mw + tw + pw + gapX * 2 <= col.w - 16) {
      this.minusBtn.setX(Math.round(col.cx - tw / 2 - gapX - mw / 2));
      this.plusBtn.setX(Math.round(col.cx + tw / 2 + gapX + pw / 2));
    } else {
      // Narrow, or big text: the count over the two buttons.
      this.serversText.setY(Math.round(by - this.minusBtn.height / 2 - this.serversText.height / 2 - 6));
      this.minusBtn.setX(Math.round(col.cx - 6 - mw / 2));
      this.plusBtn.setX(Math.round(col.cx + 6 + pw / 2));
    }
    this.onKeys((key) => {
      // A key press shows on its button too (stageFx.pressLook), as a click does.
      if (key === '+' || key === '=' || key === 'ArrowUp' || key === 'ArrowRight') {
        pressLook(this, this.plusBtn);
        this.add1();
      } else if (key === '-' || key === '_' || key === 'ArrowDown' || key === 'ArrowLeft') {
        pressLook(this, this.minusBtn);
        this.remove();
      }
    });
    this.time.addEvent({ delay: this.tickMs, loop: true, callback: () => this.second() });
    this.draw();
  }

  /** A frame round the slot a press changed: the new server starting, or the one turned off. */
  private popSlot(i: number) {
    const slot = this.slots[i];
    if (slot) answerPop(this, slot.x, slot.y, slot.w, slot.h, null);
  }

  private add1() {
    if (this.over) return;
    if (!addServer(this.s)) return (this.miss(), this.floater(this.geo.mid, this.geo.by - 32, 'the factory is full', FEEDBACK.wrong));
    sfx('pop', { own: true });
    this.draw();
    this.popSlot(serverCount(this.s) - 1);
    this.speak(`Servers ${serverCount(this.s)} of ${RUSH.maxServers}. Line ${this.s.queue}.`);
  }

  private remove() {
    if (this.over) return;
    if (!removeServer(this.s)) return (this.miss(), this.floater(this.geo.mid, this.geo.by - 32, 'keep one server on', FEEDBACK.wrong));
    sfx('whoosh', { own: true });
    this.draw();
    this.popSlot(serverCount(this.s));
    this.speak(`Servers ${serverCount(this.s)} of ${RUSH.maxServers}. Line ${this.s.queue}.`);
  }

  /** One second of the day. */
  private second() {
    if (this.over) return;
    const r = tick(this.s, arrivals(this.s.t));
    this.addScore(r.points, 'none');
    const parts = [`+${r.served * RUSH.servedPts} served`];
    if (r.idle) parts.push(`−${r.idle * RUSH.idleCost} idle`);
    if (r.long) parts.push(`−${RUSH.longCost} line`);
    if (r.lost) parts.push(`−${r.lost * RUSH.lostCost} left`);
    this.ticker.setText(parts.join(' ')).setColor(r.points > 0 ? FEEDBACK.right : r.points < 0 ? FEEDBACK.wrong : PAL.ink);
    const { fx, left, mid, groundY, top } = this.geo;
    const lx = (left + fx) / 2;
    const phase = phaseAt(this.s.t);
    if (phase !== this.phase) {
      this.phase = phase;
      const p = PHASES.find((x) => x.id === phase)!;
      this.phaseText.setText(p.label);
      this.floater(mid, (top + groundY) / 2, p.label, CSS.gold);
      this.speak(`${p.label}. Line ${this.s.queue}, servers ${serverCount(this.s)}.`);
      sfx('pop', { soft: true });
    }
    if (r.long && !this.wasLong) {
      this.floater(lx, this.geo.labels - 30, 'Line too long! Press +', FEEDBACK.wrong);
      this.speak(`The line is too long: ${this.s.queue} waiting. Press + to add a server.`);
      sfx('wrong', { soft: true });
    }
    if (r.lost) this.floater(lx, this.geo.labels - 56, `${r.lost} gave up and left`, FEEDBACK.wrong);
    const idle = r.idle >= 2;
    if (idle && !this.wasIdle) {
      this.floater((fx + this.geo.right) / 2, groundY - 30 * this.geo.k, '💤 idle servers still cost money', FEEDBACK.note);
      this.speak(`${r.idle} servers sit idle, and idle servers still cost money. Press − to turn one off.`);
    }
    this.wasLong = r.long;
    this.wasIdle = idle;
    this.draw(r.served);
  }

  private draw(served = 0) {
    const s = this.s;
    const busy = Math.min(s.ready, Math.ceil(served / RUSH.perServer));
    this.slots.forEach((slot, i) => {
      const state = i < busy ? 'busy' : i < s.ready ? 'idle' : i < s.ready + s.booting.length ? 'boot' : 'off';
      const lit = state === 'busy' ? COLOR.good : state === 'boot' ? (s.t % 2 ? COLOR.warn : COLOR.panelHi) : state === 'idle' ? COLOR.muted : COLOR.panelHi;
      slot.leds.forEach((l, k) => l.setFillStyle(state === 'busy' && (s.t + k) % 3 === 0 ? COLOR.goodInk : lit));
      slot.body.setFillStyle(state === 'off' ? COLOR.bgDeep : COLOR.bg);
      slot.label.setText(this.words[state]).setColor(state === 'busy' ? PAL.good : state === 'boot' ? CSS.warn : PAL.muted);
    });
    this.line.forEach((sp, i) => sp.setVisible(i < s.queue));
    // An empty label would still show its plate: hide it until the line outgrows the drawn customers.
    this.moreText.setText(s.queue > SHOWN ? `+${s.queue - SHOWN}` : '').setVisible(s.queue > SHOWN);
    const long = s.queue >= RUSH.longQueue;
    this.lineText.setText(`Line: ${s.queue}`).setColor(long ? FEEDBACK.wrong : PAL.ink);
    this.serversText.setText(`Servers ${serverCount(s)}/${RUSH.maxServers}`);
    const want = busy ? 'ec2:hammer:SE' : 'ec2:idle:SE';
    if (this.eddie.anims.currentAnim?.key !== want) this.eddie.play(want);
    this.sky.setFillStyle(SKY[this.phase]);
    // the sun climbs to noon, then sets; in the evening it's the moon
    const t = s.t / RUSH.seconds;
    const span = this.geo.fx - this.geo.left;
    this.sun.setPosition(this.geo.left + span * (0.18 + 0.68 * t), this.geo.top + (40 - Math.sin(Math.PI * t) * 10) * this.geo.k).setFillStyle(this.phase === 'evening' ? COLOR.inkHi : 0xfde047);
  }

  protected lesson() {
    // One line a kid can read. Launch templates, health checks and scaling policies are in the EC2 flashcards.
    const st = this.s.stats;
    return `${'⭐'.repeat(rushStars(st))} ${rushVerdict(st)} ${RUSH_LESSON}`;
  }
}
