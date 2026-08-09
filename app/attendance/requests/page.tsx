import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment } from '@/core/read';
import { myAttendanceCorrections } from '@/packs/attendance/service';
import { myTravelRequests } from '@/core/travel-request';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myRequestCorrection, myRequestTravel } from '@/app/me/actions';

/**
 * My Attendance > Attendance Request (0bb0e303 rev2) — the employee's own attendance/overtime/travel
 * requests, and the pending ones they have already filed.
 *
 * WHY THIS PAGE EXISTS. All three forms were already built (R45 3707cba9) but lived as collapsed
 * fold-outs inside the Attendance card on /me, where staff had to know to go to their profile and open
 * them. That was the reporter's actual complaint: not that the capability was missing, but that it was
 * unreachable from the menu. So the forms MOVED here whole rather than being rebuilt — same fields, same
 * wording, same server actions, same approval route (requestAttendanceCorrection → decideAttendanceCorrection
 * for the first two; the approvals inbox for travel). /me keeps a link across, so there is one place to
 * file a request rather than two that can drift apart.
 *
 * WHY ALL THREE AND NOT JUST THE ATTENDANCE ONE. They are one request menu and were built together; a
 * split would leave staff hunting on two screens for the same kind of thing.
 *
 * WHY THE `me` NAMESPACE ON A PAGE UNDER /attendance. These are the SAME strings, moved screen not moved
 * catalog — re-keying nineteen entries across six locales to buy nothing a reader can see is how
 * translations get broken. `me.leaveStatus.*` is also still needed by /me itself (the profile-change
 * request list), so a clean split would have meant duplicating it anyway.
 *
 * TRUST MODEL: identical to /me. The viewer's OWN employment is resolved from the session and every read
 * below is RLS-scoped to it; the three actions each re-resolve the caller server-side, so this page is
 * self-service for every employee and carries no gate — see the nav row in packs/attendance/index.ts.
 * Clocking itself deliberately did NOT move: /me and /attendance/clock remain the only places a geofenced
 * punch can be made (311ad7ba).
 */
