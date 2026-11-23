import Phaser from 'phaser';
import { FEEDBACK, MiniGame, PAL, pace, TXT } from './MiniGame';
import { reducedMotion } from '../../motion';
import { crisp } from '../../SpeechBubble';
import { CITY_ATLAS, hasSprite, spriteAnchor } from '../../assets';
import { COLOR, CSS, LABEL_BG } from '../../theme';
import { EDGE } from '@/world/minigames';
import { change, EDGE_RULES, expire, hitRatio, invalidate, isChanged, isPopular, newEdge, request, store, type EdgeState } from './edgeCache';
import { minAccuracy } from './scoring';
import { edgeKey } from './gameKeys';
import { act, cast, districtColor, fitScale, landmarkFrame, person, prop } from './cast';

type TextStyle = Phaser.Types.GameObjects.Text.TextStyle;

/** The play group (sprites, the street, the counters' padding) at a whole-number scale: 1 in the side panel, 2 in the tab. */
const MAX_SCALE = 2;
/** The play column's widest, px: the tab's stage gets a wide street, not a 760 px strip with empty sides. */
const MAX_W = 960;
/** Three viewers side by side (crowd sheets, 36 px wide at 1×), this far apart. */
const VIEWER_STEP = 20;
const VIEWERS_W = 2 * VIEWER_STEP + 36;
/** A place (the edge location, the origin): a landmark's 100 px canvas at 1×. */
const PLACE_W = 100;
/** CloudFront's agent stands this far right of the edge location's middle, and reaches this far right of it. */
const AGENT_DX = 58;
const AGENT_REACH = AGENT_DX + 12;
/** The row of sprites at 1×: the viewers, the edge location with its agent, the origin. */
const ROW_W = VIEWERS_W + PLACE_W / 2 + AGENT_REACH + PLACE_W;
/** The column's margins and the gaps between the row's three groups, px (not scaled). */
const ROW_MARGINS = 48;
/** How tall they stand above their feet at 1×: a viewer (a crowd sheet), the agent (a full sheet). */
const VIEWER_H = 50;
const AGENT_H = 67;
/** A place drawn without its sprite (an atlas without it) stands this tall at 1×. */
const FALLBACK_H = 80;
/** The street the packets ride, from this far above the ground line to this far under it, at 1×. */
const STREET_UP = 2;
const STREET_DOWN = 8;
/** The edge location's sign: Network Junction's violet bands above and under its board, px, and the whole frame's extra height. */
const SIGN_BAND = 3;
const SIGN_EDGE = 2 * SIGN_BAND + 4;
/** "4 cache slots" stays on one line when the sign wraps (no-break spaces). */
const SIGN = 'Edge location: 4 cache slots';
/** The picked slot's ring: this wide, with this gap between it and its counter's border. */
const RING_W = 3;
const RING_GAP = 2;
/** The counters' desk: its margin round the counters, and the gap between two rows of counters, px. */
const DESK_PAD = 10;
const ROW_GAP = 12;
/** The hit-ratio row, px. */
const RATIO_H = 24;
/**
 * The post office's props (art/tiles/games_art.py): the counter round the cubbies, a 9-slice whose wooden lip, posts
 * and plinth are this many px at 1× (drawn round the desk, at the play scale); a viewer's phone; a file on its way, an
 * envelope (amber for a trip to the origin, green for a hit).
 */
const COUNTER = { frame: 'game:edge:counter', top: 8, side: 5, bottom: 7 };
const PHONE = 'game:edge:phone';
const FILE = { miss: 'game:edge:file-miss', hit: 'game:edge:file-hit' };

/** The nearest even number of px (a counter's middle then sits on a whole pixel, and so does its ring). */
const even = (n: number) => 2 * Math.round(n / 2);

interface Viewer {
  /** Where their request leaves from (their hands). */
  x: number;
  y: number;
  who: Phaser.GameObjects.Sprite;
  /** Their requests still out: they talk while any is. */
  busy: number;
}

