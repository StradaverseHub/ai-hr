import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { listBatches } from '@/core/payroll';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { PeriodSwitcher } from '@/components/period-switcher';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { deleteDraftBatchAction, resetAction } from './actions';
import { resumeHref } from './process/selection-logic';
import { settingEnabledOrDefault } from '@/core/entitlements';
import { payrollPublicationState } from '@/lib/payroll-publication';

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  processed: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  closed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
};

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; period?: string; page?: string; size?: string }>;
}) {
  // ADR-0077 slice 4 — a courtesy redirect when the tenant has not bought this module, so they get
  // an explanation instead of the service error. NOT the control: the reads below refuse on their
  // own (D3), and this guard fails open on an unresolved snapshot. Applied at the module ENTRY
  // point; a deep link skips it and meets the service refusal, which is the correct outcome.
  await requireModule('payroll');
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.list');
  // Payroll Reset (a03b2d9b) shares the batch-detail namespace so the confirm copy is written once.
  const tb = await getTranslations('payroll.batch');
  const resetOn = settingEnabledOrDefault(s, 'payroll.reset_enabled');
  const sp = await searchParams;
  const { error } = sp;
  const period = sp.period || '';
  const allBatches = await listBatches(s, scopeIds);
  // Build #10: derive the distinct pay-period options inline from the already-fetched scoped
  // batches (already desc-sorted by listBatches' orderBy). A single round-trip; the in-JS filter
  // is cheap at per-tenant batch counts. `activePeriod` reconciles the URL param against the
  // available periods — a valid-but-absent ?period (e.g. after a company switch, or a hand-typed
  // value) quietly falls back to "All periods" so the list is never blank with a ghost selection.
  const periodOptions = [...new Set(allBatches.map((b) => b.payPeriod))];
  const activePeriod = period && periodOptions.includes(period) ? period : '';
  const batches = activePeriod ? allBatches.filter((b) => b.payPeriod === activePeriod) : allBatches;
  // fc776376 — payroll runs accumulate every period, so the list pages like every other list.
  const { rows: batchPage, state: pgState } = paginateRows(batches, parsePageQuery(sp));
  // Feedback ef31d251 — "a skipped one cannot sit unnoticed for months". Counted off `allBatches`, NOT
  // `batches` (period-filtered above) or `batchPage` (paginated): either would let a ?period selection or
  // page 2 hide the exact warning this exists to raise. Same shared derivation as the run detail screen.
  const unpublishedCount = allBatches.filter((b) => payrollPublicationState(b) === 'unpublished').length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div data-tour="payroll-intro">
        <PageHeader
          title={t('title')}
          actions={
            /* Feedback 8bf6dfa1: "Import payroll history" moved off this operational header into the
               Payroll > Transactions hub (admin data-maintenance grouping). Route unchanged. */
            <Button asChild data-tour="payroll-create">
              <Link href="/payroll/process">{t('newRun')}</Link>
            </Button>
          }
        />
      </div>
      <div className="flex justify-end">
        <PeriodSwitcher options={periodOptions} active={activePeriod} />
      </div>
      <ErrorBanner message={error} />

      {unpublishedCount > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          🙈 {t('notPublishedBanner', { n: unpublishedCount })}
        </div>
      )}

      <Card className="overflow-hidden" data-tour="payroll-batches">
        <SectionHeader title={t('batches')} count={batches.length} />
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
              <th className="px-4 py-2 font-medium">{t('colCycle')}</th>
              <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
              <th className="px-4 py-2 font-medium">{t('colEmployees')}</th>
              <th className="px-4 py-2 font-medium">{t('colNetPay')}</th>
              <th className="px-4 py-2 font-medium">{t('colPaymentDate')}</th>
              <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
              {/* 4f00d8f0: narrow trailing actions column — only Draft rows render a control in it. */}
              <th className="w-px px-4 py-2 font-medium">
                <span className="sr-only">{t('colActions')}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {batchPage.map((b) => {
              const totals = b.totals as { net?: number } | null;
              return (
                <tr key={b.id} className="hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    {/* A DRAFT batch resumes into the wizard at Step 1 (Payroll Period & Company shown
                        read-only for review — feedback 4f00d8f0), then Employee Selection. Processed/closed
                        batches open directly as read-only, unchanged. */}
                    <Link
                      href={resumeHref(b.id, b.status)}
                      className="font-medium hover:text-primary"
                    >
                      {b.payPeriod}
                    </Link>
                  </td>
                  {/* Payroll Cycle: same pattern as the batch detail page — the runType label, plus the
                      free-text remarks (e.g. Advance Salary / Mid-Month) when present, so wizard cycles
                      stored under the generic 'off_cycle' bucket display distinctly. */}
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {t(`runType.${b.runType}`)}
                    {b.remarks ? ` — ${b.remarks}` : ''}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{b.company}</td>
                  <td className="px-4 py-2.5 tabular-nums">{b.employeeCount}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {totals?.net != null ? `RM ${Number(totals.net).toLocaleString()}` : '—'}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-muted-foreground" title={b.batchDate?.endsWith('-28') ? t('paymentDateLegacyNote') : undefined}>
                    {b.batchDate ?? '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLE[b.status]}`}>
                      {t(`status.${b.status}`)}
                    </span>
                    {/* ef31d251 — a second badge, from the SHARED derivation rather than a repeated
                        inline `b.status === 'processed'` test, so this and the run detail header can
                        never drift apart about what has actually reached employees. */}
                    {payrollPublicationState(b) === 'unpublished' && (
                      <span className="ml-1.5 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                        {t('notPublishedBadge')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {/* Delete is available for DRAFT runs ONLY (feedback 4f00d8f0) — processed/closed rows
                        render nothing here. ConfirmSubmit gates the destructive submit behind the reporter's
                        confirmation copy; the draft-only guard is re-enforced server-side (deleteDraftBatch
                        throws BatchNotDraftError for anything else). */}
                    {b.status === 'draft' && (
                      <form action={deleteDraftBatchAction}>
                        <input type="hidden" name="batchId" value={b.id} />
                        <ConfirmSubmit
                          size="sm"
                          title={t('deleteDraftTitle')}
                          description={t('deleteDraftBody')}
                          confirmLabel={t('deleteDraft')}
                        >
                          {t('deleteDraft')}
                        </ConfirmSubmit>
                      </form>
                    )}
                    {/* Reset / Zeroize (feedback a03b2d9b): PROCESSED rows only — a processed run is
                        locked; the controlled reset returns it to Draft (payslips cleared, loan/claim
                        side-effects reversed, audited). Closed rows render nothing: permanently
                        immutable. Admin-only + processed-only re-enforced server-side. */}
                    {b.status === 'processed' && resetOn && (
                      <form action={resetAction}>
                        <input type="hidden" name="batchId" value={b.id} />
                        <ConfirmSubmit
                          size="sm"
                          title={tb('resetTitle')}
                          description={tb('resetDescription')}
                          confirmLabel={tb('resetConfirm')}
                          reasonField={{ name: 'reason', label: tb('resetReasonLabel'), placeholder: tb('resetReasonPlaceholder') }}
                        >
                          {tb('resetPayroll')}
                        </ConfirmSubmit>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
            {batchPage.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  {activePeriod ? t('filteredEmpty') : t('empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pager basePath="/payroll" params={{ period: sp.period }} state={pgState} />
      </Card>
    </div>
  );
}
