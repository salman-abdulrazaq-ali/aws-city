import Phaser from 'phaser';
import { FEEDBACK, MiniGame, pace, PAL, TXT } from './MiniGame';
import { POINTS } from './scoring';
import { freeLane } from './lanes';
import { act, cast, districtColor, fitScale, landmarkFrame, person, prop } from './cast';
import { reducedMotion } from '../../motion';
import { crisp } from '../../SpeechBubble';
import { COLOR, CSS, LABEL_BG } from '../../theme';
import { useCity } from '@/state/store';
import { REDTEAM, tierFor, type Flaw, type RedTeamRequest } from '@/world/minigames';

/** The play group's natural width at 1×, px: your app (its landmark, `APP_W`) and a range long enough to read a line on. */
const NATURAL_W = 380;
/** Your app's end of the range at 1×, px (the Security Agent landmark is 100 wide). */
const APP_W = 100;
/** A crowd citizen's head, px above the feet at 1× (36×54 frame, feet at 50). */
const HEAD = 50;

/**
 * Red Team Range (AWS Security Agent): a penetration test of *your own* app. Requests from your app's log walk up the
 * range's five lanes, each person holding their log line; flag the ones that show a security flaw (another customer's
 * invoice, a token in the URL, a query that breaks out of its quotes) before they reach the app, and let the fine ones
 * pass. Each flag names the flaw; the end card says how to fix the ones you found. The city never sends traffic
 * anywhere: it's all on the screen. Every request looks alike until it's read (the same paper tag, a random citizen),
 * and a false flag costs more than a real one pays, so flagging everything doesn't win.
 */
export class RedTeamGame extends MiniGame {
  private pool: RedTeamRequest[] = [];
  private found: Partial<Record<Flaw, number>> = {};
  private live: Phaser.GameObjects.Container[] = [];
  /** Which lanes hold a live request (one each, src/game/scenes/games/lanes.ts). */
  private busy: boolean[] = [];
  private dealt = 0;
  private laneTop = 0;
  private laneH = 0;
  /** The play group's whole-number scale (src/game/scenes/games/cast.ts fitScale): 2× in the tab, 1× in the 400 px panel. */
  private s = 1;
  /** This round's requesters (crowd-size citizen sheets). */
  private crowd: string[] = [];
  /** The range's left edge (your app's end), its right edge, and your app's width. */
  private range = { x: 0, r: 0, app: 0 };
  /** The widest a log line's tag may be before it shrinks, then wraps. */
  private chipRoom = 0;

  constructor() {
    super('game:redteam', 'redteam', 'securityagent', '🎯 Red Team Range — read each request: click (or Space) the ones with a flaw; let fine ones pass');
  }

