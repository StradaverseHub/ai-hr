import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { batchDetail, listBatches, payrollCloseCompanyIds } from '@/core/payroll';
import { payrollCloseCycleLabel } from '@/core/payslip-cycle-label';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { formatPayPeriodMonth } from '@/lib/hr-date';
// Back / No return the Payroll Process list EXACTLY as it was left (9066bd6c): the list hands this link
// its own filter query as `?from=…`, whitelisted BY SHAPE here, never echoed raw.
import { payrollListReturnTo } from '@/lib/return-to';
import { closeAction } from '../../actions';

/**
 * cdb1c6ca — CLOSE BATCH, a screen of its own, reached from the Payroll Process list's row menu.
 *
 * A SCREEN, NOT A DIALOG, for the reason the sibling Reset screen documents (9f8cd608): the row menu is a
 * `position: fixed` panel that closes on any scroll, and a confirmation dialog owned by it is destroyed by
 * its own opening. This page IS the confirmation step — the question naming the month and pay cycle, the
 * run's identity, what closing does, and Yes / No.
 *
 * NOTHING ABOUT CLOSING IS DECIDED HERE. `closeAction` → `closeBatch` holds every rule: payroll.close,
 * processed-only, the recalculation mark, anomalies, swing, coverage and the outstanding-work gates. The
 * three refusals this page can read for itself are rendered with their reason instead of a Yes button, so
 * the operator does not discover them by pressing the button that publishes pay. Everything else comes
 * back from the action on `?error=`, translated, with `from` intact.
 *
 * NO CHANGES NOTHING. It is a link back to the list as it was left — no form, no post.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ClosePayrollPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.batch');
  // The summary strip reuses the list's own column labels and run-type words, from the namespace that
  // actually holds them (r134).
  const tl = await getTranslations('payroll.list');
  const locale = await getLocale();
  const { batchId } = await params;
  // A non-uuid would reach a uuid parameter and come back as a 500 where a 404 belongs.
  if (!UUID_RE.test(batchId)) notFound();
  const sp = await searchParams;
  const back = payrollListReturnTo(sp.from);
  const from = back === '/payroll' ? null : back;

  const data = await batchDetail(s, batchId);
  if (!data) notFound();
  const { batch, slips } = data;

  // The run's identity through the SAME projection the list renders, so the prompt cannot disagree with
  // the row that was clicked.
  const listed = (await listBatches(s, [batch.companyId], batch.payPeriod)).find((b) => b.id === batchId);
  // The pay cycle is the configured cycle's own name; a run opened under no cycle reads its run-type word,
  // and imported history keeps its "… - By Import" label (b240c0ff). One rule, shared with the run screen.
  const cycle = payrollCloseCycleLabel(
    { ...batch, payrollCycleName: listed?.payrollCycleName ?? null },
    tl(`runType.${batch.runType}`),
  );
  const month = formatPayPeriodMonth(batch.payPeriod, locale);

  // Resolved per COMPANY on the server — payroll scope plus the granular payroll.close key.
  const canClose = (await payrollCloseCompanyIds(s, [batch.companyId])).has(batch.companyId);

  const summary: { label: string; value: string }[] = [
    { label: tl('colCompany'), value: listed?.company ?? '—' },
    { label: t('summaryPeriod'), value: month },
    { label: t('summaryCycle'), value: cycle },
    { label: t('closeSummaryPayslips'), value: String(slips.length) },
  ];

  const header = (
    <PageHeader
      back={{ href: back, label: t('closeBack') }}
      title={t('closeBatch')}
      description={`${month} · ${listed?.company ?? ''}`}
    />
  );

  // Ordered as `closeBatch` asserts them, so the two surfaces agree about which reason comes first.
  const refusal = !canClose
    ? t('closePermissionDenied')
    : batch.status !== 'processed'
      ? t('closeNotProcessed')
      : batch.needsRecalcAt != null
        ? t('closeBlockedRecalc')
        : null;
  if (refusal) {
    return (
      <div className={pageWideCls}>
        {header}
        <ErrorBanner message={refusal} />
      </div>
    );
  }

  return (
    <div className={pageWideCls}>
      {header}

      {/* A refused close comes back HERE with the translated reason (closeAction, `surface` flag). */}
      <ErrorBanner message={sp.error} />

      <Card className="px-4 py-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {summary.map((f) => (
            <div key={f.label}>
              <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
                {f.label}
              </div>
              <div className="mt-0.5 text-sm font-medium tabular-nums">{f.value}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionHeader title={t('closeBatch')} />
        <div className="px-4 pb-4">
          <p className="mb-2 text-sm font-medium text-foreground">{t('closeConfirmTitle', { month, cycle })}</p>
          <p className="mb-4 text-xs text-muted-foreground">{t('closeConfirmBody', { n: slips.length })}</p>
          <form action={closeAction} className="flex flex-wrap items-center justify-end gap-2">
            <input type="hidden" name="batchId" value={batchId} />
            {/* Which surface pressed it — a flag, never a destination (see closeAction). */}
            <input type="hidden" name="surface" value="close-screen" />
            {/* The raw filter path, not the encoded href — a FormData value must not be double-encoded. */}
            {from && <input type="hidden" name="from" value={from} />}
            <Link
              href={back}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {t('closeConfirmNo')}
            </Link>
            <Button type="submit" size="sm">
              {t('closeConfirmYes')}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
