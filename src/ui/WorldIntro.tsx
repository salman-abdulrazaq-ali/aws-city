import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { onWorldMap, requestDive, worldMapUp } from '@/game/worldUi';
import { useCity } from '@/state/store';
import { CITY_REGION, REGIONS } from '@/world/culture';
import { FIRST_STEPS } from '@/state/firstSteps';
import { Portrait } from './Portrait';
import { Plain } from './Term';
import { openEverything } from './useLadder';

/** The City tab's panel (App.tsx), where the To-do list or the shift opens. */
const CITY_PANEL_ID = 'city-tabpanel';

/**
 * A first run opens on the world map: Connie says one line and offers the suggested Region (it pulses on the map),
 * so a new player never has to understand Regions before they can play. Gone once any Region is picked.
 * `docked`: the side panel's map is short, so the card stands just under it (App.tsx) and never covers the dots.
 *
 * "Start in <city>" dives into the city like a picked dot (WorldScene.dive, through `requestDive`): the press answers in
 * the same frame, the card steps aside, and the zoom and the fade to the sea cover the city's build. Under reduced
 * motion the dive is a cut; with no world map left by the press (it went meanwhile) the Region opens at once.
 *
 * Connie points at glowing dots, so the card waits for the world map (`worldMapUp`: WorldScene registers its dive
 * right after its first draw). Before that the boot bar ("Building AWS City…") stands alone, and a press can always dive.
 *
 * The choice (DESIGN-tutorial §3): beginners are the default. The card showing chooses the first steps
 * (`prefs.firstSteps = 'beginner'`), so "Start in Oregon" and a dot picked on the map both start them on arrival; "I
 * already know AWS" opens the whole city instead (the old "I already build on AWS") and skips them. A pref already set
 * (the smoke's opt-out, 'skipped') is kept.
 */
export function WorldIntro({ docked = false }: { docked?: boolean }) {
  const onWorld = useCity((s) => s.view.name === 'world');
  const picked = useCity((s) => !!s.prefs.region);
  const enterRegion = useCity((s) => s.enterRegion);
  const setPref = useCity((s) => s.setPref);
  const mapUp = useSyncExternalStore(onWorldMap, worldMapUp, worldMapUp);
  /** The map is diving: the card keeps its place (nothing below it jumps) but can't be seen, read or focused. */
  const [going, setGoing] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const shown = onWorld && !picked && !!CITY_REGION && (mapUp || going);
  // Before any dot is picked (WorldScene's own press calls enterRegion, which starts the path when this is set).
  useEffect(() => {
    if (shown && !useCity.getState().prefs.firstSteps) setPref('firstSteps', 'beginner');
  }, [shown, setPref]);
  if (!shown || !CITY_REGION) return null;
  // The intro (and the button pressed) goes with the world map: focus moves to the city's panel, never <body>. After
  // the frame in which the city scene may take the keys (createGame's focusSoon): a canvas that took them keeps them,
  // so the arrow keys walk Kai as the tour says ("Keys go to the canvas when … the city starts"; seen in review 23 Nov
  // 2026: moving focus off the canvas left the arrows scrolling the panel after the tour). Focus left on the intro
  // (hidden once the dive starts) goes to the panel too. Unless the player moved on.
  const toPanel = () => {
    const a = document.activeElement;
    if (!a || a === document.body || card.current?.contains(a)) document.getElementById(CITY_PANEL_ID)?.focus({ preventScroll: true });
  };
  const start = () => {
    // Set before the Region opens (enterRegion starts the first steps); never over the smoke's 'skipped'.
    if (useCity.getState().prefs.firstSteps !== 'skipped') setPref('firstSteps', 'beginner');
    dive();
  };
  const dive = () => {
    if (!requestDive(REGIONS.cityRegion)) {
      enterRegion(REGIONS.cityRegion);
      requestAnimationFrame(toPanel);
      return;
    }
    setGoing(true);
    requestAnimationFrame(toPanel);
    if (useCity.getState().view.name === 'city') return; // reduced motion: the dive was a cut
    // Once the dive has entered the city, again after the frame in which the city may take the keys.
    const off = useCity.subscribe((s, prev) => {
      if (s.view === prev.view) return;
      off();
      if (s.view.name === 'city') requestAnimationFrame(toPanel);
    });
  };
  return (
    <div
      ref={card}
      className={`world-intro${docked ? ' docked' : ''}`}
      role="region"
      aria-label="Where to start"
      inert={going || undefined}
      style={going ? { visibility: 'hidden' } : undefined}
    >
      <Portrait id="concierge" size={32} />
      <p>
        <b>Connie:</b> <Plain text={FIRST_STEPS.map.connie} />
      </p>
      <div className="world-intro-go">
        <button className="btn primary" onClick={start}>
          {FIRST_STEPS.map.start.replace('Oregon', CITY_REGION.city)}
        </button>
        <span className="world-intro-note">{FIRST_STEPS.map.note}</span>
      </div>
      <button
        className="btn ghost tiny"
        title="The whole game: every tab and area open from the start (Everything, not Simple), and the deeper text shown first. Play the first steps any time from ⋯."
        onClick={() => {
          setPref('builder', true);
          setPref('simple', false);
          openEverything();
          useCity.getState().skipFirstSteps();
          dive();
        }}
      >
        {FIRST_STEPS.map.advanced}
      </button>
    </div>
  );
}