/**
 * Edge Cache (CloudFront), played on a street: viewers (three citizens, left) ask the edge location (the CloudFront
 * landmark in the middle, its agent carrying parcels at the door) for files. Its four cache counters, in front of it,
 * answer a fresh cached file at once (a hit); anything else is a slow trip to the origin (a data centre, right). Click a
 * missed file in the feed to cache it: popular files are worth a slot. When a file changes at the origin, click its
 * counter to invalidate it, or viewers get the stale copy until its TTL runs out. Rules: src/game/scenes/games/edgeCache.ts.
 * The round's accuracy is the hit ratio itself (requests only: hit() / wrong()), so the end card and the lesson always
 * show one number; invalidations score points but aren't requests. Each miss shows how often its file was asked for,
 * popular ones marked 🔥, and a tip names the strategy a few seconds in. The sprites, the street and the counters'
 * padding are drawn at a whole-number scale (cast.ts fitScale): 2× in the tab, 1× in the side panel; text follows
 * ⋯ → Text size and the layout measures it. The counter, the phones and the envelopes are the art generator's
 * (art/tiles/games_art.py).
 */
export class EdgeGame extends MiniGame {
  private s: EdgeState = newEdge([]);
  private feed: Phaser.GameObjects.Text[] = [];
  /** Each counter's label (its middle is the counter's), and the counter itself. */
  private boxes: Phaser.GameObjects.Text[] = [];
  private cells: Phaser.GameObjects.Rectangle[] = [];
  private slotXY: { x: number; y: number }[] = [];
  /** A counter's size, px (even, so its middle and its ring sit on whole pixels). */
  private cellW = 0;
  private cellH = 0;
  /** The gold ring round the slot the number keys picked. */
  private ring?: Phaser.GameObjects.Graphics;
  private feedTop = 0;
  private feedRows = 2;
  /** One feed row's height: it grows with the player's text size. */
  private rowH = 22;
  private viewers: Viewer[] = [];
  private edgeX = 0;
  private originX = 0;
  /** The packets' lane: the street's middle, under the sign, over the counters. */
  private laneY = 0;
  /** The play group's whole-number scale (fitScale). */
  private px = 1;
  private feedX = 12;
  private feedW = 0;
  private ratioBar?: Phaser.GameObjects.Rectangle;
  private ratioText?: Phaser.GameObjects.Text;
  private barW = 0;
  private feedHead?: Phaser.GameObjects.Text;
  /** The slot the number keys picked (I invalidates it). */
  private sel = 0;

  constructor() {
    super('game:edge', 'edge', 'cloudfront', '🌍 Edge Cache — click a missed file to cache it (or press C); click a ⚠️ slot to invalidate a changed file (or press 1–4, then I)');
    this.wrongWord = 'misses';
    this.accuracyWord = 'hit ratio';
  }

