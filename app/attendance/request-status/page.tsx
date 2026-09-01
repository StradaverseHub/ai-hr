import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { myAttendanceCorrections } from '@/packs/attendance/service';
import { Button, Card, ErrorBanner, PageHeader, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { myCancelAttendanceRequest } from '@/app/me/actions';
import { KIND_LABEL, Pill, REQUEST_STATUSES, askedFor, statusLabel } from '../request-ui';

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
 *
 * r239 — TWO FACES OF THE SAME LIST, AND NOTHING ELSE CHANGED. The reporter approved a plan whose whole
 * content is presentational: a narrow screen gets one BLOCK per request, with the date and the outcome on
 * the same line (the answer they came for, read first) and the reason, remark, approver and attachment
 * given room UNDERNEATH instead of stacked inside one table cell; a wide monitor keeps the seven-column
 * table exactly as it was. The read, the filter, the status colours and the pager are untouched.
 *
 * `md:` IS THE SWITCH (768px). Below it the seven columns can only be reached by dragging the table
 * sideways, and the Status column — the thing being looked for — is the furthest one from the date. It is
 * the breakpoint the app shell itself divides at (app/layout.tsx) and the one the module's other
 * two-shapes-one-content layouts use, so this screen does not introduce a third idea of "narrow".
 *
 * NO CLIENT STATE, deliberately: both faces are rendered server-side and CSS decides which one is visible.
 * A viewport-measuring island would cost a hydration round trip on a list that never changes after it is
 * rendered, and would flash the wrong shape first. (The guard that pins this scans the source for the
 * browser APIs that would do it, so this note names none of them — AGENTS 27.)
 *
 * ONE DEFINITION OF THE CANCEL RULE (`canCancel` below). Two faces drawing the same control is exactly how
 * a state rule ends up written twice and then differing — and this one is a real rule, not styling: an
 * overtime plan is withdrawn from Self Overtime under its own condition (see above), so Cancel appears
 * here only on a NON-overtime request that is still pending.
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
          <>
            {/* WIDE (md and up) — the seven-column table, unchanged but for the Cancel control's styling. */}
            <div className={`hidden md:block ${tableWrapCls}`}>
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
                  {reqPage.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2.5 tabular-nums">{r.attendanceDate}</td>
                      <td className="px-3 py-2.5">{t(kindKey(r))}</td>
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
                        <Pill status={r.status} label={statusLabel(r.status, t, isOvertime(r))} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {canCancel(r) ? <CancelRequest id={r.id} label={t('maCancelRequest')} /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* NARROW (below md) — the same rows, one block each. Date and outcome share the first line;
                everything the table stacked inside one cell gets its own line underneath. */}
            <ul className="divide-y divide-border md:hidden">
              {reqPage.rows.map((r) => (
                <li key={r.id} className="space-y-1.5 px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 text-sm">
                      <span className="font-semibold tabular-nums">{r.attendanceDate}</span>
                      <span className="ml-2 text-muted-foreground">{t(kindKey(r))}</span>
                    </div>
                    <Pill status={r.status} label={statusLabel(r.status, t, isOvertime(r))} />
                  </div>
                  <p className="text-sm">
                    <span className="tabular-nums">{askedFor(r, t)}</span>
                    {r.reason && <span className="text-muted-foreground"> — {r.reason}</span>}
                  </p>
                  {r.remark && <p className="text-sm italic text-muted-foreground">{r.remark}</p>}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {t('maColSubmitted')}{' '}
                      <span className="tabular-nums">{r.createdAt.toISOString().slice(0, 10)}</span>
                    </span>
                    <span>
                      {t('otGoesToColumn')} {approver}
                    </span>
                    {r.hasAttachment && (
                      <a
                        href={`/attendance/requests/attachment/${r.id}`}
                        className="font-medium text-primary underline-offset-2 hover:underline"
                      >
                        {t('maAttachmentOnRequest')}
                      </a>
                    )}
                  </div>
                  {canCancel(r) ? (
                    <div className="pt-1">
                      <CancelRequest id={r.id} label={t('maCancelRequest')} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
        <Pager basePath="/attendance/request-status" params={{ status: sp.status }} state={reqPage.state} />
      </Card>
    </div>
  );
}

/** One row of the list, as the read returns it. */
type RequestRow = Awaited<ReturnType<typeof myAttendanceCorrections>>[number];

/**
 * Is this row an overtime PLAN rather than a clock correction? Overtime is the only kind filed without a
 * proposed clock-in, and it is the distinction the label and the cancel rule both turn on — so it is
 * written once here rather than inline in each of the two faces.
 */
const isOvertime = (r: RequestRow) => r.proposedCheckIn == null && r.requestedOtMinutes != null;

/**
 * THE CANCEL RULE. A clock correction may only be cancelled while PENDING, because approving one rewrites
 * an attendance day; an overtime plan is withdrawn from Self Overtime under its own state rule and never
 * from here. Both faces of the list ask this question, and a second copy of the condition is how the two
 * would come to disagree about which requests may still be taken back.
 */
const canCancel = (r: RequestRow) => !isOvertime(r) && r.status === 'pending';

/** The `me` key naming the request's kind. `other` covers every request filed before migration 0434. */
const kindKey = (r: RequestRow) => KIND_LABEL[r.requestKind ?? (isOvertime(r) ? 'self_overtime' : 'other')];

/**
 * Cancel, as a BUTTON — the module's standard small outline button (the one every other My Attendance
 * screen submits with), not the bare underlined word it used to be. Still the same server-action form:
 * only the styling changed, and the decision to draw it at all stays with `canCancel`.
 */
function CancelRequest({ id, label }: { id: string; label: string }) {
  return (
    <form action={myCancelAttendanceRequest}>
      <input type="hidden" name="correctionId" value={id} />
      <Button type="submit" size="sm" variant="outline">
        {label}
      </Button>
    </form>
  );
}

/** The filter row: All, then the four stored statuses — derived from the ONE tuple, never restated. */
const STATUS_FILTERS = [null, ...REQUEST_STATUSES] as const;

/** …and so is the URL whitelist, so the pills and the addresses they link to cannot drift apart. */
const parseStatus = (raw: string | undefined) =>
  REQUEST_STATUSES.includes(raw as never) ? (raw as (typeof REQUEST_STATUSES)[number]) : null;
