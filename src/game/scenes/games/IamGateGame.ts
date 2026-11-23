import Phaser from 'phaser';
import { FEEDBACK, MiniGame, pace, PAL, TXT } from './MiniGame';
import { POINTS } from './scoring';
import { reducedMotion } from '../../motion';
import { crisp } from '../../SpeechBubble';
import { hasSprite, spriteAnchor } from '../../assets';
import { COLOR, CSS } from '../../theme';
import { IAM_GATE } from '@/world/minigames';
import { act, cast, districtColor, fitScale, landmarkFrame, person, prop } from './cast';

type Req = { text: string; allow: boolean; why: string };

/** How far back a requester starts and how far they walk on, at 1× (px). */
const WALK = { dx: 28, dy: 26 };
/** A requester's walk up to the boom and away again, ms. */
const WALK_MS = 260;
const LEAVE_MS = 620;

/**
 * Permission Gate (IAM): a security checkpoint in Security Keep red. The role's policy is pinned on a paper notice board
 * in front of the IAM landmark; requesters (citizens) walk up to the boom one by one, each holding the request as a
 * ticket. Allow (A, or the left button) only what a statement allows: the boom lifts and they walk through. Deny (D,
 * or the right button) everything else, and anything an explicit Deny names: they turn back. Each answer says why; a new
 * role (and policy) every few requests. A wrong call costs more than a right one pays, so always pressing Deny doesn't
 * win (src/game/scenes/games/scoring.ts).
 */
export class IamGateGame extends MiniGame {
  private wave = 0;
  private queue: Req[] = [];
  private card?: Phaser.GameObjects.Text;
  private current?: Req;
  private policyText?: Phaser.GameObjects.Text;
  private roleText?: Phaser.GameObjects.Text;
  private right = 0;
  private timer?: Phaser.Time.TimerEvent;
  /** The play group's whole-number scale: 1 in the side panel, 2 in the tab. */
  private s = 1;
  /** Where a requester stands at the gate (feet), and the boom's pivot on the left post. */
  private gate = { x: 0, y: 0 };
  private boom?: Phaser.GameObjects.Container;
  /** The requester at the gate now, and the round's crowd (a different one each round). */
  private visitor?: Phaser.GameObjects.Sprite;
  private crowd: string[] = [];
  private met = 0;
  /** Under the boom: where the verdict hangs, between the request and the buttons. */
  private verdictY = 0;

  constructor() {
    super('game:iamgate', 'iamgate', 'iam', '🛂 Permission Gate — A or ← allows, D or → denies: only what the policy allows gets through');
  }

