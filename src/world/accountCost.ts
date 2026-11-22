import type { CityBillReadyEvent } from '@/backend/contract';

/**
 * A bill's month so far as a day and a month, pure. Cost Explorer gives one month-to-date figure per service (read at
 * most once a day, src/backend/contract.ts city.bill); a day is that ÷ the UTC days so far, and the month is a day × the
 * month's days. Both are estimates, and the diagram marks them "est.": AWS's own figure is the month so far.
 */

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** UTC days counted in the bill (its period runs from the 1st through today) and the days in its month. */
export function billDays(bill: Pick<CityBillReadyEvent, 'month' | 'takenAt'>): { elapsed: number; inMonth: number } {
  const [y, m] = bill.month.split('-').map(Number);
  const inMonth = y && m ? daysIn(y, m) : 30;
  const taken = new Date(bill.takenAt);
  const sameMonth = taken.getUTCFullYear() === y && taken.getUTCMonth() + 1 === m;
  // A bill read in another month (an old copy) covers the whole of its month.
  return { elapsed: sameMonth ? Math.max(1, taken.getUTCDate()) : inMonth, inMonth };
}

export interface CostView {
  soFar: number;
  perDay: number;
  perMonth: number;
}

export function costView(soFar: number, days: { elapsed: number; inMonth: number }): CostView {
  const perDay = soFar / Math.max(1, days.elapsed);
  return { soFar, perDay, perMonth: perDay * days.inMonth };
}

/** "$0.23", or "under $0.01" (a per-day figure is often a fraction of a cent). */
export const dollars = (n: number, currency = 'USD') => {
  const sign = currency === 'USD' ? '$' : `${currency} `;
  return n > 0 && n < 0.005 ? `under ${sign}0.01` : `${sign}${n.toFixed(2)}`;
};

/** ["$0.23 a day est.", "$6.90 a month est."]. */
export const costLines = (c: CostView, currency = 'USD'): [string, string] => [`${dollars(c.perDay, currency)} a day est.`, `${dollars(c.perMonth, currency)} a month est.`];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-11" → "November 2026" (seen 22 Nov 2026: "So far in 2026-11: $0.00" read like $2,026,110). */
export const monthName = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return y && m && MONTHS[m - 1] ? `${MONTHS[m - 1]} ${y}` : month;
};
