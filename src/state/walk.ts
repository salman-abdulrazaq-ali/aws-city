import { bus } from './bus';
import { taskById } from '@/world/clients';
import { activeSteps } from './ladder';
import { useCity } from './store';

/**
 * A walk asked for from a mini-game, an HQ or the world map (a game's end card, the To-do list) goes back to the city
 * first, so the player sees Kai walk (the city wakes at once: createGame's view sync). Not from a first run's world map,
 * where no city is picked yet.
 */
function backToCity() {
  const s = useCity.getState();
  if (s.view.name === 'city' || (s.view.name === 'world' && !s.prefs.region)) return;
  s.setView({ name: 'city' });
}

/** The building whose card waits for Kai: the press's own `select` (the city sends one at once) doesn't open it. */
let held: string | undefined;
/** Stops watching for the last walk's visit to count. */
let stopWatching: (() => void) | undefined;

/** App's card opener asks this about each `select`: true for the one a walk sent at its press, so no card opens yet. */
export const cardWaitsForKai = (id: string) => held === id;

const visitOpen = (id: string) => activeSteps(useCity.getState().progress).some((st) => st.kind === 'visit' && st.serviceId === id);

/**
 * Kai walks to a landmark and a quest's visit step counts when he gets there (CityScene's `walkTo`). Its card opens
 * then too, with the step ticked, never while he's still walking (seen 22 Nov 2026: the card opened at the press and the
 * step stayed unticked). When the city can't walk him (asleep behind a game or an HQ), the visit counts at once, so a
 * quest never waits on a scene that isn't running.
 */
export function walkTo(id: string) {
  backToCity();
  stopWatching?.();
  stopWatching = undefined;
  const waits = visitOpen(id);
  let taken = false;
  held = waits ? id : undefined;
  bus.emit('walkTo', { id, accept: () => (taken = true) });
  held = undefined;
  if (!taken) {
    useCity.getState().select(id);
    useCity.getState().arrive(id);
    return;
  }
  if (!waits) return;
  // He's there when the visit counts: the card opens on the step just ticked. Tapping another building ends the wait.
  const offStore = useCity.subscribe((s, prev) => {
    if (s.progress === prev.progress || visitOpen(id)) return;
    stop();
    bus.emit('select', { id });
  });
  const offSelect = bus.on('select', (e) => e.id !== id && stop());
  const stop = () => {
    offStore();
    offSelect();
    if (stopWatching === stop) stopWatching = undefined;
  };
  stopWatching = stop;
}

/**
 * City Clients: Kai walks to the station of a side job (its business's site, src/world/clients.ts) and the job opens
 * when he gets there. A station out on the landscape ring (no walking out there) is reached at the city gate while the
 * camera looks at it; a city that can't walk him (asleep behind a game or an HQ) opens the job at once.
 */
export function walkToStation(taskId: string) {
  const ref = taskById(taskId);
  if (!ref) return;
  const open = () => useCity.getState().openClientTask(taskId);
  backToCity();
  let taken = false;
  bus.emit('walkToStation', { clientId: ref.client.id, station: ref.task.station, accept: () => (taken = true), arrived: open });
  if (!taken) open();
}
