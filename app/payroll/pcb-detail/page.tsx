/**
 * Feedback 45df860a — PCB / MTD Calculation Detail.
 *
 * ONE SCREEN, TWO DOORS. Transaction View → Transaction Detail and the Individual Payslip both link the
 * PCB amount here with `?payslipId=`. That is the reporter's requirement stated as an architecture:
 * "This avoids having two different PCB calculation engines or two different calculation displays."
 *
 * THE SCOPE GUARD IS THE READ, NOT A COMPARISON. `payslipForReview` is fenced on the caller's authorised
 * `companyIds` and fails CLOSED on an empty scope, so a tampered `payslipId` naming somebody else's
 * payslip is indistinguishable from a payslip that does not exist — the same posture the Individual
 * Payslip screen's `?params` guard has. No second, weaker read exists for this screen: it reads the
 * admin review row exactly as the payslip screen does, and the ESS release gate (`payslipDetail`) is
 * neither used nor widened here.
 *
 * READ-ONLY END TO END. No row is inserted, updated, deleted or recomputed. The tax figures come off the
 * payslip's own `pcbMeta` stamp via `explainPcb` — this screen cannot compute PCB and must never learn
 * how, because a second calculation is exactly how a detail screen ends up contradicting the payslip.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { currentPcbReliefs, payslipForReview } from '@/core/payroll-view';
import { explainPcb } from '@/core/pcb-explain';
import { payslipProvenance } from '@/core/payslip-recompute';
import { Card, PageHeader } from '@/components/ui';
import { PcbDetailView } from './pcb-detail-view';

/** The stored `YYYY-MM` as a month name in the reader's own language — the same `Intl` idiom the
 *  Individual Payslip uses, deliberately, so one payroll month is named identically on both screens. */
function monthYear(payPeriod: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(payPeriod ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return payPeriod ?? '';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  );
}

export default async function PcbDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ payslipId?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.pcbDetail');
  const locale = await getLocale();
  const sp = await searchParams;

  const payslipId = typeof sp.payslipId === 'string' && sp.payslipId.length > 0 ? sp.payslipId : undefined;
  const row = payslipId ? await payslipForReview(s, { companyIds: scopeIds, payslipId }) : null;

  // The relief FALLBACK, consulted ONLY for a payslip calculated before the relief working was recorded
  // on the slip itself. `explainPcb` reports which of the two it used and the screen says so — a silent
  // fallback would explain a closed month with a relief position that did not exist when it ran.
  const fallbackReliefs = row
    ? await currentPcbReliefs(s, {
        companyIds: scopeIds,
        employmentId: row.employmentId,
        asOf: `${row.payPeriod}-28`,
      })
    : null;
  const explanation = row ? explainPcb(row.statutory, fallbackReliefs) : null;
  const prov = row ? payslipProvenance(row.statutory) : null;

  const backHref = row
    ? `/payroll/individual-payslip?${new URLSearchParams({
        employmentId: row.employmentId,
        payslipId: row.id,
      }).toString()}`
    : '/payroll/transaction-view';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
        back={{ href: backHref, label: row ? t('backToPayslip') : t('backToTransactionView') }}
      />

      {!row && (
        <Card className="p-6">
          <p className="text-sm text-muted-foreground">{payslipId ? t('notFound') : t('noSelection')}</p>
          <Link href="/payroll/transaction-view" className="mt-3 inline-block text-sm font-medium text-primary underline">
            {t('backToTransactionView')}
          </Link>
        </Card>
      )}

      {row && explanation && (
        <PcbDetailView
          ctx={{
            employeeCode: row.employeeCode,
            employeeName: row.employeeName,
            company: row.company,
            periodLabel: monthYear(row.payPeriod, locale),
            payPeriod: row.payPeriod,
            runType: row.runType,
            runSeq: row.runSeq,
            currency: row.currency ?? null,
            rulesetVersion: prov?.rulesetVersion ?? null,
          }}
          explanation={explanation}
        />
      )}
    </div>
  );
}
