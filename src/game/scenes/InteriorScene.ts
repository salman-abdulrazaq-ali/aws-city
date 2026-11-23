import Phaser from 'phaser';
import type { ServerEvent } from '@/backend/contract';
import { bus } from '@/state/bus';
import { isDiscovered, useCity } from '@/state/store';
import { placeFor } from '@/world/places';
import { districtById, servicesIn, type DistrictId } from '@/world/taxonomy';
import { Agent, setBubbleTopInset, type AgentWorld } from '../Agent';
import { addSprite, CITY_ATLAS } from '../assets';
import { blip, click, sfx } from '../audio';
import { castFor, workAnimFor } from '../cast';
import { DOOR, ENTRY, keptClear, piecesFor, ROOM_H, ROOM_W, staffPlaces, tilesOf, type Piece } from '../hqRoom';
import { cornerScreen, entityDepth, ROOM_ISO, toScreen, toTile } from '../iso';
import { KAI_SHEET } from '@/world/culture';
import { crisp, TEXT_FONT } from '../SpeechBubble';
import { CSS, withAlpha } from '../theme';
import { onSceneEnd } from './lifecycle';

const W = ROOM_W;
const H = ROOM_H;

/** Back walls, in the pack's style: [sprite, index along the wall]. Two-tile pieces take two slots. */
const RIGHT_WALL: Record<string, string[]> = {
  default: ['pack:server_right', 'pack:dashboard_right', '', 'wallR', 'pack:poster_lambda_right', 'pack:server_right', 'pack:dashboard_right', '', 'wallR', 'pack:server_right'],
  spheres: ['pack:dashboard_right', '', 'glassWallR', 'glassWallR', 'pack:poster_lambda_right', 'glassWallR', 'pack:dashboard_right', '', 'glassWallR', 'glassWallR'],
};
const LEFT_WALL: Record<string, string[]> = {
  default: ['pack:window_left', '', 'pack:poster_lambda_left', 'pack:dashboard_left', '', 'pack:server_left', 'wallL', 'DOOR', 'wallL'],
  spheres: ['pack:window_left', '', 'pack:window_left', '', 'pack:window_left', '', 'glassWallL', 'DOOR', 'glassWallL'],
};

export class InteriorScene extends Phaser.Scene {
  private districtId!: string;
  private agents = new Map<string, Agent>();
  private player!: Agent;
  private blocked = new Set<number>();
  private offs: (() => void)[] = [];
  private answers = new Map<string, string>();
  private title?: Phaser.GameObjects.Text;

  readonly world: AgentWorld = {
    iso: ROOM_ISO,
    gridW: W,
    gridH: H,
    walkable: (x, y) => x >= 0 && y >= 0 && x < W && y < H && !this.blocked.has(y * W + x),
    // The staff idle on their own patches (hqRoom staffPlaces), never in front of the door or on Kai's first tile.
    wanderable: (x, y) => !keptClear(x, y),
  };

  constructor() {
    super('interior');
  }

  init(data: { districtId: string }) {
    this.districtId = data.districtId;
    this.agents = new Map();
    this.blocked = new Set();
    this.answers = new Map();
    this.offs = [];
  }

  preload() {
    if (!this.textures.exists('door')) this.load.spritesheet('door', '/assets/city/door_left.png', { frameWidth: 40, frameHeight: 64 });
  }

  create() {
    const spheres = this.districtId === 'spheres';
    const d = spheres ? undefined : districtById(this.districtId);
    this.cameras.main.setBackgroundColor('#0f1114').setRoundPixels(true);

    // floor
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const n = cornerScreen(ROOM_ISO, x, y);
        let f = spheres ? ((x * 7 + y * 3) % 5 === 0 ? 'grass0' : 'floorTile') : x >= 8 ? 'floorGrate' : 'carpet';
        if (!spheres && x >= 6 && x <= 8 && y >= 7) f = 'floorTile';
        this.add.image(n.x, n.y, CITY_ATLAS, f).setOrigin(0.5, 0).setDepth(x + y);
      }

