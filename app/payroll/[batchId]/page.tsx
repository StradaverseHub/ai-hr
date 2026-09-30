import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { batchDetail, batchInputRows, leaverAdvisory, preProcessAdvisory, type PreProcessAdvisory } from '@/core/payroll';
import { payrollReadiness, type PayrollReadiness } from '@/core/payroll-readiness';
import { statutoryPackStale } from '@/lib/statutory-readiness';
import { auditEvents } from '@/core/read';
import { Button, Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { closeAction, generateAction, resetAction, unlockAction } from '../actions';
// b372e923 — the payroll result destination, now spelled in ONE place because the Reprocess result table
// links to it too and the reporter's requirement is that the two cannot be different screens.
import { payrollResultHref } from '../payroll-result-href';
import { payrollListReturnTo } from '@/lib/return-to';
import { isModuleEnabledOrFalse, settingEnabledOrDefault } from '@/core/entitlements';
import { packFor } from '@/localization/registry';
import { payrollPublicationState, type PayrollPublicationState } from '@/lib/payroll-publication';
import {
  listSkippedEmployees,
  listUnattachedTxnSummary,
  narrowToNothingPayable,
  pendingBatchMoney,
  unattachedHoldersOutsideBatchScope,
} from '@/core/payroll-view';
import { payslipProvenance } from '@/core/payslip-recompute';
// 3c473773 — payslip boxes + the employer-borne disclosure, both read from each payslip's own snapshot.
import { payslipDisplayEarnings } from '@/core/pay-display-category';
import { payslipEmployerBorne } from '@/core/payslip-employer-borne';

/**
 * `/payroll/<segment>` is the catch-all under the payroll workbench, so ANY unmatched path lands here
 * with `batchId` set to whatever the segment was. Handing a non-UUID straight to `batchDetail` makes
 * Postgres reject the parameter (`invalid input syntax for type uuid`) and the page returns a **500**,
 * not a 404 — verified on a dev server, not reasoned about.
 *
 * It became reachable by a formerly valid URL when efe1d230 deleted /payroll/guide: every bookmark and
 * every stale link to the guide now falls through to this route and would 500. A missing page must
 * answer 404, so the id is shape-checked before anything is read.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function BatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{
    error?: string;
    from?: string;
    hw?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.batch');
  const ta = await getTranslations('anomaly');
  const { batchId } = await params;
  if (!UUID_RE.test(batchId)) notFound(); // see UUID_RE — a non-uuid segment must 404, not 500
  const sp = await searchParams;
  const { error, from, hw } = sp;
  // 9066bd6c — BACK RETURNS THE LIST AS IT WAS LEFT. The Payroll Process list hands each row link its
  // own current query as `?from=…`; this sends Back there instead of to a bare `/payroll`, which threw
  // away the year, months, company, cycle and status every single time.
  //
  // `from` ALREADY EXISTED ON THIS ROUTE with an older meaning — `?from=process`, the marker that once
  // made this screen title itself "Step 3 of 3". Nothing has read that value since 7076f8af (see the
  // note below); it survives only as a pager passthrough. `payrollListReturnTo` refuses anything that
  // is not a relative path under `/payroll`, so a legacy `?from=process` resolves to `/payroll` — i.e.
  // byte-identical to today's behaviour — while a real filter query is honoured.
  const backHref = payrollListReturnTo(from);
  // …and the two screens BELOW this one get it too, so Back is unbroken all the way down the chain.
  const fromSuffix = backHref === '/payroll' ? '' : `?from=${encodeURIComponent(backHref)}`;
  const data = await batchDetail(s, batchId);
  if (!data) notFound();
  const { batch, slips } = data;
  // Feedback ef31d251 — this header used to render the RAW status enum, and "Processed" reads as
  // finished. It is not: payslips stay invisible to employees until Close, which is why eighteen runs
  // were calculated and never published. Derived through the shared helper the payroll LIST also uses,
  // so the two screens cannot start disagreeing about what "published" means. batchDetail does a bare
  // select() of the batch row, so releasedAt is already in hand — no extra read.
  const pubState = payrollPublicationState(batch);
  // 49e7e0a2 — the run's recalculation mark. Set when a one-off transaction is added, changed or removed
  // AFTER the run was processed; `closeBatch` refuses while it is set. `batchDetail` does a bare select()
  // of the batch row, so both columns are already in hand — no extra read.
  const needsRecalc = batch.needsRecalcAt != null;
  const recalcEmploymentIds = Array.isArray(batch.recalcEmploymentIds)
    ? batch.recalcEmploymentIds.filter((x): x is string => typeof x === 'string')
    : [];
  const PUBLICATION_LABEL: Record<PayrollPublicationState, string> = {
    draft: t('publishStateDraft'),
    unpublished: t('publishStateUnpublished'),
    scheduled: t('publishStateScheduled'),
    published: t('publishStatePublished'),
  };
  const totals = (batch.totals ?? {}) as Record<string, number>;
  const inputs = batch.status === 'draft' ? await batchInputRows(s, batchId) : [];
  const leavers = batch.status === 'draft' ? await leaverAdvisory(s, batchId) : [];
  // fc776376 — both per-employee tables on this run are genuine lists that grow with headcount. The
  // payslip BREAKDOWN (one payslip's own lines) is deliberately not paged: it is one record, not a list.
  const slipPage = paginateRows(slips, parsePageQuery(sp));
  // Pre-processing checks (feedback f1564110, Phase 1): validate employee master data BEFORE the run
  // is calculated. Blockers (no salary record) disable Generate outright; warnings (no statutory
  // profile / no bank details) swap Generate for a ConfirmSubmit that posts ackWarnings=1.
  const preChecks: PreProcessAdvisory =
    batch.status === 'draft'
      ? await preProcessAdvisory(s, batchId)
      : { missingCompensation: [], missingStatutory: [], missingBank: [] };
  // a1d82340 STEP 5 — every money line queued against this draft, whichever of the twelve doors it came
  // through. Before this, four of the five tables money lands in were invisible until AFTER generation:
  // the inputs grid below reads payroll_input only. Draft-only: once processed, the payslips ARE the
  // record and this card would be a second, weaker account of the same figures.
  const pendingMoney = batch.status === 'draft' ? await pendingBatchMoney(s, { batchId }) : null;
  // r227 — WHO THIS RUN LEFT OUT, BY NAME, ON THE SCREEN THAT RAN IT. r226 gave this screen's Generate
  // button a toast carrying a bare COUNT ("… 40 employee(s) skipped"), which is the shape the whole
  // change existed to stop being: forty people accounted for by a number. The wizard's Step-3 result page
  // listed them; this screen — the one an operator actually presses Generate on — did not, and a toast is
  // gone on the next navigation anyway. Read from the run's own `payroll-batch.processed` event, so it is
  // still here tomorrow. Processed runs only: a draft has no decision yet, and on a run that skipped
  // nobody this is an empty list and renders nothing. (r369 — that used to read "every regular run". A
  // regular run now skips an employee with no monthly basic and nothing payable, which is exactly why this
  // panel matters on the ordinary monthly run and not only on a bonus one.)
  const skippedEmployees = batch.status === 'draft' ? [] : await listSkippedEmployees(s, [batchId]);
  // Feedback 64fb5e48 — blockers are the salary-record gaps (missing / period-miss / a daily-or-hourly
  // employee with no pay rate); the old BASIC-pay-item existence blocker is gone, and r369 took the MONTHLY
  // zero out of `zeroBasic` (it is `preNotices` below). A stale BASIC pay item is a confirm-to-proceed warning.
  const preSalaryBlockers = preChecks.missingCompensation.length + (preChecks.zeroBasic?.length ?? 0);
  // Item 1bb09a73 — COUNTED SEPARATELY, and that is not tidiness. `preChecksBlockerHint` says in words
  // that the named employees "have no current salary record"; folding a TP3 year mismatch into that
  // count would print that sentence about people whose salary record is fine. The group gets its own
  // red banner below, which says what is actually wrong.
  const preTp3Blockers = preChecks.tp3YearMismatch?.length ?? 0;
  // Item 4ca06dea — the THIRD blocker count on this card, for the same reason the TP3 one is separate:
  // `preChecksBlockerHint` says the named employees "have no current salary record", which is FALSE of a
  // custom_period employee whose salary record is complete and simply has no calculation behind it
  // (ADR-0078). Counted into `preBlockers` — the card's colour and the parity with the server's exact set
  // — with its own red banner below. The server already refused these runs; this card just never said so.
  const prePayModeBlockers = preChecks.unpayablePayMode?.length ?? 0;
  const preBlockers = preSalaryBlockers + prePayModeBlockers + preTp3Blockers;
  // r369 (item eb949191) — THE THIRD STATE, AND IT IS IN NEITHER COUNT ABOVE NOR THE WARNING COUNT BELOW.
  //
  // An employee with no monthly basic salary is a deliberate arrangement (a Director paid fees quarterly),
  // and the run will leave them out of a month with nothing payable rather than block or pay them below zero.
  // The badge on this card is otherwise binary blocker/warning, so folding this into either one would paint a
  // deliberate skip red or amber and tell the operator to "fix" it — which is how somebody ends up typing a
  // salary that is not true. It gets its own neutral group and its own count, and `preBlockers` /
  // `preWarnings` are byte-identical to what they were (they are also extracted by name and evaluated as a
  // bitmask by test/4ca06dea-process-blocker-parity.test.ts, which is the guard that says so).
  //
  // NARROWED AGAINST THE CARD TWO PANELS DOWN, not against a second reading of the same tables: a Director
  // whose RM30,000 fee is keyed for this month WILL be paid, and naming him under "will be skipped" on the
  // very run whose Pending money card lists that fee by name would be a lie the operator can see through.
  // See `narrowToNothingPayable` for why the derivation lives beside `pendingBatchMoney`.
  const preNothingPayable = narrowToNothingPayable(preChecks.nothingPayable ?? [], pendingMoney);
  const preNotices = preNothingPayable.length;
  // 297ae65a — the non-MYR/mixed-currency salary notice counts among the confirm-to-proceed warnings.
  // r79 — an explicit "Subject to HRDF = Yes" at an unregistered company joins the confirm-to-proceed
  // warnings: the run records the employee as subject and charges nothing, and until now said so nowhere.
  const preWarnings =
    preChecks.missingStatutory.length +
    preChecks.missingBank.length +
    (preChecks.staleBasicComponent?.length ?? 0) +
    (preChecks.currencyMismatch?.length ?? 0) +
    (preChecks.hrdfSubjectUnregistered?.length ?? 0);
  // Config-level readiness (feedback 5db3ae48, Phase A) — the layer ABOVE the employee-master pre-checks:
  // is the COMPANY configured to run payroll (statutory tables, active cycle, pay-day, pay items, policy)?
  // Read-only; surfaced here as a compact panel linking to the full report (now on Payroll Settings —
  // efe1d230). Uses the payroll.guide namespace so the check copy is written once.
  const tg = await getTranslations('payroll.guide');
  // r134 — the four payroll-cycle names (regular / off_cycle / bonus / adjustment) are catalogued under
  // payroll.list, NOT payroll.batch. See the Cycle field below.
  const tList = await getTranslations('payroll.list');
  const configReadiness: PayrollReadiness | null =
    batch.status === 'draft'
      ? await payrollReadiness(s, {
          companyId: batch.companyId,
          payPeriod: batch.payPeriod,
          statutoryStale: await statutoryPackStale(s),
        })
      : null;
  const configAlerts = configReadiness ? configReadiness.checks.filter((c) => c.status !== 'ok') : [];
  const CHECK_CAP: Record<string, string> = {
    masterData: 'MasterData',
    payrollItems: 'PayrollItems',
    statutoryConfig: 'StatutoryConfig',
    payrollCycle: 'PayrollCycle',
    // 707b3851 — the company's stored default cycle name resolving to an active cycle. Loosely typed
    // Record here (unlike the guide page), so a missing entry would silently render `checkundefined…`.
    defaultCycle: 'DefaultCycle',
    payrollSchedule: 'PayrollSchedule',
    payrollPolicy: 'PayrollPolicy',
    payModes: 'PayModes', // ADR-0078 — custom_period pay-mode blocker (names the affected employees)
    transactions: 'Transactions',
  };
  const STATUS_CAP: Record<string, string> = { ok: 'Ok', warning: 'Warning', blocker: 'Blocker' };
  const STATUS_PILL: Record<string, string> = {
    warning: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
    blocker: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  };
  // 1.2.8 (ADR-0060): loan deductions are RESERVED onto a regular draft run only. The running summary and
  // the reservation button travel with the adjustment panel (7076f8af); `isRegular` stays — the unattached
  // -transaction indicators below are gated on it.
  const isRegular = batch.runType === 'regular';
  const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
  const periodDays = new Date(pYear, pMonth, 0).getDate(); // calendar days in the pay period
  /**
   * e440991b point 5 — the payslip list's code and name become links to that employee's full payroll
   * result. The destination is NOT new: /payroll/transaction-view's History tab already renders the
   * itemised breakdown (earnings, allowances, overtime, deductions, employer contributions, statutory
   * working, year-to-date). It simply was not reachable from the run you are reading.
   *
   * THE SELECTION TRAVELS IN THE URL, deliberately. Transaction View is a server component driving GET
   * forms, and it SCOPE-GUARDS every param it receives: an `employmentId` outside the viewer's employee
   * scope is coerced to `undefined` — "no selection" — rather than queried (its own comment at the
   * coercion says so, and it is pinned by test/payroll-run-screen-e440991b.test.ts — "THE REFUSAL:
   * Transaction View still coerces an out-of-scope employmentId to 'no selection'", written for this
   * link; test/employee-scope-panel-guard.test.ts proves the same refusal against a real out-of-scope
   * id in the database. r253 corrected this reference: it named a guard file that has never existed.)
   * Handing the selection over as a link therefore inherits that fence for free; passing a callback or
   * pre-resolved rows across the boundary instead would both break RSC and route around the guard.
   *
   * b372e923 MOVED THE URL ITSELF into `payrollResultHref` and changed nothing about it. The Reprocess
   * result table now links to the same place, and the reporter's requirement is that the two open the
   * SAME payroll result screen — which one shared builder makes structural instead of a promise. The
   * run's own company, period and cycle are still what identifies the record; this screen still passes
   * no `from`, exactly as before.
   */
  // r253 — the URL lives in `payrollResultHref` (b372e923 moved it there so Reprocess links to the
  // SAME screen), and `backHref` is d75b0c11's half: the operator's filter selection travels with the
  // link so Back from the result restores the list as they left it. The helper omits an empty `from`.
  const payslipDetailHref = (employmentId: string) =>
    payrollResultHref(batch, employmentId, backHref === '/payroll' ? undefined : backHref);
  // Payroll Reset (feedback a03b2d9b) — ships dark behind a flag; the page is already requireAdmin-
  // gated, and resetAction + resetProcessedBatch re-assert admin (a payroll_partner never sees this).
  const resetOn = settingEnabledOrDefault(s, 'payroll.reset_enabled');
  // Selective reprocessing (feedback 9bc442bc, reporter ask #3) needs same-month adjustment runs.
  const multiCycleOn = isModuleEnabledOrFalse(s, 'multi_cycle_payroll');
  // Unlock Closed run (feedback 9bc442bc, reporter ask #2) — gated so an environment can keep Closed
  // permanently frozen. Single-confirm + mandatory reason + warnings live in the service; the page is
  // requireAdmin-gated and unlockClosedBatch re-asserts the granular payroll.unlock permission
  // (hr_admin + super_admin by default, per-company configurable — feedback 62e85140).
  const unlockOn = settingEnabledOrDefault(s, 'payroll.unlock_enabled');
  // This batch's lifecycle events. e440991b point 4 took the History CARD off this screen (the Audit
  // Trail renders the same `domain_event` rows), but the read stays: the "published by X on Y" line
  // below finds the most recent `payroll-batch.closed` event in it, and without it every closed run
  // would report "no publication record". Kept at the same limit so that lookup is unchanged.
  const history = await auditEvents(s, { aggregateId: batchId, limit: 50 });
  // Feedback efece4ce — this run's company HRDF registration. The levy tile was shown only when the total
  // was > 0, so "this company pays no HRDF because it is not registered" and "the levy failed to compute"
  // rendered identically: as nothing at all. That ambiguity IS the reported bug. Read for display only —
  // the figure on the payslips stays whatever the run computed. `packFor('MY')` mirrors the Organization
  // page: the levy, like this page's RM formatting, is Malaysia-specific.
  const hrdfRegistered =
    ((await packFor('MY')?.companyStatutory.get(s, batch.companyId))?.hrdfStatus ?? 'not_registered') !==
    'not_registered';
  // 7076f8af — THIS SCREEN NO LONGER CALLS ITSELF A WIZARD STEP. It used to prefix its subtitle with
  // "Step 3 of 3 — Review & process" whenever it was reached with ?from=process, which meant the product
  // counted to three twice: the run flow's own rail already reads "3 of 3" on its Review step, and then
  // the screen it handed you to said "3 of 3" again about something else. The run flow is terminal now
  // (it ends on the result page, not here), so there is no third step to be. The `from` param survives
  // only as a pager passthrough. A compact one-shot holiday-warning code list still rides the query
  // string ('country|state|year|loaded|required' ';'-joined) — the domain event appended in createBatch
  // is the durable record; this is only shown for this one render right after creation.
  const holidayWarnings = hw
    ? hw.split(';').map((code) => {
        const [country, state, year, loaded, required] = code.split('|');
        return { country, state: state || null, year, loaded, required };
      })
    : [];
  const scope = (batch.scope ?? null) as { departmentIds?: string[]; employmentIds?: string[] } | null;
  const isScoped = !!(scope?.departmentIds?.length || scope?.employmentIds?.length);

  // ── Feedback d0d2c9d1 — money entered for this month that has never reached a payslip. ──
  // STILL GATED TO runType === 'regular', but the REASON changed under it in c11e81aa and the old one is
  // now false. It used to read "off_cycle / bonus / adjustment runs NEVER collect transactions by design",
  // and that sentence is what this gate rested on. It no longer holds: a non-regular run that names a pay
  // cycle now collects the rows that name that same cycle (core/payroll.ts collectableCycleIds).
  //
  // The gate is kept deliberately, on a narrower claim: the REGULAR run is the one that sweeps up
  // everything unclaimed for the month, so it is the only run for which "money left behind" is both
  // complete and actionable. A bonus run collects exactly what named it and leaves the rest to the regular
  // run by design, so an outstanding indicator there would still be the permanent un-actionable alert this
  // gate was added to prevent — EXCEPT for rows naming that bonus run's own cycle, which it really can
  // strand. That last case is NOT surfaced here yet; it is a known follow-up, recorded in HANDOFF, and it
  // is a missing warning rather than wrong money. Reuses the `isRegular` declared above for the loan
  // summary — same expression, one binding.
  const [txnYear, txnMonth] = batch.payPeriod.split('-').map(Number);
  // Before Generate on a SCOPED draft: who this run is about to leave out, and what they are holding.
  const scopeHolders =
    isRegular && isScoped && batch.status === 'draft'
      ? await unattachedHoldersOutsideBatchScope(s, {
          companyId: batch.companyId,
          payPeriod: batch.payPeriod,
          scope,
          // c11e81aa — so the warning also names money marked for another Pay Cycle, which this run
          // walks past no matter who is in scope.
          runType: batch.runType,
        })
      : [];
  // After Generate: whatever is still outstanding for the month. For a processed run EVERY unattached
  // row of its (company, period) is outstanding, regardless of when it arrived — arrival time only
  // decides which of the two causes the copy should name.
  const outstanding =
    isRegular && batch.status !== 'draft'
      ? await listUnattachedTxnSummary(s, { companyIds: [batch.companyId], year: txnYear, month: txnMonth })
      : [];
  // Summed in CENTS — float-summing the decimal strings would drift on four-figure bonuses.
  const outstandingTotal =
    outstanding.reduce((cents, g) => cents + Math.round(Number(g.totalAmount) * 100), 0) / 100;
  const outstandingEntries = outstanding.reduce((n, g) => n + g.count, 0);
  const outstandingOldest = outstanding.map((g) => g.oldestTxnDate).sort()[0] ?? null;
  const outstandingAfterProcessing = outstanding.some((g) => g.arrivedAfterProcessing);
  const outstandingHref = `/payroll/transaction-view?tab=outstanding&companyId=${batch.companyId}&year=${txnYear}&month=${String(txnMonth).padStart(2, '0')}`;

  return (
    /* 65e2d5de — the View screen joins the one Payroll width standard (152fea7f). It was one of three
       under app/payroll/[batchId] the sweep missed, and it is the widest table in the module. */
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: backHref, label: t('back') }}
        title={batch.payPeriod}
        description={
          <>
            {t('subtitle')} · <span>{PUBLICATION_LABEL[pubState]}</span>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* ADR-0076 — the exceptions queue. Only from `processed` onward: a draft has no payslips, and
                the checks read payslips. It is a plain Link because the page is read-only; running the
                checks is a deliberate action taken ON that page, not a side effect of navigating to it. */}
            {/* d75b0c11 — the CHAIN, not just the last hop: Anomalies' own Back returns HERE, so without
                carrying `from` this screen's Back would then collapse to a bare /payroll and the
                operator's filter selection would be lost one screen deeper than anyone was looking.
                Same `fromSuffix` Reprocess and Remove already ride. */}
            {batch.status !== 'draft' && (
              <Link
                href={`/payroll/${batch.id}/anomalies${fromSuffix}`}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {ta('title')}
              </Link>
            )}
            {batch.status !== 'draft' && (
              <a
                href={`/payroll/reports/payment-summary?batchId=${batch.id}`}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                title={t('paymentSummaryTitle')}
              >
                ⬇ {t('paymentSummary')}
              </a>
            )}
            {/* e440991b point 6 — the whole run into Excel, one row per employee with every earning,
                deduction, employer contribution and total, off the stored payslips. A plain <a>, not a
                form: the route is a GET download and this keeps the header a server component.
                Processed/closed only — a draft has no payslips to reconcile. */}
            {batch.status !== 'draft' && (
              <a
                href={`/payroll/${batch.id}/export?format=xlsx`}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                title={t('transactionDetailTitle')}
              >
                ⬇ {t('transactionDetail')}
              </a>
            )}
            {batch.status === 'draft' && (
              <form action={generateAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                {/* r253 — THE SELECTION SURVIVES THE BUTTON, not just the Back link. This action
                    redirects to this same screen, and until now it redirected to a HARDCODED
                    `/payroll/<id>?toast=…` with no `from` — so pressing Generate silently reset the
                    operator's filter selection to the current period. Posts the already-whitelisted
                    `backHref`, exactly as the reset form below does. */}
                <input type="hidden" name="from" value={backHref} />
                {preBlockers > 0 ? (
                  // Blocked: employees with no salary record — server re-asserts (PreProcessBlockedError).
                  <Button type="submit" disabled title={t('preChecksBlockedError', { n: preBlockers })}>
                    {t('generatePayslips')}
                  </Button>
                ) : preWarnings > 0 ? (
                  // Warnings only: explicit confirm required; the dialog posts ackWarnings=1.
                  <>
                    <input type="hidden" name="ackWarnings" value="1" />
                    <ConfirmSubmit
                      variant="default"
                      title={t('preConfirmTitle')}
                      description={t('preConfirmDescription', { n: preWarnings })}
                      confirmLabel={t('preConfirmLabel')}
                    >
                      {t('generatePayslips')}
                    </ConfirmSubmit>
                  </>
                ) : (
                  <Button type="submit">{t('generatePayslips')}</Button>
                )}
              </form>
            )}
            {/* e440991b — REPROCESS, at the TOP of the run screen. It used to be a panel at the very
                bottom of this page, below the Recalculation History card, on a screen this long; the
                reporter's rejection was about exactly that. The panel is gone and this is the way in.
                Same gates as the panel had (processed-only, multi-cycle on, payslips exist); the
                destination re-asserts all three and the service is still the authority. A plain <Link>,
                not a form: the destination is a page, and this keeps the header a server component. */}
            {batch.status === 'processed' && multiCycleOn && slips.length > 0 && (
              <Link
                href={`/payroll/${batch.id}/reprocess${fromSuffix}`}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {t('reprocessHeaderAction')}
              </Link>
            )}
            {/* 9066bd6c — REMOVE EMPLOYEE PAYROLL, beside Reprocess and before Reset because that is
                the order of escalation: correct one person, take one person off, clear the whole run.
                The same three gates its Reprocess sibling carries (processed, multi-cycle on, payslips
                exist) PLUS the reset setting, because removal rides that same operator risk switch —
                and the destination re-asserts every one of them. A plain <Link>: the destination is a
                page, which keeps this header a server component. */}
            {batch.status === 'processed' && multiCycleOn && resetOn && slips.length > 0 && (
              <Link
                href={`/payroll/${batch.id}/remove${fromSuffix}`}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {t('removeHeaderAction')}
              </Link>
            )}
            {batch.status === 'processed' &&
              // 49e7e0a2 — Close is refused by `closeBatch` while the run owes a recalculation, so the
              // button is not offered while that is true. The service throw is the authority (this is a
              // second surface, not the guard); what the screen adds is not making the operator discover
              // the refusal by pressing the button that publishes pay to every employee.
              (needsRecalc ? (
                <Button type="button" variant="secondary" disabled title={t('closeBlockedRecalc')}>
                  {t('closeBatch')}
                </Button>
              ) : (
                <form action={closeAction}>
                  <input type="hidden" name="batchId" value={batch.id} />
                  {/* r253 — CLOSE PAYROLL IS THE PATH THE REPORTER WALKED: filter to January, View a
                      processed run, Close, then Back — and Back went to September, because this action
                      redirected to a bare `/payroll/<id>?toast=…`. The filter selection posts with it. */}
                  <input type="hidden" name="from" value={backHref} />
                  {/* ef31d251 — Close is the step that publishes pay to employees and fans out a
                      payslip.ready notification to every one of them, and it was a plain button that
                      said nothing about either. variant="secondary" is mandatory: ConfirmSubmit
                      defaults to 'destructive' (red), and closing a run is not destructive. */}
                  <ConfirmSubmit
                    variant="secondary"
                    title={t('closeConfirmTitle')}
                    description={t('closeConfirmBody', { n: slips.length })}
                    confirmLabel={t('closeConfirmYes')}
                  >
                    {t('closeBatch')}
                  </ConfirmSubmit>
                </form>
              ))}
            {/* Reset / Zeroize (feedback a03b2d9b): PROCESSED-only — never draft (nothing to reset;
                delete-draft is 4f00d8f0's flow) and never closed (permanently immutable). The
                ConfirmSubmit dialog carries the reporter's confirmation copy; processed-only and
                admin-only are re-enforced server-side. */}
            {batch.status === 'processed' && resetOn && (
              <form action={resetAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                {/* 65e2d5de — a successful reset now returns to the Payroll Process list rather than into
                    Continue Progress, so this screen posts the same filter selection its own Back uses.
                    `backHref` is already whitelisted by shape; posting the raw `from` would hand the
                    action an untrusted value to re-validate for no gain. */}
                <input type="hidden" name="from" value={backHref} />
                {/* d0d2c9d1 — returning to Draft and calculating again DOES collect every outstanding
                    transaction for the month (the attach guard runs on a full draft→processed
                    generation). That is the one working recovery path and nothing said so. */}
                <ConfirmSubmit
                  title={t('resetTitle')}
                  description={`${t('resetDescription')} ${t('resetCollectsOutstanding')}`}
                  confirmLabel={t('resetConfirm')}
                  reasonField={{ name: 'reason', label: t('resetReasonLabel'), placeholder: t('resetReasonPlaceholder'), required: true }}
                >
                  {t('resetPayroll')}
                </ConfirmSubmit>
              </form>
            )}
          </div>
        }
      />

      <ErrorBanner message={error} />

      {/* Reporter req. #1/#2 made explicit (a03b2d9b): a processed run is LOCKED — amendments don't
          silently reprocess; corrections go through the controlled Reset. */}
      {batch.status === 'processed' && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400">
          🔒 {t('lockedNote')}
        </div>
      )}

      {/* 49e7e0a2 — THE RUN SAYS ITS OWN FIGURES ARE STALE. Set when a one-off transaction was added,
          changed or removed after this run was processed. Until the named employees are recalculated the
          payslips, the statutory figures and the totals on this page are the OLD numbers, and Close is
          refused (closeBatch throws BatchNeedsRecalculationError).

          THIS BANNER AND THE DISABLED CLOSE STAY ON THIS SCREEN. e440991b moved the selection panel and
          the Recalculation History card to /payroll/<id>/reprocess, but these two are LIVE CONTROLS, not
          history: without them a run can be closed owing a recalculation, publishing figures the system
          already knows are stale. What changed is that the banner now LINKS to the screen that fixes it,
          which arrives with exactly these people already ticked (batch.recalcEmploymentIds). */}
      {needsRecalc && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
          <div className="font-medium">⚠ {t('recalcBannerTitle', { n: recalcEmploymentIds.length })}</div>
          <p className="mt-1">{t('recalcBannerBody')}</p>
          {multiCycleOn && slips.length > 0 && (
            <Link href={`/payroll/${batch.id}/reprocess${fromSuffix}`} className="mt-1 inline-block font-medium underline">
              {t('recalcBannerAction')}
            </Link>
          )}
        </div>
      )}

      {/* ef31d251 — the "hidden from employees" statement. Nothing on this screen has ever said that a
          calculated run's payslips are invisible until Close, which is why the step was skipped on all
          eighteen runs. Keyed off the publication state, not `status === 'processed'`, so a draft (which
          has no payslips at all) never claims to be hiding pay. */}
      {pubState === 'unpublished' && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <div className="font-medium">🙈 {t('unpublishedBannerTitle')}</div>
          <p className="mt-1">{t('unpublishedBannerBody')}</p>
        </div>
      )}

      {/* d0d2c9d1 — BEFORE Generate on a scoped draft: the employees this run will leave out are
          holding transactions for this month, and generating will walk straight past them. Informational,
          never a block: a narrowed run can be exactly what the operator intends. */}
      {scopeHolders.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <div className="font-medium">⚠ {t('scopeUnattachedTitle', { n: scopeHolders.length })}</div>
          <p className="mt-1">{t('scopeUnattachedWarning')}</p>
          <ul className="mt-1 space-y-0.5">
            {scopeHolders.map((h) => (
              <li key={h.employmentId}>
                {t('outstandingTxnHolder', { name: h.name, n: h.count, amount: h.amount })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* d0d2c9d1 — AFTER Generate: money for this month that never reached a payslip. The two causes
          are split into separate sentences so the operator knows which one applies: a row that arrived
          after processing is a different problem from one the run's scope left out. */}
      {outstanding.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <div className="font-medium">
            ⚠ {t('outstandingTxnTitle', { n: outstandingEntries, amount: outstandingTotal.toFixed(2) })}
          </div>
          <p className="mt-1">{t('outstandingTxnHint', { when: outstandingOldest ?? '—' })}</p>
          {outstandingAfterProcessing && <p className="mt-1">{t('outstandingTxnAfterProcessing')}</p>}
          {outstanding.some((g) => !g.arrivedAfterProcessing) && (
            <p className="mt-1">{t('outstandingTxnLeftOutByScope')}</p>
          )}
          <p className="mt-1.5">
            <Link href={outstandingHref} className="font-medium underline">
              {t('outstandingTxnLink')}
            </Link>
          </p>
        </div>
      )}

      {/* ef31d251 — who published this run and when. Read off the batch's own `payroll-batch.closed`
          domain event, already fetched above for the History card; no new read and no new column.
          `history` is desc(occurredAt), so .find() yields the MOST RECENT close, which is the right one
          after an unlock → re-close cycle. The no-record branch is NOT optional: core/payroll-history-
          import.ts sets status='closed' directly with closed_at/released_at NULL and appends no close
          event, so an imported run would otherwise render "Published by undefined on Invalid Date". */}
      {(pubState === 'published' || pubState === 'scheduled') &&
        (() => {
          const closeEv = history.find((ev) => ev.eventType === 'payroll-batch.closed');
          const releasedOn = batch.releasedAt ? new Date(batch.releasedAt).toLocaleDateString() : null;
          return (
            <div className="text-xs text-muted-foreground">
              <div>
                {closeEv
                  ? t('publishedBy', {
                      actor: closeEv.actorName ?? t('historySystemActor'),
                      when: new Date(closeEv.occurredAt).toLocaleString(),
                    })
                  : pubState === 'scheduled' && releasedOn
                    ? t('publishedScheduledOn', { when: releasedOn })
                    : t('publishedNoRecord')}
              </div>
              {closeEv && pubState === 'scheduled' && releasedOn && (
                <div className="mt-0.5 text-amber-700 dark:text-amber-400">
                  {t('publishedScheduledOn', { when: releasedOn })}
                </div>
              )}
            </div>
          );
        })()}

      {/* Unlock a CLOSED run (feedback 9bc442bc, reporter ask #2; simplified in 62e85140): a controlled,
          audited reversal of the closed-immutability freeze. A single confirm dialog (no OTP) collects the
          mandatory reason before flipping Closed→Processed; the service warns if payment was disbursed or
          statutory returns were filed. Gated by PAYROLL_UNLOCK_ENABLED and the granular payroll.unlock
          permission (re-asserted server-side). */}
      {batch.status === 'closed' && unlockOn && (
        <Card className="overflow-hidden border-amber-300 dark:border-amber-500/40">
          <SectionHeader title={t('unlockTitle')} />
          <div className="space-y-3 px-4 py-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
              🔓 {t('unlockLockedNote')}
            </div>
            <p className="text-xs text-muted-foreground">{t('unlockDescription')}</p>
            {/* Single confirm-dialog-gated form: the reason is collected inside the dialog (required) and
                mirrored into a hidden input in this form; Confirm requestSubmit()s it to unlockAction. */}
            <form action={unlockAction} className="flex justify-end">
              <input type="hidden" name="batchId" value={batch.id} />
              {/* r253 — same as Generate and Close: the action returns to this screen, so it is handed
                  the filter selection this screen's own Back is built from. */}
              <input type="hidden" name="from" value={backHref} />
              <ConfirmSubmit
                size="sm"
                title={t('unlockConfirmTitle')}
                description={t('unlockConfirmBody')}
                confirmLabel={t('unlockConfirmYes')}
                reasonField={{
                  name: 'reason',
                  label: t('unlockReasonLabel'),
                  placeholder: t('unlockReasonPlaceholder'),
                  required: true,
                }}
              >
                {t('unlockConfirm')}
              </ConfirmSubmit>
            </form>
          </div>
        </Card>
      )}

      {batch.status === 'draft' && (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2 divide-x divide-border sm:grid-cols-4">
            <div className="p-3">
              <div className="text-xs text-muted-foreground">{t('summaryPeriod')}</div>
              <div className="text-sm font-medium">{batch.payPeriod}</div>
            </div>
            <div className="p-3">
              <div className="text-xs text-muted-foreground">{t('summaryCycle')}</div>
              {/* r134 — this read `t('runType.…')` under the `payroll.batch` namespace, where runType
                  has NEVER existed: the four cycle names live under payroll.list, payroll.process and
                  payrollCycleConfig. So the Cycle field on EVERY run detail page resolved to a
                  MISSING_MESSAGE. Same class as the bug r127 shipped and r130 fixed, and found the same
                  way — by rendering the page and reading the dev log, not by any gate step.
                  Read where they live rather than minting a fourth copy (r130's rule). */}
              <div className="text-sm font-medium">{tList(`runType.${batch.runType}`)}{batch.remarks ? ` — ${batch.remarks}` : ''}</div>
            </div>
            <div className="p-3">
              <div className="text-xs text-muted-foreground">{t('summaryPaymentDate')}</div>
              <div className="text-sm font-medium">{batch.batchDate}</div>
            </div>
            <div className="p-3">
              <div className="text-xs text-muted-foreground">{t('summaryHeadcount')}</div>
              <div className="text-sm font-medium">{inputs.length}</div>
            </div>
          </div>
        </Card>
      )}

      {holidayWarnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          {holidayWarnings.map((w, i) => (
            <div key={i}>{t('holidayWarning', { country: w.country, state: w.state || '—', year: w.year, loaded: w.loaded, required: w.required })}</div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
        ⚠️{' '}
        {t.rich('disclaimer', {
          strong: (chunks) => <span className="font-medium">{chunks}</span>,
          mono: (chunks) => <span className="font-mono">{chunks}</span>,
        })}
      </div>

      {/* Config-level readiness (feedback 5db3ae48, Phase A): whether the COMPANY is configured to run
          payroll at all — one layer above the per-employee pre-checks below. Only non-ok checks are listed
          here to keep the draft page focused; the full eight-check per-company checklist lives on Payroll
          Settings (efe1d230 — it moved there when the Workflow Guide page was retired). */}
      {configReadiness && configAlerts.length > 0 && (
        <Card
          className={`overflow-hidden ${
            configReadiness.blockers > 0 ? 'border-red-200 dark:border-red-500/30' : 'border-amber-200 dark:border-amber-500/30'
          }`}
        >
          <SectionHeader title={tg('readinessTitle')} count={configAlerts.length} />
          <div className="space-y-2 px-4 py-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {configReadiness.blockers > 0
                  ? tg('readinessBlocked', { n: configReadiness.blockers })
                  : tg('readinessWarnings', { n: configReadiness.warnings })}
              </p>
              {/* efe1d230 — the Workflow Guide page is retired; the full eight-check per-company report
                  it carried now opens on Payroll Settings behind ?readiness=full. Same report, same
                  copy, one fewer menu row. */}
              <Link
                href="/payroll/setup?readiness=full"
                className="shrink-0 text-xs font-medium text-primary hover:underline"
              >
                {tg('title')} →
              </Link>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {configAlerts.map((c) => (
                <li key={c.key} className="flex items-start justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_PILL[c.status]}`}>
                        {tg(`status${STATUS_CAP[c.status]}`)}
                      </span>
                      <span className="text-sm font-medium text-foreground">{tg(`check${CHECK_CAP[c.key]}Title`)}</span>
                    </div>
                    {/* ADR-0078 — `names` rides only on the payModes blocker; a harmless extra ICU arg otherwise. */}
                    <p className="text-xs text-muted-foreground">
                      {tg(`check${CHECK_CAP[c.key]}${STATUS_CAP[c.status]}`, { ...c.detail, names: (c.names ?? []).join(', ') })}
                    </p>
                  </div>
                  <Link href={c.href} className="shrink-0 text-xs font-medium text-primary hover:underline">
                    {tg('fix')} →
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      {/* Pre-processing checks (feedback f1564110, Phase 1): the validation step of the reporter's
          "maintain → validate → process" workflow, surfaced on every draft run. Blocker rows stop
          generation entirely (previously these employees were silently dropped from the run with no
          warning); warning rows require an explicit confirm on Generate. Each row links to the
          employee profile so the gap can be fixed in place. */}
      {batch.status === 'draft' && (
        <Card
          className={`overflow-hidden ${
            preBlockers > 0
              ? 'border-red-200 dark:border-red-500/30'
              : preWarnings > 0
                ? 'border-amber-200 dark:border-amber-500/30'
                : // r369 — a deliberate skip is not a fault, so it does not get amber; but it is also not
                  // "all checks passed", so it does not get the green border either. The default border is
                  // the third state: something is listed, nothing is wrong.
                  preNotices > 0
                  ? 'border-border'
                  : 'border-emerald-200 dark:border-emerald-500/30'
          }`}
        >
          {/* r369 — the notice joins the HEADER count and the all-clear test, so a run whose only finding is
              a deliberate skip renders the group instead of claiming "All checks passed" and saying nothing
              about the person it is about to leave out. It stays out of the blocker/warning arithmetic. */}
          <SectionHeader title={t('preChecksTitle')} count={preBlockers + preWarnings + preNotices} />
          {preBlockers + preWarnings + preNotices === 0 ? (
            <p className="px-4 py-4 text-sm text-emerald-700 dark:text-emerald-400">✓ {t('preChecksAllClear')}</p>
          ) : (
            <div className="space-y-4 px-4 py-4">
              {preSalaryBlockers > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                  {t('preChecksBlockerHint', { n: preSalaryBlockers })}
                </div>
              )}
              {prePayModeBlockers > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                  {t('preChecksPayModeBlockerHint', { n: prePayModeBlockers })}
                </div>
              )}
              {preTp3Blockers > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                  {t('preChecksTp3BlockerHint', { n: preTp3Blockers })}
                </div>
              )}
              {preBlockers === 0 && preWarnings > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                  {t('preChecksWarningHint', { n: preWarnings })}
                </div>
              )}
              {/* r369 (item eb949191) — the deliberate skip, NAMED BEFORE THE OPERATOR PRESSES GENERATE.
                  A silent drop out of a payroll run is the exact defect feedback f1564110 was raised about,
                  so this is the first of three surfaces (this panel, the run's own result afterwards, and the
                  "eligible but not on this run" list on the correction screen). Neutral by design — see the
                  `preNotices` note above for why neither red nor amber would be honest. Each row prints the
                  remark whoever set the salary up typed, which is the confirmation gesture core/comp.ts now
                  requires and the only reason the operator has for trusting the zero was deliberate. */}
              {preNotices > 0 && (
                <div>
                  <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
                    {t('preChecksNothingPayableHint', { n: preNotices })}
                  </div>
                  <div className="mb-1.5 mt-3 flex items-center gap-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t('preChecksNoticeBadge')}
                    </span>
                    <span className="text-xs font-semibold text-foreground">
                      {t('preChecks.nothingPayable')} · {preNotices}
                    </span>
                  </div>
                  <ul className="divide-y divide-border rounded-lg border border-border">
                    {preNothingPayable.map((r) => (
                      <li key={r.employmentId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                        <span className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-2">
                            <EmployeeCode code={r.employeeCode} />
                            <span className="font-medium">{r.name}</span>
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {r.remarks?.trim()
                              ? t('preChecksNothingPayableRemark', { remarks: r.remarks.trim() })
                              : t('preChecksNothingPayableNoRemark')}
                          </span>
                        </span>
                        <Link
                          href={`/people/${r.employmentId}`}
                          className="shrink-0 text-xs font-medium text-primary hover:underline"
                        >
                          {t('preChecksOpenProfile')} →
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(
                [
                  ['missingCompensation', preChecks.missingCompensation, true],
                  ['zeroBasic', preChecks.zeroBasic ?? [], true],
                  ['unpayablePayMode', preChecks.unpayablePayMode ?? [], true],
                  ['tp3YearMismatch', preChecks.tp3YearMismatch ?? [], true],
                  ['missingStatutory', preChecks.missingStatutory, false],
                  ['missingBank', preChecks.missingBank, false],
                  ['staleBasicComponent', preChecks.staleBasicComponent ?? [], false],
                  ['currencyMismatch', preChecks.currencyMismatch ?? [], false],
                  ['hrdfSubjectUnregistered', preChecks.hrdfSubjectUnregistered ?? [], false],
                ] as const
              ).map(([key, rows, isBlocker]) =>
                rows.length === 0 ? null : (
                  <div key={key}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                          isBlocker
                            ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                            : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                        }`}
                      >
                        {isBlocker ? t('preChecksBlockerBadge') : t('preChecksWarningBadge')}
                      </span>
                      <span className="text-xs font-semibold text-foreground">
                        {t(`preChecks.${key}`)} · {rows.length}
                      </span>
                    </div>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {rows.map((r) => (
                        <li key={r.employmentId} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                          <span className="flex items-center gap-2">
                            <EmployeeCode code={r.employeeCode} />
                            <span className="font-medium">{r.name}</span>
                          </span>
                          <Link
                            href={`/people/${r.employmentId}`}
                            className="text-xs font-medium text-primary hover:underline"
                          >
                            {t('preChecksOpenProfile')} →
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ),
              )}
            </div>
          )}
        </Card>
      )}

      {/* a1d82340 STEP 5 — the consolidated money view. The approved plan's "one obvious home" for every
          door money can arrive through. It ADDS no entry point and REMOVES none: r91 established that
          three of four screens an earlier revision proposed retiring were sole writers, and that closing
          a door is not reversible through configuration. So this reports; it never writes.

          Rendered even when empty, because "nothing is queued" is exactly the fact an operator about to
          press Generate needs, and an absent card cannot say it. */}
      {batch.status === 'draft' && pendingMoney && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('pendingMoney.title')} count={pendingMoney.lines.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">{t('pendingMoney.hint')}</p>
          {/* Rows that exist and pay nothing because a feature flag stops the kernel reading them. Kept
              out of every total above and called out here instead — the alternative was to hide them,
              which loses the fact that somebody keyed transactions into a dead end. */}
          {pendingMoney.inertRows > 0 && (
            <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
              {t('pendingMoney.inert', { n: pendingMoney.inertRows })}
            </div>
          )}
          {pendingMoney.lines.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">{t('pendingMoney.empty')}</p>
          ) : (
            <div className="space-y-4 px-4 py-4">
              <div className="flex flex-wrap gap-4 rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-xs">
                <span>
                  {t('pendingMoney.employees')} <span className="font-semibold tabular-nums">{pendingMoney.employees}</span>
                </span>
                <span>
                  {t('pendingMoney.earnings')}{' '}
                  <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {rm(pendingMoney.earnings)}
                  </span>
                </span>
                <span>
                  {t('pendingMoney.deductions')}{' '}
                  <span className="font-semibold tabular-nums text-red-700 dark:text-red-400">
                    {rm(pendingMoney.deductions)}
                  </span>
                </span>
              </div>

              {/* Per-door roll-up: which of the twelve doors this run's money actually came through. */}
              <ul className="divide-y divide-border rounded-lg border border-border">
                {pendingMoney.byDoor.map((d) => (
                  <li key={d.door} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{t(`pendingMoney.door.${d.door}`)}</span>
                      <span className="text-xs text-muted-foreground">× {d.count}</span>
                    </span>
                    <span
                      className={`tabular-nums font-medium ${
                        d.total < 0 ? 'text-red-700 dark:text-red-400' : 'text-foreground'
                      }`}
                    >
                      {rm(d.total)}
                    </span>
                  </li>
                ))}
              </ul>

              {/* The lines themselves. Deliberately not paginated: a draft run's queued transactions are
                  the thing being checked, and a pager would hide the tail behind a click at the exact
                  moment the operator is asked to confirm the whole of it. */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
                      <th className="px-3 py-2 font-medium">{t('pendingMoney.colSource')}</th>
                      <th className="px-3 py-2 font-medium">{t('pendingMoney.colItem')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('pendingMoney.colAmount')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {pendingMoney.lines.map((l, i) => (
                      <tr key={`${l.employmentId}-${l.door}-${l.itemName ?? ''}-${i}`}>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2">
                            <EmployeeCode code={l.employeeCode} />
                            <span className="font-medium">{l.employeeName}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span>{t(`pendingMoney.door.${l.door}`)}</span>
                            {/* Provenance the door carries: 'attendance'/'manual' overtime, and the
                                period-keyed txn that attach-on-generate has not stamped on yet. */}
                            {l.note && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                {t(`pendingMoney.note.${l.note}`)}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{l.itemName ?? '—'}</td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums ${
                            l.amount < 0 ? 'text-red-700 dark:text-red-400' : ''
                          }`}
                        >
                          {rm(l.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      )}

      {batch.status === 'draft' && leavers.length > 0 && (
        <Card className="overflow-hidden border-blue-200 dark:border-blue-500/30">
          <SectionHeader title={t('leaversTitle')} count={leavers.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            {t.rich('leaversHint', {
              strong: (chunks) => <span className="font-medium">{chunks}</span>,
            })}
          </p>
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                <th className="px-4 py-2 font-medium">{t('colLastDay')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colUnusedAnnual')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colOrpPerDay')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colSuggestedInLieu')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leavers.map((l) => (
                <tr key={l.employmentId}>
                  <td className="px-4 py-2.5">
                    <EmployeeCode code={l.employeeCode} />
                  </td>
                  <td className="px-4 py-2.5 font-medium">
                    {l.name}
                    {/* ADR-0069: badge the source of annualBalance/suggested — a frozen resignation-
                        approval snapshot wins over the live ledger balance when one exists. */}
                    {l.encashmentSource === 'frozen_snapshot' && (
                      <span
                        className="ml-2 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
                        title={l.frozenAsOf ? t('encashmentFrozenAsOfTitle', { date: l.frozenAsOf }) : undefined}
                      >
                        {l.overridden ? t('encashmentOverriddenBadge') : t('encashmentFrozenBadge')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{l.terminatedOn}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{t('daysShort', { d: l.annualBalance })}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(l.basic / 26)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{rm(l.suggested)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* 7076f8af — TWO CARDS LEFT THIS SCREEN HERE, and neither was deleted.
          The draft adjustment panel (Payroll inputs: the seven consolidation bridges + the per-employee
          input grid) now renders on the run flow's Review step and on a screen under Transactions —
          app/payroll/adjustments-panel.tsx, same actions, same batchId contract. The pay-component CSV
          import moved to Transactions only. A reset no longer lands anyone here, so leaving them would
          have left two copies of the same functions in two places. */}

      {batch.status !== 'draft' &&
        (() => {
          // HRD Corp levy is an employer-only cost. Feedback efece4ce — the tile is ALWAYS present now: a
          // registered company shows the amount, an unregistered one says so in words. Hiding it left the
          // reporter unable to tell "not registered" from "the calculation never ran". The value is a
          // string so the not-registered tile can carry copy instead of RM 0.00, which reads as a fault.
          const tiles: [string, string][] = [
            ['totalGross', rm(totals.gross)],
            ['totalDeductions', rm(totals.deductions)],
            ['totalNet', rm(totals.net)],
            ['totalHrdf', hrdfRegistered ? rm(totals.hrdfEmployer) : t('totalHrdfNotRegistered')],
            ['totalEmployerCost', rm(totals.employerCost)],
          ];
          return (
            <div className="grid grid-cols-2 divide-x divide-border rounded-lg border border-border sm:grid-cols-5">
              {tiles.map(([key, v]) => (
                <div key={key} className="p-4">
                  <div className="text-xs text-muted-foreground">{t(key)}</div>
                  <div
                    className={`font-semibold ${
                      key === 'totalHrdf' && !hrdfRegistered
                        ? 'text-sm text-muted-foreground'
                        : 'text-lg tabular-nums'
                    }`}
                  >
                    {v}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}

      {skippedEmployees.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('skipped.title')} count={skippedEmployees.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">{t('skipped.note')}</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                  <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="px-4 py-2 font-medium">{t('skipped.colReason')}</th>
                </tr>
              </thead>
              <tbody>
                {skippedEmployees.map((e) => (
                  <tr key={e.employmentId} className="border-t border-border">
                    <td className="px-4 py-2"><EmployeeCode code={e.employeeCode} /></td>
                    <td className="px-4 py-2 text-foreground">{e.name}</td>
                    <td className="px-4 py-2 text-muted-foreground">{t(`skipped.reason.${e.reason}`)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <SectionHeader title={t('payslipsTitle')} count={slips.length} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colGross')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colBonus')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colEpf')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colSocso')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colSkbbk')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colEis')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colPcb')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('colNet')}</th>
                {/* 97a9b0ab — the statutory ruleset version that produced this row, plus the revision
                    counter. Both were already stored (statutory.version since 2026.0; payslip.version
                    since the selective-reprocess build) and neither was ever shown, which is why a
                    figure that moved on a re-run looked unexplainable. No DDL. */}
                <th className="px-4 py-2 font-medium">{t('colRules')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {slipPage.rows.map((sl) => {
                const prov = payslipProvenance(sl.statutory);
                // 3c473773 — the Bonus column reads the payslip's own box stamp (so an overtime code
                // declared as additional remuneration no longer inflates Bonus here while reading Overtime
                // on the payslip), and the five statutory columns are NET of anything the employer agreed
                // to fund — the same figures the payslip and Transaction View show. Two screens printing
                // different numbers for one deduction is the failure this enumeration exists to prevent.
                const disp = payslipDisplayEarnings(sl);
                const eb = payslipEmployerBorne(sl.statutory);
                return (
                  <tr key={sl.id}>
                    <td className="px-4 py-2.5">
                      {/* e440991b point 5 — code and name both open the employee's full payroll result. */}
                      <Link href={payslipDetailHref(sl.employmentId)} className="hover:underline">
                        <EmployeeCode code={sl.employeeCode} />
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 font-medium">
                      <Link href={payslipDetailHref(sl.employmentId)} className="text-primary hover:underline">
                        {sl.name}
                      </Link>
                      {sl.daysWorked != null && Number(sl.daysWorked) < periodDays && (
                        <span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
                          {t('proratedDays', { worked: Number(sl.daysWorked), total: periodDays })}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{rm(sl.gross)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {disp.bonus > 0 ? rm(disp.bonus) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(eb.employee.epf)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(eb.employee.socso)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(eb.employee.skbbk)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(eb.employee.eis)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(eb.employee.pcb)}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(sl.net)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                      <span className="font-mono">{prov.rulesetVersion ?? '—'}</span>
                      {/* Signed statutory pack, when one produced the run. Every company computing from
                          the built-in ruleset has no pack stamp, so this stays absent for them. */}
                      {prov.packVersion && (
                        <span className="ml-1.5 font-mono">{t('slipPackStamp', { v: prov.packVersion })}</span>
                      )}
                      {sl.version > 1 && (
                        <span className="ml-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400">
                          {t('slipRevision', { n: sl.version })}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {slipPage.rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noPayslips')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager
          basePath={`/payroll/${batchId}`}
          params={{ from, hw }}
          state={slipPage.state}
        />
        {slipPage.rows.length > 0 && (
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t('provenanceNote')}</p>
        )}
      </Card>

      {/* e440991b point 4 — THE PER-RUN HISTORY CARD IS GONE FROM THIS SCREEN. It listed this batch's
          append-only lifecycle events (created / processed / reset / selective-reprocess / unlocked /
          closed), added for 9bc442bc ask #4 "fully traceable". The reporter has since asked for the run
          screen to show the run and for the history to live in the Audit Trail, and that is a safe move
          for THESE records specifically: they are `domain_event` rows, `auditEvents` is the same read
          the Audit Trail issues, and nothing is deleted — only this second rendering of them.

          `history` is still read above and MUST stay: the "published by X on Y" line (ef31d251) finds
          the most recent `payroll-batch.closed` event in it. Removing the read with the card would have
          quietly downgraded every closed run to "no publication record".

          THE RECALCULATION HISTORY CARD (97a9b0ab) AND THE SELECTION PANEL ARE GONE FROM HERE TOO, and
          the distinction matters: they were MOVED to /payroll/<id>/reprocess, not deleted. r168b held
          the History card back from point 4 with a finding — it is NOT a domain-event rendering, it
          reads `payroll_employee_result_history` through `listRecomputeDisclosure`, the Audit Trail
          does not carry that table, and deleting it would have destroyed the only account of why a
          statutory figure moved on a re-run. That finding stands; moving it satisfies the declutter
          without losing anything, and the new page is now its only reader.

          WHAT DID NOT MOVE, deliberately: the recalculation banner and the disabled Close above. Those
          are live controls, not history — dropping them lets a run close owing a recalculation. */}
    </div>
  );
}
