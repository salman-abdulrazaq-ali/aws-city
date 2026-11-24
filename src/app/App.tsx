import { ClientsBoard } from '@/ui/clients/ClientsPanel';
import { ClientDone, ClientTask } from '@/ui/clients/ClientTask';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from 'react';
import { REGIONS } from '@/world/culture';
import { bus } from '@/state/bus';
import { openFindings, SETTLE, settledTo, useCity } from '@/state/store';
import { ChatPanel } from '@/ui/ChatPanel';
import { Hud, SyncNote } from '@/ui/Hud';
import { Workshop } from '@/ui/Workshop';
import { Collection } from '@/ui/Collection';
import { AccountMap } from '@/ui/AccountMap';
import { CoinFly } from '@/ui/CoinFly';
import { Leaderboard } from '@/ui/Leaderboard';
import { LaunchDay } from '@/ui/launch/LaunchDay';
import { Celebrate } from '@/ui/Celebrate';
import { CarrierCard } from '@/ui/CarrierCard';
import { RequestCard } from '@/ui/RequestCard';
import { ChoiceCard } from '@/ui/ChoiceCard';
import { IncidentCard } from '@/ui/IncidentCard';
import { NewsTicker } from '@/ui/NewsTicker';
import { MapCredit, Minimap } from '@/ui/Minimap';
import { LandmarkCard } from '@/ui/LandmarkCard';
import { PromptBar } from '@/ui/PromptBar';
import { Toasts } from '@/ui/Toasts';
import { ArchitectureBoard } from '@/ui/ArchitectureBoard';
import { Sandbox } from '@/ui/diagram/Sandbox';
import { DeployPanel } from '@/ui/DeployPanel';
import { Flashcards } from '@/ui/Flashcards';
import { badgeCount } from '@/state/srs';
import { activeSteps, type Tab } from '@/state/ladder';
import { isSimple, shows } from '@/state/simple';
import { linking } from '@/state/account';
import { setNextRunner } from '@/state/next';
import { runPlan, type OpenTab as GoTo } from '@/ui/QuestLog';
import { Home, taskMovedOn } from '@/ui/Home';
import { Navigator } from '@/ui/Navigator';
import { Icon, type IconName } from '@/ui/icons';
import { CoachTips, Tour, useFirstRunTour } from '@/ui/Tour';
import { FirstStepsMoments, GuideCard, GuideStrip, useFirstSteps, useQuiet } from '@/ui/FirstSteps';
import { FIRST_STEPS_QUEST } from '@/state/firstSteps';
import { WorldIntro } from '@/ui/WorldIntro';
import { useCanConnect, useLadder } from '@/ui/useLadder';
import { FindingCard } from '@/ui/FindingCard';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { SoundCaptions } from '@/ui/SoundCaptions';
import { BuildDrawer } from '@/ui/BuildDrawer';
import { useKeepFocus } from '@/ui/useDialog';
import { cardWaitsForKai } from '@/state/walk';
import { citySummary, newlyUnlocked, nextTabIndex, readPref, readSet, TAB_KEY, UNLOCK_TOASTS_KEY, unlockText, writePref, writeSet } from '@/ui/logic';
import { GameCanvas } from './GameCanvas';
import type { Layout } from './runtime';

/**
 * Where a button can send the player. Older names still land in the right place: 'feed', 'quests' and 'map' are the
 * City tab; 'info' is a building's card in City; 'cards', 'arch' and 'sandbox' are Learn's Cards, Puzzles and Drawing board.
 */
export type OpenTab = Tab | Parameters<GoTo>[0] | 'info';

const TABS: [Tab, IconName, string][] = [
  ['home', 'home', 'City'],
  ['learn', 'learn', 'Learn'],
  ['jobs', 'quests', 'Jobs'],
  ['deploy', 'deploy', 'Deploy'],
];

const labelOf = (t: Tab) => TABS.find(([id]) => id === t)![2];

