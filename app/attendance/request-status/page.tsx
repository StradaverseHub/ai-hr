import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { myEmployment, reportingLinesFor } from '@/core/read';
import { MY_ATTENDANCE_REQUEST_ROW_CEILING, myAttendanceCorrections } from '@/packs/attendance/service';
import { Button, Card, ErrorBanner, PageHeader, pageWideCls, tableWrapCls, tbodyCls, theadCls, thCls } from '@/components/ui';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { myCancelAttendanceRequest } from '@/app/me/actions';
import { KIND_LABEL, Pill, REQUEST_STATUSES, askedFor, statusLabel } from '../request-ui';
import { parseRequestStatus, requestRowsProbeLimit, resolveRequestRows } from './rows';

/**
 * My Attendance > My Request — every request the employee has filed, and what happened to it.
 *
 * 7709ffd1 (r369) — THE ROW AND THE TITLE READ "My Request", and the LABELS are all that changed about
 * either. The rail truncated "My Attendance Request Status" to "My Attendance Request …", which is the
 * reporter's complaint; `nav.myAttendanceRequestStatus` and `me.myAttendanceRequestStatus` carry the new
 * words in all six catalogues and the KEY, the href and the route are untouched (the same label-only
 * pattern r362 used when My Records became Attendance Overview), so no bookmark breaks and nothing needs
 * redirecting. The card header is `me.maRequestsTitle`, now "My requests".
 *
 * ⚠️ TWO THINGS THE TICKET ASKED FOR DO NOT EXIST TO RENAME, and that is recorded rather than quietly
 * skipped: there is no breadcrumb on any screen in this product, and the browser tab is one global title —
 * giving this page its own would make it the only page that behaves differently.
 *
 * MOVED, NOT REBUILT. This card is 2166ef79's "My requests" list, lifted whole off the shared
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
 * overtime plan is withdrawn from Self Overtime under its own condition (see above), so the take-back
 * control appears here only on a NON-overtime request that is still pending.
 *
 * r363 — ONE WORD FOR ONE STATE ON THIS SCREEN, AND ONLY THE WORD CHANGED. The reporter read a filter chip
 * saying "Cancelled" directly above an overtime row saying "Withdrawn". Both kinds of row, the chip and the
 * take-back button now resolve "Withdrawn" / "Withdraw" — Self Overtime's own words, already translated in
 * all six catalogues — because only the employee can ever put one of these requests into `cancelled`
 * (see the comment above `statusLabel` in ../request-ui). The stored value, the URL (`?status=cancelled`),
 * the reads, the two state rules above and every name in this file are untouched.
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
      /* `max-w-md`, not `max-w-2xl`: `capsPage` in test/attendance-screens-layout.test.ts reads
         `mx-auto` + `max-w-…xl` as a PAGE-level cap, and this screen is now in WIDE_LIST_SCREENS. The
         one-sentence notice stays centred and narrow while the SCREEN is full width — the same
         arrangement app/attendance/requests/page.tsx and app/attendance/plan-ot/page.tsx use. */
      <div className="mx-auto max-w-md">
        <Card className="p-8 text-center">
          <h1 className="text-lg font-semibold">{t('myAttendanceRequestStatus')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('notLinked')}</p>
        </Card>
      </div>
    );
  }

  /**
   * 7709ffd1 (r369) — THE STATUS NARROWS THE READ, AND THE READ ANSWERS ONE ROW PAST THE CEILING.
   *
   * What stood here was `{ limit: 200 }` followed by `requests.filter(r => r.status === statusFilter)` and
   * a pager whose total was `shown.length`. Three things were wrong with that together: the 200 was a
   * private number nobody could see, the filter ran over whatever the 200 happened to contain, and the
   * total was counted off the fetched array — so an employee past the cap read "200" and was told nothing.
   *
   * Now the status goes INTO the query (so pressing a tab genuinely narrows what is read, which is what
   * makes the refusal below actionable), and the limit is one past the kernel's published ceiling so the
   * page can tell a complete answer from a cut one. Past it the screen REFUSES rather than slicing: see
   * ./rows.ts. The pager's total is therefore always counted over a list that is known to be complete.
   */
  const statusFilter = parseRequestStatus(sp.status);
  const [fetched, lines] = await Promise.all([
    myAttendanceCorrections(s, me.employmentId, {
      ...(statusFilter ? { status: statusFilter } : {}),
      limit: requestRowsProbeLimit(MY_ATTENDANCE_REQUEST_ROW_CEILING),
    }),
    reportingLinesFor(s, me.employmentId),
  ]);
  const approver = lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown');

  const { rows: shown, refusal } = resolveRequestRows(fetched, MY_ATTENDANCE_REQUEST_ROW_CEILING);
  const reqPage = paginateRows(shown, parsePageQuery(sp));
  /** The file must hold what the screen holds, so it is offered only when the screen has a complete list. */
  const exportHref = `/attendance/request-status/export?format=xlsx${statusFilter ? `&status=${statusFilter}` : ''}`;

  const href = (status: string | null) =>
    status ? `/attendance/request-status?status=${status}` : '/attendance/request-status';

  return (
    /* 7709ffd1 (r369) — `pageWideCls`, the twelfth list screen in this menu to take it. At
       `mx-auto max-w-6xl` roughly a third of a wide monitor was empty margin while "What was asked for",
       the column carrying the most words, was the one being squeezed. Listed in
       test/attendance-screens-layout.test.ts WIDE_LIST_SCREENS in the round that grants it. */
    <div className={pageWideCls}>
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
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 text-sm font-semibold">
          <span>{t('maRequestsTitle')}</span>
          {/* THE EXPORT IS A PLAIN GET LINK, like every other download in this product: the browser shows
              its own progress and a refusal comes back as a sentence on screen. No client island, no
              spinner and no toast — the shell has no toast for downloads and adding one here would make
              this the odd link out.
              It is NOT DRAWN when the list was refused (a file cannot be more complete than the screen it
              was asked from) and not when there is nothing in it — an export link over an empty tab is an
              empty workbook nobody asked for, so the muted sentence says so instead. */}
          {refusal == null && reqPage.state.total > 0 ? (
            <Link
              href={exportHref}
              prefetch={false}
              className="ml-auto font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('maExportExcel')}
            </Link>
          ) : refusal == null ? (
            <span className="ml-auto text-xs font-normal text-muted-foreground">{t('maExportNone')}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          {STATUS_FILTERS.map((f) => {
            const on = (f ?? null) === statusFilter;
            return (
              <Link
                key={f ?? 'all'}
                href={href(f ?? null)}
                // The filters are unchanged for the eye, as the plan promised. This attribute is not
                // visible: without it, colour is the ONLY carrier of which filter is applied, so a screen
                // reader hears five identical links. Same treatment as the segmented filters on
                // app/admin/personnel.
                aria-current={on ? 'true' : undefined}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'
                }`}
              >
                {f == null ? t('maFilterAll') : statusLabel(f, t, false)}
              </Link>
            );
          })}
        </div>
        {/* REFUSED, NOT SLICED. `maNoRequests` says "you have not filed any" and would be a lie here: the
            reader has MORE than this screen shows, not none. The status pills above stay drawn, because
            narrowing by one of them is the way out — the status is part of the query now. */}
        {refusal === 'too_many' ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="ma-too-many">
            {t('maTooManyRequests', { ceiling: MY_ATTENDANCE_REQUEST_ROW_CEILING })}
          </p>
        ) : reqPage.rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('maNoRequests')}</p>
        ) : (
          <>
            {/* WIDE (lg and up) — the seven-column table, unchanged but for the Cancel control's styling.
                ⚠️ `lg`, NOT `md`, AND THE ARITHMETIC IS THE REASON. The nav rail appears at `sm` and takes
                232px (components/sidebar.tsx), and the shell adds 24px of padding and a 12px gap
                (app/layout.tsx). So a 768px viewport gives this list a ~500px CONTENT column — narrower
                than the ~615px the block face gets at 639px. Switching at `md` would therefore bring the
                seven columns back at the tightest width the screen ever has. `lg` (1024px) keeps the
                table on every laptop, which is what the approved plan promised, and gives the 768-1023px
                band the blocks it is actually better served by. */}
            <div className={`hidden lg:block ${tableWrapCls}`}>
              <table className="w-full text-sm">
                {/* The page is full width now, so the room has to go somewhere deliberate: "What was asked
                    for" carries the reason and the remark under the asked-for line and is the column the
                    reporter said was being squeezed. Percentages on <col>, NOT `table-fixed` — fixed layout
                    would clip those two sub-lines instead of wrapping them. */}
                <colgroup>
                  <col className="w-[10%]" />
                  <col className="w-[12%]" />
                  <col className="w-[34%]" />
                  <col className="w-[12%]" />
                  <col className="w-[16%]" />
                  <col className="w-[10%]" />
                  <col className="w-[6%]" />
                </colgroup>
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
                      <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{submittedOn(r)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{approver}</td>
                      <td className="px-3 py-2.5">
                        <Pill status={r.status} label={statusLabel(r.status, t, isOvertime(r))} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {canCancel(r) ? (
                          <CancelRequest id={r.id} label={t('otWithdraw')} on={r.attendanceDate} />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* NARROW (below lg) — the same rows, one block each. Date and outcome share the first line;
                everything the table stacked inside one cell gets its own line underneath. */}
            <ul className="divide-y divide-border lg:hidden">
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
                      {t('maColSubmitted')} <span className="tabular-nums">{submittedOn(r)}</span>
                    </span>
                    {/* ⚠️ THE LABEL ONLY WHERE IT IS STILL TRUE. `otGoesToColumn` reads "Goes to" (ms
                        "Kepada", th/vi "sent to") — fine as a column HEADING over a list of names, and a
                        false statement as a running caption beside a red Rejected pill: it says the
                        request is still with that person when it was decided weeks ago. And `approver` is
                        the employee's CURRENT approver, not whoever decided this row, so on a settled
                        request it may not even be the right name. AGENTS 28 — a caption that asserts
                        something untrue is worse than one that is merely terse. Pending rows keep it;
                        decided rows show nothing rather than a claim we cannot stand behind. */}
                    {r.status === 'pending' ? (
                      <span>
                        {t('otGoesToColumn')} {approver}
                      </span>
                    ) : null}
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
                      <CancelRequest id={r.id} label={t('otWithdraw')} on={r.attendanceDate} />
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
        {/* No pager over a refused list: its total would be 0 beside a sentence saying there are hundreds. */}
        {refusal == null ? (
          <Pager basePath="/attendance/request-status" params={{ status: sp.status }} state={reqPage.state} />
        ) : null}
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

/**
 * The submitted date, in ONE place.
 *
 * It is the expression the table has always shown, kept byte-for-byte: this round is presentational and
 * changing a printed date is not presentational. It is lifted here only so the two faces cannot come to
 * disagree — the build briefly carried two copies of it.
 *
 * ⚠️ 7709ffd1 (r369) — THIS IS THE ROUND THAT SAYS SO. What stood here read: "IT IS A UTC SLICE RENDERED
 * TO A UTC+8 AUDIENCE, and that is a REAL pre-existing defect, not a style: a request filed at 07:00 in
 * Kuala Lumpur prints the previous day. `lib/hr-date.ts` already has `todayInKualaLumpur` for it. Fixing it
 * changes what people see and belongs to a round that says so — not to this one." The expression was
 * `r.createdAt.toISOString().slice(0, 10)`.
 *
 * THE EXPORT IS WHY IT COULD NOT WAIT. This round puts a Submitted column in a downloadable file, and the
 * only two ways out of that were to repeat the defect in the workbook or to let the file and the screen
 * print different days for one request — the second being precisely the "two figures for one thing" fault
 * cac9a3a1 was raised about. So the ONE expression both faces and the export route resolve is the
 * Malaysian calendar day, which is what `attendance_correction.created_at` is a UTC+8 event. Same class of
 * fix as r362's on Self Overtime.
 */
const submittedOn = (r: RequestRow) => todayInKualaLumpur(r.createdAt);

/** The `me` key naming the request's kind. `other` covers every request filed before migration 0434. */
const kindKey = (r: RequestRow) => KIND_LABEL[r.requestKind ?? (isOvertime(r) ? 'self_overtime' : 'other')];

/**
 * The take-back control, as a BUTTON — the module's standard small outline button (the one every other
 * My Attendance screen submits with), not the bare underlined word it used to be. Still the same
 * server-action form, and the decision to draw it at all still stays with `canCancel`.
 *
 * r363 — THE WORD ON IT IS `me.otWithdraw`, WHICH IS SELF OVERTIME'S. It used to be `me.maCancelRequest`
 * ("Cancel"), and the reporter read two words for one act on one screen. The KEY is what matters here,
 * not the English: Self Overtime's withdraw control resolves the same key, so the two screens cannot
 * drift into different words again without someone editing both. `maCancelRequest` is retired, not
 * deleted — it stays in all six catalogues and is simply no longer rendered.
 *
 * THE NAMES ARE DELIBERATELY NOT SWEPT. `CancelRequest`, `canCancel` and `myCancelAttendanceRequest`
 * keep their names: the stored status is still `cancelled`, renaming them is a separate decision, and
 * test/attendance-screens-layout.test.ts case D pins each of them verbatim.
 */
function CancelRequest({ id, label, on }: { id: string; label: string; on: string }) {
  return (
    <form action={myCancelAttendanceRequest}>
      <input type="hidden" name="correctionId" value={id} />
      {/* `aria-label` carries the DATE as well as the verb. Every pending row draws this control, so
          without it a screen reader hears the same one word down the whole list with nothing to say
          which request each one takes back. The date needs no translation. */}
      <Button type="submit" size="sm" variant="outline" aria-label={`${label} · ${on}`}>
        {label}
      </Button>
    </form>
  );
}

/** The filter row: All, then the four stored statuses — derived from the ONE tuple, never restated. */
const STATUS_FILTERS = [null, ...REQUEST_STATUSES] as const;

/*
 * …and so is the URL whitelist — LIFTED INTO ./rows.ts by 7709ffd1 (r369) rather than copied. What stood
 * here was:
 *   const parseStatus = (raw: string | undefined) =>
 *     REQUEST_STATUSES.includes(raw as never) ? (raw as (typeof REQUEST_STATUSES)[number]) : null;
 * The export route has to narrow by exactly what the pressed pill narrows by, and a second copy of this
 * three-line derivation in the route is how a file comes to hold "every request" while the tab said
 * "Rejected". It is still DERIVED from REQUEST_STATUSES and not restated — see `parseRequestStatus`.
 */