  protected setup() {
    this.wave = 0;
    this.right = 0;
    this.met = 0;
    this.visitor = undefined;
    this.crowd = cast(8);
    const { width: w, height: h } = this.scale;
    const red = districtColor('iam');
    const cw = Math.min(w, 760);
    // Top-down in a centred column (MiniGame.column): the notice board with the role and its policy (as tall as the
    // longest one, so the gate never moves between roles), the checkpoint (the IAM landmark behind, the boom, IAM's
    // agent checking), the request at the gate as a ticket, a lane for the verdict, then the two buttons.
    const boardW = Math.min(cw - 32, 560);
    const roleStyle = { ...TXT(18, PAL.paperInk), align: 'center', wordWrap: { width: boardW - 24 } } as const;
    const policyStyle = { ...TXT(16, PAL.paperInk), lineSpacing: 3, wordWrap: { width: boardW - 24 } };
    const ticketStyle = { ...TXT(18, PAL.paperInk), backgroundColor: CSS.paper, padding: { x: 12, y: 8 }, align: 'center', wordWrap: { width: Math.min(w - 40, 480) } } as const;
    const verdictStyle = { ...TXT(16, PAL.ink), padding: { x: 10, y: 5 }, wordWrap: { width: Math.min(w - 32, 520) } };
    const probe = this.add.text(0, 0, '');
    const tallest = (style: Phaser.Types.GameObjects.Text.TextStyle, texts: string[]) => (probe.setStyle(style), Math.max(...texts.map((t) => probe.setText(t).height)));
    const roleH = tallest(roleStyle, IAM_GATE.waves.map((wv) => `Role: ${wv.role}`));
    const policyH = tallest(policyStyle, IAM_GATE.waves.map((wv) => this.policyLines(wv.policy)));
    const requests = IAM_GATE.waves.flatMap((wv) => wv.requests);
    const ticketH = tallest(ticketStyle, requests.map((r) => r.text));
    const verdictH = tallest(verdictStyle, requests.map((r) => `✗ Too slow. ${r.why}`));
    probe.destroy();
    const heading = crisp(this.add.text(0, 0, 'Policy', TXT(14, PAL.paperMeta))).setOrigin(0, 0);
    const boardH = 10 + roleH + 6 + heading.height + 2 + policyH + 12;
    // The checkpoint at 1×: a requester (54 px) at the gate, the boom and the ground in front of it.
    const yardNatural = 54 + 10 + 18;
    const fixed = boardH + 12 + ticketH + 6 + 8 + verdictH + 10 + 48;
    this.s = Math.min(fitScale(cw, 380), fitScale(h - this.top - fixed, yardNatural));
    const s = this.s;
    const yardH = ticketH + 6 + 54 * s + 10 * s + 18 * s;
    const col = this.column(boardH + 12 + yardH + 8 + verdictH + 10 + 48);
    const boardTop = col.y + 4;
    const yardTop = boardTop + boardH + 12;
    this.gate = { x: col.cx, y: yardTop + ticketH + 6 + 54 * s };
    const boomY = this.gate.y + 6 * s;
    this.verdictY = boomY + 18 * s;
    this.cardAt = yardTop + ticketH / 2;
    // The ground: graphite flagstones with a Security Keep red runner up to the gate, and a back wall behind the board.
    const g = this.add.graphics();
    g.fillStyle(PAL.bg, 1).fillRect(0, this.top, w, h - this.top);
    g.fillStyle(COLOR.panel, 1).fillRect(0, this.top, w, yardTop + 10 * s - this.top);
    g.fillStyle(red, 0.6).fillRect(0, yardTop + 10 * s - 3 * s, w, 3 * s);
    for (let y = yardTop + 10 * s, row = 0; y < h; y += 12 * s, row++)
      for (let x = (row % 2) * -12 * s; x < w; x += 24 * s) g.fillStyle(row % 2 ? COLOR.bgDeep : PAL.line, 1).fillRect(x + s, y + s, 22 * s, 10 * s);
    const runW = 44 * s;
    g.fillStyle(red, 0.22).fillRect(col.cx - runW / 2, yardTop + 10 * s, runW, h - yardTop);
    // The IAM landmark behind the gate (right of the lane), at the play scale or the highest level that fits under the board.
    const lm = this.landmarkThatFits(this.gate.y - 10 * s - boardTop);
    // Half the gate's width: room is left outside the right post for IAM's agent, inside the column.
    const half = Math.min(200, col.w / 2 - 24 - 30 * s);
    if (lm) {
      const a = spriteAnchor(lm)!;
      const ls = Math.max(1, Math.min(s, Math.floor((this.gate.y - 10 * s - boardTop) / a.h)));
      prop(this, lm, Math.min(col.r - 50 * ls, col.cx + half * 0.6), this.gate.y - 10 * s - (a.h - a.ay) * ls, ls).setDepth(2);
    }
    if (col.x > 40 * s && hasSprite('deco:banner-security')) {
      prop(this, 'deco:banner-security', col.x - 22 * s, yardTop - 10 * s, s).setDepth(2);
      prop(this, 'deco:banner-security', col.r + 4 * s, yardTop - 10 * s, s).setDepth(2);
    }
    // The notice board: paper on a black pixel border and shadow, red pins, the role as its title, "Policy", the rules.
    const bx = col.cx - boardW / 2;
    g.fillStyle(PAL.black, 1).fillRect(bx + 4, boardTop + 4, boardW, boardH);
    const board = this.add.graphics().setDepth(5);
    board.fillStyle(PAL.black, 1).fillRect(bx - 3, boardTop - 3, boardW + 6, boardH + 6);
    board.fillStyle(PAL.paper, 1).fillRect(bx, boardTop, boardW, boardH);
    for (const px of [bx + 10, bx + boardW - 16]) board.fillStyle(red, 1).fillRect(px, boardTop + 4, 6, 6);
    this.roleText = crisp(this.add.text(col.cx, boardTop + 10, '', roleStyle)).setOrigin(0.5, 0).setDepth(6);
    heading.setPosition(bx + 12, boardTop + 10 + roleH + 6).setDepth(6);
    this.policyText = crisp(this.add.text(bx + 12, heading.y + heading.height + 2, '', policyStyle)).setDepth(6);
    // The gate: two posts, a red-and-white boom pivoting on the left one, and IAM's agent checking at the right post.
    const postW = 6 * s;
    const postTop = boomY - 30 * s;
    g.fillStyle(PAL.black, 1).fillRect(col.cx - half - postW - 2, postTop - 2, postW + 4, boomY - postTop + 12 * s);
    g.fillStyle(COLOR.panelHi, 1).fillRect(col.cx - half - postW, postTop, postW, boomY - postTop + 10 * s);
    const post = this.add.graphics().setDepth(30);
    post.fillStyle(PAL.black, 1).fillRect(col.cx + half - 2, postTop - 2, postW + 4, boomY - postTop + 12 * s);
    post.fillStyle(COLOR.panelHi, 1).fillRect(col.cx + half, postTop, postW, boomY - postTop + 10 * s);
    const bh = 4 + 4 * s;
    const len = half * 2;
    const bar: Phaser.GameObjects.Rectangle[] = [this.add.rectangle(0, 0, len, bh, PAL.black).setOrigin(0, 0.5)];
    for (let x = 0, i = 0; x < len; x += 12 * s, i++) bar.push(this.add.rectangle(x + 1, 0, Math.min(12 * s, len - x) - 2, bh - 4, i % 2 ? COLOR.inkHi : red).setOrigin(0, 0.5));
    this.boom = this.add.container(col.cx - half - postW / 2, boomY, bar).setDepth(31);
    person(this, 'iam', col.cx + half + postW + 14 * s, boomY + 4 * s, s, 'check', 'SW').setDepth(29);
    // The verdict's lane, then the buttons, laid out by their measured width so bigger text never makes them overlap.
    const by = this.verdictY + verdictH + 10 + 22;
    const allowBtn = this.pxButton(0, by, '✅ Allow (A)', () => this.answer(true), COLOR.good);
    const denyBtn = this.pxButton(0, by, '⛔ Deny (D)', () => this.answer(false), COLOR.bad);
    const apart = Math.max(90, Math.max(allowBtn.width, denyBtn.width) / 2 + 10);
    allowBtn.setX(col.cx - apart);
    denyBtn.setX(col.cx + apart);
    this.onKeys((k) => {
      if (k === 'a' || k === 'A' || k === 'ArrowLeft') this.answer(true);
      if (k === 'd' || k === 'D' || k === 'ArrowRight') this.answer(false);
    });
    this.nextWave();
  }