  protected setup() {
    this.s = newEdge(EDGE.files.map((f) => f.name));
    this.feed = [];
    this.boxes = [];
    this.cells = [];
    this.sel = 0;
    const { width: w, height: h } = this.scale;
    // The sky and the street, across the whole stage (drawn once the layout is known, behind everything).
    const g = this.add.graphics();
    // Everything the player reads lives in a centred column (MiniGame.column), laid out top-down: the hit ratio, the
    // street scene, the counters, the misses feed, then the legend right under it, so a tall view has no gap between
    // the play and its key.
    const cw = Math.min(w, MAX_W);
    const legend = crisp(
      this.add.text(w / 2, 0, 'Hit = fast and cheap · miss = a trip to the origin · ⚠️ changed file = invalidate its slot', {
        ...TXT(13, CSS.inkSoft),
        backgroundColor: LABEL_BG,
        padding: { x: 6, y: 2 },
        align: 'center',
        wordWrap: { width: cw - 24 },
      }),
    )
      .setOrigin(0.5, 0)
      .setDepth(5);
    /** A text's size in this style (the layout measures its text: it follows ⋯ → Text size). */
    const measure = (text: string, style: TextStyle) => {
      const t = this.add.text(0, 0, text, style);
      const size = { w: Math.ceil(t.width), h: Math.ceil(t.height) };
      t.destroy();
      return size;
    };
    const chipStyle: TextStyle = { ...TXT(12, CSS.ink), backgroundColor: LABEL_BG, padding: { x: 5, y: 2 } };
    const chipH = measure('viewers', chipStyle).h;
    const longest = EDGE.files.map((f) => f.name).reduce((a, b) => (b.length > a.length ? b : a), '');
    const label = measure(`${EDGE_RULES.slots} · ${longest} ⚠️`, TXT(13));
    const head = Math.max(
      measure('Misses (click a file to cache it):', { ...TXT(13), wordWrap: { width: cw - 24 } }).h,
      measure('Tip: cache the 🔥 files: they’re asked for most', { ...TXT(13), wordWrap: { width: cw - 24 } }).h,
    );
    this.rowH = Math.max(22, measure(`🔥 ${EDGE.cities[0]} → ${longest} · asked 99×`, { ...TXT(13), padding: { x: 5, y: 2 } }).h + 2);
    // The counters: four in a row when the post office has room for their labels, else 2×2 (the side panel).
    const cols = cw - 24 >= 4 * (label.w + 32) ? 4 : 2;
    const rows = EDGE_RULES.slots / cols;
    // The counter's wooden frame round the desk (a 9-slice: WebGL), or the desk's own black edge.
    const framed = hasSprite(COUNTER.frame) && this.game.renderer.type === Phaser.WEBGL;
    const rim = (px: number, scale: number) => (framed ? px * scale : 0);

    // The play group's scale: the biggest whole number at which the row of sprites fits the column's width and the
    // whole layout (two feed rows at least) fits the room under the chrome.
    const edgeFrame = landmarkFrame('cloudfront');
    const originFrame = hasSprite('culture:dc:0') ? 'culture:dc:0' : landmarkFrame('s3');
    const edgeH = this.heightOf(edgeFrame);
    const originH = this.heightOf(originFrame);
    const room = h - this.top;
    const widthScale = fitScale(cw - ROW_MARGINS, ROW_W, MAX_SCALE);
    // The sign wraps between the viewers and the origin; at a smaller scale it has more room, so this is its tallest.
    const signWrap = (s: number) => Math.max(60, cw - 24 - (VIEWERS_W + PLACE_W) * s - 28);
    const signStyle = (s: number): TextStyle => ({ ...TXT(13, CSS.inkHi), align: 'center', padding: { x: 8, y: 3 }, wordWrap: { width: signWrap(s) } });
    const signTallest = measure(SIGN, signStyle(widthScale)).h + SIGN_EDGE;
    const fixedH =
      RATIO_H + 6 + 4 + Math.max(signTallest, chipH) + 10 + rim(COUNTER.top + COUNTER.bottom, widthScale) + 2 * DESK_PAD + rows * (label.h + 7) + (rows - 1) * ROW_GAP + 12 + head + 4 + 2 * this.rowH + 10 + legend.height + 6;
    const scaledH = Math.max(edgeH, AGENT_H, originH, VIEWER_H) + STREET_DOWN + 6 * rows;
    const S = Math.min(widthScale, fitScale(room - fixedH, scaledH, MAX_SCALE));
    this.px = S;

    // The exact layout at that scale; the misses feed gets the rows that are left (2 to 6).
    const sign = crisp(this.add.text(0, 0, SIGN, signStyle(S))).setOrigin(0.5, 1).setDepth(5);
    const above = Math.max(Math.max(edgeH, AGENT_H) * S + 4 + sign.height + SIGN_EDGE, Math.max(originH, VIEWER_H) * S + 4 + chipH);
    const cellH = even(label.h + 6 + 6 * S);
    const deskH = 2 * DESK_PAD + rows * cellH + (rows - 1) * ROW_GAP;
    const fixedNoFeed = RATIO_H + 6 + above + STREET_DOWN * S + 10 + rim(COUNTER.top + COUNTER.bottom, S) + deskH + 12 + head + 4 + 10 + legend.height + 6;
    this.feedRows = Phaser.Math.Clamp(Math.floor((room - fixedNoFeed) / this.rowH), 2, 6);
    const col = this.column(fixedNoFeed + this.feedRows * this.rowH, MAX_W);

    // The live hit ratio, with a tick at the floor a round needs (shared/minigames.json minAccuracy).
    const ry = col.y + RATIO_H / 2;
    this.ratioText = crisp(this.add.text(col.x + 12, ry, 'Hit ratio –', TXT(13, CSS.ink))).setOrigin(0, 0.5);
    const bx = this.ratioText.x + measure('Hit ratio 100%', TXT(13)).w + 10;
    this.barW = Math.max(60, col.r - bx - 14);
    this.add.rectangle(bx, ry, this.barW, 10, COLOR.panel).setOrigin(0, 0.5).setStrokeStyle(1, COLOR.panelHi);
    this.ratioBar = this.add.rectangle(bx, ry, 0, 10, COLOR.good).setOrigin(0, 0.5);
    const floor = minAccuracy('edge') / 100;
    if (floor) this.add.rectangle(bx + this.barW * floor, ry, 2, 16, COLOR.gold);

    // The street: a graphite sky over it, the ground line everyone stands on, and the lane the packets ride along its
    // middle, under the sign and over the counters (never across a title or a slot).
    const sceneTop = col.y + RATIO_H + 6;
    const groundY = Math.round(sceneTop + above);
    this.laneY = groundY + 3 * S;
    g.fillStyle(COLOR.bgDeep, 1).fillRect(0, sceneTop, w, groundY - STREET_UP * S - sceneTop);
    g.fillStyle(COLOR.panel, 1).fillRect(0, groundY - STREET_UP * S, w, (STREET_UP + STREET_DOWN) * S);
    g.fillStyle(PAL.black, 1).fillRect(0, groundY + STREET_DOWN * S, w, 2);
    g.fillStyle(COLOR.panelHi, 1);
    for (let x = 0; x < w; x += 14 * S) g.fillRect(x, this.laneY - Math.floor(S / 2), 6 * S, S);
    const chip = (x: number, bottom: number, text: string) => crisp(this.add.text(Math.round(x), Math.round(bottom), text, chipStyle)).setOrigin(0.5, 1).setDepth(5);

    // The viewers: three citizens on the left, facing the edge location; each talks while a request of theirs is out.
    const vLeft = col.x + 12;
    const vRight = vLeft + VIEWERS_W * S;
    this.viewers = cast(3).map((sheet, i) => {
      const x = Math.round(vLeft + (18 + i * VIEWER_STEP) * S);
      // The middle one stands a step nearer.
      const feet = groundY + (i % 2) * 3 * S;
      const who = person(this, sheet, x, feet, S, 'idle', 'SE').setDepth(2 + (i % 2));
      // Each asks from their phone (the requests leave from it).
      if (hasSprite(PHONE)) prop(this, PHONE, x + 8 * S, feet - 24 * S, S).setDepth(2.5 + (i % 2));
      return { x: x + 8 * S, y: feet - 24 * S, who, busy: 0 };
    });
    chip(vLeft + (18 + VIEWER_STEP) * S, groundY - VIEWER_H * S - 4, 'viewers');

    // The origin on the right (a data centre), and the edge location between: the CloudFront landmark at its level in
    // this city, with CloudFront's agent at the door carrying parcels (cached files) to the counters.
    this.originX = Math.round(col.r - 12 - (PLACE_W / 2) * S);
    const oLeft = this.originX - (PLACE_W / 2) * S;
    this.edgeX = Math.round((vRight + oLeft) / 2 - ((AGENT_REACH - PLACE_W / 2) / 2) * S);
    const edgeTop = this.place(edgeFrame, this.edgeX, groundY, S);
    person(this, 'cloudfront', this.edgeX + AGENT_DX * S, groundY + 2 * S, S, 'carry', 'SW').setDepth(2);
    const originTop = this.place(originFrame, this.originX, groundY, S);
    chip(this.originX, originTop - 4, 'origin');
    // The sign over the edge location (and its agent): ink on a graphite board between Network Junction's violet bands.
    const sx = Phaser.Math.Clamp(this.edgeX, vRight + 4 + sign.width / 2, oLeft - 4 - sign.width / 2);
    sign.setPosition(Math.round(sx), Math.round(Math.min(edgeTop, groundY - AGENT_H * S) - 4 - SIGN_BAND - 2));
    const b = sign.getBounds();
    this.add
      .graphics()
      .setDepth(4)
      .fillStyle(PAL.black, 1)
      .fillRect(b.x - 2, b.y - SIGN_BAND - 2, b.width + 4, b.height + SIGN_EDGE)
      .fillStyle(districtColor('cloudfront'), 1)
      .fillRect(b.x, b.y - SIGN_BAND, b.width, SIGN_BAND)
      .fillRect(b.x, b.bottom, b.width, SIGN_BAND)
      .fillStyle(COLOR.bg, 1)
      .fillRect(b.x, b.y, b.width, b.height);

    // The counters, in front of the edge location: a desk of four cubbies under the street, each numbered for its key,
    // in the post office's wooden counter (its lip over the cubbies, its plinth under them).
    const side = rim(COUNTER.side, S);
    const cTop = groundY + STREET_DOWN * S + 10 + rim(COUNTER.top, S);
    const slotW = Math.min(Math.floor((col.w - 24 - 2 * side) / cols), label.w + 32 + 16 * S);
    this.cellW = even(slotW - 8);
    this.cellH = cellH;
    const deskW = cols * slotW - 8 + 2 * DESK_PAD;
    const deskL = Math.round(Phaser.Math.Clamp(this.edgeX - deskW / 2, col.x + 6 + side, col.r - 6 - side - deskW));
    const x0 = deskL + DESK_PAD - 4;
    if (framed)
      this.add
        .nineslice(deskL - side, cTop - rim(COUNTER.top, S), CITY_ATLAS, COUNTER.frame, Math.ceil(deskW / S) + 2 * COUNTER.side, Math.ceil(deskH / S) + COUNTER.top + COUNTER.bottom, COUNTER.side, COUNTER.side, COUNTER.top, COUNTER.bottom)
        .setOrigin(0, 0)
        .setScale(S)
        .setDepth(1);
    else
      this.add
        .graphics()
        .setDepth(1)
        .fillStyle(PAL.black, 1)
        .fillRect(deskL - 2, cTop - 2, deskW + 4, deskH + 4)
        .fillStyle(COLOR.bgDeep, 1)
        .fillRect(deskL, cTop, deskW, deskH)
        .fillStyle(COLOR.panelHi, 1)
        .fillRect(deskL, cTop, deskW, 3);
    this.slotXY = Array.from({ length: EDGE_RULES.slots }, (_, i) => ({
      x: Math.round(x0 + (i % cols) * slotW + slotW / 2),
      y: cTop + DESK_PAD + Math.floor(i / cols) * (cellH + ROW_GAP) + cellH / 2,
    }));
    this.ring = this.add.graphics().setDepth(3);
    for (let i = 0; i < EDGE_RULES.slots; i++) this.drawSlot(i);

    this.feedX = col.x + 12;
    this.feedW = col.w - 24;
    this.feedTop = cTop + deskH + rim(COUNTER.bottom, S) + 12 + head + 4;
    this.feedHead = crisp(this.add.text(this.feedX, this.feedTop - 4, 'Misses (click a file to cache it):', { ...TXT(13, CSS.info), wordWrap: { width: this.feedW } })).setOrigin(0, 1);
    legend.setY(this.feedTop + this.feedRows * this.rowH + 10);
    this.onKeys((k) => {
      const a = edgeKey(k, EDGE_RULES.slots);
      if (!a) return;
      if (a.kind === 'select') {
        const prev = this.sel;
        this.sel = a.slot;
        this.drawSlot(prev);
        this.drawSlot(this.sel);
      } else if (a.kind === 'invalidate') this.invalidate(this.sel);
      else {
        const oldest = this.feed[0];
        if (oldest) this.store(oldest.getData('file') as string, oldest);
      }
    });
    this.time.addEvent({ delay: pace(650), loop: true, callback: () => this.request() });
    this.time.addEvent({ delay: pace(EDGE_RULES.changeMs), loop: true, callback: () => this.change() });
    // A few seconds in, the strategy in one line, in the feed's heading where the player is already looking.
    this.time.delayedCall(EDGE_RULES.tipMs, () => {
      if (this.over) return;
      const low = hitRatio(this.s) < minAccuracy('edge');
      this.feedHead?.setText(low ? 'Tip: cache the 🔥 files: they’re asked for most' : 'Misses: keep the 🔥 files cached').setColor(FEEDBACK.gold);
    });
    this.time.addEvent({ delay: 500, loop: true, callback: () => this.expire() });
  }

