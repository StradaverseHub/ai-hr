import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listReports, submissionDueFor } from '@/core/reporting';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Payroll → Statutory Forms (feedback 956cec85).
 *
 * WHAT THIS SCREEN IS, AND DELIBERATELY IS NOT. The forms themselves were ALREADY BUILT and live:
 * localization/my/reports.ts registers EPF (KWSP), SOCSO + EIS (PERKESO), CP39/PCB (LHDN) and
 * Form E/CP8D, each already listing employee name, IC, agency number, gross, the employee/employer
 * split and totals — and already flagging employees MISSING an agency number rather than quietly
 * leaving them off a submission. The EA form exists too, with its own screen, an employee PDF and an
 * amendment layer. The reporter asked for "a new submenu called Statutory Form ... a centralized
 * location", and that is the part that did not exist: the forms sat mixed in with general reports,
 * which is almost certainly why they read as missing.
 *
 * So this page GENERATES NOTHING. It is a directory: it asks the pack which of its reports are actual
 * submissions, says where each is filed and by when, and links to the existing preview. Writing a
 * second generator for the same statutory figures is the duplication 241817ef spent two rounds undoing.
 *
 * The deadline is the one genuinely new fact, and it comes from the reporter's own answer to the
 * question this item was parked on: EPF via i-Akaun, SOCSO+EIS together via PERKESO ASSIST, PCB via
 * LHDN e-PCB/e-CP39, all by the 15th of the following month. Where a deadline was never stated — the
 * annual Form E — the screen says so instead of printing a date somebody might file against.
 */
const STATUS_CLS: Record<string, string> = {
  overdue: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  due_soon: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  upcoming: 'bg-muted text-muted-foreground',
  unknown: 'bg-muted text-muted-foreground',
};

/** Default to the month just ENDED — the one whose submission is actually open. */
function previousMonth(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export default async function StatutoryFormsPage({
  searchParams,
}: {
  searchParams: Promise<{ companyId?: string; periodKey?: string; error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  const sp = await searchParams;
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt);
  const companyId = sp.companyId || companies[0]?.id || '';
  const today = todayInKualaLumpur();
  const periodKey = /^\d{4}-\d{2}$/.test(sp.periodKey ?? '') ? sp.periodKey! : previousMonth(today);
  const year = periodKey.slice(0, 4);

  // Only the pack entries that ARE submissions. The monthly contributions overview has no `submission`
  // and is correctly absent here: it is an internal reconciliation view, not a form anybody files.
  const all = companyId ? await listReports(s, companyId) : [];
  const submissions = all.filter((r) => r.submission != null);
  const monthly = submissions.filter((r) => r.periodKind === 'month');
  const annual = submissions.filter((r) => r.periodKind === 'year');

  const previewHref = (reportId: string, period: string) =>
    `/payroll/reports?companyId=${companyId}&reportId=${reportId}&periodKey=${period}`;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-4">
          <Field label={t('company')}>
            <select name="companyId" defaultValue={companyId} className={inputCls}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('period')}>
            <input type="month" name="periodKey" defaultValue={periodKey} className={inputCls} />
          </Field>
          <button className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent">
            {t('show')}
          </button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('monthlyTitle', { period: periodKey })} count={monthly.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('monthlyHint')}</p>
        {monthly.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noneForCountry')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colForm')}</th>
                  <th className="px-4 py-2 font-medium">{t('colAgency')}</th>
                  <th className="px-4 py-2 font-medium">{t('colChannel')}</th>
                  <th className="px-4 py-2 font-medium">{t('colDueBy')}</th>
                  <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {monthly.map((r) => {
                  const due = submissionDueFor(periodKey, r.submission!.dueDayOfNextMonth, today);
                  return (
                    <tr key={r.id} className="hover:bg-muted/40">
                      <td className="px-4 py-2.5 font-medium">{r.label}</td>
                      <td className="px-4 py-2.5">{r.submission!.agency}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{r.submission!.channel}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{due.dueBy ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLS[due.status]}`}>
                          {t(`status_${due.status}` as 'status_upcoming')}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link href={previewHref(r.id, periodKey)} className="text-primary hover:underline">
                          {t('openForm')}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('annualTitle', { year })} count={annual.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('annualHint')}</p>
        <ul className="divide-y divide-border">
          {annual.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <span className="font-medium">{r.label}</span>
                <span className="ms-2 text-xs text-muted-foreground">
                  {r.submission!.agency} · {r.submission!.channel}
                </span>
                {/* Stated, not guessed: nobody told us the annual deadline. */}
                {r.submission!.dueDayOfNextMonth == null && (
                  <span className="ms-2 text-xs text-muted-foreground">· {t('deadlineNotConfigured')}</span>
                )}
              </div>
              <Link href={previewHref(r.id, year)} className="text-primary hover:underline">
                {t('openForm')}
              </Link>
            </li>
          ))}
          {/* The EA form is per EMPLOYEE, so it has no single "open" link — it is reached from the
              employee list on Reports, which already carries a per-person EA link per year. */}
          <li className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3 text-sm">
            <div>
              <span className="font-medium">{t('eaFormLabel')}</span>
              <span className="ms-2 text-xs text-muted-foreground">{t('eaFormHint')}</span>
            </div>
            <Link href={`/payroll/reports?companyId=${companyId}&periodKey=${year}`} className="text-primary hover:underline">
              {t('openEmployeeList')}
            </Link>
          </li>
        </ul>
      </Card>
    </div>
  );
}