  /** The IAM landmark at its level in this city, or a lower level when that one is taller than `room` at 1×. */
  private landmarkThatFits(room: number) {
    const f = landmarkFrame('iam');
    if (!f) return undefined;
    for (let t = Number(f.split(':')[2]); t >= 1; t--) {
      const name = `lm:iam:${t}`;
      const a = spriteAnchor(name);
      if (a && a.h <= room) return name;
    }
    return undefined;
  }

  private nextWave() {
    const wv = IAM_GATE.waves[this.wave % IAM_GATE.waves.length];
    this.wave++;
    this.roleText?.setText(`Role: ${wv.role}`);
    this.policyText?.setText(this.policyLines(wv.policy));
    this.speak(`New role: ${wv.role}. Its policy: ${wv.policy.join('. ')}.`, true);
    this.queue = [...wv.requests].sort(() => Math.random() - 0.5);
    this.next();
  }

  private next() {
    if (this.over) return;
    if (!this.queue.length) return this.nextWave();
    this.current = this.queue.shift()!;
    this.speak(`Request: ${this.current.text}. A allows, D denies.`, true);
    const { width: w } = this.scale;
    this.card?.destroy();
    const y = this.cardAt;
    // The request is a paper ticket held up at the gate: always in the same place, over the requester's head.
    this.card = crisp(
      this.add.text(w / 2, y, this.current.text, { ...TXT(18, PAL.paperInk), backgroundColor: CSS.paper, padding: { x: 12, y: 8 }, align: 'center', wordWrap: { width: Math.min(w - 40, 480) } }),
    )
      .setOrigin(0.5)
      .setDepth(40);
    this.walkUp();
    if (!reducedMotion()) {
      this.card.setAlpha(0).setY(y - 20);
      this.tweens.add({ targets: this.card, alpha: 1, y, duration: 160 });
    }
    // Too slow counts as a wrong answer: the queue at the gate doesn't wait forever.
    this.timer?.remove();
    this.timer = this.time.delayedCall(pace(Math.max(2600, 5200 - this.wave * 400)), () => this.answer(undefined));
  }

