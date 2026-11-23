import Phaser from 'phaser';
import { FEEDBACK, MiniGame, pace, PAL, TXT } from './MiniGame';
import { POINTS } from './scoring';
import { reducedMotion } from '../../motion';
import { crisp } from '../../SpeechBubble';
import { CITY_ATLAS, hasSprite, spriteAnchor } from '../../assets';
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
 * The checkpoint's props (art/tiles/games_art.py) at 1×, px: a post (8 wide, 40 tall) at each end of the boom; the
 * striped arm, its anchor the pivot on the left post, reaching `reach` to rest on the right one; the notice board's
 * frame, a 9-slice `rim` wide (10 px slices) round the paper; the guard's booth by the right post.
 */
const GATE = { post: 'game:iamgate:post', arm: 'game:iamgate:arm', reach: 152, postW: 8, booth: 'game:iamgate:booth' };
const BOARD = { frame: 'game:iamgate:board', rim: 6, slice: 10 };
/** The board's black shadow hangs this far under its frame, px; the lifted boom keeps CLEAR px (at 1×) more from it. */
const SHADOW = 4;
const CLEAR = 3;

/** The boom's lift for an Allow: 81°, a little short of upright. */
export const LIFT = -Math.PI * 0.45;

/** The boom's bar about its pivot, px: `x0`..`x1` along it (its far end at x1), `y0`..`y1` across it. */
export interface Bar {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** The bar turned by `angle` (0 down, LIFT up) about its pivot: its bounding box, px from the pivot (pure). */
export function turnedBox(bar: Bar, angle: number) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const x of [bar.x0, bar.x1])
    for (const y of [bar.y0, bar.y1]) {
      xs.push(x * cos - y * sin);
      ys.push(x * sin + y * cos);
    }
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/** How far above its pivot the bar reaches anywhere in its lift (from down to LIFT), px, rounded up (pure). */
export function liftReach(bar: Bar) {
  let top = 0;
  for (let i = 0; i <= 45; i++) top = Math.min(top, turnedBox(bar, (LIFT * i) / 45).top);
  return Math.ceil(-top);
}

/**
 * The yard's rows under the notice board (pure): from the bottom edge of the board's frame (`frame`), the back wall, the
 * request ticket (`ticketH`), the requester (54 px at 1×) at the boom, whose pivot is 6 px under their feet, and the
 * ground in front (`end`, 22 px under the pivot: the verdict's lane starts 18 px down). The wall is 9 px, or taller
 * when the boom's whole lift (`reach` px above its pivot, liftReach) would come within CLEAR px of the board's shadow,
 * so the arm never crosses the policy.
 */
export function gateRows(frame: number, ticketH: number, s: number, reach: number) {
  const pivot = ticketH + 6 + 60 * s;
  const yardTop = frame + Math.max(9, SHADOW + CLEAR * s + reach - pivot);
  return { yardTop, boomY: yardTop + pivot, end: yardTop + pivot + 22 * s };
}

