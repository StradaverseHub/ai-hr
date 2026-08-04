import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { batchDetail, batchInputRows, leaverAdvisory, preProcessAdvisory, type PreProcessAdvisory } from '@/core/payroll';
import { payrollReadiness, type PayrollReadiness } from '@/core/payroll-readiness';
import { statutoryPackStale } from '@/lib/statutory-readiness';
import { loanSummaryForBatch } from '@/core/loans';
import { listAllowancePolicies, auditEvents } from '@/core/read';
import { humanizeEvent } from '@/lib/audit-format';
import { Button, Card, EmployeeCode, ErrorBanner, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { closeAction, generateAction, prefillClaimsAction, prefillFixedZakatAction, prefillLoansAction, prefillOvertimeAction, prefillShiftDifferentialAction, prefillTp1Action, resetAction, transferAllowancesAction, unlockAction } from '../actions';
import { ComponentImport } from './component-import';
import { OtInputRow } from './ot-input-row';
import { ReprocessPanel } from './reprocess-panel';
import { isModuleEnabledOrFalse, settingEnabledOrDefault } from '@/core/entitlements';
import { packFor } from '@/localization/registry';
import { payrollPublicationState, type PayrollPublicationState } from '@/lib/payroll-publication';
import { listRecomputeDisclosure, listUnattachedTxnSummary, pendingBatchMoney, unattachedHoldersOutsideBatchScope } from '@/core/payroll-view';
import { payslipProvenance, type StatutoryLineKey } from '@/core/payslip-recompute';
// 3c473773 — payslip boxes + the employer-borne disclosure, both read from each payslip's own snapshot.
import { payslipDisplayEarnings } from '@/core/pay-display-category';
import { payslipEmployerBorne } from '@/core/payslip-employer-borne';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 97a9b0ab — statutory line key → its payroll.batch label key. Exhaustive by TYPE (Record over
 *  StatutoryLineKey), so adding a key to STATUTORY_LINE_KEYS without a label fails the build rather
 *  than rendering `lineundefined` at runtime. */
const STATUTORY_LINE_LABEL: Record<StatutoryLineKey, string> = {
  epfEmployee: 'lineEpfEmployee',
  epfEmployer: 'lineEpfEmployer',
  socsoEmployee: 'lineSocsoEmployee',
  socsoEmployer: 'lineSocsoEmployer',
  socsoSkbbk: 'lineSocsoSkbbk',
  eisEmployee: 'lineEisEmployee',
  eisEmployer: 'lineEisEmployer',
  pcb: 'linePcb',
  cp38: 'lineCp38',
  zakat: 'lineZakat',
  lp: 'lineLp',
  hrdf: 'lineHrdf',
};

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
    // The draft-run inputs table pages independently of the payslips table below it.
    iPage?: string;
    iSize?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.batch');
  const { batchId } = await params;
  const sp = await searchParams;
  const { error, from, hw } = sp;
  const data = await batchDetail(s, batchId);
  if (!data) notFound();
  const { batch, slips } = data;
  // Feedback ef31d251 — this header used to render the RAW status enum, and "Processed" reads as
  // finished. It is not: payslips stay invisible to employees until Close, which is why eighteen runs
  // were calculated and never published. Derived through the shared helper the payroll LIST also uses,
  // so the two screens cannot start disagreeing about what "published" means. batchDetail does a bare
  // select() of the batch row, so releasedAt is already in hand — no extra read.
  const pubState = payrollPublicationState(batch);
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
  // 97a9b0ab — recomputations of this run's payslips, each diffed against the calculation it replaced
  // with the cause(s) named. Only a PROCESSED/CLOSED run can have any (a draft has no payslips), and the
  // read returns [] when the history table has no row for this batch, so a never-reprocessed run pays
  // one indexed lookup and renders nothing extra.
  const recomputes = batch.status === 'draft' ? [] : await listRecomputeDisclosure(s, { batchId });
  const inputPage = paginateRows(inputs, parsePageQuery({ page: sp.iPage, size: sp.iSize }));
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
  // Feedback 64fb5e48 — blockers are the salary-record gaps (missing/period-miss/zero); the old
  // BASIC-pay-item existence blocker is gone. A stale BASIC pay item is a confirm-to-proceed warning.
  const preBlockers = preChecks.missingCompensation.length + (preChecks.zeroBasic?.length ?? 0);
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
  // Read-only; surfaced here as a compact panel with a link to the full Workflow Guide. Uses the
  // payroll.guide namespace so the check copy is written once.
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
  // 1.2.8 (ADR-0060): loan deductions are RESERVED onto a regular draft run only; show the running summary.
  const isRegular = batch.runType === 'regular';
  const loanSummary = batch.status === 'draft' && isRegular ? await loanSummaryForBatch(s, batchId) : { loans: 0, total: 0 };
  // Attendance Allowance (ADR-0072): active policies in this batch's company available to transfer.
  const allowancePolicies =
    batch.status === 'draft'
      ? await listAllowancePolicies(s, { companyIds: [batch.companyId] }).then((rows) =>
          rows.filter((r) => r.status === 'active'),
        )
      : [];
  const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
  const periodDays = new Date(pYear, pMonth, 0).getDate(); // calendar days in the pay period
  // Bulk component import (1D) is only meaningful when the kernel reads typed components.
  const typedComponentsOn = isModuleEnabledOrFalse(s, 'typed_pay_components');
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
  // Per-run History (reporter ask #4 "fully traceable") — this batch's lifecycle events (created /
  // processed / reset / run-added / selective-reprocess / closed / payment-summary.exported). Read-only.
  const history = await auditEvents(s, { aggregateId: batchId, limit: 50 });
  // Feedback efece4ce — this run's company HRDF registration. The levy tile was shown only when the total
  // was > 0, so "this company pays no HRDF because it is not registered" and "the levy failed to compute"
  // rendered identically: as nothing at all. That ambiguity IS the reported bug. Read for display only —
  // the figure on the payslips stays whatever the run computed. `packFor('MY')` mirrors the Organization
  // page: the levy, like this page's RM formatting, is Malaysia-specific.
  const hrdfRegistered =
    ((await packFor('MY')?.companyStatutory.get(s, batch.companyId))?.hrdfStatus ?? 'not_registered') !==
    'not_registered';
  // Payroll Process wizard: this draft is presented as "Step 3 of 3" when it arrived straight from the
  // wizard's terminal create action. A compact one-shot holiday-warning code list rides the query string
  // ('country|state|year|loaded|required' ';'-joined) — the domain event appended in createBatch is the
  // durable record; this is only shown for this one render right after creation.
  const fromWizard = from === 'process' && batch.status === 'draft';
  const holidayWarnings = hw
    ? hw.split(';').map((code) => {
        const [country, state, year, loaded, required] = code.split('|');
        return { country, state: state || null, year, loaded, required };
      })
    : [];
  const scope = (batch.scope ?? null) as { departmentIds?: string[]; employmentIds?: string[] } | null;
  const isScoped = !!(scope?.departmentIds?.length || scope?.employmentIds?.length);

  // ── Feedback d0d2c9d1 — money entered for this month that has never reached a payslip. ──
  // GATED TO runType === 'regular' on purpose: off_cycle / bonus / adjustment runs NEVER collect
  // transactions by design (the attach guard in generatePayslips), so an indicator on them would be a
  // permanent, un-actionable alert about behaviour that is working correctly. Reuses the `isRegular`
  // declared above for the loan summary — same expression, one binding.
  const [txnYear, txnMonth] = batch.payPeriod.split('-').map(Number);
  // Before Generate on a SCOPED draft: who this run is about to leave out, and what they are holding.
  const scopeHolders =
    isRegular && isScoped && batch.status === 'draft'
      ? await unattachedHoldersOutsideBatchScope(s, {
          companyId: batch.companyId,
          payPeriod: batch.payPeriod,
          scope,
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
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        back={{ href: '/payroll', label: t('back') }}
        title={batch.payPeriod}
        description={
          <>
            {fromWizard ? `${t('step3Title')} · ` : ''}
            {t('subtitle')} · <span>{PUBLICATION_LABEL[pubState]}</span>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {batch.status !== 'draft' && (
              <a
                href={`/payroll/reports/payment-summary?batchId=${batch.id}`}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                title={t('paymentSummaryTitle')}
              >
                ⬇ {t('paymentSummary')}
              </a>
            )}
            {batch.status === 'draft' && (
              <form action={generateAction}>
                <input type="hidden" name="batchId" value={batch.id} />
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
            {batch.status === 'processed' && (
              <form action={closeAction}>
                <input type="hidden" name="batchId" value={batch.id} />
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
            )}
            {/* Reset / Zeroize (feedback a03b2d9b): PROCESSED-only — never draft (nothing to reset;
                delete-draft is 4f00d8f0's flow) and never closed (permanently immutable). The
                ConfirmSubmit dialog carries the reporter's confirmation copy; processed-only and
                admin-only are re-enforced server-side. */}
            {batch.status === 'processed' && resetOn && (
              <form action={resetAction}>
                <input type="hidden" name="batchId" value={batch.id} />
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
          here to keep the draft page focused; the full checklist + guided Phase 1→6 flow lives on the
          Workflow Guide tab. */}
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
              <Link href="/payroll/guide" className="shrink-0 text-xs font-medium text-primary hover:underline">
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
                : 'border-emerald-200 dark:border-emerald-500/30'
          }`}
        >
          <SectionHeader title={t('preChecksTitle')} count={preBlockers + preWarnings} />
          {preBlockers + preWarnings === 0 ? (
            <p className="px-4 py-4 text-sm text-emerald-700 dark:text-emerald-400">✓ {t('preChecksAllClear')}</p>
          ) : (
            <div className="space-y-4 px-4 py-4">
              {preBlockers > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                  {t('preChecksBlockerHint', { n: preBlockers })}
                </div>
              )}
              {preBlockers === 0 && preWarnings > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                  {t('preChecksWarningHint', { n: preWarnings })}
                </div>
              )}
              {(
                [
                  ['missingCompensation', preChecks.missingCompensation, true],
                  ['zeroBasic', preChecks.zeroBasic ?? [], true],
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

      {batch.status === 'draft' && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('inputsTitle')} count={inputs.length} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            {t('inputsHint')}
          </p>
          <div className="mx-4 mt-3 rounded-xl border border-border bg-muted/40 px-3 py-2.5">
            <div className="mb-1.5 text-xs font-semibold text-foreground">{t('consolidateTitle')}</div>
            <p className="text-xs text-muted-foreground">
              {t.rich('prefillHint', {
                strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
              })}
            </p>
            {isScoped && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t('scopedCaption')}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <form action={prefillOvertimeAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit" size="sm" variant="secondary">
                  {t('prefillOt')}
                </Button>
              </form>
              <form action={prefillClaimsAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit" size="sm" variant="secondary">
                  {t('prefillClaims')}
                </Button>
              </form>
              {/* 1.2.8 Loan deductions — reserve onto a regular draft run only (ADR-0060). */}
              {isRegular && (
                <form action={prefillLoansAction} className="flex items-center gap-2">
                  <input type="hidden" name="batchId" value={batch.id} />
                  <Button type="submit" size="sm" variant="secondary">
                    {t('prefillLoans')}
                  </Button>
                  {loanSummary.loans > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {t('loanSummary', {
                        count: loanSummary.loans,
                        amount: loanSummary.total.toLocaleString('en-MY', { minimumFractionDigits: 2 }),
                      })}
                    </span>
                  )}
                </form>
              )}
              <form action={prefillShiftDifferentialAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit" size="sm" variant="secondary">
                  {t('prefillShiftDiff')}
                </Button>
              </form>
              <form action={prefillFixedZakatAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <Button type="submit" size="sm" variant="secondary">
                  {t('prefillFixedZakat')}
                </Button>
              </form>
              {/* a1d82340 rev 3 — TP1 self-relief. `prefillTp1Action` has existed since the TP1 screen
                  shipped and was rendered by NO screen: five of the six prefill actions had a button
                  here and this one did not. An employee could submit their TP1 relief, HR could see it
                  on the relief screen, and it could never reach a payslip, because the only bridge from
                  tp1_relief to payroll_input.tp1_deduction is this action. Regular runs only, like the
                  loan reservation above: an additional/off-cycle run pays its bonus and does not carry
                  the month's declared reliefs. */}
              {isRegular && (
                <form action={prefillTp1Action}>
                  <input type="hidden" name="batchId" value={batch.id} />
                  <Button type="submit" size="sm" variant="secondary">
                    {t('prefillTp1')}
                  </Button>
                </form>
              )}
              {/* Attendance Allowance (ADR-0072) — pick an active policy and transfer its qualified
                  allowances onto this draft. Gated by TYPED_PAY_COMPONENTS_ENABLED. */}
              {allowancePolicies.length > 0 && (
                <form action={transferAllowancesAction} className="flex items-center gap-2">
                  <input type="hidden" name="batchId" value={batch.id} />
                  <select name="policyId" className={inputCls} defaultValue={allowancePolicies[0]?.id}>
                    {allowancePolicies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — RM {Number(p.amount).toFixed(2)}
                      </option>
                    ))}
                  </select>
                  <Button type="submit" size="sm" variant="secondary">
                    {t('transferAllowance')}
                  </Button>
                </form>
              )}
            </div>
            {allowancePolicies.length > 0 && !typedComponentsOn && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t('allowanceGateWarning')}</p>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                  <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colBasic')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colOtBonusTp1Zakat')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('colUnpaidDays')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {inputPage.rows.map((r) => (
                  <tr key={r.employmentId}>
                    <td className="px-4 py-2.5">
                      <EmployeeCode code={r.employeeCode} />
                    </td>
                    <td className="px-4 py-2.5 font-medium">{r.name}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(r.basic)}</td>
                    <td className="px-4 py-2.5">
                      {/* Fix-5: manual OT (RM you enter) with the s.60I(1A) ORP/hourly basis surfaced, a
                          >RM4,000 eligibility note, and a clobber warning before overwriting an
                          attendance-prefilled row. See ot-input-row.tsx. */}
                      <OtInputRow
                        batchId={batch.id}
                        row={{
                          employmentId: r.employmentId,
                          otBreakdown: r.otBreakdown,
                          otSource: r.otSource,
                          orp: r.orp,
                          hourly: r.hourly,
                          otEligible: r.otEligible,
                          otWageCeiling: r.otWageCeiling,
                          bonusAmount: r.bonusAmount,
                          tp1Deduction: r.tp1Deduction,
                          zakat: r.zakat,
                        }}
                      />
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {r.unpaidDays > 0 ? r.unpaidDays : '—'}
                    </td>
                  </tr>
                ))}
                {inputPage.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      {t('noActiveEmployees')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager
            basePath={`/payroll/${batchId}`}
            params={{ from, hw, page: sp.page, size: sp.size }}
            paramNames={{ page: 'iPage', size: 'iSize' }}
            state={inputPage.state}
          />
        </Card>
      )}

      {batch.status === 'draft' && typedComponentsOn && (
        <Card>
          <SectionHeader title={t('componentImport.title')} />
          <div className="px-4 pb-4">
            <p className="mb-3 text-xs text-muted-foreground">{t('componentImport.description')}</p>
            <ComponentImport batchId={batch.id} />
          </div>
        </Card>
      )}

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
                      <EmployeeCode code={sl.employeeCode} />
                    </td>
                    <td className="px-4 py-2.5 font-medium">
                      {sl.name}
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
          params={{ from, hw, iPage: sp.iPage, iSize: sp.iSize }}
          state={slipPage.state}
        />
        {slipPage.rows.length > 0 && (
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{t('provenanceNote')}</p>
        )}
      </Card>

      {/* 97a9b0ab — RE-RUN DISCLOSURE. The run already wrote a full before/after payslip pair into
          payroll_employee_result_history on every selective reprocess, and NOTHING read it back: a
          statutory figure could move while gross stood still and the screen said nothing at all.
          This section diffs each pair and names the cause. Read-only; rendered only when this run has
          actually been recalculated, so an untouched run is visually unchanged. */}
      {recomputes.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('disclosureTitle')} count={recomputes.length} />
          <ul className="divide-y divide-border">
            {recomputes.map((r) => {
              const d = r.diff;
              return (
                <li key={r.id} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-medium">{r.employeeName}</span>
                    {r.employeeCode && <EmployeeCode code={r.employeeCode} />}
                    <span className="text-xs text-muted-foreground">
                      {t('disclosureRevision', { before: d.versionBefore ?? '?', after: d.versionAfter ?? '?' })}
                    </span>
                    <span className="text-xs text-muted-foreground">{r.at.toISOString().slice(0, 16).replace('T', ' ')}</span>
                    {r.reason && (
                      <span className="text-xs text-muted-foreground">{t('disclosureReason', { reason: r.reason })}</span>
                    )}
                  </div>

                  {d.moved.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t('disclosureNoMove')}</p>
                  ) : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        {d.grossChanged
                          ? t('disclosureGrossChanged', { before: rm(d.grossBefore), after: rm(d.grossAfter) })
                          : t('disclosureGrossUnchanged', { gross: rm(d.grossAfter) })}
                      </p>
                      <ul className="space-y-0.5">
                        {d.moved.map((m) => (
                          <li key={m.key} className="flex items-baseline justify-between gap-4 text-xs">
                            <span>{t(STATUTORY_LINE_LABEL[m.key])}</span>
                            <span className="tabular-nums">
                              <span className="text-muted-foreground">{rm(m.before)}</span>
                              {' → '}
                              <span className="font-medium">{rm(m.after)}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="rounded-md bg-muted/50 px-3 py-2 text-xs">
                        <p className="mb-1 font-medium">{t('disclosureCauseHeading')}</p>
                        <ul className="space-y-1 text-muted-foreground">
                          {/* Cause (a). Reported as a FACT TO CHECK, never as proof the tax moved: a
                              ruleset bump is not automatically behavioural (2026.4 → 2026.5 changed no
                              PCB band, rate or relief — it only added optional pay-code classification
                              tables that are inert unless a pay item is explicitly classified). The
                              note below carries that caveat, and must not be dropped. */}
                          {d.rulesetChanged && (
                            <li>
                              {t('disclosureCauseRuleset', {
                                before: d.before.rulesetVersion ?? '?',
                                after: d.after.rulesetVersion ?? '?',
                              })}{' '}
                              {t('disclosureCauseRulesetNote')}
                            </li>
                          )}
                          {d.rulesetUnknown && <li>{t('disclosureCauseRulesetUnknown')}</li>}
                          {/* Cause (b) — the cumulative-PCB replay. This one IS a mechanism, not a hint. */}
                          {r.priorMonths.length > 0 && (
                            <li>{t('disclosureCausePriorMonths', { periods: r.priorMonths.join(', ') })}</li>
                          )}
                          {d.causes.length === 0 && !d.rulesetUnknown && <li>{t('disclosureCauseOwnInputs')}</li>}
                        </ul>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Selective reprocessing (feedback 9bc442bc, reporter ask #3): pick specific employees on a
          PROCESSED run and reprocess them as a same-month adjustment run — the regular run's payslips
          for everyone else stay physically untouched. Admin-only (page is requireAdmin; the action +
          service re-assert it) and gated on multi-cycle. Not on closed runs (permanently immutable). */}
      {batch.status === 'processed' && multiCycleOn && slips.length > 0 && (
        <Card>
          <SectionHeader title={t('reprocessTitle')} />
          <div className="px-4 pb-4">
            {/* d0d2c9d1 — the counterpart to the reset copy. A selective reprocess passes
                `reprocessSubset`, and the attach guard is `!subset && runType === 'regular'`, so it
                does NOT collect outstanding transactions. Reset-and-regenerate is the path that does. */}
            <p className="mb-3 text-xs text-muted-foreground">
              {t('reprocessHint')} {t('reprocessDoesNotCollect')}
            </p>
            <ReprocessPanel
              batchId={batch.id}
              employees={slips.map((sl) => ({ employmentId: sl.employmentId, employeeCode: sl.employeeCode, name: sl.name }))}
            />
          </div>
        </Card>
      )}

      {/* Per-run History (reporter ask #4 "fully traceable — who, when, why, before/after"): this run's
          append-only lifecycle events. The reset event carries its reason + reversal counts; the
          selective-reprocess event carries who was picked. Read-only, admin-only (page is requireAdmin). */}
      <Card className="overflow-hidden">
        <SectionHeader title={t('historyTitle')} count={history.length} />
        {history.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('historyEmpty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {history.map((ev) => {
              const pl = (ev.payload ?? {}) as Record<string, unknown>;
              const reason = typeof pl.reason === 'string' && pl.reason.trim() ? pl.reason.trim() : null;
              return (
                <li key={ev.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between">
                  <div>
                    <div className="text-sm font-medium">{humanizeEvent(ev.eventType)}</div>
                    {reason && <div className="mt-0.5 text-xs text-muted-foreground">{t('historyReason', { reason })}</div>}
                    {ev.eventType === 'payroll-batch.reset' && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {t('historyResetCounts', {
                          payslips: Number(pl.payslipsCleared ?? 0),
                          loans: Number(pl.loanInstalmentsReversed ?? 0),
                          claims: Number(pl.claimsReverted ?? 0),
                        })}
                      </div>
                    )}
                    {(ev.eventType === 'payroll-batch.selective-reprocessed' ||
                      ev.eventType === 'payroll-batch.selective-reprocess-initiated') && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {t('historyReprocessCount', { n: Number(pl.reprocessedCount ?? pl.employeeCount ?? 0) })}
                      </div>
                    )}
                    {ev.eventType === 'payroll-batch.unlocked' &&
                      (() => {
                        const w = (pl.warnings ?? {}) as { paymentDisbursed?: boolean; statutoryFiled?: boolean };
                        return (
                          <>
                            {w.paymentDisbursed && (
                              <div className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">{t('unlockWarnPayment')}</div>
                            )}
                            {w.statutoryFiled && (
                              <div className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">{t('unlockWarnStatutory')}</div>
                            )}
                          </>
                        );
                      })()}
                  </div>
                  <div className="text-xs text-muted-foreground sm:text-right">
                    <div>{ev.actorName ?? t('historySystemActor')}</div>
                    <div className="tabular-nums">{new Date(ev.occurredAt).toLocaleString()}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
