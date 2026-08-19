/**
 * Feedback 6b4ca488 part 2 — Statutory Explanation, the Individual Payslip's door onto it.
 *
 * ONE SCREEN, TWO DOORS, the shape 45df860a settled for the PCB working. This route answers "explain THE
 * SLIP I AM LOOKING AT", addressed by `?payslipId=`, and is what the Individual Payslip links to.
 * Transaction View's `?tab=statutory` is the other door: it lets a reader pick company / employee / year
 * / month / cycle and lands on the same `StatutoryDetailView` component. Neither door owns the display.
 *
 * THE SCOPE GUARD IS THE READ, NOT A COMPARISON. `payslipForReview` is fenced on the caller's authorised
 * `companyIds` and fails CLOSED on an empty scope, so a tampered `payslipId` naming somebody else's
 * payslip is indistinguishable from a payslip that does not exist. The ESS release gate
 * (`payslipDetail`) is neither used nor widened here — this is the admin review read, exactly as
 * pcb-detail and Individual Payslip use it.
 *
 * READ-ONLY END TO END. No row is inserted, updated, deleted or recomputed. Every figure comes off the
 * payslip's own `statutory` blob through `explainStatutory`, which takes no SessionContext and therefore
 * cannot reach today's EPF table, today's PERKESO schedule or the employee's current statutory flags.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { payslipForReview } from '@/core/payroll-view';
import { explainStatutory } from '@/core/statutory-explain';
import { Card, PageHeader } from '@/components/ui';
import { StatutoryDetailView } from './statutory-detail-view';

/** The stored `YYYY-MM` as a month name in the reader's own language — the same `Intl` idiom Individual
 *  Payslip and pcb-detail use, deliberately, so one payroll month is named identically on all three. */
function monthYear(payPeriod: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(payPeriod ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return payPeriod ?? '';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  );
}

export default async function StatutoryDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ payslipId?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.statutoryDetail');
  const locale = await getLocale();
  const sp = await searchParams;

  // SHAPE-CHECK BEFORE THE QUERY, exactly as pcb-detail does. `payslip.id` is a uuid column, so a mangled
  // id out of a shared link reaches Postgres as `invalid input syntax for type uuid` and — with no
  // try/catch here and no app/error.tsx in the tree — becomes an HTTP 500 rather than the "not found"
  // card this page's own header promises. An unparseable id is treated as absent, which is truthful.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const payslipId = typeof sp.payslipId === 'string' && UUID_RE.test(sp.payslipId) ? sp.payslipId : undefined;
  const row = payslipId ? await payslipForReview(s, { companyIds: scopeIds, payslipId }) : null;
  const explanation = row ? explainStatutory(row.statutory, row.runType) : null;

  const backHref = row
    ? `/payroll/individual-payslip?${new URLSearchParams({
        employmentId: row.employmentId,
        payslipId: row.id,
      }).toString()}`
    : '/payroll/transaction-view?tab=statutory';

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
          <Link
            href="/payroll/transaction-view?tab=statutory"
            className="mt-3 inline-block text-sm font-medium text-primary underline"
          >
            {t('backToTransactionView')}
          </Link>
        </Card>
      )}

      {row && explanation && (
        <>
          {/* The Excel export of this explanation. A link, not a form: the route re-guards the payslip id
              through the same fence this page did, so a hand-edited download link can no more cross the
              company boundary than a hand-edited page link can. */}
          <div className="flex justify-end">
            <a
              href={`/payroll/statutory-detail/export?payslipId=${encodeURIComponent(row.id)}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              {t('exportExcel')}
            </a>
          </div>
          <StatutoryDetailView
            ctx={{
              payslipId: row.id,
              employeeCode: row.employeeCode,
              employeeName: row.employeeName,
              company: row.company,
              periodLabel: monthYear(row.payPeriod, locale),
              payPeriod: row.payPeriod,
              runType: row.runType,
              runSeq: row.runSeq,
              currency: row.currency ?? null,
            }}
            explanation={explanation}
          />
        </>
      )}
    </div>
  );
}
