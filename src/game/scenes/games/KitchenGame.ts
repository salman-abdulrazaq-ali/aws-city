import Phaser from 'phaser';
import { FRAME_H, FRAME_W, PIVOT } from '../../assets';
import { FEEDBACK, MiniGame, pace, PAL, TXT } from './MiniGame';
import { crisp } from '../../SpeechBubble';
import { invokeChef, STALL, type ChefState } from './foodStall';
import { COLOR, CSS } from '../../theme';
import { reducedMotion } from '../../motion';
import { PILL, POINTS, SWING, swingReady } from './scoring';
import { answerPop } from './stageFx';

interface Order {
  t: Phaser.GameObjects.Text;
  born: number;
  source: string;
}
interface Chef extends ChefState {
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
}

const SOURCES = ['📸 S3 upload', '🌐 API request', '📬 SQS message', '⏰ EventBridge', '🔔 SNS alert'];
const { maxConcurrency: MAX_CONCURRENCY, timeoutMs: TIMEOUT_MS, idleBillMs: IDLE_BILL_MS } = STALL;

/**
 * Lambda Food Stall: event orders arrive; click one to invoke. A free warm chef serves fast; otherwise a
 * cold chef needs a cold start. Max 4 concurrent chefs; orders time out. Buy provisioned concurrency.
 * Rules: src/game/scenes/games/foodStall.ts. A served order is a right call; a throttled invoke, an expired order and a
 * Space press with no order waiting are wrong ones, so mashing Space doesn't win.
 */
export class KitchenGame extends MiniGame {
  private orders: Order[] = [];
  private chefs: Chef[] = [];
  private coins = 0;
  private coinText!: Phaser.GameObjects.Text;
  /** Where the order tickets stack (the chalkboard). */
  private board = { x: 0, y: 0, rows: 8 };
  /** The row of controls (provision button and coins). */
  private controlsY = 0;

  constructor() {
    super('game:lambda', 'lambda', 'lambda', '🍳 Lambda Food Stall — click an order (or Space) to invoke a chef before it expires');
    this.duration = 50;
  }