  /** A place's height at 1×: its sprite's canvas, or the plain block that stands in for it. */
  private heightOf(frame: string | undefined) {
    return (frame && spriteAnchor(frame)?.h) || FALLBACK_H;
  }

  /**
   * A place at the play group's scale: its middle at `cx` and its front corner on the ground at `bottom`; returns its
   * top. An atlas without the sprite gets a plain block instead.
   */
  private place(frame: string | undefined, cx: number, bottom: number, scale: number) {
    const a = frame ? spriteAnchor(frame) : undefined;
    if (!frame || !a) {
      const bh = FALLBACK_H * scale;
      this.add.rectangle(cx, bottom - bh / 2, PLACE_W * scale * 0.8, bh, COLOR.panelHi).setStrokeStyle(2, PAL.black).setDepth(1);
      return bottom - bh;
    }
    prop(this, frame, Math.round(cx + (a.ax - a.w / 2) * scale), Math.round(bottom - (a.h - a.ay) * scale), scale).setDepth(1);
    return bottom - a.h * scale;
  }

  /**
   * One counter per slot: an empty cubby, the cached file on the counter, or a warn-tinted counter whose file changed at
   * the origin (⚠️; tap to invalidate). The slot the number keys picked gets the gold ring.
   */
  private drawSlot(i: number) {
    const c = this.s.slots[i];
    const p = this.slotXY[i];
    this.cells[i]?.destroy();
    this.boxes[i]?.destroy();
    const changed = c && isChanged(this.s, c);
    const cell = this.add
      .rectangle(p.x, p.y, this.cellW, this.cellH, changed ? COLOR.warn : c ? COLOR.panelHi : COLOR.panel, changed ? 0.32 : 1)
      .setStrokeStyle(2, changed ? COLOR.warn : PAL.black)
      .setDepth(2);
    const box = crisp(
      this.add.text(p.x, p.y, c ? `${i + 1} · ${c.name}${changed ? ' ⚠️' : ''}` : `${i + 1} · (empty)`, {
        ...TXT(13, changed ? CSS.goldHi : c ? CSS.inkHi : CSS.muted),
        align: 'center',
        wordWrap: { width: this.cellW - 8 },
      }),
    )
      .setOrigin(0.5)
      .setDepth(3);
    if (c) cell.setInteractive({ useHandCursor: true }).on('pointerdown', () => this.invalidate(i));
    this.cells[i] = cell;
    this.boxes[i] = box;
    if (i === this.sel) this.drawRing();
  }