    // back walls
    const rw = RIGHT_WALL[spheres ? 'spheres' : 'default'];
    rw.forEach((name, x) => name && x < W && addSprite(this, name, cornerScreen(ROOM_ISO, x, 0).x, cornerScreen(ROOM_ISO, x, 0).y).setDepth(-5));
    const lw = LEFT_WALL[spheres ? 'spheres' : 'default'];
    lw.forEach((name, y) => {
      if (!name || y >= H || name === 'DOOR') return;
      const n = cornerScreen(ROOM_ISO, 0, y);
      addSprite(this, name, n.x, n.y).setDepth(-5);
    });
    // the team's animated door on the left wall
    const dp = toScreen(ROOM_ISO, -0.5, DOOR.y + 0.5);
    addSprite(this, spheres ? 'glassWallL' : 'wallL', cornerScreen(ROOM_ISO, 0, DOOR.y).x, cornerScreen(ROOM_ISO, 0, DOOR.y).y).setDepth(-6);
    const door = this.add.sprite(dp.x, dp.y, 'door', 0).setOrigin(8 / 40, 52 / 64).setDepth(-4);

    for (const piece of piecesFor(this.districtId)) this.furniture(piece);

    // who works here
    const staff: string[] = spheres
      ? ['concierge', 'builder', 'lookout']
      : servicesIn(this.districtId as DistrictId)
          .filter((s) => isDiscovered(useCity.getState().progress, s.id, useCity.getState().cityRegion))
          .map((s) => s.id);
    // The first six sit at the desks, the rest stand at the racks (src/game/hqRoom.ts): a full district fits. Each starts
    // at its own spot and idles on its own patch of floor, so the staff never stand in one knot.
    const places = staffPlaces(this.districtId, staff.length);
    for (const { spot } of places) {
      if (!spot?.desk) continue;
      this.furniture(['pack:desk_computer_SE', spot.desk.x, spot.desk.y]);
      const n = cornerScreen(ROOM_ISO, spot.tile.x, spot.tile.y);
      addSprite(this, 'pack:office_chair_SE', n.x, n.y).setDepth(entityDepth(toScreen(ROOM_ISO, spot.tile.x, spot.tile.y).y) - 2);
    }

    // A name only: the Concierge's welcome says what to do here, and a longer sign covered the side panel's small room.
    const titleText = spheres ? 'The Spheres · Console HQ' : `${d!.hq} · ${d!.name}`;
    // The room's sign, pinned to the top of the view (update): placed above the back wall it was off-screen at every zoom.
    this.title = crisp(
      this.add
        .text(0, 0, titleText, { fontFamily: TEXT_FONT, fontSize: '12px', fontStyle: '800', align: 'center', color: CSS.inkHi, backgroundColor: withAlpha('bg', 0.87), padding: { x: 8, y: 4 } })
        .setOrigin(0.5, 0)
        .setDepth(70_000),
    );

    staff.forEach((id, i) => {
      const c = castFor(id)!;
      const { start, area, spot } = places[i];
      const a = new Agent(this, this.world, {
        id,
        name: c.name,
        tile: start,
        home: area,
        workSpot: spot?.tile,
        workAnim: spot?.seated === false ? workAnimFor(c.activity) : 'sit',
        workDir: 'SE',
        speed: 1.6,
      });
      a.onSpeak = (ag) => blip(ag.id);
      a.onClick(() => {
        click();
        useCity.getState().select(id === 'concierge' ? 'plaza' : id);
        bus.emit('select', { id });
        a.face(this.player.tile);
        a.emote('hi', 1400);
        a.say(spheres ? 'Tell me what you want to do — type it below and I’ll send the right agent!' : `Ask me anything about ${placeFor(id)?.place ?? 'this place'}! Use the chat.`);
      });
      this.agents.set(id, a);
      if (useCity.getState().agents[id]?.state === 'working') this.time.delayedCall(200, () => a.setWorking(true));
    });

    this.player = new Agent(this, this.world, { id: 'player', sheet: KAI_SHEET, name: 'Kai (you)', tile: DOOR, home: { x: 0, y: 0, w: W, h: H }, speed: 2.4, wanders: false });
    this.player.sprite.disableInteractive();
    door.setFrame(3);
    sfx('door', 0.4);
    this.time.delayedCall(250, () => this.player.goTo(ENTRY, () => door.setFrame(0)));

