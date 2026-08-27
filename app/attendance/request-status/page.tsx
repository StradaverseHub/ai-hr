import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { myAttendanceCorrections } from '@/packs/attendance/service';
import { Card, ErrorBanner, PageHeader, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { myCancelAttendanceRequest } from '@/app/me/actions';
import { KIND_LABEL, Pill, askedFor, statusLabel } from '../request-ui';

/**
 * My Attendance > My Attendance Request Status — every request the employee has filed, and what happened
 * to it.
 *
 * MOVED, NOT REBUILT. This card is 2166ef79's "My attendance requests" list, lifted whole off the shared
 * screen: the same `myAttendanceCorrections` read, the same status-filter pills, the same columns (date,
 * type, what was asked for, submitted, who it went to, outcome), the same pager and the same cancel rule.
 * c6bb5f5a asked for it to have its own menu row and its own page rather than sitting under four tabs
 * about attendance exceptions, and that is the whole of the change.
 *
 * WHY IT IS NOT ALSO LEFT BEHIND. Two copies of a request list drift, and this one carries an ACTION
 * (cancel). The irregularity screen still tells an employee that a day already has a request waiting —
 * that is the `pendingDates` marker on the row, which is a different statement and stays there.
 *
 * OVERTIME IS LISTED HERE BUT NOT WITHDRAWN HERE, deliberately and unchanged: an overtime plan is taken
 * back from Self Overtime under its own state rule (approved-but-not-yet-counted may still be withdrawn),
 * while a clock correction may only be cancelled while pending — approving one rewrites an attendance day.
 * The service enforces both; this screen only decides whether to draw a control.
 *
 * TRUST MODEL: self-service, so NO page guard. Own employment from the session, RLS-scoped read, and the
 * cancel action re-resolves the caller server-side.
 */
export default async function MyRequestStatusPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    /** pending | approved | rejected | cancelled (absent = All). */
    status?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const t = await getTranslations('me');
  const sp = await searchParams;
  const s = await getSession();
  const me = await myEmployment(s);

  if (!me) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('myAttendanceRequestStatus')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  const [requests, lines] = await Promise.all([
    myAttendanceCorrections(s, me.employmentId, { limit: 200 }),
    reportingLinesFor(s, me.employmentId),
  ]);
  const approver = lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown');

  const statusFilter = parseStatus(sp.status);
  const shown = statusFilter ? requests.filter((r) => r.status === statusFilter) : requests;
  const reqPage = paginateRows(shown, parsePageQuery(sp));

  const href = (status: string | null) =>
    status ? `/attendance/request-status?status=${status}` : '/attendance/request-status';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('myAttendanceRequestStatus')}
        description={
          <>
            <span>{[me.name, me.employeeCode, me.position, me.company].filter(Boolean).join(' · ')}</span>
            <span className="mt-0.5 block">{t('myAttendanceRequestStatusHelp')}</span>
          </>
        }
      />

      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">{t('maRequestsTitle')}</div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          {STATUS_FILTERS.map((f) => {
            const on = (f ?? null) === statusFilter;
            return (
              <Link
                key={f ?? 'all'}
                href={href(f ?? null)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'
                }`}
              >
                {f == null ? t('maFilterAll') : statusLabel(f, t, false)}
              </Link>
            );
          })}
        </div>
        {reqPage.rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('maNoRequests')}</p>
        ) : (
          <div className={tableWrapCls}>
            <table className="w-full text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>{t('maColDate')}</th>
                  <th className={thCls}>{t('maColType')}</th>
                  <th className={thCls}>{t('maColAsked')}</th>
                  <th className={thCls}>{t('maColSubmitted')}</th>
                  <th className={thCls}>{t('otGoesToColumn')}</th>
                  <th className={thCls}>{t('otStatusColumn')}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody className={tbodyCls}>
                {reqPage.rows.map((r) => {
                  const isOt = r.proposedCheckIn == null && r.requestedOtMinutes != null;
                  return (
                    <tr key={r.id}>
                      <td className="px-3 py-2.5 tabular-nums">{r.attendanceDate}</td>
                      <td className="px-3 py-2.5">{t(KIND_LABEL[r.requestKind ?? (isOt ? 'self_overtime' : 'other')])}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        <div className="tabular-nums">{askedFor(r, t)}</div>
                        {r.reason && <div className="text-[11px]">{r.reason}</div>}
                        {r.remark && <div className="text-[11px] italic">{r.remark}</div>}
                        {r.hasAttachment && (
                          <a
                            href={`/attendance/requests/attachment/${r.id}`}
                            className="text-[11px] font-medium text-primary underline-offset-2 hover:underline"
                          >
                            {t('maAttachmentOnRequest')}
                          </a>
                        )}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">
                        {r.createdAt.toISOString().slice(0, 10)}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">{approver}</td>
                      <td className="px-3 py-2.5">
                        <Pill status={r.status} label={statusLabel(r.status, t, isOt)} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {!isOt && r.status === 'pending' ? (
                          <form action={myCancelAttendanceRequest}>
                            <input type="hidden" name="correctionId" value={r.id} />
                            <button
                              type="submit"
                              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                            >
                              {t('maCancelRequest')}
                            </button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager basePath="/attendance/request-status" params={{ status: sp.status }} state={reqPage.state} />
      </Card>
    </div>
  );
}

const STATUS_FILTERS = [null, 'pending', 'approved', 'rejected', 'cancelled'] as const;

const parseStatus = (raw: string | undefined) =>
  (['pending', 'approved', 'rejected', 'cancelled'] as const).includes(raw as never)
    ? (raw as 'pending' | 'approved' | 'rejected' | 'cancelled')
    : null;