  /**
   * The slot the number keys picked: a gold rectangle round its counter, RING_GAP px clear of the counter's 2 px border
   * (1 px of which lies outside the fill), never an outline on its letters.
   */
  private drawRing() {
    const p = this.slotXY[this.sel];
    if (!p) return;
    const out = 1 + RING_GAP + RING_W / 2;
    this.ring
      ?.clear()
      .lineStyle(RING_W, COLOR.gold, 1)
      .strokeRect(p.x - this.cellW / 2 - out, p.y - this.cellH / 2 - out, this.cellW + 2 * out, this.cellH + 2 * out);
  }

  /** Where a slot's floater goes: just under its counter, or just over it. */
  private belowSlot(i: number) {
    return this.boxes[i].y + this.cellH / 2 + 6;
  }

  private aboveSlot(i: number) {
    return this.boxes[i].y - this.cellH / 2 - 6;
  }

  private pickFile() {
    const total = EDGE.files.reduce((n, f) => n + f.weight, 0);
    let r = Math.random() * total;
    for (const f of EDGE.files) if ((r -= f.weight) < 0) return f.name;
    return EDGE.files[0].name;
  }

  /**
   * A file from a viewer's phone to the edge (and on to the origin on a miss): an envelope, amber for a miss, green for a
   * hit (a dot without the atlas). The viewer talks while it's out.
   */
  private packet(miss: boolean) {
    if (reducedMotion()) return;
    const v = this.viewers[Math.floor(Math.random() * this.viewers.length)];
    const file = miss ? FILE.miss : FILE.hit;
    const dot = hasSprite(file)
      ? prop(this, file, v.x, v.y, this.px).setDepth(4)
      : this.add
          .circle(v.x, v.y, 2 + this.px, miss ? COLOR.accent : COLOR.good)
          .setStrokeStyle(1, PAL.black)
          .setDepth(4);
    const lane = this.laneY;
    v.busy++;
    act(v.who, 'talk', 'SE');
    this.tweens.chain({
      targets: dot,
      tweens: miss
        ? [
            { x: this.edgeX, y: lane, duration: 200 },
            { x: this.originX, duration: 380 },
            { x: v.x, y: v.y, duration: 420 },
          ]
        : [
            { x: this.edgeX, y: lane, duration: 200 },
            { x: v.x, y: v.y, duration: 160 },
          ],
      onComplete: () => {
        dot.destroy();
        if (--v.busy > 0) return;
        v.busy = 0;
        act(v.who, 'idle', 'SE');
      },
    });
  }

