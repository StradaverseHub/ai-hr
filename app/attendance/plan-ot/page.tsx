import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { myOvertimePlans } from '@/packs/attendance/service';
import { Button, Card, ErrorBanner, PageHeader, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myWithdrawOvertimePlan } from '@/app/me/actions';

/**
 * My Attendance > Plan OT (1e9145d4) — the employee's OWN overtime plans, newest first, and the landing
 * page of the fourth self-service row.
 *
 * WHY THIS PAGE EXISTS. The record and the form already existed (ADR-0069 / R45): an overtime request is an
 * attendance_correction with no proposed punches. What did not exist was anywhere to SEE them. The list was
 * buried inside the Attendance Request screen, capped at the five most recent, mixed in with clock-time
 * corrections, and it showed neither the reason, nor the planned window, nor whether the hours had actually
 * landed on the day. Nothing could be taken back at all.
 *
 * WHAT "STATUS" MEANS HERE, because there are four states and two of them look alike:
 *   • Pending    — waiting on the superior.
 *   • Approved, not worked yet — agreed AHEAD of the date (the item's whole point). The hours are held on
 *     the plan; they are not on any attendance day and payroll has not seen them.
 *   • Approved, counted on the day — the day was worked and the hours landed on it (applied_at).
 *   • Withdrawn  — the employee took it back. Nothing is deleted, so the trail of what was asked for and
 *     taken back stays readable.
 *
 * TRUST MODEL: identical to /attendance/requests. The viewer's OWN employment is resolved from the session,
 * every read is RLS-scoped to it, and the withdraw action re-resolves the caller server-side and refuses
 * anyone who is not the subject. Self-service, so no gate — see the nav row in packs/attendance/index.ts.
 */
export default async function PlanOtPage({
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
          <h1 className="text-lg font-semibold">{t('planOtTitle')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const [plans, lines] = await Promise.all([
    myOvertimePlans(s, me.employmentId, { limit: 100 }),
    reportingLinesFor(s, me.employmentId),
  ]);
  // Who each plan goes to: the administrative reporting line, which is the edge assertCanDecide routes an
  // attendance decision along. Falling back to the HR administrator rather than blank, because "nobody" is
  // never the answer — an employee with no line still has their request decided, by HR.
  const approver =
    lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown');
  const today = todayInKualaLumpur();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('planOtTitle')} description={t('planOtDescription')} />

      <ErrorBanner message={error} />

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t('planOtTitle')}</h2>
          <Button asChild size="sm">
            <Link href="/attendance/plan-ot/apply">{t('applyOtPlan')}</Link>
          </Button>
        </div>

        {plans.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">{t('otNoPlans')}</p>
        ) : (
          <div className={`mt-4 ${tableWrapCls}`}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('otDateColumn')}</th>
                  <th className={thCls}>{t('otPlannedTimeColumn')}</th>
                  <th className={thCls}>{t('otHoursColumn')}</th>
                  <th className={thCls}>{t('reasonRequired')}</th>
                  <th className={thCls}>{t('otGoesToColumn')}</th>
                  <th className={thCls}>{t('otStatusColumn')}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {plans.map((p) => {
                  // The withdraw rule, mirrored from cancelPlannedOvertime so the control is not offered
                  // where the service would refuse it. The SERVICE is the authority — this only decides
                  // whether to draw a button.
                  const canWithdraw =
                    p.status === 'pending' ||
                    (p.status === 'approved' && p.appliedAt == null && p.attendanceDate >= today);
                  return (
                    <tr key={p.id}>
                      <td className="px-3 py-2 tabular-nums">{p.attendanceDate}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {p.plannedStartTime && p.plannedEndTime
                          ? `${p.plannedStartTime.slice(0, 5)} – ${p.plannedEndTime.slice(0, 5)}`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {p.requestedOtMinutes != null ? (p.requestedOtMinutes / 60).toFixed(1) : '—'}
                      </td>
                      <td className="px-3 py-2">
                        {p.otReasonCategory && (
                          <span className="font-medium">{t(CATEGORY_KEY[p.otReasonCategory])}</span>
                        )}
                        {p.otReasonCategory && p.reason ? ' — ' : ''}
                        <span className="text-muted-foreground">{p.reason ?? ''}</span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{approver}</td>
                      <td className="px-3 py-2">
                        <Pill
                          status={p.status}
                          label={
                            // `cancelled` is the stored status; WITHDRAWN is what the employee did, and
                            // what the mockup names it — the leave vocabulary's "Cancelled" would read as
                            // somebody else having called it off.
                            p.status === 'cancelled'
                              ? t('otStatusWithdrawn')
                              : p.status === 'approved'
                                ? t('leaveStatus.approved')
                                : p.status === 'rejected'
                                  ? t('leaveStatus.rejected')
                                  : t('leaveStatus.pending')
                          }
                        />
                        {p.status === 'approved' && (
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {p.appliedAt
                              ? t('otCountedOnDay', { date: p.appliedAt.toISOString().slice(0, 10) })
                              : t('otNotWorkedYet')}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {canWithdraw ? (
                          <form action={myWithdrawOvertimePlan}>
                            <input type="hidden" name="correctionId" value={p.id} />
                            <button
                              type="submit"
                              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                            >
                              {t('otWithdraw')}
                            </button>
                          </form>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">{t('otWithdraw')}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** ot_reason_category → the `me` key naming it. Exhaustive over db/schema OT_REASON_CATEGORIES. */
const CATEGORY_KEY = {
  project_deadline: 'otCategoryProjectDeadline',
  system_maintenance: 'otCategorySystemMaintenance',
  month_end_closing: 'otCategoryMonthEndClosing',
  client_request: 'otCategoryClientRequest',
  other: 'otCategoryOther',
} as const;

// The same palette the Attendance Request list uses, so a moved list looks like the one it replaced.
// Deliberately NOT components/ui's StatusBadge: that palette is the Employee Status vocabulary
// (probation/active/resigned…), which has no entry for pending/approved/rejected.
const REQUEST_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
  cancelled: 'bg-muted text-muted-foreground',
};

function Pill({ status, label }: { status: string; label: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${REQUEST_STATUS[status] ?? 'bg-muted text-muted-foreground'}`}
    >
      {label}
    </span>
  );
}
