import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityFinding } from '@/backend/contract';
import { demoFindings } from '@/backend/mockAccount';
import { bus } from '@/state/bus';
import { ADVANCED_RULES, DRIP_MS, heldFindingIds, MAX_OPEN_FINDINGS, openFindings, severityRank, useCity } from '@/state/store';
import { SERVICES } from '@/world/taxonomy';
import { landmarkOf } from '@/state/cities';

const s = () => useCity.getState();
const send = (finding: CityFinding) => s().applyServerEvent({ type: 'city.finding', finding });
const shown = () => openFindings(s().findings).map((f) => f.id);
/** Five distinct findings with mixed severities (the demo account's, cycled with fresh ids). */
const findings = (n: number): CityFinding[] => {
  const base = demoFindings();
  const sev: CityFinding['severity'][] = ['high', 'medium', 'low', 'high', 'medium', 'low'];
  return Array.from({ length: n }, (_, i) => ({ ...base[i % base.length], id: `f${i}`, severity: sev[i % sev.length] }));
};

beforeEach(() => {
  vi.useFakeTimers();
  s().resetSession();
  s().clearToasts();
});
afterEach(() => {
  s().resetSession();
  useCity.setState({ backendKind: 'mock' });
  vi.useRealTimers();
});

describe('hardware-choice advice waits for a beginner (round 3 step 5)', () => {
  it('x86 → Graviton and older-hardware findings stay held until a quest is finished, then come last', async () => {
    const base = findings(1)[0];
    const graviton = { ...base, id: 'g1', ruleId: 'ec2-graviton-candidate', severity: 'low' as const };
    const plain = { ...base, id: 'p1', ruleId: 'ebs-unattached', severity: 'medium' as const };
    expect(ADVANCED_RULES.has('ec2-graviton-candidate')).toBe(true);
    send(graviton);
    send(plain);
    s().releaseCare();
    // The plain one first, though it's more severe; the Graviton advice waits.
    expect(shown()).toEqual(['p1']);
    s().openFinding('p1');
    await vi.advanceTimersByTimeAsync(DRIP_MS * 3);
    expect(shown()).toEqual(['p1']);
    expect(heldFindingIds()).toEqual(['g1']);
    // A quest finished: it drips in.
    useCity.setState({ progress: { ...s().progress, quests: { q: { status: 'done', step: 1 } } } });
    await vi.advanceTimersByTimeAsync(DRIP_MS);
    expect(shown().sort()).toEqual(['g1', 'p1']);
  });
});

describe('"Got it": a finding with no automatic fix never holds a place forever', () => {
  beforeEach(() => {
    // "Got it" is remembered on the device (localStorage).
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  });
  afterEach(() => vi.unstubAllGlobals());
  const plain = demoFindings().find((f) => !f.fix && !ADVANCED_RULES.has(f.ruleId))!;
  const fixable = demoFindings().find((f) => !!f.fix)!;

  it('resolves it, lets the next one in at once, and it stays read for this player (not for the next one)', () => {
    expect(plain).toBeTruthy();
    const fs = [0, 1, 2, 3].map((i): CityFinding => ({ ...plain, id: `n${i}`, severity: 'low' }));
    fs.forEach(send);
    s().releaseCare();
    // Look at each one: City care fills to MAX_OPEN_FINDINGS and the fourth waits.
    const looked = new Set<string>();
    for (let i = 0; i < MAX_OPEN_FINDINGS; i++) {
      const id = shown().find((x) => !looked.has(x))!;
      looked.add(id);
      s().openFinding(id);
    }
    expect(shown()).toHaveLength(MAX_OPEN_FINDINGS);
    expect(heldFindingIds()).toHaveLength(1);
    // Explain-only findings used to hold those places for good. "Got it" on one: it's resolved, and the next comes in.
    const read = shown()[0];
    expect(s().ackFinding(read)).toBe(true);
    expect(s().findings[read].status).toBe('resolved');
    expect(shown()).toHaveLength(MAX_OPEN_FINDINGS);
    expect(shown()).not.toContain(read);
    expect(heldFindingIds()).toEqual([]);
    // The server (or the demo) sends it again: it stays read.
    send({ ...fs.find((f) => f.id === read)! });
    expect(s().findings[read].status).toBe('resolved');
    // The device remembers it (a reload reads it back): still read when it arrives again.
    expect(JSON.parse(localStorage.getItem('awscity.findingsGotIt') ?? '[]')).toContain(read);
    // The session ends (sign-out): this player's "Got it"s leave with them, so the next player sees their own city's.
    s().resetSession();
    expect(localStorage.getItem('awscity.findingsGotIt')).toBeNull();
    send({ ...fs.find((f) => f.id === read)! });
    s().releaseCare();
    expect(s().findings[read].status).toBe('open');
  });

  it('a finding with an automatic fix is fixed, not dismissed', () => {
    send({ ...fixable, id: 'fx', severity: 'low' });
    s().releaseCare();
    expect(shown()).toEqual(['fx']);
    expect(s().ackFinding('fx')).toBe(false);
    expect(s().findings.fx.status).toBe('open');
    expect(s().ackFinding('nobody')).toBe(false);
  });
});