  protected setup() {
    this.orders = [];
    this.chefs = [];
    this.coins = 0;
    this.lastSwing = -Infinity;
    const { width: w, height: h } = this.scale;
    const top = this.top;
    const floorY = Math.round(h * 0.74);
    // The wall, awning and floor fill the canvas; the stall itself (board, counter, chefs) sits in a centred column.
    const col = this.column();
    const g = this.add.graphics();
    // back wall: bricks
    g.fillStyle(0x5b2c2c, 1).fillRect(0, 0, w, floorY);
    for (let y = top, row = 0; y < floorY; y += 12, row++)
      for (let x = (row % 2) * -14; x < w; x += 28) g.fillStyle(row % 3 ? 0x6b3434 : 0x733a3a, 1).fillRect(x + 1, y + 1, 26, 10);
    // awning: orange and white stripes with a scalloped edge
    const aw = top + 4;
    for (let i = 0, n = Math.ceil(w / 32); i < n; i++) {
      g.fillStyle(i % 2 ? 0xffffff : 0xed7100, 1).fillRect(i * 32, aw, 32, 22);
      g.fillStyle(i % 2 ? 0xffffff : 0xed7100, 1).fillRect(i * 32 + 4, aw + 22, 24, 6);
    }
    g.fillStyle(0x000000, 0.25).fillRect(0, aw + 28, w, 4);
    // floor: checker tiles
    for (let y = floorY, r = 0; y < h; y += 20, r++) for (let x = 0, c = 0; x < w; x += 20, c++) g.fillStyle((r + c) % 2 ? 0x3f2a1d : 0x4a3222, 1).fillRect(x, y, 20, 20);
    // chalkboard of incoming events
    const bx = col.x + 10;
    const by = aw + 42;
    const bw = Math.min(210, Math.round(col.w * 0.38));
    const bh = floorY - by - 8;
    g.fillStyle(0x8b5a2b, 1).fillRect(bx, by, bw, bh);
    g.fillStyle(0x1f3b2d, 1).fillRect(bx + 5, by + 5, bw - 10, bh - 10);
    crisp(this.add.text(bx + bw / 2, by + 16, 'ORDERS · events', TXT(14, CSS.ink))).setOrigin(0.5);
    this.board = { x: bx + 12, y: by + 32, rows: Math.max(3, Math.min(8, Math.floor((bh - 40) / 26))) };
    // counter + stoves for the chefs, under a hanging λ sign and lamps
    const left = bx + bw + 24;
    const right = col.r;
    const counterY = floorY - 4;
    // Chefs grow with the stage so the full tab isn't a wall of empty bricks, but never wider than their spot at the
    // counter (a chef is about 30 px wide at 1×), so four never overlap on the narrow panel.
    const spot = (right - left - 16) / MAX_CONCURRENCY;
    // Whole numbers only: at 1.5× the pixel art drops pixels.
    const chefScale = Phaser.Math.Clamp(Math.floor(Math.min(h / 260, spot / 30)), 1, 3);
    const signX = left + (right - left) / 2;
    const signY = aw + 60;
    for (let i = 0; i < MAX_CONCURRENCY; i++) {
      const x = left + ((i + 0.5) * (right - left - 16)) / MAX_CONCURRENCY;
      g.fillStyle(0x000000, 1).fillRect(x - 1, aw + 32, 2, 24);
      g.fillStyle(0xfde047, 1).fillRect(x - 7, aw + 56, 14, 6);
      g.fillStyle(0xfde047, 0.08).fillTriangle(x, aw + 62, x - 40, counterY, x + 40, counterY);
    }
    // The sign hangs in front of the lamps' wires.
    g.fillStyle(0x000000, 1).fillRect(signX - 1, aw + 32, 2, signY - aw - 50);
    g.fillStyle(0x000000, 1).fillRect(signX - 46, signY - 20, 92, 40);
    g.fillStyle(0xed7100, 1).fillRect(signX - 44, signY - 18, 88, 36);
    crisp(this.add.text(signX, signY, 'λ  STALL', TXT(20, PAL.ink))).setOrigin(0.5);
    g.fillStyle(0x000000, 1).fillRect(left - 8, counterY - 2, right - left, 30);
    g.fillStyle(0x9a6b3e, 1).fillRect(left - 8, counterY, right - left, 26);
    g.fillStyle(0xb57f4a, 1).fillRect(left - 8, counterY, right - left, 5);
    for (let i = 0; i < MAX_CONCURRENCY; i++) {
      const x = left + ((i + 0.5) * (right - left - 16)) / MAX_CONCURRENCY;
      g.fillStyle(COLOR.panelHi, 1).fillRect(x - 20, counterY - 8, 40, 8);
      g.fillStyle(COLOR.bgDeep, 1).fillRect(x - 14, counterY - 12, 28, 4);
      const sprite = this.add.sprite(x, counterY - 6, 'char:lambda', 0).setOrigin(PIVOT.x / FRAME_W, PIVOT.y / FRAME_H).setScale(chefScale).setAlpha(0.45);
      sprite.play('lambda:idle:SE');
      // On the narrow panel the labels ("provisioned") are wider than a chef's spot: every other one sits a row lower.
      const label = crisp(this.add.text(x, counterY + 34 + (spot < 80 ? (i % 2) * 18 : 0), 'cold', { ...TXT(14, CSS.info), backgroundColor: PILL, padding: { x: 5, y: 1 } })).setOrigin(0.5, 0);
      this.chefs.push({ sprite, label, busyUntil: 0, warmUntil: 0, provisioned: false });
    }
    // The controls sit on the floor just under the chefs' labels, not at the far bottom of a tall view.
    this.controlsY = Math.min(h - 20, counterY + (spot < 80 ? 100 : 84));
    this.coinText = crisp(this.add.text(col.r - 12, this.controlsY, '', { ...TXT(16, CSS.gold), backgroundColor: PILL, padding: { x: 6, y: 2 } })).setOrigin(1, 0.5);
    this.pxButton(col.x + Math.min(150, col.w / 2 - 10), this.controlsY, '+ Provisioned (P) · $5', () => this.provision(), COLOR.good, PAL.paperInk);
    // Keyboard: Space serves the oldest order (once per cooldown; with none waiting it costs), P buys an always-warm chef.
    this.onKeys((k) => {
      if (k === ' ') this.swing();
      else if (k === 'p' || k === 'P') this.provision();
    });
    this.time.addEvent({ delay: pace(STALL.spawnMs), loop: true, callback: () => !this.over && this.spawn() });
    // Provisioned concurrency is billed while it waits, not only while it cooks: each idle provisioned chef costs a
    // coin every few seconds, and goes back to on-demand when the coins run out.
    this.time.addEvent({ delay: pace(IDLE_BILL_MS), loop: true, callback: () => !this.over && this.billIdle() });
  }