  protected setup() {
    this.live = [];
    this.busy = [false, false, false, false, false];
    this.found = {};
    this.dealt = 0;
    this.crowd = cast(16);
    this.onKeys((k) => (k === ' ' || k.startsWith('Arrow')) && this.flagNearest());
    const { width: w, height: h } = this.scale;
    const cw = Math.min(w, 760);
    const legend = crisp(this.add.text(w / 2, 0, '🚩 a flaw: click it (Space: the one nearest the app)   ✅ fine: let it pass', { ...TXT(14, CSS.ink), backgroundColor: LABEL_BG, padding: { x: 6, y: 2 }, align: 'center', wordWrap: { width: cw - 24 } }))
      .setOrigin(0.5, 0)
      .setDepth(5);
    const plays = useCity.getState().progress.games?.redteam?.plays ?? 0;
    this.pool = REDTEAM.requests.filter((r) => r.tier <= tierFor(plays));
    // The strip above the lanes holds "your app" and the verdicts (as tall as a verdict), so a verdict never covers a request.
    const probe = this.add.text(0, 0, '✓ Ag', { ...TXT(16), padding: { x: 10, y: 5 } });
    const strip = Math.max(34, Math.ceil(probe.height) + 6);
    probe.destroy();
    // Five lanes, each tall enough for a person with their log line (wrapped on a narrow panel) over their head and no
    // taller (a tall tab doesn't stretch them), in a centred column (MiniGame.column) with the legend right under them.
    // The play group's scale is the biggest whole number at which the lanes fit the room.
    const room = this.column();
    const free = room.h - strip - 12 - legend.height;
    let s = fitScale(room.w, NATURAL_W, 2);
    let laneMin = this.laneFor(s, room.w);
    while (s > 1 && laneMin * 5 > free) laneMin = this.laneFor(--s, room.w);
    this.s = s;
    this.laneH = Phaser.Math.Clamp(Math.floor(free / 5), laneMin, laneMin + 16 * s);
    const col = this.column(strip + this.laneH * 5 + 12 + legend.height);
    const appW = APP_W * s;
    this.range = { x: col.x, r: col.r, app: appW };
    this.laneTop = col.y + strip;
    const { laneTop: y0, laneH: lh } = this;
    const appX = col.x + appW;
    legend.setY(y0 + lh * 5 + 10);
    const g = this.add.graphics();
    // A test range: five lanes of people from your app's log walk right to left into the app.
    g.fillStyle(COLOR.bg, 1).fillRect(0, this.top, w, h - this.top);
    for (let i = 0; i < 5; i++) {
      const floor = y0 + (i + 1) * lh;
      g.fillStyle(i % 2 ? COLOR.panel : COLOR.panelHi, 1).fillRect(appX, y0 + i * lh, col.r - appX, lh);
      // the lane's divider, and distance marks along it
      g.fillStyle(COLOR.bgDeep, 1).fillRect(appX, floor - 2, col.r - appX, 2);
      for (let x = appX + 60 * s; x < col.r - 8; x += 60 * s) g.fillStyle(COLOR.muted, 0.35).fillRect(x, floor - 2 - 4 * s, 2, 4 * s);
    }
    // your app's end of the range in the security district's colour, and the range's accent strip where the lanes end
    const accent = districtColor('securityagent');
    g.fillStyle(accent, 0.12).fillRect(col.x, y0, appW, lh * 5);
    g.fillStyle(accent, 1).fillRect(appX - 2 * s, y0, 4 * s, lh * 5);
    g.fillStyle(PAL.black, 1).fillRect(appX + 2 * s, y0, 1, lh * 5);
    // your app: Security Agent's own landmark at its level in this city (the security HQ when the atlas has none)
    prop(this, landmarkFrame('securityagent') ?? 'hq:security', col.x + appW / 2, y0 + lh * 5 - 2 * s, s)
      .setOrigin(0.5, 1)
      .setDepth(8);
    crisp(this.add.text(col.x + appW / 2, y0 - 4, 'your app', { ...TXT(14, CSS.inkHi), backgroundColor: LABEL_BG, padding: { x: 5, y: 1 } }))
      .setOrigin(0.5, 1)
      .setDepth(15);
    // Security Agent at the head of the range, scanning the lanes
    person(this, 'securityagent', appX - 14 * s, y0 + lh * 5 - 4 * s, s, 'scan', 'SE').setDepth(26);
    this.scheduleSpawn();
  }

  /** A lane's height at scale `s`: a person, the tallest log line in this round's pool over their head, and a little air. */
  private laneFor(s: number, width: number) {
    this.chipRoom = width - APP_W * s - 4 * s - 8;
    const lines = [...new Set(this.pool.map((r) => r.line))];
    const tallest = lines.reduce((most, line) => {
      const t = this.logChip(line);
      const th = t.height;
      t.destroy();
      return Math.max(most, th);
    }, 0);
    return HEAD * s + tallest + 4 * s + 10;
  }

  /**
   * A request's log line on a paper tag (monospace: it's a log line), the same for every request. It spawns fully
   * inside the view: a smaller font on a narrow panel (TXT's, never under 11 px), then wrapping if it's still too wide.
   */
  private logChip(line: string) {
    const t = crisp(this.add.text(0, 0, line, { ...TXT(14, CSS.paperInk), fontFamily: 'monospace', backgroundColor: CSS.paper, padding: { x: 5, y: 2 } }));
    if (t.width > this.chipRoom) t.setFontSize(TXT(12).fontSize ?? '11px');
    if (t.width > this.chipRoom) t.setWordWrapWidth(this.chipRoom - 10, true);
    return t;
  }

  private scheduleSpawn(ms = pace(Math.max(1100, 1900 - this.dealt * 40))) {
    if (this.over || !this.pool.length) return;
    this.time.delayedCall(ms, () => {
      if (this.over) return;
      // Every lane busy: this request waits a moment for one to clear.
      if (!this.spawn()) return this.scheduleSpawn(300);
      this.scheduleSpawn();
    });
  }

  /** Space or an arrow key: flag the request nearest the app, as a click would. */
  private flagNearest() {
    const t = this.live.reduce<Phaser.GameObjects.Container | undefined>((a, b) => (!a || b.x < a.x ? b : a), undefined);
    t?.emit('pointerdown');
  }