  /** The next citizen in the round's crowd walks the last steps up to the boom (they're simply there under reduced motion). */
  private walkUp() {
    const s = this.s;
    const sheet = this.crowd[this.met++ % this.crowd.length];
    const { x, y } = this.gate;
    const v = person(this, sheet, x, y, s, 'idle', 'SE').setDepth(20);
    this.visitor = v;
    if (reducedMotion()) return;
    act(v, 'walk', 'SE');
    v.setPosition(x - WALK.dx * s, y - WALK.dy * s);
    this.tweens.add({ targets: v, x, y, duration: WALK_MS, onComplete: () => v.active && act(v, 'idle', 'SE') });
  }

  /** Allowed: the boom lifts and they walk through. Denied (or too slow): the boom stays down and they turn back. */
  private send(through: boolean) {
    const v = this.visitor;
    this.visitor = undefined;
    if (!v) return;
    const s = this.s;
    if (reducedMotion()) {
      this.boom?.setRotation(through ? -Math.PI * 0.45 : 0);
      if (through) this.time.delayedCall(pace(600), () => this.boom?.setRotation(0));
      return void this.time.delayedCall(pace(300), () => v.destroy());
    }
    // A lift still running from the last request ends first, so the boom always starts down.
    if (this.boom) this.tweens.killTweensOf(this.boom.setRotation(0));
    if (through && this.boom) this.tweens.add({ targets: this.boom, rotation: -Math.PI * 0.45, duration: 160, yoyo: true, hold: pace(380) });
    act(v, 'walk', through ? 'SE' : 'NW');
    this.tweens.add({
      targets: v,
      x: v.x + (through ? WALK.dx : -WALK.dx) * s,
      y: v.y + (through ? 2 * WALK.dy : -WALK.dy) * s,
      alpha: 0,
      delay: through ? 120 : 0,
      duration: LEAVE_MS,
      onComplete: () => v.destroy(),
    });
    if (through) v.setDepth(32);
  }

  private answer(allow: boolean | undefined) {
    if (this.over || !this.current) return;
    this.timer?.remove();
    const c = this.current;
    this.current = undefined;
    this.send(allow === true);
    // The verdict hangs under the boom, between the request ticket and the buttons: never on the next request.
    const x = this.scale.width / 2;
    const y = this.verdictY;
    if (allow === c.allow) {
      this.right++;
      this.hit();
      this.addScore(POINTS.iamgate.right);
      this.verdict(x, y, `✓ ${c.why}`, FEEDBACK.right, 0);
    } else {
      this.wrong();
      if (allow === undefined) this.addScore(POINTS.iamgate.slow, 'soft');
      else this.addScore(POINTS.iamgate.wrong);
      this.verdict(x, y, `✗ ${allow === undefined ? 'Too slow. ' : ''}${c.why}`, FEEDBACK.wrong, 0);
    }
    this.time.delayedCall(pace(650), () => this.next());
  }

  /** The request ticket's middle: at the gate, over the requester, under the tallest policy (setup). */
  private cardAt = 0;

  private policyLines(policy: string[]) {
    return policy.map((s) => `• ${s}`).join('\n');
  }

  protected lesson() {
    return `${this.right} right at the gate. ${IAM_GATE.lesson}`;
  }
}