  private spawn() {
    if (this.orders.length >= this.board.rows) return;
    const source = SOURCES[Math.floor(Math.random() * SOURCES.length)];
    const t = crisp(this.add.text(this.board.x, 0, source, { ...TXT(15, PAL.paperInk), backgroundColor: CSS.paper, padding: { x: 6, y: 3 } })).setInteractive({ useHandCursor: true });
    const o: Order = { t, born: this.time.now, source };
    t.on('pointerdown', () => this.invoke(o));
    this.orders.push(o);
    this.layout();
    // Each order is said as it comes in (the board is only drawn), with how many wait.
    this.speak(`New order: ${source}. ${this.orders.length} waiting.`, true);
  }

  /** When Space last swung (one swing per SWING.cooldownMs). */
  private lastSwing = -Infinity;

  /** Space: invoke the oldest order. With none waiting it's a wasted call (src/game/scenes/games/scoring.ts). */
  private swing() {
    const now = this.time.now;
    if (this.over || !swingReady(this.lastSwing, now)) return;
    this.lastSwing = now;
    if (this.orders[0]) return this.invoke(this.orders[0]);
    this.wrong();
    this.addScore(SWING.blank);
    this.floater(this.board.x + 80, this.board.y + 10, `no order waiting ${SWING.blank}`, FEEDBACK.wrong);
    this.speak('No order waiting.');
  }

  private layout() {
    this.orders.forEach((o, i) => o.t.setY(this.board.y + i * 26));
  }

  private invoke(o: Order) {
    if (this.over) return;
    const run = invokeChef(this.chefs, this.time.now);
    if (!run) {
      // Every chef is busy: the call is throttled (max concurrency), and a throttled call costs.
      this.wrong();
      this.addScore(POINTS.lambda.throttled);
      this.floater(o.t.x + 80, o.t.y, `throttled! (max concurrency) ${POINTS.lambda.throttled}`, FEEDBACK.wrong);
      answerPop(this, o.t.x + o.t.width / 2, o.t.y + o.t.height / 2, o.t.width, o.t.height, false, 40);
      this.speak('Throttled: every chef is busy.');
      return;
    }
    const { chef, cold, ms: dur } = run;
    chef.sprite.setAlpha(1).play('lambda:cook:SE');
    chef.label.setText(cold ? 'cold start…' : 'cooking').setColor(cold ? CSS.info : CSS.gold);
    this.orders = this.orders.filter((x) => x !== o);
    // The ticket goes to the chef who takes it: a Space press shows where it went (no pointer there).
    o.t.disableInteractive();
    if (reducedMotion()) o.t.destroy();
    else this.tweens.add({ targets: o.t, x: chef.sprite.x - o.t.width / 2, y: chef.sprite.y - chef.sprite.displayHeight * 0.6, scale: 0.6, alpha: 0.4, duration: 220, ease: 'Quad.easeIn', onComplete: () => o.t.destroy() });
    this.layout();
    this.speak(cold ? `${o.source}: a cold chef, so a cold start first.` : `${o.source}: a warm chef is cooking.`);
    this.time.delayedCall(dur, () => {
      if (this.over) return;
      const waited = this.time.now - o.born;
      if (waited > pace(TIMEOUT_MS)) {
        this.wrong();
        this.addScore(POINTS.lambda.expired, 'soft');
        this.floater(chef.sprite.x, chef.sprite.y - chef.sprite.displayHeight * 0.85, 'order expired', FEEDBACK.wrong);
        this.popChef(chef, false);
        this.speak(`${o.source} expired before it was served. Score ${this.score}.`);
      } else {
        this.hit();
        this.addScore(cold ? POINTS.lambda.cold : POINTS.lambda.warm, 'soft');
        this.coins++;
        this.floater(chef.sprite.x, chef.sprite.y - chef.sprite.displayHeight * 0.85, cold ? `+${POINTS.lambda.cold} (cold)` : `+${POINTS.lambda.warm}`, FEEDBACK.right);
        this.popChef(chef, true);
        this.speak(`Served ${o.source}, plus ${cold ? POINTS.lambda.cold : POINTS.lambda.warm}. Score ${this.score}.`);
      }
      chef.sprite.play('lambda:idle:SE');
    });
  }

