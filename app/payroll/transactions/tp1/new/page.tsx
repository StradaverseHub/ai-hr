import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
import { listTp1DeclarationsForPersonYear } from '@/core/tax-relief';
import { Button, Card, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * 27605faa rev 2 — ADD NEW TP1, STEP ONE: which year and which month.
 *
 * WHY THIS SCREEN EXISTS AT ALL, in the reporter's own words: "The Assessment Year and Deduction Month
 * selection is currently displayed on the TP1 viewing page. This is not the correct workflow because
 * these fields are relevant when creating a new TP1 transaction, not when viewing existing transaction
 * history."
 *
 * They are right, and r324 got it wrong in a smaller way than the first report suggested: the month was
 * never fixed to the current month — any month was reachable — but the CONTROL for choosing it sat beside
 * the Add button on the history screen, which is the viewing screen. So the fix is not a new capability;
 * it is moving one control to where the decision belongs.
 *
 * ⚠️ IT CREATES NOTHING. This screen resolves a year and a month and then REDIRECTS to the declaration
 * form that already exists at tp1/[year]/[month]. A second write path to tp1_relief is the one thing this
 * must not become — the form there, and only it, saves a declaration.
 *
 * ⚠️ A YEAR AND MONTH THAT ALREADY HAS A RECORD OPENS THAT RECORD. The destination is the SAME href the
 * history list links each row to, so "Add" on an existing month lands on the existing declaration rather
 * than starting a second one. That is what makes "Add can never quietly overwrite" true rather than a
 * promise — and it is a property of the destination, not of a check performed here.
 *
 * SCOPED LIKE THE SCREEN IT RETURNS TO. `scopedAdmin` plus a re-guard of the employment against the
 * caller's own list: an employmentId in the url is a suggestion, and an out-of-scope or unknown one is a
 * 404 rather than a differently-worded refusal.
 */
const YEAR_MIN = 2000;
const YEAR_MAX = 2100;

export default async function Tp1NewDeclarationPage({
  searchParams,
}: {
  searchParams: Promise<{ employmentId?: string; year?: string; month?: string }>;
}) {
  await requireAdmin();
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payroll.transactions');
  const sp = await searchParams;

  const employees = await listEmployees(s, scopeIds);
  const selected = employees.find((e) => e.employmentId === sp.employmentId);
  // No employee, or one this caller may not see: the same bare 404, so the url cannot enumerate either.
  if (!selected) notFound();

  const todayIso = todayInKualaLumpur();
  const currentYear = Number(todayIso.slice(0, 4));
  const currentMonth = Number(todayIso.slice(5, 7));

  const askedYear = Number(sp.year ?? '');
  const year =
    Number.isInteger(askedYear) && askedYear >= YEAR_MIN && askedYear <= YEAR_MAX ? askedYear : currentYear;
  const askedMonth = Number(sp.month ?? '');
  const month = Number.isInteger(askedMonth) && askedMonth >= 1 && askedMonth <= 12 ? askedMonth : currentMonth;

  // STEP TWO is the declaration form. Both values already validated above, so this cannot build a url
  // pointing at month 13 or year 3000 however the query arrived.
  if (sp.year && sp.month) {
    redirect(
      `/payroll/transactions/tp1/${year}/${month}?employmentId=${encodeURIComponent(selected.employmentId)}`,
    );
  }

  const monthFmt = new Intl.DateTimeFormat(await getLocale(), { month: 'long' });
  const months = Array.from({ length: 12 }, (_, i) => ({
    value: i + 1,
    label: monthFmt.format(new Date(Date.UTC(2000, i, 1))),
  }));
  // The years a reader plausibly keys: this one, the two behind it, and next year for an early filing.
  const years = [currentYear + 1, currentYear, currentYear - 1, currentYear - 2];

  const backHref = `/payroll/transactions/tp1?employmentId=${encodeURIComponent(selected.employmentId)}&year=${year}`;

  return (
    <div className={pageWideCls}>
      <PageHeader
        back={{ href: backHref, label: t('tp1.title') }}
        title={t('tp1.addButton')}
        description={
          selected.employeeCode ? `${selected.employeeCode} · ${selected.name}` : selected.name
        }
      />

      <Card className="overflow-hidden">
        <SectionHeader title={t('tp1.addStepTitle')} subtitle={t('tp1.addStepHint')} />
        {/* A plain GET form: submitting comes back HERE with year and month set, and the redirect above
            then opens the declaration. No action, no write, nothing to roll back. */}
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-4">
          <input type="hidden" name="employmentId" value={selected.employmentId} />
          <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('tp1.assessmentYear')}
            <select name="year" defaultValue={String(year)} className={inputCls}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('tp1.addMonthLabel')}
            <select name="month" defaultValue={String(month)} className={inputCls}>
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" size="sm">
            {t('tp1.addStepContinue')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
