import { useCity } from '@/state/store';
import { CITY_REGION, REGIONS } from '@/world/culture';
import { Portrait } from './Portrait';
import { openEverything } from './useLadder';

/** The City tab's panel (App.tsx), where the To-do list or the shift opens. */
const CITY_PANEL_ID = 'city-tabpanel';

/**
 * A first run opens on the world map: Connie says one line and offers the suggested Region (it pulses on the map),
 * so a new player never has to understand Regions before they can play. Gone once any Region is picked.
 */
export function WorldIntro() {
  const onWorld = useCity((s) => s.view.name === 'world');
  const picked = useCity((s) => !!s.prefs.region);
  const enterRegion = useCity((s) => s.enterRegion);
  const setPref = useCity((s) => s.setPref);
  if (!onWorld || picked || !CITY_REGION) return null;
  // The intro (and the button pressed) goes with the world map: focus moves to the city's panel, never <body>. After
  // the frame in which the city scene may take the keys (createGame's focusSoon): a canvas that took them keeps them,
  // so the arrow keys walk Kai as the tour says ("Keys go to the canvas when … the city starts"; seen in review 23 Nov
  // 2026: moving focus off the canvas left the arrows scrolling the panel after the tour). Unless the player moved on.
  const start = () => {
    enterRegion(REGIONS.cityRegion);
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body) document.getElementById(CITY_PANEL_ID)?.focus({ preventScroll: true });
    });
  };
  return (
    <div className="world-intro" role="region" aria-label="Where to start">
      <Portrait id="concierge" size={32} />
      <p>
        <b>Connie:</b> AWS is Amazon’s cloud: the computers that run much of the internet. Build a city and learn how it works. Every glowing dot is a place AWS runs. Pick one to build your city there!
      </p>
      <button className="btn primary" onClick={start}>
        Start in {CITY_REGION.city}
      </button>
      <button
        className="btn ghost tiny"
        title="The whole game: every tab and area open from the start (Everything, not Simple), and the deeper text shown first. Change it any time in ⋯."
        onClick={() => {
          setPref('builder', true);
          setPref('simple', false);
          openEverything();
          start();
        }}
      >
        I already build on AWS
      </button>
    </div>
  );
}
