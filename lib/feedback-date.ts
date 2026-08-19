/**
 * ONE way to print a feedback timestamp (e14334ef).
 *
 * Lifted verbatim from `app/feedback/[id]/page.tsx`, which had it as a local `fmtDate` used for plan
 * versions, approvals, block questions and answers. The board list now shows Last Updated too, and a
 * second copy of the same `toLocaleString` options in `app/feedback/bulk-table.tsx` is exactly how the
 * list and the detail page start disagreeing about what "14 Aug 2026, 09:32" means.
 *
 * ═══ THE ONE THING THAT WAS ADDED ═══
 *
 * `timeZone` is now named explicitly. The original relied on the HOST clock, which is right on this
 * deployment only because the box happens to be set to MYT — the same trap `lib/hr-date.ts` documents
 * for `timeInKualaLumpur`. Leaving it implicit was survivable while every caller was a SERVER component;
 * `bulk-table.tsx` is `'use client'`, so the same string is rendered once on the server and again in the
 * browser, and a reader in another timezone would get two different strings for one row — a React
 * hydration mismatch, not merely a cosmetic difference.
 *
 * Production output is unchanged: the server already resolved these in MYT.
 */
import { HR_LOCAL_TZ } from './hr-date';

/**
 * `14 Aug 2026, 09:32` — day / short month / year / 24h, in the tenant's local calendar.
 *
 * Accepts a `Date` or the ISO string a `timestamptz` arrives as when a row has crossed a serialization
 * boundary (a server component handing rows to a client one).
 */
export function formatFeedbackDateTime(d: Date | string): string {
  return new Date(d).toLocaleString('en-GB', {
    timeZone: HR_LOCAL_TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
