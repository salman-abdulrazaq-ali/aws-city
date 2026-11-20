/** Pure key → action maps for the two games that began mouse-only. The scenes act on the result. */

export type FishingState = 'ready' | 'casting' | 'waiting' | 'bite' | 'reeling' | 'quiz' | 'summary';
export type FishingKey = { kind: 'cast' } | { kind: 'hook' } | { kind: 'bucket'; index: number } | { kind: 'again' } | { kind: 'leave' };

/** Space or Enter casts (ready) and hooks (bite); 1–3 answer the quiz with that bucket; on the result card, Enter/Space plays again and Escape leaves. */
export function fishingKey(state: FishingState, key: string, buckets: number): FishingKey | undefined {
  const act = key === ' ' || key === 'Enter';
  if (state === 'ready' && act) return { kind: 'cast' };
  if (state === 'bite' && act) return { kind: 'hook' };
  if (state === 'quiz' && /^[1-9]$/.test(key) && Number(key) <= buckets) return { kind: 'bucket', index: Number(key) - 1 };
  if (state === 'summary' && act) return { kind: 'again' };
  if (state === 'summary' && key === 'Escape') return { kind: 'leave' };
  return undefined;
}

export type EdgeKey = { kind: 'select'; slot: number } | { kind: 'invalidate' } | { kind: 'cache' };

/** 1–4 pick a cache slot, I (or Enter) invalidates the picked slot, Space or C caches the oldest missed file in the feed. */
export function edgeKey(key: string, slots: number): EdgeKey | undefined {
  if (/^[1-9]$/.test(key) && Number(key) <= slots) return { kind: 'select', slot: Number(key) - 1 };
  const k = key.toLowerCase();
  if (k === 'i' || key === 'Enter') return { kind: 'invalidate' };
  if (k === 'c' || key === ' ') return { kind: 'cache' };
  return undefined;
}