  private request() {
    if (this.over) return;
    const name = this.pickFile();
    const city = EDGE.cities[Math.floor(Math.random() * EDGE.cities.length)];
    const r = request(this.s, name, this.time.now);
    this.packet(r === 'miss');
    const i = this.s.slots.findIndex((c) => c?.name === name);
    if (r === 'stale') {
      this.wrong();
      this.addScore(EDGE_RULES.stale, 'soft');
      this.floater(this.boxes[i].x, this.belowSlot(i), `✗ stale ${name}!`, FEEDBACK.wrong);
      this.speak(`Stale: a viewer got the old ${name} from slot ${i + 1}. Press ${i + 1}, then I, to invalidate it. Score ${this.score}.`);
    } else if (r === 'hit') {
      this.hit();
      this.addScore(EDGE_RULES.hit, 'none');
      this.floater(this.boxes[i].x, this.belowSlot(i), 'hit', FEEDBACK.right);
    } else {
      this.wrong();
      this.addScore(EDGE_RULES.miss, 'none');
      this.addFeed(city, name);
    }
    this.showRatio();
  }

  /** A miss lands in the feed: the player may cache it now. */
  private addFeed(city: string, name: string) {
    // The first free row; a full feed drops its oldest line.
    const used = new Set(this.feed.map((f) => Math.round((f.y - this.feedTop) / this.rowH)));
    let row = [...Array(this.feedRows).keys()].find((r) => !used.has(r));
    if (row === undefined) {
      const old = this.feed.shift()!;
      row = Math.round((old.y - this.feedTop) / this.rowH);
      old.destroy();
    }
    // Each miss shows the file's heat: how often it's been asked for, 🔥 for the most popular (worth a slot).
    const n = this.s.asked.get(name) ?? 1;
    const hot = isPopular(this.s, name);
    const t = crisp(
      this.add.text(this.feedX, this.feedTop + row * this.rowH, `${hot ? '🔥 ' : ''}${city} → ${name} · asked ${n}×`, {
        ...TXT(13, hot ? FEEDBACK.gold : CSS.ink),
        backgroundColor: CSS.panel,
        padding: { x: 5, y: 2 },
        wordWrap: { width: this.feedW },
      }),
    )
      .setDepth(5)
      .setInteractive({ useHandCursor: true });
    t.setData('file', name);
    this.feed.push(t);
    // Each miss is said as it lands in the feed (it's only drawn); C caches the oldest one there.
    this.speak(`Miss: ${city} asked for ${name}, ${n} ${n === 1 ? 'time' : 'times'}${hot ? ', one of the most asked for' : ''}.${this.feed.length === 1 ? ' Press C to cache it.' : ''}`, true);
    t.once('pointerdown', () => this.store(name, t));
    this.time.delayedCall(pace(EDGE_RULES.feedMs), () => {
      this.feed = this.feed.filter((x) => x !== t);
      t.destroy();
    });
  }