    const lead = this.agents.values().next().value as Agent | undefined;
    this.time.delayedCall(800, () =>
      lead?.say(spheres ? 'Welcome to The Spheres! Type a request below — I’ll dispatch the right agent in the city.' : `Welcome to ${d!.hq}! We sit at our desks when real AWS calls run. Ask us anything below.`, {
        holdMs: 5000,
      }),
    );

    this.setupCamera();
    this.input.on('pointerup', (ptr: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      if (over.length || ptr.getDistance() > 8) return;
      const t = toTile(ROOM_ISO, ptr.worldX, ptr.worldY);
      if (t.x === DOOR.x && t.y === DOOR.y) {
        this.player.goTo(DOOR, () => useCity.getState().setView({ name: 'city' }));
        return;
      }
      if (this.world.walkable(t.x, t.y)) this.player.goTo(t);
    });

    this.offs.push(bus.on('server', (e) => this.onServer(e)));
    const teardown = () => {
      for (const off of this.offs) off();
      this.offs = [];
    };
    onSceneEnd(this, teardown);
  }

  override update(time: number, dt: number) {
    // As in the city: one on-screen size at every zoom, times the player's text size (⋯ → Text size).
    const cam = this.cameras.main;
    const text = (useCity.getState().prefs.textSize ?? 100) / 100;
    const ui = text / cam.zoom;
    if (this.title) {
      // Top centre of the view, 8 px down, wrapped to the view's width (The Spheres' line is long for the side panel).
      const wrap = Math.max(160, Math.floor((this.scale.width - 32) / text));
      if (this.title.style.wordWrapWidth !== wrap) this.title.setWordWrapWidth(wrap);
      this.title.setScale(ui).setPosition(cam.midPoint.x, cam.midPoint.y - cam.height / 2 / cam.zoom + 8 / cam.zoom);
      // Speech bubbles stay below the sign (screen px from the top of the view).
      setBubbleTopInset(this, Math.ceil(12 + this.title.displayHeight * cam.zoom));
    }
    for (const a of this.agents.values()) {
      a.update(time, dt);
      a.setUiScale(ui);
    }
    this.player.update(time, dt);
    this.player.setUiScale(ui);
  }

  private setupCamera() {
    const cam = this.cameras.main;
    const c = toScreen(ROOM_ISO, W / 2 - 0.5, H / 2 - 0.5);
    const fit = () => {
      const z = Math.min(this.scale.width / 360, this.scale.height / 300);
      cam.setZoom(Phaser.Math.Clamp(Math.floor(z + 0.3), 1, 4));
      cam.centerOn(c.x, c.y - 24);
    };
    fit();
    this.scale.on('resize', fit);
    this.offs.push(() => this.scale.off('resize', fit));
  }

  private furniture(piece: Piece) {
    const [key, x, y] = piece;
    const n = cornerScreen(ROOM_ISO, x, y);
    addSprite(this, key, n.x, n.y).setDepth(entityDepth(toScreen(ROOM_ISO, x, y).y));
    for (const t of tilesOf(piece)) this.blocked.add(t.y * W + t.x);
  }

  private onServer(e: ServerEvent) {
    switch (e.type) {
      case 'agent.state':
        this.agents.get(e.agentId)?.setDetail(e.state === 'working' ? e.detail : undefined);
        this.agents.get(e.agentId)?.setWorking(e.state === 'working');
        break;
      case 'agent.message':
        // As in the city: agents talking among themselves are ambient (a bubble only with chatter on) and never blip.
        this.agents.get(e.from)?.say(e.text, { priority: e.to === 'user' ? 'normal' : 'ambient', silent: e.to !== 'user' });
        break;
      case 'chat.answer': {
        if (e.districtId !== this.districtId) return;
        const text = (this.answers.get(e.requestId) ?? '') + e.delta;
        this.answers.set(e.requestId, text);
        // The answer is in the chat panel: the agent only points to it (seen 21 Nov 2026: shown twice, it read as two answers).
        if (e.done && text.trim()) {
          const a = this.agents.get(e.agentId) ?? this.agents.values().next().value;
          a?.say('Answered in the chat ↓', { holdMs: 4000 });
        }
        break;
      }
    }
  }
}