/** The side panel's map at its smallest (styles/01-layout.css): it shrinks there while the tab below is scrolled. */
const STAGE_FLOOR = 150;

const savedTab = (): Tab => {
  const t = readPref(TAB_KEY);
  return TABS.some(([id]) => id === t) ? (t as Tab) : 'home';
};

export function App({ layout }: { layout: Layout }) {
  const view = useCity((s) => s.view);
  // Build mode in the side panel takes the panel's whole height for the city and its drawer (styles/26-build.css).
  const building = useCity((s) => !!s.build);
  const celebrating = useCity((s) => !!s.celebration);
  // After graduation's card, AWS news waits its turn (store SETTLE): the coins note and Connie's word come first.
  const newsTurn = useCity((s) => settledTo(s, SETTLE.banner));
  const stage = useCity((s) => s.prefs.stage);
  const setPref = useCity((s) => s.setPref);
  const cityRegion = useCity((s) => s.cityRegion);
  const regionCity = REGIONS.regions.find((r) => r.code === cityRegion)?.city ?? cityRegion;
  const openWorld = useCity((s) => s.openWorld);
  const textSize = useCity((s) => s.prefs.textSize);
  const contrast = useCity((s) => !!s.prefs.contrast);
  const easyFont = useCity((s) => !!s.prefs.easyFont);
  // Accessibility prefs (⋯ menu) live on <html>, so every stylesheet can follow them (styles/22-access.css).
  useEffect(() => {
    const d = document.documentElement.dataset;
    if (textSize) d.text = String(textSize);
    else delete d.text;
    if (contrast) d.contrast = 'high';
    else delete d.contrast;
    if (easyFont) d.font = 'easy';
    else delete d.font;
  }, [textSize, contrast, easyFont]);
  const [tab, setTabState] = useState<Tab>(savedTab);
  /** The player went to this tab (a button that said so): it shows while they're there, locked or not. */
  const [visiting, setVisiting] = useState(false);
  /** The Jobs tab: a business ('' = the order board and every business). */
  const [jobsAt, setJobsAt] = useState('');
  const [learn, setLearn] = useState<'cards' | 'build' | 'sandbox'>('cards');
  const [place, setPlace] = useState(false);
  /** Where the side panel's tab was scrolled down (view and tab): there the map steps back to its floor so the reading gets the room. */
  const [readingAt, setReadingAt] = useState<string>();
  const [deployBadge, setDeployBadge] = useState(false);
  const [homeBadge, setHomeBadge] = useState(false);
  const due = useCity((s) => badgeCount(s.progress));
  // The unlock ladder: which tabs (and panels) this player has earned. A button that sends the player to a tab not
  // earned yet shows it while they're there; it never opens it for good (src/state/ladder.ts).
  const l = useLadder();
  // Simple mode (src/state/simple.ts): Deploy only when it's needed (a quest's deploy step, a linked account, a change
  // waiting for approval); the Drawing board only for a quest's design step. Everything shows them as the ladder says.
  const prefs = useCity((s) => s.prefs);
  const simple = isSimple(prefs);
  const steps = useCity((s) => activeSteps(s.progress).map((x) => x.kind).join());
  const linked = useCity((s) => s.account.linked);
  const deployWaiting = useCity((s) => Object.values(s.deploys).some((d) => d.status === 'preview' && !d.findingId));
  // A real account being linked keeps Deploy (its steps) in sight, in Simple too (src/state/account.ts), and so does a
  // hosted player with no account linked yet (Deploy is where it connects).
  const linkingNow = useCity((s) => linking(s.account));
  const canConnect = useCanConnect();
  // The first steps (src/state/firstSteps.ts): the quiet city hides what the path doesn't teach yet, in either mode.
  const path = useFirstSteps();
  const quiet = useQuiet();
  const simpleCtx = { steps: steps.split(','), linked, deployWaiting, linking: linkingNow, canConnect, ...quiet };
  const deployShown = shows('deployTab', prefs, simpleCtx);
  /** The tabs this player has earned and this mode shows (a new one gets the unlock toast). */
  const earned = useMemo(() => new Set([...l.tabs].filter((t) => t !== 'deploy' || deployShown)), [l.tabs, deployShown]);
  // A saved tab that isn't earned (another player's, before the ladder, or hidden in Simple) shows City.
  const shownTab: Tab = earned.has(tab) || visiting ? tab : 'home';
  const tabs = TABS.filter(([t]) => earned.has(t) || t === shownTab);
  // Only in the view and tab where it was scrolled.
  const readingKey = `${view.name}:${shownTab}`;
  const reading = layout === 'panel' && readingAt === readingKey;
  /**
   * Panel only: scrolled down far enough (and with enough below that the map's room is read, not just a jump back),
   * the map shrinks to its floor; back at the top, it grows again.
   */
  const onBodyScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (reading) return void (el.scrollTop <= 2 && setReadingAt(undefined));
    const map = el.closest('.app')?.querySelector('.stage')?.getBoundingClientRect().height ?? 0;
    if (el.scrollTop > 32 && el.scrollHeight - el.clientHeight > map - STAGE_FLOOR + 64) setReadingAt(readingKey);
  };
  /** Tabs that just unlocked: a dot until they're opened. */
  const [fresh, setFresh] = useState<ReadonlySet<Tab>>(new Set());
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const body = useRef<HTMLDivElement>(null);
  const tabNow = useRef(tab);
  tabNow.current = tab;

  const setTab = (to: OpenTab) => {
    const t: Tab = to === 'learn' || to === 'cards' || to === 'arch' || to === 'sandbox' ? 'learn' : to === 'deploy' ? 'deploy' : to === 'jobs' ? 'jobs' : 'home';
    if (to === 'cards' || to === 'learn') setLearn('cards');
    if (to === 'arch') setLearn('build');
    if (to === 'sandbox') setLearn('sandbox');
    // City: a building's card ('info'), else today's shift and the places.
    if (t === 'home') setPlace(to === 'info');
    setVisiting(true);
    setFresh((f) => (f.has(t) ? new Set([...f].filter((x) => x !== t)) : f));
    setTabState(t);
    writePref(TAB_KEY, t);
    if (t === 'deploy') setDeployBadge(false);
    if (t === 'home') setHomeBadge(false);
    // Every tab starts at its top, never half-scrolled (and the map comes back to its size).
    body.current?.scrollTo({ top: 0 });
    setReadingAt(undefined);
  };


  useEffect(
    () =>
      useCity.subscribe((s, p) => {
        // Another view (an HQ's chat, a game, the world map) gives the map its size back.
        if (s.view.name !== p.view.name) setReadingAt(undefined);
        // Decorate clears the picked building: the side column goes back to the shift, never a "Pick a place" card
        // waiting for one (during or after decorating).
        if (s.build && !p.build) setPlace(false);
      }),
    [],
  );
  // A building tapped (in the city or a list): its card opens in the City tab, in place of the shift. A "Walk to" opens
  // it when Kai gets there (src/state/walk.ts), not at the press.
  useEffect(() => bus.on('select', ({ id }) => !cardWaitsForKai(id) && setTab('info')), []);
  // A button that went away with its row, tab or card leaves focus on the new panel's heading, never on <body>.
  const side = useRef<HTMLElement>(null);
  useKeepFocus(side, () => body.current);
  // Home's big button (src/state/next.ts nextAction) runs through here, so it can open the tab its label names.
  const setTabNow = useRef(setTab);
  setTabNow.current = setTab;
  useEffect(() => setNextRunner((plan) => (taskMovedOn(), runPlan(plan, (t) => setTabNow.current(t)))), []);
  // ⋯ → Account (outside the tabs) shows a tab the way a button that names it does.
  useEffect(() => bus.on('showTab', ({ tab }) => setTabNow.current(tab)), []);
  // City Clients (a business tapped in the city, a job closed, "All businesses"): the Jobs tab shows it.
  const clientsOpen = useCity((s) => s.clientsOpen);
  useEffect(() => {
    if (clientsOpen === undefined) return;
    setJobsAt(clientsOpen);
    setTabNow.current('jobs');
    useCity.getState().openClients(undefined);
  }, [clientsOpen]);
  // A new deploy preview: jump there only from City; otherwise flag the Deploy tab.
  useEffect(
    () =>
      useCity.subscribe((s, p) => {
        if (Object.keys(s.deploys).length <= Object.keys(p.deploys).length) return;
        // A fix's preview is approved in its finding's card, never in the Deploy tab.
        const added = Object.values(s.deploys).filter((d) => !p.deploys[d.deployId]);
        const fix = added.find((d) => d.findingId);
        if (fix) {
          if (s.findingOpen !== fix.findingId) s.openFinding(fix.findingId);
          if (added.every((d) => d.findingId)) return;
        }
        // From City the tab opens; anywhere else (an HQ's chat hides the tabs, Learn, Jobs) a toast says so and opens it.
        const waiting = added.find((d) => !d.findingId && d.status === 'preview');
        if (s.view.name !== 'interior' && tabNow.current === 'home') setTab('deploy');
        else if (s.view.name === 'interior' || tabNow.current !== 'deploy') {
          setDeployBadge(true);
          if (waiting) s.toast('🛡️', 'Your approval is waiting in Deploy. Tap here to open it.', 'info', undefined, undefined, { first: true, action: () => useCity.getState().openDeployAt(waiting.deployId) });
        }
      }),
    [],
  );
  // "Approve in Deploy" (a task card, a toast): open the tab; DeployPanel brings the card up.
  const deployOpenSeq = useCity((s) => s.deployOpenSeq);
  useEffect(() => {
    if (deployOpenSeq) setTabNow.current('deploy');
  }, [deployOpenSeq]);
  // A prompt sent (or a reply to the player) while another tab is open: flag Home, where the answer shows.
  useEffect(
    () =>
      useCity.subscribe((s, p) => {
        if (s.feed === p.feed) return;
        const last = s.feed.at(-1);
        // The player asked something while a building's card was open: back to the shift, where the agent's work shows.
        if (tabNow.current === 'home') {
          if (last && last !== p.feed.at(-1) && last.kind === 'user') setPlace(false);
          return;
        }
        if (last && last !== p.feed.at(-1) && (last.kind === 'user' || (last.kind === 'message' && last.to === 'user'))) setHomeBadge(true);
      }),
    [],
  );
  // First run: the coach-mark tour, once the city has arrived; never for a player on, past or back from the first steps.
  useFirstRunTour();

  // A tab that newly appears: one toast (once per browser) and a dot until it's opened.
  const prevTabs = useRef<ReadonlySet<Tab> | undefined>(undefined);
  useEffect(() => {
    const prev = prevTabs.current;
    prevTabs.current = earned;
    const shown = readSet(UNLOCK_TOASTS_KEY);
    if (!prev) {
      // What's open when the app starts was earned before: no toast for it.
      if ([...earned].some((t) => !shown.has(t))) writeSet(UNLOCK_TOASTS_KEY, [...shown, ...earned]);
      return;
    }
    const added = newlyUnlocked(prev, earned, shown);
    if (!added.length) return;
    writeSet(UNLOCK_TOASTS_KEY, [...shown, ...added]);
    setFresh((f) => new Set([...f, ...added]));
    // Graduation's card names what opened: the tabs get their dot, never a toast on top of it.
    if (useCity.getState().celebration === FIRST_STEPS_QUEST) return;
    useCity.getState().toast('🔓', unlockText(added.map(labelOf)));
  }, [earned]);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = nextTabIndex(e.key, i, tabs.length);
    if (next === undefined) return;
    e.preventDefault();
    const t = tabs[next][0];
    setTab(t);
    tabRefs.current[t]?.focus();
  };

  const badge = (t: Tab) => (t === 'deploy' && deployBadge) || (t === 'home' && homeBadge) || fresh.has(t);
  return (
    <div
      className={`app app-${layout} stage-${stage} view-${view.name}${building ? ' building' : ''}${reading ? ' reading' : ''}`}
      // The panel's rows slid (reading, a bigger or smaller map): the city redraws at its new size now, not at Phaser's
      // next half-second size check, so no black band shows under it.
      onTransitionEnd={(e) => e.target === e.currentTarget && e.propertyName === 'grid-template-rows' && window.dispatchEvent(new Event('resize'))}
    >
      <Hud layout={layout} />
      <div className="stage">
        <GameCanvas />
        {/* Not while a quest's celebration card is up: the first quest opens AWS news, and it arrives after the card. */}
        {l.news && shows('news', prefs) && !celebrating && newsTurn && (view.name === 'city' || view.name === 'world') && <NewsTicker layout={layout} />}
        <Toasts />
        <CityAnnouncer />
        <SoundCaptions />
        <CarrierCard />
        {/* The panel's map is short: Connie's card stands just under it (in the side column), never over the dots. */}
        {layout === 'full' && <WorldIntro />}
        <Minimap layout={layout} />
        <MapCredit />
        {view.name === 'city' && <BuildDrawer />}
        {view.name === 'city' && (
          <button className="world-btn" onClick={() => openWorld()} title={`You're in ${regionCity} (${cityRegion}). Zoom out to the world map to visit another Region.`} aria-label={`World map. You're in ${regionCity}.`}>
            🌍 <span>{regionCity}</span>
          </button>
        )}

        {layout === 'panel' && view.name !== 'game' && (
          <button
            className="stage-size"
            onClick={() => setPref('stage', stage === 'tall' ? 'compact' : 'tall')}
            title={stage === 'tall' ? 'Make the city smaller' : 'Make the city bigger'}
            aria-label={stage === 'tall' ? 'Make the city smaller' : 'Make the city bigger'}
          >
            <Icon name={stage === 'tall' ? 'chevronUp' : 'chevronDown'} />
          </button>
        )}
      </div>
      <aside className="side" ref={side}>
        <SyncNote />
        {layout === 'panel' && <WorldIntro docked />}
        {view.name === 'interior' && view.districtId !== 'spheres' ? (
          <ChatPanel districtId={view.districtId} />
        ) : (
          <>
            <div className="tabs" role="tablist" aria-label="City panels">
              {tabs.map(([t, icon, label], i) => (
                <button
                  key={t}
                  ref={(el) => {
                    tabRefs.current[t] = el;
                  }}
                  id={`tab-${t}`}
                  role="tab"
                  aria-selected={shownTab === t}
                  aria-controls="city-tabpanel"
                  tabIndex={shownTab === t ? 0 : -1}
                  className={shownTab === t ? 'on' : ''}
                  onClick={() => setTab(t)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  title={label}
                >
                  <Icon name={icon} />
                  <span className="tl">{label}</span>
                  {badge(t) && (
                    <>
                      <span className="badge" aria-hidden="true" />
                      <span className="sr-only">(new)</span>
                    </>
                  )}
                  {t === 'learn' && due > 0 && (
                    <span className="badge-count" aria-label={`${due} cards due`}>
                      {due > 99 ? '99+' : due}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div ref={body} className="tab-body" role="tabpanel" id="city-tabpanel" aria-labelledby={`tab-${shownTab}`} tabIndex={0} onScroll={layout === 'panel' ? onBodyScroll : undefined}>
              <ErrorBoundary what="This tab" resetKey={shownTab}>
              {/* The first steps: Connie's guide stands above whatever the City tab shows, a building's card included. */}
              {shownTab === 'home' && <GuideCard openTab={setTab} />}
              {(shownTab === 'learn' || shownTab === 'deploy') && <GuideStrip tab={shownTab} openTab={setTab} />}
              {shownTab === 'home' &&
                (place ? (
                  <>
                    <button className="btn ghost tiny back-link" onClick={() => setPlace(false)}>
                      <Icon name="back" size={10} /> {path.active ? 'Back' : simple ? 'To do' : 'Today’s shift'}
                    </button>
                    <LandmarkCard openTab={setTab} layout={layout} />
                  </>
                ) : (
                  <Home openTab={setTab} places={<Navigator onOpen={() => setPlace(true)} />} />
                ))}
              {shownTab === 'learn' && (
                <>
                  {/* Puzzles and the Drawing board join Cards once a puzzle step comes up (or a button went there). */}
                  {(l.learnBuild || learn !== 'cards') && (
                    <div className="seg" role="group" aria-label="Learn">
                      <button data-sub="cards" aria-pressed={learn === 'cards'} onClick={() => setLearn('cards')}>
                        Cards {due > 0 && <span className="seg-count">{due > 99 ? '99+' : due}</span>}
                      </button>
                      <button data-sub="build" aria-pressed={learn === 'build'} onClick={() => setLearn('build')}>
                        Puzzles
                      </button>
                      {(learn === 'sandbox' || shows('drawingBoard', prefs, simpleCtx)) && (
                        <button data-sub="sandbox" aria-pressed={learn === 'sandbox'} onClick={() => setLearn('sandbox')} title="Draw any design, get a review">
                          Drawing board
                        </button>
                      )}
                    </div>
                  )}
                  {learn === 'build' ? <ArchitectureBoard /> : learn === 'sandbox' ? <Sandbox /> : <Flashcards />}
                </>
              )}
              {shownTab === 'jobs' && <ClientsBoard at={jobsAt} />}
              {shownTab === 'deploy' && <DeployPanel />}
              </ErrorBoundary>
            </div>
            {/* The Copilot's switch stands on the City tab (and wherever a console page or the Copilot is on). Both wait
                while the first steps run (introduced at graduation as "Ask the city"). */}
            {shows('promptBar', prefs, quiet) && <PromptBar layout={layout} consoleHere={shownTab === 'home'} />}
            <ErrorBoundary what="This card">
              <FindingCard openTab={setTab} />
            </ErrorBoundary>
          </>
        )}
        {/* A citizen's question is a bottom sheet over the side column, every answer in view (never squeezed into the
            panel's short map). */}
        <RequestCard />
        <FirstStepsMoments />
      </aside>
      <ErrorBoundary what="This card">
        <IncidentCard openTab={setTab} />
        <ChoiceCard />
        <Celebrate openTab={setTab} />
        <Workshop />
        <ClientTask />
        <ClientDone />
        <Collection />
        <AccountMap layout={layout} />
        <CoinFly />
        <Leaderboard />
        <LaunchDay />
      </ErrorBoundary>
      <Tour layout={layout} />
      <CoachTips layout={layout} />
    </div>
  );
}

/** Screen readers hear what the keyboard just did in the city (] / [ through the buildings): one polite line. */
function CityAnnouncer() {
  const [text, setText] = useState('');
  useEffect(() => bus.on('announce', ({ text }) => setText(text)), []);
  // Arriving in a city: one line that says what's there (the canvas itself has no text).
  useEffect(
    () =>
      bus.on('arrived', () => {
        const st = useCity.getState();
        setText(
          citySummary({
            cityRegion: st.cityRegion,
            regionName: REGIONS.regions.find((r) => r.code === st.cityRegion)?.name,
            progress: st.progress,
            openIssues: openFindings(st.findings).length,
            outage: !!st.health?.incidents.some((i) => i.region === st.cityRegion && i.status === 'open' && i.severity !== 'informational'),
            flowOn: st.flowOn,
          }),
        );
      }),
    [],
  );
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