  private showRatio() {
    const pct = hitRatio(this.s);
    this.ratioText?.setText(`Hit ratio ${pct}%`);
    this.ratioBar?.setSize((this.barW * pct) / 100, 10).setFillStyle(pct >= minAccuracy('edge') ? COLOR.good : COLOR.bad);
  }

  /** Caching pays nothing by itself: the hits it brings do. */
  private store(name: string, from: Phaser.GameObjects.Text) {
    if (this.over) return;
    from.destroy();
    const i = store(this.s, name, this.time.now, pace(EDGE_RULES.ttlMs));
    if (i < 0) return;
    this.drawSlot(i);
    this.floater(this.boxes[i].x, this.aboveSlot(i), `cached ${name}`, FEEDBACK.note);
    this.speak(`Cached ${name} in slot ${i + 1}.`);
  }

  private change() {
    if (this.over) return;
    const cached = this.s.slots.filter((c) => !!c);
    if (!cached.length) return;
    const c = cached[Math.floor(Math.random() * cached.length)]!;
    change(this.s, c.name);
    const i = this.s.slots.indexOf(c);
    this.drawSlot(i);
    this.floater(this.boxes[i].x, this.aboveSlot(i) - 4, `${c.name} changed at the origin!`, FEEDBACK.gold);
    this.speak(`${c.name} changed at the origin: slot ${i + 1} is out of date. Press ${i + 1}, then I.`);
  }

  private invalidate(i: number) {
    if (this.over) return;
    const b = this.boxes[i];
    const r = invalidate(this.s, i);
    if (!r) return;
    // Invalidations score, but they aren't requests: the round's accuracy stays the hit ratio.
    if (r === 'right') {
      this.addScore(EDGE_RULES.invalidate);
      this.floater(b.x, this.belowSlot(i), '✓ invalidated', FEEDBACK.right);
    } else {
      this.addScore(EDGE_RULES.wrongInvalidate);
      this.floater(b.x, this.belowSlot(i), '✗ it was still fresh', FEEDBACK.wrong);
    }
    this.drawSlot(i);
    this.showRatio();
  }

  /** A cached copy past its TTL is dropped (the next request goes back to the origin and gets the new version). */
  private expire() {
    for (const i of expire(this.s, this.time.now)) this.drawSlot(i);
  }

  protected lesson() {
    return `Cache hit ratio ${hitRatio(this.s)}%${this.s.stale ? `, ${this.s.stale} stale` : ''}. ${EDGE.lesson}`;
  }
}
