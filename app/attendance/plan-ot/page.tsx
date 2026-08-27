import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { myOvertimePlans } from '@/packs/attendance/service';
import {
  Button,
  Card,
  ErrorBanner,
  PageHeader,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myWithdrawOvertimePlan } from '@/app/me/actions';
import { CATEGORY_KEY, Pill, statusLabel } from '../request-ui';

/**
 * My Attendance > Self Overtime — the employee's own overtime plans, on a screen of their own.
 *
 * ⚠️ THIS FILE IS A DELIBERATE REVERSAL, AND THE HISTORY MATTERS. 1e9145d4 moved the overtime list ONTO
 * this route; 2166ef79 moved it OFF again, onto the shared My Attendance screen as a fourth tab, and left
 * this file as a one-line redirect into that tab — both times because that is what the reporter asked for
 * at the time. c6bb5f5a is them asking for the opposite, in writing and confirmed: Self Overtime gets its
 * own menu row AND its own page, showing overtime and nothing else. So the redirect is gone and the list
 * is rendered here.
 *
 * MOVED, NOT REBUILT — for the third time, and that is the point. Same `myOvertimePlans` read, same seven
 * columns, same Withdrawn-vs-Cancelled wording, same withdraw-eligibility rule mirrored from the service.
 * A relocation that re-implemented the list would be how the employee's screen and the approver's start
 * disagreeing about one plan.
 *
 * THE ERROR QUERY IS WHY THIS ROUTE COULD NEVER JUST BE DELETED. `myWithdrawOvertimePlan` reports a refusal
 * ("the overtime date has passed") by redirecting to `/attendance/plan-ot?error=…`. The banner below is
 * what makes that visible; without it the employee presses Withdraw, the list comes back unchanged, and
 * nothing says why. `toast` is still NOT rendered: no screen in this module renders one (it never has).
 *
 * THE APPLY FORM DID NOT MOVE. `/attendance/plan-ot/apply` is untouched — same fields, same island, same
 * server action, same warnings. Its entry point is the button in this header again, where it began.
 *
 * TRUST MODEL: self-service, so NO page guard — the viewer's own employment is resolved from the session,
 * the read is RLS-scoped to it, and the withdraw action re-resolves the caller server-side. See the nav row
 * in packs/attendance/index.ts (ungated, like its siblings) and test/attendance-pack.test.ts.
 */
export default async function SelfOvertimePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const t = await getTranslations('me');
  const sp = await searchParams;
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

  const today = todayInKualaLumpur();
  const [plans, lines] = await Promise.all([
    myOvertimePlans(s, me.employmentId, { limit: 100 }),
    reportingLinesFor(s, me.employmentId),
  ]);
  // Who the plan goes to. Resolved from the administrative reporting line — the edge assertCanDecide routes
  // the decision along — falling back to HR rather than blank, because "nobody" is never the answer.
  const approver = lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown');

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('planOtTitle')}
        description={
          <>
            <span>{[me.name, me.employeeCode, me.position, me.company].filter(Boolean).join(' · ')}</span>
            <span className="mt-0.5 block">{t('maSectionOvertimeHelp')}</span>
          </>
        }
        actions={
          <Button asChild size="sm">
            <Link href="/attendance/plan-ot/apply">{t('maApplyOvertime')}</Link>
          </Button>
        }
      />

      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">{t('maSectionOvertime')}</div>
        {plans.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('otNoPlans')}</p>
        ) : (
          <div className={tableWrapCls}>
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
                  // Mirrored from cancelPlannedOvertime so the control is not offered where the service
                  // would refuse it. The SERVICE is the authority.
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
                        {p.otReasonCategory && <span className="font-medium">{t(CATEGORY_KEY[p.otReasonCategory])}</span>}
                        {p.otReasonCategory && p.reason ? ' — ' : ''}
                        <span className="text-muted-foreground">{p.reason ?? ''}</span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{approver}</td>
                      <td className="px-3 py-2">
                        <Pill status={p.status} label={statusLabel(p.status, t, true)} />
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
