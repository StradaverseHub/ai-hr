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
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { closeAction, generateAction, prefillClaimsAction, prefillFixedZakatAction, prefillLoansAction, prefillOvertimeAction, prefillShiftDifferentialAction, resetAction, transferAllowancesAction, unlockAction } from '../actions';
import { ComponentImport } from './component-import';
import { OtInputRow } from './ot-input-row';
import { ReprocessPanel } from './reprocess-panel';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function BatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string; from?: string; hw?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.batch');
  const { batchId } = await params;
  const { error, from, hw } = await searchParams;
  const data = await batchDetail(s, batchId);
  if (!data) notFound();
  const { batch, slips } = data;
  const totals = (batch.totals ?? {}) as Record<string, number>;
  const inputs = batch.status === 'draft' ? await batchInputRows(s, batchId) : [];
  const leavers = batch.status === 'draft' ? await leaverAdvisory(s, batchId) : [];
  // Pre-processing checks (feedback f1564110, Phase 1): validate employee master data BEFORE the run
  // is calculated. Blockers (no salary record) disable Generate outright; warnings (no statutory
  // profile / no bank details) swap Generate for a ConfirmSubmit that posts ackWarnings=1.
  const preChecks: PreProcessAdvisory =
    batch.status === 'draft'
      ? await preProcessAdvisory(s, batchId)
      : { missingCompensation: [], missingBasicComponent: [], missingStatutory: [], missingBank: [] };
  const preBlockers = preChecks.missingCompensation.length + preChecks.missingBasicComponent.length;
  const preWarnings = preChecks.missingStatutory.length + preChecks.missingBank.length;
  // Config-level readiness (feedback 5db3ae48, Phase A) — the layer ABOVE the employee-master pre-checks:
  // is the COMPANY configured to run payroll (statutory tables, active cycle, pay-day, pay items, policy)?
  // Read-only; surfaced here as a compact panel with a link to the full Workflow Guide. Uses the
  // payroll.guide namespace so the check copy is written once.
  const tg = await getTranslations('payroll.guide');
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
    payrollSchedule: 'PayrollSchedule',
    payrollPolicy: 'PayrollPolicy',
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
  const typedComponentsOn = process.env.TYPED_PAY_COMPONENTS_ENABLED === 'true';
  // Payroll Reset (feedback a03b2d9b) — ships dark behind a flag; the page is already requireAdmin-
  // gated, and resetAction + resetProcessedBatch re-assert admin (a payroll_partner never sees this).
  const resetOn = process.env.PAYROLL_RESET_ENABLED === 'true';
  // Selective reprocessing (feedback 9bc442bc, reporter ask #3) needs same-month adjustment runs.
  const multiCycleOn = process.env.MULTI_CYCLE_PAYROLL_ENABLED === 'true';
  // Unlock Closed run (feedback 9bc442bc, reporter ask #2) — gated so an environment can keep Closed
  // permanently frozen. Single-confirm + mandatory reason + warnings live in the service; the page is
  // requireAdmin-gated and unlockClosedBatch re-asserts the granular payroll.unlock permission
  // (hr_admin + super_admin by default, per-company configurable — feedback 62e85140).
  const unlockOn = process.env.PAYROLL_UNLOCK_ENABLED === 'true';
  // Per-run History (reporter ask #4 "fully traceable") — this batch's lifecycle events (created /
  // processed / reset / run-added / selective-reprocess / closed / payment-summary.exported). Read-only.
  const history = await auditEvents(s, { aggregateId: batchId, limit: 50 });
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

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        back={{ href: '/payroll', label: t('back') }}
        title={batch.payPeriod}
        description={
          <>
            {fromWizard ? `${t('step3Title')} · ` : ''}
            {t('subtitle')} · <span className="capitalize">{batch.status}</span>
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
                <Button type="submit" variant="secondary">
                  {t('closeBatch')}
                </Button>
              </form>
            )}
            {/* Reset / Zeroize (feedback a03b2d9b): PROCESSED-only — never draft (nothing to reset;
                delete-draft is 4f00d8f0's flow) and never closed (permanently immutable). The
                ConfirmSubmit dialog carries the reporter's confirmation copy; processed-only and
                admin-only are re-enforced server-side. */}
            {batch.status === 'processed' && resetOn && (
              <form action={resetAction}>
                <input type="hidden" name="batchId" value={batch.id} />
                <ConfirmSubmit
                  title={t('resetTitle')}
                  description={t('resetDescription')}
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
              <div className="text-sm font-medium">{t(`runType.${batch.runType}`)}{batch.remarks ? ` — ${batch.remarks}` : ''}</div>
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
                    <p className="text-xs text-muted-foreground">{tg(`check${CHECK_CAP[c.key]}${STATUS_CAP[c.status]}`, c.detail)}</p>
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
                  ['missingBasicComponent', preChecks.missingBasicComponent, true],
                  ['missingStatutory', preChecks.missingStatutory, false],
                  ['missingBank', preChecks.missingBank, false],
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
                {inputs.map((r) => (
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
                {inputs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      {t('noActiveEmployees')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
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
          // HRD Corp levy is an employer-only cost; show its tile only when the company is registered.
          const tiles: [string, number][] = [
            ['totalGross', totals.gross],
            ['totalDeductions', totals.deductions],
            ['totalNet', totals.net],
          ];
          if (Number(totals.hrdfEmployer) > 0) tiles.push(['totalHrdf', totals.hrdfEmployer]);
          tiles.push(['totalEmployerCost', totals.employerCost]);
          return (
            <div
              className={`grid grid-cols-2 divide-x divide-border rounded-lg border border-border ${
                tiles.length === 5 ? 'sm:grid-cols-5' : 'sm:grid-cols-4'
              }`}
            >
              {tiles.map(([key, v]) => (
                <div key={key} className="p-4">
                  <div className="text-xs text-muted-foreground">{t(key)}</div>
                  <div className="text-lg font-semibold tabular-nums">{rm(v)}</div>
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
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {slips.map((sl) => {
                const st = sl.statutory as Record<string, number>;
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
                      {Number(sl.bonus) > 0 ? rm(sl.bonus) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.epfEmployee)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.socsoEmployee)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.socsoSkbbk)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.eisEmployee)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{rm(st.pcb)}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums">{rm(sl.net)}</td>
                  </tr>
                );
              })}
              {slips.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                    {t('noPayslips')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Selective reprocessing (feedback 9bc442bc, reporter ask #3): pick specific employees on a
          PROCESSED run and reprocess them as a same-month adjustment run — the regular run's payslips
          for everyone else stay physically untouched. Admin-only (page is requireAdmin; the action +
          service re-assert it) and gated on multi-cycle. Not on closed runs (permanently immutable). */}
      {batch.status === 'processed' && multiCycleOn && slips.length > 0 && (
        <Card>
          <SectionHeader title={t('reprocessTitle')} />
          <div className="px-4 pb-4">
            <p className="mb-3 text-xs text-muted-foreground">{t('reprocessHint')}</p>
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
