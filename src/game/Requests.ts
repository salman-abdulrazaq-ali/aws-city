import Phaser from 'phaser';
import { announce } from '@/state/announce';
import { bus } from '@/state/bus';
import { FIRST_STEPS, firstStep } from '@/state/firstSteps';
import { pickRequest, REQUEST_GAP_MS, REQUEST_LOG_KEY, requestsLeft, type CitizenRequest, type RequestLog } from '@/state/requests';
import { dayKey } from '@/state/progress';
import { useCity } from '@/state/store';
import type { Tile } from '@/world/layout';
import type { Agent } from './Agent';
import { click } from './audio';
import { cityShows, plantedFor, plantedRequest, plantTile, streetQuestions } from './firstStepsGame';
import { reducedMotion } from './motion';
import { crisp, TEXT_FONT } from './SpeechBubble';
import { CSS, labelStyle } from './theme';

/** How far the "?" floats over the citizen's feet, and how wide their body is (crowd sheets, in the mark's units). */
const MARK_LIFT = 58;
const BODY_W = 28;

const readLog = (): RequestLog | undefined => {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(REQUEST_LOG_KEY) ?? 'null') as RequestLog | null;
    return v && typeof v.day === 'string' && typeof v.n === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
};

/** What the first steps' planted citizen needs from the city: its streets, a building's work spot, the camera on Kai. */
export interface RequestPlaces {
  streets: () => Tile[];
  spot: (serviceId: string) => Tile | undefined;
  /** Kai is walking over to the citizen: the camera goes with him. */
  followKai?: () => void;
}

/**
 * One citizen at a time has a question (src/state/requests.ts): a gold "?" over an existing pedestrian (no new walkers,
 * so the crowd cap holds). Tapping the "?" walks Kai over; reaching them (by any route) opens the question card. The
 * "?" stays until the question is answered (the card counts it then): closed unanswered, it opens again once Kai steps
 * away and comes back.
 *
 * The first steps (src/state/firstSteps.ts): while the city is quiet random questions wait (none spawns, one already up
 * goes). Their `request` step (or the UI's bus `requestNow`) plants one citizen a few tiles from Kai, by the step's
 * building, asking about a tutorial card; the guide's "Walk to the citizen" (bus `walkToRequest`) walks Kai there.
 */
export class Requests {
  private asker?: Agent;
  /** Whose "?" is up: a random passer-by's, or the first steps' planted citizen's. */
  private kind: 'random' | 'planted' = 'random';
  /** The planted question waiting to be answered (its service, and the card the UI named), kept until it's answered. */
  private planted?: { serviceId: string; cardId?: string };
  /** "Walk to the citizen" came before the citizen stood there: Kai walks over once they do. */
  private walkWhenPlanted = false;
  private mark?: Phaser.GameObjects.Text;
  private bob?: Phaser.Tweens.Tween;
  private nextAt: number;
  /** 'open': the card is up. 'closed': closed unanswered, and Kai hasn't stepped away yet (so it doesn't reopen at once). */
  private card: 'none' | 'open' | 'closed' = 'none';
  private offs: (() => void)[];

  constructor(
    private scene: Phaser.Scene,
    private citizens: () => Agent[],
    private player: () => Agent,
    private places?: RequestPlaces,
  ) {
    // The first one comes a little while after arriving, not on the doorstep.
    this.nextAt = scene.time.now + REQUEST_GAP_MS / 3;
    this.offs = [
      bus.on('citizenRequestDone', ({ answered }) => {
        if (answered) {
          if (this.kind === 'planted') this.planted = undefined;
          this.clear(this.scene.time.now);
        } else if (this.card === 'open') this.card = 'closed';
      }),
      // Asked again (the guide naming a card): the same citizen keeps standing there, with that card.
      bus.on('requestNow', ({ serviceId, cardId }) => {
        if (this.planted?.serviceId === serviceId) this.planted = { serviceId, cardId: cardId ?? this.planted.cardId };
        else {
          if (this.kind === 'planted') this.clear(this.scene.time.now);
          this.planted = { serviceId, cardId };
        }
      }),
      bus.on('walkToRequest', () => {
        if (this.kind === 'planted' && this.asker) this.walkOver();
        else this.walkWhenPlanted = true;
      }),
    ];
  }

  update(time: number, ui: number) {
    const st = useCity.getState();
    // The path's own step plants its citizen too (a reload on that step, or the UI's requestNow sent before the city ran).
    const due = plantedFor(firstStep(st.progress, st.prefs));
    if (due && !this.planted) this.planted = { serviceId: due };
    const quiet = !cityShows('citizenRequests', st.progress, st.prefs);
    if (streetQuestions(quiet, this.asker ? this.kind : 'none').dropCurrent) this.clear(time);
    if (!this.asker) {
      if (this.planted) this.plant(time);
      // Paused: the first random one comes a whole gap after the quiet ends (graduation), not at once.
      else if (quiet) this.nextAt = Math.max(this.nextAt, time + REQUEST_GAP_MS);
      else if (time >= this.nextAt) this.spawn(time);
      return;
    }
    if (!this.citizens().includes(this.asker)) return this.clear(time); // the crowd thinned (panel width)
    const s = this.asker.screen;
    this.mark?.setPosition(Math.round(s.x), Math.round(s.y - MARK_LIFT * ui)).setScale(ui);
    const p = this.player();
    const near = Math.abs(p.gx - this.asker.gx) + Math.abs(p.gy - this.asker.gy) <= 1;
    if (!near && this.card === 'closed') this.card = 'none';
    // Not while Decorate is open (its card would cover the drawer): the citizen waits and asks once it closes.
    else if (near && this.card === 'none' && !useCity.getState().build) this.open(time);
  }