  /** A served (or expired) order shows on the chef who cooked it. */
  private popChef(chef: Chef, ok: boolean) {
    const { x, y, displayWidth: dw, displayHeight: dh } = chef.sprite;
    answerPop(this, x, y - dh * 0.45, dw * 0.6, dh * 0.8, ok, 40);
  }

  private billIdle() {
    const now = this.time.now;
    for (const c of this.chefs) {
      if (!c.provisioned || c.busyUntil > now) continue;
      const y = c.sprite.y - c.sprite.displayHeight * 0.85;
      if (this.coins > 0) {
        this.coins--;
        this.floater(c.sprite.x, y, '−$1 idle', CSS.gold);
      } else {
        c.provisioned = false;
        this.floater(c.sprite.x, y, 'released: no coins', FEEDBACK.note);
        this.speak('A provisioned chef went back to on demand: no budget left.');
      }
    }
  }

  private provision() {
    if (this.over) return;
    const c = this.chefs.find((x) => !x.provisioned);
    if (!c || this.coins < 5) {
      this.speak(c ? `A provisioned chef costs $5; your budget is $${this.coins}.` : 'Every chef is provisioned already.');
      return this.floater(this.scale.width / 2, this.controlsY - 28, 'need $5', FEEDBACK.wrong);
    }
    this.coins -= 5;
    c.provisioned = true;
    this.floater(c.sprite.x, c.sprite.y - c.sprite.displayHeight * 0.85, 'always warm!', CSS.gold);
    this.speak(`One chef is provisioned: always warm. Budget $${this.coins}.`);
  }

  override update(t: number, dt: number) {
    super.update(t, dt);
    if (this.over) return;
    const now = this.time.now;
    for (const c of this.chefs) {
      if (c.busyUntil > now) continue;
      const warm = c.provisioned || c.warmUntil > now;
      c.sprite.setAlpha(warm ? 1 : 0.45);
      c.label.setText(c.provisioned ? 'provisioned' : warm ? 'warm' : 'cold').setColor(warm ? CSS.good : CSS.info);
    }
    for (const o of [...this.orders]) {
      if (now - o.born > pace(TIMEOUT_MS)) {
        this.orders = this.orders.filter((x) => x !== o);
        o.t.destroy();
        this.wrong();
        this.addScore(POINTS.lambda.expired, 'soft');
        this.layout();
        this.speak(`${o.source} waited too long and expired. Score ${this.score}.`);
      } else if (now - o.born > pace(TIMEOUT_MS) * 0.6) o.t.setBackgroundColor(CSS.badInk);
    }
    this.coinText?.setText(`Budget $${this.coins}`);
  }

  protected lesson() {
    // One line a kid can read. Cold starts, throttling and the 15-minute limit are in the Lambda flashcards.
    return 'Lola only cooks when an order comes in, so an empty stall costs nothing. Always-warm (provisioned) chefs cost money even while they wait.';
  }
}