describe('findings wait until city care unlocks', () => {
  it('holds new findings out of sight (so Explain and Fix can’t reach them)', () => {
    const [f] = findings(1);
    send(f);
    expect(s().findings).toEqual({});
    expect(heldFindingIds()).toEqual([f.id]);
    expect(s().careReleased).toBe(false);
  });

  it('a held finding that resolves is never shown', () => {
    const [f] = findings(1);
    send(f);
    send({ ...f, status: 'resolved' });
    expect(heldFindingIds()).toEqual([]);
    s().releaseCare();
    expect(s().findings).toEqual({});
  });

  it('drips them in lowest severity first, the next once the last is opened or 90 s pass, at most 3 open', async () => {
    const fs = findings(5);
    fs.forEach(send);
    s().releaseCare();
    expect(shown()).toHaveLength(1);
    expect(s().findings[shown()[0]].severity).toBe('low');
    // Opening its card lets the next one in.
    s().openFinding(shown()[0]);
    expect(shown()).toHaveLength(2);
    // Or 90 s pass.
    await vi.advanceTimersByTimeAsync(DRIP_MS - 1);
    expect(shown()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(shown()).toHaveLength(MAX_OPEN_FINDINGS);
    // Severity order held: low, low?, medium…
    const order = Object.values(s().findings).sort((a, b) => a.seenAt - b.seenAt).map((f) => severityRank(f.severity));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Full: nothing more while three are open.
    await vi.advanceTimersByTimeAsync(DRIP_MS * 3);
    expect(shown()).toHaveLength(MAX_OPEN_FINDINGS);
    expect(heldFindingIds()).toHaveLength(2);
    // One resolves: room for the next.
    const first = s().findings[shown()[0]];
    send({ ...first, status: 'resolved' });
    await vi.advanceTimersByTimeAsync(DRIP_MS);
    expect(shown()).toHaveLength(MAX_OPEN_FINDINGS);
    expect(heldFindingIds()).toHaveLength(1);
  });

  it('a finding already shown updates straight away', () => {
    const [f] = findings(1);
    send(f);
    s().releaseCare();
    send({ ...f, status: 'resolved' });
    expect(s().findings[f.id].status).toBe('resolved');
  });

  it('a linked account sees its findings at once', () => {
    const fs = findings(4);
    send(fs[0]);
    send(fs[1]);
    useCity.setState({ account: { linked: true }, backendKind: 'server' });
    s().releaseCare();
    expect(shown()).toHaveLength(2);
    send(fs[2]);
    send(fs[3]);
    expect(shown()).toHaveLength(4);
  });

  it('linking later shows everything still held', () => {
    useCity.setState({ backendKind: 'server' });
    findings(5).forEach(send);
    s().releaseCare();
    expect(shown()).toHaveLength(1);
    s().applyServerEvent({ type: 'account.status', linked: true, accountId: '123456789012', region: 'us-west-2' });
    expect(shown()).toHaveLength(5);
  });

  it('the demo’s practice account still drips (one at a time, never all at once)', () => {
    findings(5).forEach(send);
    s().releaseCare();
    expect(shown()).toHaveLength(1);
    // The reply to the player's verify (its requestId): the one status that's toasted.
    s().applyServerEvent({ type: 'account.status', requestId: 'r1', linked: true, accountId: '123456789012', region: 'us-west-2' });
    expect(shown()).toHaveLength(1);
    send(findings(6)[5]);
    expect(shown()).toHaveLength(1);
    expect(s().toasts.at(-1)?.text).toMatch(/practice account is linked/);
  });

  it('releaseCare({ all }) shows everything held at once (dev and smoke)', () => {
    findings(5).forEach(send);
    s().releaseCare({ all: true });
    expect(shown()).toHaveLength(5);
    expect(heldFindingIds()).toEqual([]);
  });

  it('forgets held findings when the session ends', () => {
    findings(2).forEach(send);
    s().resetSession();
    expect(heldFindingIds()).toEqual([]);
    expect(s().careReleased).toBe(false);
    s().releaseCare();
    expect(s().findings).toEqual({});
  });
});

describe('quiet discovery', () => {
  it('a finding builds its landmark without a toast or a camera move', async () => {
    const [f] = findings(1);
    expect(SERVICES.some((x) => x.id === f.serviceId)).toBe(true);
    const seen: { serviceId: string; quiet?: boolean }[] = [];
    const off = bus.on('discovered', (e) => seen.push(e));
    try {
      send(f);
      s().releaseCare();
      expect(landmarkOf(s().progress, f.serviceId)?.discovered).toBe(true);
      expect(seen).toEqual([{ serviceId: f.serviceId, quiet: true }]);
      expect(s().toasts).toEqual([]);
    } finally {
      off();
    }
  });

  it('XP builds quietly; visiting a page still announces it', () => {
    const [a, b] = SERVICES;
    const seen: { serviceId: string; quiet?: boolean }[] = [];
    const off = bus.on('discovered', (e) => seen.push(e));
    try {
      s().addXp(a.id, 3);
      expect(s().toasts).toEqual([]);
      s().discover(b.id);
      expect(s().toasts).toHaveLength(1);
      expect(seen).toEqual([
        { serviceId: a.id, quiet: true },
        { serviceId: b.id, quiet: false },
      ]);
    } finally {
      off();
    }
  });
});