/**
 * Permission Gate (IAM): a security checkpoint in Security Keep red. The role's policy is pinned on a paper notice board
 * in front of the IAM landmark; requesters (citizens) walk up to the boom one by one, each holding the request as a
 * ticket (the posts, the boom, the board's frame and the guard's booth are the art generator's, art/tiles/games_art.py).
 * Allow (A, or the left button) only what a statement allows: the boom lifts and they walk through. Deny (D,
 * or the right button) everything else, and anything an explicit Deny names: they turn back. Each answer says why; a new
 * role (and policy) every few requests. A wrong call costs more than a right one pays, so always pressing Deny doesn't
 * win (src/game/scenes/games/scoring.ts). The board hangs high enough on the back wall that the lifted boom never
 * crosses the policy (gateRows).
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
    // The board's frame is the generator's 9-slice when the renderer can draw one (WebGL), at the play scale.
    const framed = hasSprite(BOARD.frame) && this.game.renderer.type === Phaser.WEBGL;
    const sMax = fitScale(cw, 380);
    const boardW = framed ? sMax * Math.floor(Math.min(cw - 32, 560) / sMax) : Math.min(cw - 32, 560);
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
    const boardH0 = 10 + roleH + 6 + heading.height + 2 + policyH + 12;
    const boardH = framed ? sMax * Math.ceil(boardH0 / sMax) : boardH0;
    // The frame round the paper at scale k: the 9-slice's rim, else a 3 px border.
    const rimAt = (k: number) => (framed ? BOARD.rim * k : 3);
    // The boom at scale k: the generator's arm (its pivot to its rest `reach`) when the column has room for it with IAM's
    // agent outside the right post, else a drawn bar as long as the room; and how far its whole lift reaches up.
    const arm = spriteAnchor(GATE.arm);
    const boomAt = (k: number) => {
      const room = cw / 2 - 24 - 30 * k;
      const armed = !!arm && hasSprite(GATE.post) && (GATE.reach / 2) * k <= room;
      const postW = (armed ? GATE.postW : 6) * k;
      const half = armed ? (GATE.reach / 2) * k - postW / 2 : Math.min(200, room);
      const bh = 4 + 4 * k;
      const bar: Bar = arm && armed ? { x0: -arm.ax * k, x1: (arm.w - arm.ax) * k, y0: -arm.ay * k, y1: (arm.h - arm.ay) * k } : { x0: 0, x1: half * 2, y0: -bh / 2, y1: bh / 2 };
      return { armed, postW, half, bh, reach: liftReach(bar) };
    };
    // The column at scale k: the board in its frame, the yard (gateRows: a back wall tall enough that the lifted boom
    // never crosses the board, the ticket, the requester at the boom), the verdict's lane and the buttons. The play scale
    // is the biggest whole number that fits (1 when none does).
    const contentAt = (k: number) => 2 * rimAt(k) + 1 + boardH + gateRows(0, ticketH, k, boomAt(k).reach).end + 8 + verdictH + 10 + 48;
    let k = fitScale(cw, 380);
    while (k > 1 && contentAt(k) > h - this.top) k--;
    this.s = k;
    const s = this.s;
    const boom = boomAt(s);
    const rim = rimAt(s);
    const col = this.column(contentAt(s));
    const boardTop = col.y + rim + 1;
    const rows = gateRows(boardTop + boardH + rim, ticketH, s, boom.reach);
    const yardTop = rows.yardTop;
    const boomY = rows.boomY;
    this.gate = { x: col.cx, y: boomY - 6 * s };
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
    // The IAM landmark behind the gate, at the play scale or the highest level that fits under the board: beside the
    // generator's narrower gate on the left (the guard's booth stands on the right), else right of the lane.
    const lm = this.landmarkThatFits(this.gate.y - 10 * s - boardTop);
    // Half the gate's width (boomAt): the generator's arm sets it, or the room inside the column for a drawn one.
    const { armed, postW, half } = boom;
    if (lm) {
      const a = spriteAnchor(lm)!;
      const ls = Math.max(1, Math.min(s, Math.floor((this.gate.y - 10 * s - boardTop) / a.h)));
      const lx = armed ? Math.max(col.x + 50 * ls, col.cx - half - postW - 52 * ls) : Math.min(col.r - 50 * ls, col.cx + half * 0.6);
      prop(this, lm, lx, this.gate.y - 10 * s - (a.h - a.ay) * ls, ls).setDepth(2);
    }
    if (col.x > 40 * s && hasSprite('deco:banner-security')) {
      prop(this, 'deco:banner-security', col.x - 22 * s, yardTop - 10 * s, s).setDepth(2);
      prop(this, 'deco:banner-security', col.r + 4 * s, yardTop - 10 * s, s).setDepth(2);
    }
    // The notice board: paper in a wooden frame with a red pin in each corner (or on a black pixel border, two red pins)
    // and a black pixel shadow; the role as its title, "Policy", the rules.
    const bx = col.cx - boardW / 2;
    g.fillStyle(PAL.black, 1).fillRect(bx - rim + 4, boardTop - rim + 4, boardW + 2 * rim, boardH + 2 * rim);
    if (framed)
      this.add
        .nineslice(bx - rim, boardTop - rim, CITY_ATLAS, BOARD.frame, boardW / s + 2 * BOARD.rim, boardH / s + 2 * BOARD.rim, BOARD.slice, BOARD.slice, BOARD.slice, BOARD.slice)
        .setOrigin(0, 0)
        .setScale(s)
        .setDepth(5);
    else {
      const board = this.add.graphics().setDepth(5);
      board.fillStyle(PAL.black, 1).fillRect(bx - 3, boardTop - 3, boardW + 6, boardH + 6);
      board.fillStyle(PAL.paper, 1).fillRect(bx, boardTop, boardW, boardH);
      for (const px of [bx + 10, bx + boardW - 16]) board.fillStyle(red, 1).fillRect(px, boardTop + 4, 6, 6);
    }
    this.roleText = crisp(this.add.text(col.cx, boardTop + 10, '', roleStyle)).setOrigin(0.5, 0).setDepth(6);
    heading.setPosition(bx + 12, boardTop + 10 + roleH + 6).setDepth(6);
    this.policyText = crisp(this.add.text(bx + 12, heading.y + heading.height + 2, '', policyStyle)).setDepth(6);
    // The gate: two posts, a red-and-white boom pivoting on the left one, and IAM's agent checking at the right post, in
    // front of the guard's booth.
    const postTop = boomY - 30 * s;
    let bar: Phaser.GameObjects.GameObject[];
    if (armed) {
      prop(this, GATE.post, col.cx - half - postW / 2, boomY + 10 * s, s).setDepth(1);
      prop(this, GATE.post, col.cx + half + postW / 2, boomY + 10 * s, s).setDepth(30);
      bar = [prop(this, GATE.arm, 0, 0, s)];
    } else {
      g.fillStyle(PAL.black, 1).fillRect(col.cx - half - postW - 2, postTop - 2, postW + 4, boomY - postTop + 12 * s);
      g.fillStyle(COLOR.panelHi, 1).fillRect(col.cx - half - postW, postTop, postW, boomY - postTop + 10 * s);
      const post = this.add.graphics().setDepth(30);
      post.fillStyle(PAL.black, 1).fillRect(col.cx + half - 2, postTop - 2, postW + 4, boomY - postTop + 12 * s);
      post.fillStyle(COLOR.panelHi, 1).fillRect(col.cx + half, postTop, postW, boomY - postTop + 10 * s);
      const bh = boom.bh;
      const len = half * 2;
      bar = [this.add.rectangle(0, 0, len, bh, PAL.black).setOrigin(0, 0.5)];
      for (let x = 0, i = 0; x < len; x += 12 * s, i++) bar.push(this.add.rectangle(x + 1, 0, Math.min(12 * s, len - x) - 2, bh - 4, i % 2 ? COLOR.inkHi : red).setOrigin(0, 0.5));
    }
    this.boom = this.add.container(col.cx - half - postW / 2, boomY, bar).setDepth(31);
    const guardX = col.cx + half + postW + 14 * s;
    if (hasSprite(GATE.booth)) prop(this, GATE.booth, guardX + 6 * s, boomY + 2 * s, s).setDepth(28);
    person(this, 'iam', guardX, boomY + 4 * s, s, 'check', 'SW').setDepth(29);
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
      this.boom?.setRotation(through ? LIFT : 0);
      if (through) this.time.delayedCall(pace(600), () => this.boom?.setRotation(0));
      return void this.time.delayedCall(pace(300), () => v.destroy());
    }
    // A lift still running from the last request ends first, so the boom always starts down.
    if (this.boom) this.tweens.killTweensOf(this.boom.setRotation(0));
    if (through && this.boom) this.tweens.add({ targets: this.boom, rotation: LIFT, duration: 160, yoyo: true, hold: pace(380) });
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
