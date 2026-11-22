import { describe, expect, it } from 'vitest';
import { diffSnapshots, movesInventory } from '../src/state/diff.js';
import { instance, snapshot, table } from './fixtures.js';

describe('diffSnapshots', () => {
  it('emits nothing for the first snapshot', () => {
    expect(diffSnapshots(null, snapshot([instance('i-00000001', 'running')]))).toEqual([]);
  });

  it('detects created, deleted and state changes', () => {
    const prev = snapshot([instance('i-00000001', 'pending'), table('city-old')]);
    const next = snapshot([instance('i-00000001', 'running'), table('city-new', 'CREATING')]);
    const events = diffSnapshots(prev, next);

    expect(events).toContainEqual({ type: 'stateChanged', resource: next.resources[0], from: 'pending', to: 'running' });
    expect(events).toContainEqual({ type: 'created', resource: next.resources[1] });
    expect(events).toContainEqual({ type: 'deleted', resource: prev.resources[1] });
    expect(events).toHaveLength(3);
  });

  it('does not report deletions for a service that failed to read', () => {
    const prev = snapshot([table('city-a')]);
    const next = snapshot([], { services: { ...prev.services, dynamodb: 'error' } });
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  it('reports a newly locked service without demolishing its buildings', () => {
    const prev = snapshot([table('city-a')]);
    const next = snapshot([], { services: { ...prev.services, dynamodb: 'locked' } });
    expect(diffSnapshots(prev, next)).toEqual([{ type: 'serviceLocked', service: 'dynamodb' }]);
  });

  it('reports credential expiry and recovery', () => {
    const ok = snapshot([]);
    const expired = snapshot([], { credentials: 'expired' });
    expect(diffSnapshots(ok, expired)).toEqual([{ type: 'credentialsExpired' }]);
    expect(diffSnapshots(expired, ok)).toEqual([{ type: 'credentialsRestored' }]);
  });
});

describe('movesInventory: a poll change that moves the account mirror', () => {
  it('is a server appearing, going or changing state', () => {
    const prev = snapshot([instance('i-1', 'running'), instance('i-2', 'running'), table('city-a')]);
    const next = snapshot([instance('i-1', 'stopped'), instance('i-3', 'pending'), table('city-a', 'UPDATING')]);
    const events = diffSnapshots(prev, next);
    expect(events.filter(movesInventory).map((e) => [e.type, 'resource' in e ? e.resource.id : ''])).toEqual([
      ['stateChanged', 'i-1'],
      ['created', 'i-3'],
      ['deleted', 'i-2'],
    ]);
  });

  it('is not a table change or a security group rule change', () => {
    const sg = (state: string) => ({ id: 'sg-1', service: 'ec2' as const, kind: 'security-group' as const, name: 'sg-1', state, managedByGame: false, meta: {} });
    const events = diffSnapshots(snapshot([table('city-a'), sg('1 inbound rule')]), snapshot([table('city-a', 'UPDATING'), sg('2 inbound rules')]));
    expect(events).toHaveLength(2);
    expect(events.some(movesInventory)).toBe(false);
  });
});