export default async function AttendanceRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const t = await getTranslations('me');
  const { error } = await searchParams;
  const s = await getSession();
  const me = await myEmployment(s);

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('attendanceRequest')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const [corrections, travelRequests] = await Promise.all([
    myAttendanceCorrections(s, me.employmentId),
    myTravelRequests(s, me.employmentId),
  ]);
  // The date the three forms default to. Derived from the MYT day-key and not from `Date.now()`, which
  // is what the /me card did: an ISO timestamp minus a day names the day before yesterday for the eight
  // hours between 00:00 and 08:00 MYT (bb4f2265), and a night-shift employee filing a correction is
  // exactly the person who would meet that. Subtracting a day from a date-only string is plain UTC
  // arithmetic on a KNOWN date, which is the form that must stay UTC.
  const yesterday = new Date(Date.parse(`${todayInKualaLumpur()}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

  // Attendance and Overtime requests are the same stored record type, told apart by whether the employee
  // asked for OT minutes — exactly the split the /me card made, kept so each form lists back only its own.
  // 1e9145d4 — the OT half of this split moved to Plan OT, which lists overtime in full (no five-row cap,
  // with reasons, planned times and whether the hours have landed). What stays here is what this screen is
  // still for: clock-time corrections.
  const punchCorrections = corrections.filter((c) => c.requestedOtMinutes == null);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('attendanceRequest')} description={t('requestsDescription')} />

      <ErrorBanner message={error} />

      {/* R45 3707cba9 — the ESS request menu, in its established order: Attendance Request · Overtime
          Request · Travel Request. (Replacement-leave requests live on My Absence.) The forms are the /me
          card's, unchanged; only the <details> folds are gone. A page whose entire purpose is these three
          forms would otherwise open with all three of them shut, which is the discoverability problem this
          item was raised about. */}

      {/* Attendance Request — a pure clock-in/out correction (manager/admin approves, ADR-0011 Phase B). */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold">{t('attendanceRequest')}</h2>
        <form action={myRequestCorrection} className="mt-3 space-y-2.5">
          <Field label={t('dateLabel')}>
            <input type="date" name="date" required defaultValue={yesterday} className={inputCls} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('checkInLabel')}>
              <input type="time" name="checkIn" defaultValue="09:00" className={inputCls} />
            </Field>
            <Field label={t('checkOutLabel')}>
              <input type="time" name="checkOut" defaultValue="18:00" className={inputCls} />
            </Field>
          </div>
          <Field label={t('reasonRequired')}>
            <input name="reason" required placeholder={t('reasonPlaceholder')} className={inputCls} />
          </Field>
          <Button type="submit" size="sm">
            {t('requestCorrection')}
          </Button>
        </form>
        {punchCorrections.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-xs">
            {punchCorrections.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2">
                <span className="tabular-nums text-muted-foreground">
                  {c.attendanceDate}
                  {c.proposedCheckIn
                    ? ` · ${c.proposedCheckIn.slice(0, 5)}${c.proposedCheckOut ? `–${c.proposedCheckOut.slice(0, 5)}` : ''}`
                    : ''}
                </span>
                <Pill status={c.status} label={t(`leaveStatus.${c.status}`)} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 1e9145d4 — THE OVERTIME REQUEST FORM MOVED OUT, to My Attendance > Plan OT, and this signpost is
          what is left. Mirrors exactly what 0bb0e303 rev2 did to /me when the three forms moved HERE.
          Overtime asked for BEFORE the day and overtime claimed AFTER it now live in one place, so the two
          lists cannot drift apart; this screen keeps clock-time corrections and travel requests, which are
          not overtime and are not decided the same way. Nobody loses the route they use today: the link is
          on the screen the form used to be on. */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold">{t('overtimeMovedHeading')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('overtimeMovedBody')}</p>
        <Button asChild size="sm" variant="outline" className="mt-3">
          <Link href="/attendance/plan-ot">{t('applyOtPlan')} →</Link>
        </Button>
      </Card>

      {/* Travel Request (off-site work window; renamed from "Request Travel"). Same approvals inbox / decide flow. */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold">{t('travelRequest')}</h2>
        <form action={myRequestTravel} className="mt-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('travelFromLabel')}>
              <input type="date" name="travelFrom" required defaultValue={yesterday} className={inputCls} />
            </Field>
            <Field label={t('travelToLabel')}>
              <input type="date" name="travelTo" required defaultValue={yesterday} className={inputCls} />
            </Field>
          </div>
          <Field label={t('reasonRequired')}>
            <input name="remarks" required placeholder={t('travelRemarksPlaceholder')} className={inputCls} />
          </Field>
          <Button type="submit" size="sm">
            {t('requestTravelButton')}
          </Button>
        </form>
        {travelRequests.length > 0 && (
          <ul className="mt-3 space-y-1.5 text-xs">
            {travelRequests.map((tr) => (
              <li key={tr.id} className="flex items-center justify-between gap-2">
                <span className="tabular-nums text-muted-foreground">
                  {tr.travelFrom} → {tr.travelTo}
                </span>
                <Pill status={tr.status} label={t(`leaveStatus.${tr.status}`)} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// The request-status colours the /me card used, kept identical so a moved list looks like the one it
// replaced. Deliberately NOT components/ui's StatusBadge: that palette is the Employee Status vocabulary
// (probation/active/resigned…), which has no entry for pending/approved/rejected — every pill here would
// render neutral grey.
const REQUEST_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};

function Pill({ status, label }: { status: string; label?: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${REQUEST_STATUS[status] ?? 'bg-muted text-muted-foreground'}`}
    >
      {label ?? status.replace('_', ' ')}
    </span>
  );
}