  private spawn(time: number) {
    this.nextAt = time + REQUEST_GAP_MS;
    const today = dayKey();
    if (requestsLeft(readLog(), today) <= 0) return;
    const st = useCity.getState();
    if (st.view.name !== 'city') return;
    const idle = this.citizens().filter((c) => !c.isBusy);
    const who = idle[Math.floor(Math.random() * idle.length)];
    if (!who || !pickRequest(st.progress, st.cityRegion, 0)) return;
    this.ask(who, 'random');
  }

  /**
   * The first steps' citizen: an idle passer-by (the one nearest the spot, so no random draw) steps onto a street tile a
   * few tiles from Kai by the building, faces him, says the path's line and gets the "?". Waits a frame when nobody's free.
   */
  private plant(time: number) {
    const planted = this.planted!;
    if (useCity.getState().view.name !== 'city' || !this.places) return;
    const kai = this.player().tile;
    const tile = plantTile(kai, this.places.spot(planted.serviceId), this.places.streets());
    const idle = this.citizens().filter((c) => !c.isBusy);
    if (!tile || !idle.length) return;
    const d = (c: Agent) => Math.abs(c.gx - tile.x) + Math.abs(c.gy - tile.y);
    const who = idle.reduce((a, b) => (d(b) < d(a) ? b : a));
    who.teleport(tile);
    who.face(kai);
    this.ask(who, 'planted');
    this.nextAt = Math.max(this.nextAt, time + REQUEST_GAP_MS);
    const line = FIRST_STEPS.steps[3]?.citizen;
    if (line && who.say(line, { caption: 'to you' })) announce(`A citizen says: ${line}`);
    if (this.walkWhenPlanted) this.walkOver();
  }

  /** The gold "?" over a citizen, pinned where they stand; tapping it walks Kai over. */
  private ask(who: Agent, kind: 'random' | 'planted') {
    this.asker = who;
    this.kind = kind;
    who.pin(true);
    this.mark = crisp(this.scene.add.text(0, 0, '?', { ...labelStyle(TEXT_FONT, CSS.accentInk), fontSize: '15px', fontStyle: '900', backgroundColor: CSS.gold, padding: { x: 6, y: 2 } }))
      .setOrigin(0.5, 1)
      .setDepth(50_500);
    // The "?" is tappable down to the citizen's feet: standing in front of a building, they win the tap (the mark sits
    // over every building, and the scene's input takes only the top-most object).
    const w = Math.max(this.mark.width, BODY_W);
    this.mark
      .setInteractive({ hitArea: new Phaser.Geom.Rectangle((this.mark.width - w) / 2, 0, w, this.mark.height + MARK_LIFT), hitAreaCallback: Phaser.Geom.Rectangle.Contains, useHandCursor: true })
      .on('pointerup', (ptr: Phaser.Input.Pointer) => {
        if (ptr.getDistance() >= 8 || !this.asker) return;
        click();
        this.player().goTo(this.asker.tile);
      });
    if (!reducedMotion()) this.bob = this.scene.tweens.add({ targets: this.mark, scaleY: { from: 1, to: 1.12 }, yoyo: true, repeat: -1, duration: 500, ease: 'Sine.easeInOut' });
  }

  /** Kai walks to the planted citizen, the camera with him; reaching them opens the question, as a tap on the "?" does. */
  private walkOver() {
    this.walkWhenPlanted = false;
    if (!this.asker) return;
    this.places?.followKai?.();
    this.player().goTo(this.asker.tile);
  }

  private open(time: number) {
    const who = this.asker!;
    const st = useCity.getState();
    const request: CitizenRequest | undefined =
      this.kind === 'planted' && this.planted
        ? (plantedRequest(st.progress, this.planted.serviceId, this.planted.cardId) ?? pickRequest(st.progress, st.cityRegion, 0))
        : pickRequest(st.progress, st.cityRegion, Math.floor(Math.random() * 1e6));
    if (!request) {
      if (this.kind === 'planted') this.planted = undefined;
      return this.clear(time); // nothing left to ask about here
    }
    who.face(this.player().tile);
    who.emote('wave', 1200);
    this.card = 'open';
    bus.emit('citizenRequest', { request, name: who.name.split(' · ')[0] ?? 'A citizen' });
  }

  private clear(time: number) {
    this.card = 'none';
    this.asker?.pin(false);
    this.asker = undefined;
    this.kind = 'random';
    this.bob?.remove();
    this.bob = undefined;
    this.mark?.destroy();
    this.mark = undefined;
    this.nextAt = Math.max(this.nextAt, time + REQUEST_GAP_MS);
  }

  destroy() {
    for (const off of this.offs) off();
    this.clear(0);
  }
}
