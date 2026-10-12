import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { CREDIT_REGISTER_STATUSES, type CreditRegisterStatus } from '@/lib/leave-credit-register';

import { requireAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { DAY_DASH, formatDays } from '@/lib/day-format';
import { listCompanies, listEmployees, listLeaveTypes, replacementLeaveSummary } from '@/core/read';
import { pickReplacementLeaveType } from '@/core/ess-view';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import {
  LEAVE_CREDIT_MOVEMENTS,
  listLeaveCreditMovements,
  listEarnedLeaveCredits,
  type LeaveCreditMovement,
  type LeaveCreditStatus,
} from '@/packs/leave/service';
import { Card, EmployeeName, ErrorBanner, PageHeader, btnGhost, btnPrimary, inputCls, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import { LeaveCreditGrantDialog } from '@/components/leave/leave-credit-grant-dialog';
import { LeaveCreditReverseDialog } from '@/components/leave/leave-credit-reverse-dialog';
import { closeReplacementLeaveYearAction, runToilExpiryAction } from '../../actions';
import { grantLeaveCreditRowsAction, leaveCreditGrantContextAction, leaveCreditGrantDayFactsAction, reverseLeaveCreditAction } from './actions';

/** Not exported: Next refuses unknown exports from a page module. */
const PAGE = '/admin/leave-config/leave-credit';

/**
 * 3fb1a611 (r299) — LEAVE CONFIG › LEAVE CREDIT (`/admin/leave-config/leave-credit`).
 *
 * The approved plan's HR screen, and the answer to "why does this person have two days of Replacement Leave":
 * every credit movement — earned through a request (or the roster / an attendance correction), added by HR,
 * used by Replacement Leave, returned when that leave was cancelled, reversed, expired or paid out — each
 * traced to its date worked, with balance before and after, the reason, who did it and when, and its status.
 *
 * ONE LEDGER. Nothing on this page is stored twice: the list is `listLeaveCreditMovements` (core/toil.ts),
 * DERIVED from the Replacement Leave type's leave_ledger rows joined to the credit register and the audit log.
 * Its RUNNING-TOTAL ORDER is per employee, `effective_on`, then `created_at`, then `id` — stated on screen too,
 * because a line dated earlier than lines already recorded changes Before and After for every later line.
 *
 * THE CREDITS TAB of the Leave Credit row (the Rules tab is its own route, `./rules/page.tsx`, drawn by the
 * row's tab strip in components/leave-config-map.tsx): filters (employee, movement, date range), the
 * movements, + Add Leave Credit, Reverse, and the ledger summary + the two settlement sweeps that used to be
 * /admin/toil (a redirect stub now).
 *
 * ⚠️ GATED ON `toil`, WITH ONE DELIBERATE EXCEPTION — THE WIND-DOWN ARGUMENT, carried over from /admin/toil
 * (now a redirect stub) and not to be tidied away. The row is hidden without the module (sidebar) and this
 * page shows only a notice. BUT the two settlement sweeps are deliberately not entitlement-gated, and must
 * never be re-gated through the UI either: a tenant whose module lapses (trial end, downgrade, non-payment)
 * still owes the credits already banked, and for a First-Schedule employee that debt is statutory — unused
 * credit must convert to pay, never lapse (core/toil.ts `runToilExpiry`). This page is the sweeps' only
 * caller (there is no cron), so hiding them would strand the obligation. So when the module is off AND credits
 * are still outstanding, the page opens a WIND-DOWN view: the movements, the summary, the sweeps and Reverse —
 * no Add (and the Rules tab shows only the notice). Those services are admin-only by design; adding a credit
 * and saving the rules refuse in the service without the module regardless of what this page renders.
 *
 * SERVER COMPONENT. The Add and Reverse dialogs are client islands fed plain data and the server actions
 * only — no translator and no closure crosses the boundary (test/server-client-boundary.test.ts).
 */
export default async function LeaveConfigLeaveCreditPage({
  searchParams,
}: {
  searchParams: Promise<{
    employee?: string;
    movement?: string;
    status?: string;
    from?: string;
    to?: string;
    error?: string;
    granted?: string;
    otDate?: string;
    otMinutes?: string;
    reversed?: string;
    otBackDate?: string;
    otBackMinutes?: string;
    processed?: string;
    converted?: string;
    lapsed?: string;
    skipped?: string;
    closed?: string;
    closedAlready?: string;
    closedProcessed?: string;
    closedConverted?: string;
    closedLapsed?: string;
    closedCarried?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leaveCredit');
  const tToil = await getTranslations('admin.toilPolicy');
  const tr = await getTranslations('admin.leaveCreditRegister');
  const locale = await getLocale();
  const sp = await searchParams;
  const header = await leaveConfigPageHeader('leaveCredit');
  const today = todayInKualaLumpur();

  const moduleOn = isModuleEnabledOrFalse(s, 'toil');
  const companies = await listCompanies(s);
  const scopeIds = await getScopeIds(companies.map((c) => c.id));
  const visible = companies.filter((c) => scopeIds.includes(c.id)).map((c) => ({ id: c.id, name: c.name }));
  const visibleIds = visible.map((c) => c.id);
  // READ UNCONDITIONALLY (ADR-0077 slice 3, carried over from /admin/toil): the outstanding count is what
  // decides whether a tenant without the module still gets the wind-down view.
  const summary = await replacementLeaveSummary(s, visibleIds);
  const windDown = !moduleOn && summary.activeAccruals > 0;
  const showCredits = moduleOn || windDown;

  const employees = showCredits ? await listEmployees(s, visibleIds) : [];
  const employeeOptions = employees
    .map((e) => ({ id: e.employmentId, label: e.employeeCode ? `${e.employeeCode} — ${e.name}` : e.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  // r406 — the tenant's OWN name for its Replacement Leave type, as the employee's form prints it (the table
  // shows "Leave type: …"). A tenant with none yet still gets the form: the grant creates the type on first
  // use (`ensureReplacementLeaveType`), so the fixed English label stands in and nothing posts an id.
  const replacementLeaveType = moduleOn ? pickReplacementLeaveType(await listLeaveTypes(s, { locale, includeArchived: false })) : null;

  const fmtDate = (iso: string | null) => {
    if (!iso) return DAY_DASH;
    try {
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' }).format(
        new Date(`${iso.slice(0, 10)}T00:00:00`),
      );
    } catch {
      return iso;
    }
  };
  const fmtInstant = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kuala_Lumpur',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };
  const hoursOf = (minutes: string | undefined) => Math.round((Number(minutes ?? 0) / 60) * 100) / 100;

  // Labels resolved statically, one call each, so the i18n coverage scan can see every key.
  const MOVEMENT_LABEL: Record<LeaveCreditMovement, string> = {
    earned_request: t('movement.earnedRequest'),
    earned_roster: t('movement.earnedRoster'),
    earned_attendance: t('movement.earnedAttendance'),
    earned_other: t('movement.earnedOther'),
    added_hr: t('movement.addedHr'),
    used: t('movement.used'),
    returned: t('movement.returned'),
    reversed: t('movement.reversed'),
    expired: t('movement.expired'),
    paid_out: t('movement.paidOut'),
    other: t('movement.other'),
  };
  const KIND_LABEL = {
    workday: t('dayKind.workday'),
    rest_day: t('dayKind.restDay'),
    off_day: t('dayKind.offDay'),
    holiday: t('dayKind.holiday'),
  } as const;
  const STATUS: Record<LeaveCreditStatus, { label: string; cls: string }> = {
    available: { label: t('status.available'), cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' },
    used: { label: t('status.used'), cls: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300' },
    reversed: { label: t('status.reversed'), cls: 'bg-muted text-muted-foreground' },
    expired: { label: t('status.expired'), cls: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400' },
    paid_out: { label: t('status.paidOut'), cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' },
  };

  const registerStatus:CreditRegisterStatus|undefined=(CREDIT_REGISTER_STATUSES as readonly string[]).includes(sp.status??'')?sp.status as CreditRegisterStatus:undefined;
  const registerLabels:Record<CreditRegisterStatus,string>={available:tr('available'),partially_used:tr('partiallyUsed'),fully_used:tr('fullyUsed'),expired:tr('expired'),reversed:tr('reversed'),paid_out:tr('paidOut')};
  const isoOrUndefined = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const employeeFilter = employees.some((e) => e.employmentId === sp.employee) ? sp.employee : undefined;
  const movements = showCredits
    ? await listLeaveCreditMovements(s, {
          companyIds: visibleIds,
          employmentId: employeeFilter,

          from: isoOrUndefined(sp.from),
          to: isoOrUndefined(sp.to),
          today,
        })
    : null;

  const register = showCredits ? await listEarnedLeaveCredits(s,{companyIds:visibleIds,employmentId:employeeFilter,status:registerStatus,from:isoOrUndefined(sp.from),to:isoOrUndefined(sp.to),today}) : null;

  const banner = (text: string, extra?: string) => (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
      {text}
      {extra && <span className="mt-1 block font-medium">{extra}</span>}
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={header.title}
        description={header.description}
        actions={
          moduleOn ? (
            <LeaveCreditGrantDialog
              employees={employeeOptions}
              today={today}
              replacementType={
                replacementLeaveType
                  ? { id: replacementLeaveType.id, name: replacementLeaveType.name }
                  : { id: '', name: t('add.leaveTypeValue') }
              }
              submitAction={grantLeaveCreditRowsAction}
              contextAction={leaveCreditGrantContextAction}
              dayFactsAction={leaveCreditGrantDayFactsAction}
            />
          ) : undefined
        }
      />
      {/* The row's tab strip (Credits · Rules), drawn by the map — this page draws no strip of its own. */}
      <LeaveConfigMap current="leaveCredit" />

      <ErrorBanner message={sp.error} />

      {!showCredits ? (
        <Card className="p-4" data-testid="leave-credit-module-off">
          <h2 className="text-sm font-semibold text-foreground">{t('moduleOffTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('moduleOffBody')}</p>
        </Card>
      ) : (
        <>
          {windDown && (
            <div
              className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
              data-testid="leave-credit-wind-down"
            >
              {t('windDown', { accruals: summary.activeAccruals })}
            </div>
          )}
          {/* ⚠️ MONEY, SAID OUT LOUD. Adding a credit took that day's overtime out of payroll; reversing one
              put it back. The banner names the date and the hours either way. */}
          {sp.granted !== undefined &&
            banner(
              t('banner.granted', { days: formatDays(Number(sp.granted)) }),
              // r406 — several dates now (one row each); listed, each formatted. One date reads exactly as before.
              sp.otDate
                ? t('banner.grantedOvertime', { hours: hoursOf(sp.otMinutes), date: sp.otDate.split(',').map((d) => fmtDate(d)).join(', ') })
                : undefined,
            )}
          {sp.reversed !== undefined &&
            banner(
              t('banner.reversed', { days: formatDays(Number(sp.reversed)) }),
              sp.otBackDate
                ? t('banner.reversedOvertime', { hours: hoursOf(sp.otBackMinutes), date: fmtDate(sp.otBackDate) })
                : undefined,
            )}
          {sp.processed !== undefined &&
            banner(
              Number(sp.processed) === 0
                ? tToil('processedNone')
                : tToil('processedBanner', {
                    processed: Number(sp.processed),
                    converted: Number(sp.converted ?? 0),
                    lapsed: Number(sp.lapsed ?? 0),
                  }),
            )}
          {/* The partial sweep, amber (review r3): another company's statutory settlement left unsettled is
              not a success. */}
          {Number(sp.skipped ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              {tToil('processedSkipped', { skipped: Number(sp.skipped) })}
            </div>
          )}
          {sp.closed !== undefined &&
            banner(
              Number(sp.closedAlready) === 1
                ? tToil('closeAlready')
                : tToil('closeBanner', {
                    processed: Number(sp.closedProcessed ?? 0),
                    converted: Number(sp.closedConverted ?? 0),
                    lapsed: Number(sp.closedLapsed ?? 0),
                    carried: Number(sp.closedCarried ?? 0),
                  }),
            )}

          <Card className="p-4">
            {/* GET, so the filters ride in the address bar and a copied link opens the same list. */}
            <form method="get" action={PAGE} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1.5fr_1fr_1fr_auto]">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('filterEmployee')}</span>
                <select name="employee" defaultValue={employeeFilter ?? ''} className={inputCls}>
                  <option value="">{t('filterAllEmployees')}</option>
                  {employeeOptions.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tr('filterStatus')}</span>
                <select name="status" defaultValue={registerStatus??''} className={inputCls}>
                  <option value="">{tr('allStatuses')}</option>
                  {CREDIT_REGISTER_STATUSES.map(status=><option key={status} value={status}>{registerLabels[status]}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tr('workedFrom')}</span>
                <input type="date" name="from" defaultValue={isoOrUndefined(sp.from) ?? ''} className={inputCls} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tr('workedTo')}</span>
                <input type="date" name="to" defaultValue={isoOrUndefined(sp.to) ?? ''} className={inputCls} />
              </label>
              <div className="flex gap-2">
                <button className={btnGhost}>{t('filterApply')}</button>
                <Link href={PAGE} className={btnGhost}>
                  {t('filterClear')}
                </Link>
              </div>
            </form>

            {employeeFilter&&register&&<div className="my-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="earned-credit-summary">
              <Stat label={tr('earned')} value={formatDays(register.summary.earned)}/><Stat label={tr('used')} value={formatDays(register.summary.used)}/><Stat label={tr('expired')} value={formatDays(register.summary.expired)}/><Stat label={tr('availableBalance')} value={formatDays(register.summary.available)}/>
            </div>}
            <div className={`${tableWrapCls} mt-4`}>
              <table className="w-full min-w-[68rem] text-sm" data-testid="earned-leave-credits">
                <thead className={theadCls}><tr>
                  <th scope="col" className={thCls}>{t('col.dateWorked')}</th><th scope="col" className={thCls}>{t('col.employee')}</th>
                  <th scope="col" className={thCls}>{tr('earned')}</th><th scope="col" className={thCls}>{tr('used')}</th><th scope="col" className={thCls}>{tr('availableBalance')}</th>
                  <th scope="col" className={thCls}>{t('col.expires')}</th><th scope="col" className={thCls}>{t('col.reason')}</th><th scope="col" className={thCls}>{tr('addedBy')}</th><th scope="col" className={thCls}>{t('col.status')}</th><th scope="col" className={thCls}>{t('col.action')}</th>
                </tr></thead>
                <tbody className={tbodyCls}>{register!.rows.length===0?<tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">{t('empty')}</td></tr>:register!.rows.map(row=><tr key={row.accrualId} className="align-top">
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(row.workedDate)}{row.workedDayKind&&<span className="block text-xs text-muted-foreground">{KIND_LABEL[row.workedDayKind]}</span>}</td>
                  <td className="px-3 py-2"><EmployeeName code={row.employeeCode} name={row.employeeName}/></td>
                  <td className="px-3 py-2 tabular-nums">{formatDays(row.earned)}</td>
                  <td className="px-3 py-2">{row.usage.length===0&&row.used===0?DAY_DASH:row.usage.map((use,i)=><div key={use.requestId+use.date+String(i)}>{tr('usageOn',{days:formatDays(use.days),date:fmtDate(use.date)})}</div>)}{row.unattributedUsed>0&&<p className="text-xs text-muted-foreground">{tr('legacyUsage',{days:formatDays(row.unattributedUsed)})}</p>}</td>
                  <td className="px-3 py-2 tabular-nums">{formatDays(row.available)}{row.expired>0&&<p className="text-xs text-destructive">{tr('expiredOn',{days:formatDays(row.expired),date:fmtDate(row.expiresOn)})}</p>}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(row.expiresOn)}</td><td className="px-3 py-2 text-muted-foreground">{row.reason??DAY_DASH}{row.reversalReason&&<p>{row.reversalReason}</p>}</td>
                  <td className="px-3 py-2">{row.actorName??(row.actorIsSystem?t('bySystem'):DAY_DASH)}<span className="block text-xs text-muted-foreground">{fmtInstant(row.recordedAt)}</span></td>
                  <td className="px-3 py-2"><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${row.status==='available'?'bg-emerald-50 text-emerald-700':row.status==='partially_used'?'bg-amber-50 text-amber-700':row.status==='expired'?'bg-rose-50 text-rose-700':'bg-muted text-muted-foreground'}`}>{registerLabels[row.status]}</span></td>
                  <td className="px-3 py-2">{row.reversible&&<LeaveCreditReverseDialog accrualId={row.accrualId} action={reverseLeaveCreditAction}/>}</td>
                </tr>)}</tbody>
              </table>
            </div>
            {register!.truncated&&<p className="mt-2 text-xs text-muted-foreground">{t('truncated',{shown:register!.rows.length,matched:register!.matched})}</p>}
            <details className="mt-5"><summary className="cursor-pointer text-sm font-medium">{tr('auditLedger')}</summary>
            <div className={`${tableWrapCls} mt-4`}>
              <table className="w-full min-w-[72rem] text-sm" data-testid="leave-credit-movements">
                <thead className={theadCls}>
                  <tr>
                    <th scope="col" className={thCls}>{t('col.date')}</th>
                    <th scope="col" className={thCls}>{t('col.employee')}</th>
                    <th scope="col" className={thCls}>{t('col.movement')}</th>
                    <th scope="col" className={thCls}>{t('col.dateWorked')}</th>
                    <th scope="col" className={`${thCls} text-right`}>{t('col.before')}</th>
                    <th scope="col" className={`${thCls} text-right`}>{t('col.amount')}</th>
                    <th scope="col" className={`${thCls} text-right`}>{t('col.after')}</th>
                    <th scope="col" className={thCls}>{t('col.expires')}</th>
                    <th scope="col" className={thCls}>{t('col.reason')}</th>
                    <th scope="col" className={thCls}>{t('col.by')}</th>
                    <th scope="col" className={thCls}>{t('col.status')}</th>
                    <th scope="col" className={thCls}>
                      <span className="sr-only">{t('col.action')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className={tbodyCls}>
                  {movements!.rows.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="px-3 py-6 text-center text-sm text-muted-foreground">
                        {t('empty')}
                      </td>
                    </tr>
                  ) : (
                    movements!.rows.map((r) => (
                      <tr key={r.ledgerEntryId} className="align-top">
                        <td className="whitespace-nowrap px-3 py-2">{fmtDate(r.effectiveOn)}</td>
                        <td className="px-3 py-2">
                          <EmployeeName code={r.employeeCode} name={r.employeeName} />
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{MOVEMENT_LABEL[r.movement]}</td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {r.workedDate ? fmtDate(r.workedDate) : DAY_DASH}
                          {r.workedDayKind && (
                            <span className="block text-xs text-muted-foreground">{KIND_LABEL[r.workedDayKind]}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatDays(r.balanceBefore)}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                          {r.days > 0 ? `+${formatDays(r.days)}` : formatDays(r.days)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{formatDays(r.balanceAfter)}</td>
                        <td className="whitespace-nowrap px-3 py-2">{fmtDate(r.expiresOn)}</td>
                        <td className="px-3 py-2 text-muted-foreground">{r.reason ?? DAY_DASH}</td>
                        <td className="px-3 py-2">
                          {r.actorName ?? (r.actorIsSystem ? t('bySystem') : DAY_DASH)}
                          <span className="block whitespace-nowrap text-xs text-muted-foreground">{fmtInstant(r.recordedAt)}</span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">
                          {r.status && (
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[r.status].cls}`}>
                              {STATUS[r.status].label}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right">
                          {r.reversible && r.accrualId && <LeaveCreditReverseDialog accrualId={r.accrualId} action={reverseLeaveCreditAction} />}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('orderFootnote')}</p>
            </details>
            {movements!.truncated && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('truncated', { shown: movements!.rows.length, matched: movements!.matched })}
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t('reverseFootnote')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('orderFootnote')}</p>
          </Card>

          {/* Moved from /admin/toil (a redirect stub now): the ledger summary across everyone in scope and the
              two settlement sweeps. NOT behind the module — see this file's header. */}
          <Card className="p-4">
            <h2 className="text-sm font-semibold text-foreground">{tToil('ledgerTitle')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{tToil('ledgerHint')}</p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={tToil('ledgerActive')} value={formatDays(summary.active)} />
              <Stat label={tToil('ledgerTaken')} value={formatDays(summary.taken)} />
              <Stat label={tToil('ledgerExpired')} value={formatDays(summary.expired)} />
              <Stat label={tToil('ledgerConverted')} value={formatDays(summary.convertedToPay)} />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              {summary.soonestExpiry ? tToil('ledgerSoonest', { date: fmtDate(summary.soonestExpiry) }) : tToil('ledgerNoneActive')}
            </p>
          </Card>

          {visible.length > 0 && (
            <Card className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-foreground">{tToil('processTitle')}</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">{tToil('processHint')}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <form action={runToilExpiryAction}>
                    <button className={btnPrimary}>{tToil('processButton')}</button>
                  </form>
                  <form action={closeReplacementLeaveYearAction}>
                    <button className={btnPrimary}>{tToil('closeYearButton')}</button>
                  </form>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{tToil('closeYearHint')}</p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}