  /** A new request in a free lane; false when every lane is busy. */
  private spawn() {
    const { x: x0, r: x1, app } = this.range;
    const s = this.s;
    const lane = freeLane(this.busy);
    if (lane < 0) return false;
    const r = this.pool[Math.floor(Math.random() * this.pool.length)];
    this.dealt++;
    this.busy[lane] = true;
    // Feet on the lane's floor; the person's log line over their head, its left edge just behind them.
    const y = this.laneTop + (lane + 1) * this.laneH - 4 * s;
    const who = person(this, this.crowd[this.dealt % this.crowd.length], 0, 0, s, 'walk', 'SW');
    const t = this.logChip(r.line).setPosition(-10 * s, -HEAD * s - 4).setOrigin(0, 1);
    const c = this.add.container(0, y, [who, t]).setDepth(20 + lane);
    // Arrives at your app: the tag stops just past the range's accent strip.
    const end = x0 + app + 14 * s;
    c.setX(Math.max(end, Math.min(x1 - 18 * s, x1 - 6 - t.width + 10 * s)));
    // The person and their tag are one target: a press on either flags the request.
    const targets = [who, t];
    for (const o of targets) o.setInteractive({ useHandCursor: true }).on('pointerdown', () => c.emit('pointerdown'));
    if (!reducedMotion()) {
      c.setAlpha(0);
      this.tweens.add({ targets: c, alpha: 1, duration: 200 });
    }
    this.live.push(c);
    // Each request is said as it comes in (the lanes are only drawn): Space flags the one nearest your app.
    this.speak(`Request: ${r.line}`, true);
    c.once('destroy', () => {
      this.live = this.live.filter((x) => x !== c);
      this.busy[lane] = false;
    });
    const tw = this.tweens.add({
      targets: c,
      x: end,
      duration: pace(7_500 + Math.random() * 1_500),
      onComplete: () => {
        if (this.over) return c.destroy();
        if (r.flaw) {
          this.wrong();
          this.addScore(POINTS.redteam.missed, 'soft');
          this.say(`✗ Missed: ${REDTEAM.flaws[r.flaw]?.name ?? r.flaw}`, FEEDBACK.wrong);
          if (!reducedMotion()) this.cameras.main.shake(100, 0.003);
        } else {
          this.hit();
          this.addScore(POINTS.redteam.passed, 'none');
        }
        c.destroy();
      },
    });
    c.on('pointerdown', () => {
      if (this.over || !this.live.includes(c)) return;
      tw.stop();
      // Flagged: off the range now, so neither Space nor a click can flag it twice while it's led away.
      this.live = this.live.filter((x) => x !== c);
      targets.forEach((o) => o.disableInteractive());
      if (r.flaw) {
        this.hit();
        this.addScore(POINTS.redteam.flag);
        this.found[r.flaw] = (this.found[r.flaw] ?? 0) + 1;
        this.say(`✓ ${REDTEAM.flaws[r.flaw]?.name ?? r.flaw}`, FEEDBACK.right);
      } else {
        this.wrong();
        this.addScore(POINTS.redteam.falseFlag);
        this.say('✗ That one was fine', FEEDBACK.wrong);
      }
      this.leadOff(c, who);
    });
    return true;
  }

  /**
   * Flagged: a red flag pops on the person and they're led back off the range. Under reduced motion nothing moves: the
   * flag shows a moment, then they're gone.
   */
  private leadOff(c: Phaser.GameObjects.Container, who: Phaser.GameObjects.Sprite) {
    const s = this.s;
    const flag = crisp(this.add.text(0, -HEAD * s * 0.5, '🚩 flagged', { ...TXT(13, CSS.paperInk), backgroundColor: CSS.bad, padding: { x: 4, y: 1 } })).setOrigin(0.5);
    c.add(flag);
    if (reducedMotion()) return void this.time.delayedCall(500, () => c.destroy());
    flag.setScale(0.4);
    this.tweens.add({ targets: flag, scale: 1, duration: 160, ease: 'Back.easeOut' });
    act(who, 'walk', 'SE');
    this.tweens.add({ targets: c, x: c.x + 90 * s, alpha: 0, delay: 300, duration: 600, onComplete: () => c.destroy() });
  }

  /** A verdict in the strip above the lanes, never on top of a request. */
  private say(text: string, color: string) {
    const { x: x0, r: x1, app } = this.range;
    // Right of the "your app" tag, which shares the strip.
    this.verdict((x0 + app + x1) / 2, this.laneTop - 2, text, color, 1);
  }

  protected lesson() {
    const top = (Object.entries(this.found) as [Flaw, number][]).sort((a, b) => b[1] - a[1])[0];
    if (!top) return REDTEAM.lesson || 'A penetration test looks for flaws in your own app before an attacker does.';
    const f = REDTEAM.flaws[top[0]];
    const n = Object.values(this.found).reduce((a, x) => a + (x ?? 0), 0);
    return `You found ${n} flaw${n === 1 ? '' : 's'}. ${f?.name ?? top[0]}: ${f?.fix ?? ''}`;
  }
}
