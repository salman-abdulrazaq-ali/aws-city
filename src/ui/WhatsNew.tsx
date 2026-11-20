import { openDocs } from '@/app/runtime';
import type { AwsNewsItem } from '@/backend/contract';
import { newsOpen } from '@/state/ladder';
import { shows } from '@/state/simple';
import { useCity } from '@/state/store';
import { ago } from '@/world/incidents';
import { feel } from './feedback';

/** At most this many launches on a building's card. */
export const WHATS_NEW_MAX = 3;
const NO_NEWS: readonly AwsNewsItem[] = [];

/** A service's newest What's New launches, newest first. */
export const launchesFor = (items: readonly AwsNewsItem[], serviceId: string) =>
  items
    .filter((n) => n.serviceIds.includes(serviceId))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, WHATS_NEW_MAX);

/**
 * AWS City Live on a building's card: what AWS launched for this service lately (the same What's New feed as the
 * ticker, so it follows the news rung and Simple mode), each opening the announcement on aws.amazon.com.
 */
export function WhatsNew({ serviceId }: { serviceId: string }) {
  // One empty list, not a new [] each render (a fresh array from a selector re-renders forever).
  const items = useCity((s) => s.news?.items ?? NO_NEWS);
  const open = useCity((s) => newsOpen(s.progress, s.account.linked) && shows('news', s.prefs));
  const list = launchesFor(items, serviceId);
  if (!open || !list.length) return null;
  return (
    <section className="place-news" aria-label="New from AWS">
      <h4 className="label">🚀 New from AWS</h4>
      <ul className="place-news-list">
        {list.map((n) => (
          <li key={n.id}>
            <button className="btn tiny ghost" onClick={() => (feel.tap(), openDocs(n.url))}>
              {n.title} <span className="muted">· {ago(n.date)}</span> <span aria-hidden="true">↗</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
