import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { leaveBalancesAll, listEmployees, listLeaveTypes, listLeaveRequests } from '@/core/read';
import { Avatar, Button, Card, Field, PageHeader, inputCls } from '@/components/ui';
import { styleFor } from '@/components/planned-absences';
import { LeaveDurationFields } from '@/components/leave-duration-fields';
import { durationLabel } from '@/lib/leave-duration';
import { requestLeaveAction, requestLeaveCancellationAction } from './actions';

const REQ_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
};

// Self-service Leave page (consultant feedback #8/#10): Balance + History + Apply only. Team
// availability lives on the Dashboard (the "Planned absences" timeline); approvals live in the
// Approvals inbox. So this page no longer carries the team-availability calendar, the status-filter
// chips, or inline approve/reject — keeping the employee/manager view focused on their own leave.
export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    // Partial Leave Cancellation (ADR-0065): success toast after a cancellation request is submitted.
    toast?: string;
    // Phase-B #15: non-blocking holiday-completeness warning surfaced after a request was created.
    warnHoliday?: string;
    loaded?: string;
    state?: string;
    year?: string;
  }>;
}) {
  const { s: session, scopeIds } = await scopedSession();
  const t = await getTranslations('leave');
  const admin = isAdmin(session);
  const today = new Date().toISOString().slice(0, 10);
  const sp = await searchParams;

  // Partial Leave Cancellation (ADR-0065): the FUTURE working-day candidates for a row's cancel disclosure.
  // Best-effort hint (strictly-after-today weekdays in the span) — the service re-validates each posted date
  // against the real roster/holidays/closed-periods, so a weekend the heuristic might miss is rejected there.
  const futureCancelDates = (start: string, end: string): string[] => {
    const out: string[] = [];
    for (let tms = Date.parse(`${start}T00:00:00Z`); tms <= Date.parse(`${end}T00:00:00Z`); tms += 86_400_000) {
      const d = new Date(tms);
      const iso = d.toISOString().slice(0, 10);
      const dow = d.getUTCDay(); // 0=Sun … 6=Sat
      if (iso > today && dow !== 0 && dow !== 6) out.push(iso);
    }
    return out;
  };

  const [employees, leaveTypes, requests, balances] = await Promise.all([
    listEmployees(session, scopeIds),
    listLeaveTypes(session),
    listLeaveRequests(session, scopeIds),
    leaveBalancesAll(session, scopeIds),
  ]);
  const active = employees.filter((e) => !e.terminatedOn);

  // Balances are personal: admins see everyone in scope; everyone else sees ONLY their own.
  const visibleBalances = admin ? balances : balances.filter((b) => b.personId === session.personId);

  // History is personal too: a manager/employee sees only their OWN requests here (team requests and
  // approvals are in the Approvals inbox). Admins keep the full list as an oversight read.
  const history = admin
    ? requests
    : requests.filter((r) => session.personId != null && r.personId === session.personId);

  // Pivot balances: one row per employee, one column per leave type seen.
  const balTypes = [...new Map(visibleBalances.map((b) => [b.leaveTypeId, b.leaveType])).entries()].sort(
    (a, b) => a[1].localeCompare(b[1]),
  );
  const balByEmp = new Map<string, { name: string; cells: Map<string, (typeof balances)[number]> }>();
  for (const b of visibleBalances) {
    const e = balByEmp.get(b.employmentId) ?? { name: b.name, cells: new Map() };
    e.cells.set(b.leaveTypeId, b);
    balByEmp.set(b.employmentId, e);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div data-tour="leave-intro">
        <PageHeader title={t('title')} description={t('description')} />
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {sp.error}
        </div>
      )}

      {sp.toast === 'cancellationRequested' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('cancelRequestedToast')}
        </div>
      )}

      {sp.warnHoliday && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          {t('errors.holidaysIncomplete', {
            loaded: sp.loaded ?? '0',
            state: sp.state || '—',
            year: sp.year ?? '',
          })}
        </div>
      )}

      <Card className="overflow-hidden" data-tour="leave-balance">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          {admin ? t('balancesTitle') : t('myBalancesTitle')}
          <span className="ml-2 font-normal text-muted-foreground">{t('balancesSubtitle')}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                {balTypes.map(([id, name]) => (
                  <th key={id} className="px-4 py-2 text-right font-medium">
                    {name.replace(/\s*leave$/i, '')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[...balByEmp.entries()].map(([empId, e]) => (
                <tr key={empId}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={e.name} className="size-7 text-[10px]" />
                      <span className="font-medium">{e.name}</span>
                    </div>
                  </td>
                  {balTypes.map(([typeId]) => {
                    const b = e.cells.get(typeId);
                    return (
                      <td
                        key={typeId}
                        className="px-4 py-2.5 text-right tabular-nums"
                        title={b ? t('balanceCellTitle', { taken: b.taken, pending: b.pending }) : undefined}
                      >
                        {b ? (
                          <>
                            {b.accrued > 0 || b.balance > 0 ? (
                              <>
                                <span className={b.available <= 0 ? 'font-semibold text-rose-600 dark:text-rose-400' : 'font-semibold'}>
                                  {b.available}
                                </span>
                                <span className="text-muted-foreground"> / {b.accrued}</span>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                            {b.pending > 0 && (
                              <span className="ml-1 text-[10px] font-medium uppercase text-amber-600 dark:text-amber-400">
                                {t('pendBadge', { count: b.pending })}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {balByEmp.size === 0 && (
                <tr>
                  <td colSpan={1 + balTypes.length} className="px-4 py-8 text-center text-muted-foreground">
                    {t('balancesEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden" data-tour="leave-requests">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">
          {admin ? t('requestsTitle') : t('myRequestsTitle')}
          <span className="ml-2 font-normal text-muted-foreground">{t('requestsCountTotal', { count: history.length })}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                <th className="px-4 py-2 font-medium">{t('colApplied')}</th>
                <th className="px-4 py-2 font-medium">{t('colType')}</th>
                <th className="px-4 py-2 font-medium">{t('colDates')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colDays')}</th>
                <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 font-medium">{t('colAction')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {history.map((r) => {
                const { chip, Icon } = styleFor(r.typeCode);
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={r.employee} className="size-7 text-[10px]" />
                        <span className="font-medium">{r.employee}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {r.appliedOn ? new Date(r.appliedOn).toISOString().slice(0, 10) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${chip}`}>
                        <Icon className="size-3" />
                        {r.leaveType.replace(/\s*leave$/i, '')}
                      </span>
                      {/* Emergency Leave (0106): an EL submission is decomposed into ANNUAL + UNPAID child
                          rows sharing a parent_group_id; tag each child so the two halves read as one EL. */}
                      {r.parentGroupId && (
                        <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t('emergency.groupLabel')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {r.startDate} → {r.endDate}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {Number(r.days)}
                      {durationLabel(t, r.durationType, r.hours) && (
                        <span className="ml-1 text-[10px] font-medium uppercase text-muted-foreground">
                          {durationLabel(t, r.durationType, r.hours)}
                        </span>
                      )}
                      {/* Hourly-leave time window (0129): the actual window on hourly rows, slice-guarded for
                          the Postgres seconds, gated so non-hourly rows never render a stray time. */}
                      {r.durationType === 'hourly' && r.fromTime && r.toTime && (
                        <span className="ml-1 text-[10px] font-medium text-muted-foreground">
                          {r.fromTime.slice(0, 5)}–{r.toTime.slice(0, 5)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${REQ_STATUS[r.status] ?? 'bg-muted text-muted-foreground'}`}>
                        {t(`status.${r.status}`)}
                      </span>
                      {/* Partial Leave Cancellation (ADR-0065): a pending give-back request shows a pill. */}
                      {r.pendingCancellationId && (
                        <span className="ml-1.5 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                          {t('cancelPendingBadge')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {(() => {
                        // Affordance shown only on the viewer's OWN approved, full-day, non-EL, multi-day row
                        // with ≥1 future working day and no pending cancellation. parentGroupId != null hides
                        // EL / per-date children (§2 — they'd throw). Admins viewing others' rows never see it
                        // (subject-only), matching the service's subject assertion.
                        const isOwn = session.personId != null && r.personId === session.personId;
                        const cands = futureCancelDates(r.startDate, r.endDate);
                        const eligible =
                          isOwn &&
                          r.status === 'approved' &&
                          r.durationType === 'full_day' &&
                          r.parentGroupId == null &&
                          !r.pendingCancellationId &&
                          cands.length > 0;
                        if (!eligible) return <span className="text-muted-foreground">—</span>;
                        return (
                          <details>
                            <summary className="cursor-pointer select-none text-xs font-medium text-indigo-600 dark:text-indigo-400">
                              {t('cancelDatesToggle')}
                            </summary>
                            <form action={requestLeaveCancellationAction} className="mt-2 space-y-2">
                              <input type="hidden" name="leaveRequestId" value={r.id} />
                              <p className="text-[11px] text-muted-foreground">{t('cancelDatesHint')}</p>
                              <div className="space-y-1">
                                {cands.map((d) => (
                                  <label key={d} className="flex items-center gap-2 text-xs">
                                    <input type="checkbox" name="cancelDate" value={d} />
                                    <span className="tabular-nums">{d}</span>
                                  </label>
                                ))}
                              </div>
                              <input name="reason" className={inputCls} placeholder={t('reasonPlaceholder')} />
                              <Button type="submit" size="sm" variant="outline">
                                {t('cancelSubmit')}
                              </Button>
                            </form>
                          </details>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
              {history.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    {t('requestsEmpty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card data-tour="leave-request">
        <details>
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
            {t('requestLeaveToggle')}
          </summary>
          <form
            action={requestLeaveAction}
            encType="multipart/form-data"
            className="grid grid-cols-1 gap-4 border-t border-border p-4 sm:grid-cols-2"
          >
            <Field label={t('fieldEmployee')}>
              <select name="employmentId" required className={inputCls}>
                {active.map((e) => (
                  <option key={e.employmentId} value={e.employmentId}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            <LeaveDurationFields
              types={leaveTypes.map((lt) => ({
                id: lt.id,
                // Supporting-document config: suffix a "· document required" badge so the applicant knows
                // a file is expected before submitting (mirrors /me). NOT leave.documentRequired — that key
                // is a full error sentence; this badge has its own leave.documentRequiredBadge key.
                label: lt.requiresDocument ? `${lt.name} · ${t('documentRequiredBadge')}` : lt.name,
                durations: lt.durations ?? null,
                code: lt.code,
              }))}
              startDefault={today}
              showDocumentFields
            />
            <Field label={t('fieldReason')}>
              <input name="reason" className={inputCls} placeholder={t('reasonPlaceholder')} />
            </Field>
            <div className="flex items-end">
              <Button type="submit">{t('submitRequest')}</Button>
            </div>
          </form>
        </details>
      </Card>
    </div>
  );
}
