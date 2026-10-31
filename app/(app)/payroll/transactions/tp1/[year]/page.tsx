import { redirect } from 'next/navigation';
import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * 7ad37961 — the year page is now a REDIRECT to the month page.
 *
 * 3e3d3fb2 built this as the dedicated Add / View / Edit page for one employee's TP1 declaration for one
 * assessment YEAR. The official LHDN TP1 (1/2026) has a DEDUCTION MONTH box, so the record's grain moved
 * from the year to the month and the form now lives at `tp1/[year]/[month]`.
 *
 * THIS FILE IS KEPT RATHER THAN DELETED because links to it are already in the wild: the save actions
 * redirect through `?year=`, HR bookmarks the page, and test/tp1-relief-redesign.test.ts asserts the
 * route is reachable. A 404 on a shipped URL is a regression a green suite would not have caught. So the
 * segment answers, and forwards — preserving `employmentId`, which is the whole reason the destination
 * resolves to anything.
 *
 * WHICH MONTH. The current calendar month when the year IS the current assessment year (that is the
 * month a reader following an old link means); January otherwise, because a closed year has no "now" and
 * January is where its record starts. Both open read-only for a past year, decided by the month page.
 *
 * NO SESSION IS READ HERE, and none is needed: this issues a redirect and touches no data. The
 * destination applies the full `scopedAdmin` guard, resolves the employment against the admin's own
 * scoped list and 404s anything outside it — so forwarding an id proves nothing about it. This page is
 * still listed in lib/permissions.ts, because it is a guarded route segment in the same tree and the
 * reverse-completeness case in test/function-access.test.ts is an EXACT-set check on page.tsx files.
 */
export default async function Tp1DeclarationYearPage({
  params,
  searchParams,
}: {
  params: Promise<{ year: string }>;
  searchParams: Promise<{ employmentId?: string }>;
}) {
  const { year: rawYear } = await params;
  const { employmentId } = await searchParams;

  const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN;
  // An unusable year goes back to the list rather than to a month page that would 404 on it.
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    redirect('/payroll/transactions/tp1');
  }

  const today = todayInKualaLumpur();
  const month = year === Number(today.slice(0, 4)) ? Number(today.slice(5, 7)) : 1;
  const qs = employmentId ? `?employmentId=${encodeURIComponent(employmentId)}` : '';
  redirect(`/payroll/transactions/tp1/${year}/${month}${qs}`);
}
