import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { getTp1, listTp1Years } from '@/core/tax-relief';
import { myEmployment } from '@/core/read';
import { TP1_CATEGORY_KEYS } from '@/db/schema';
import { Button, Card, ErrorBanner, PageHeader, inputCls } from '@/components/ui';
import { mySaveTp1Draft, mySubmitTp1 } from '../actions';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Self Personal Tax Relief — LHDN TP1 yearly self-service (ADR-0050, #1.1.3; a2f1fa24).
 *
 * The declaration is a STRUCTURED, sectioned form mirroring the paper LHDN TP1: a read-only employee
 * header, then one number input per relief category (individual, spouse, children, parent,
 * medical/insurance, lifestyle, education, other) and a remarks note. The server sums the categories into
 * the authoritative annual total that feeds monthly PCB — the client never sends the total. A submitted
 * year is read-only with a "Submit correction" affordance (a correction is just a new submitted row); a
 * past assessment year is a read-only historical view.
 */
export default async function TaxReliefPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; error?: string }>;
}) {
  const { year: spYear, error } = await searchParams;
  const s = await getSession();
  const t = await getTranslations('taxRelief');

  const currentYear = new Date().getFullYear();
  const [years, me] = await Promise.all([listTp1Years(s), myEmployment(s)]);
  // Year options: every year the employee already has a row for, plus the current assessment year.
  const yearOptions = Array.from(new Set([currentYear, ...years])).sort((a, b) => b - a);
  const selectedYear = spYear && /^\d{4}$/.test(spYear) ? Number(spYear) : currentYear;

  const latest = await getTp1(s, { assessmentYear: selectedYear });
  const isSubmitted = latest?.status === 'submitted';
  const isHistorical = selectedYear < currentYear;
  // A past assessment year is read-only (historical view); the current year is editable.
  const readOnly = isHistorical;

  // Prefill each category input from the latest row's breakdown; legacy scalar-only rows have no
  // breakdown, so those categories start empty and the employee can re-enter them per section.
  const cats = latest?.categories ?? null;
  const catValue = (key: string) => {
    const v = cats ? (cats as Record<string, unknown>)[key] : undefined;
    return v == null || v === '' ? '' : Number(v).toFixed(2);
  };
  const remarksValue = cats?.remarks ?? '';

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link href="/me" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
        ← {t('backToWorkspace')}
      </Link>
      <PageHeader title={t('title')} description={t('intro')} />

      <ErrorBanner message={error} />

      {/* Employee header — read-only, mirrors the top of the paper TP1 form. */}
      {me && (
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{t('employeeSection')}</h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t('employeeName')}</dt>
              <dd className="text-sm font-medium">{me.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('employeeNumber')}</dt>
              <dd className="text-sm font-medium tabular-nums">{me.employeeCode ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('company')}</dt>
              <dd className="text-sm font-medium">{me.company}</dd>
            </div>
          </dl>
        </Card>
      )}

      {/* Year selector */}
      <Card className="p-5">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('yearLabel')}</span>
            <select name="year" defaultValue={String(selectedYear)} className={inputCls}>
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary">
            {t('viewYear')}
          </Button>
        </form>
      </Card>

      {/* Declaration */}
      <Card className="space-y-4 p-5">
        <div>
          <h2 className="text-sm font-semibold">{t('declarationHeading', { year: String(selectedYear) })}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('amountHelp')}</p>
        </div>

        {readOnly ? (
          <div className="space-y-3 rounded-md border border-border bg-muted/40 p-4">
            {latest?.categories
              ? TP1_CATEGORY_KEYS.map((key) => (
                  <div key={key} className="flex items-baseline justify-between text-sm">
                    <span className="text-muted-foreground">{t(`categories.${key}.label`)}</span>
                    <span className="tabular-nums">
                      {rm((latest.categories as Record<string, unknown>)[key] ?? 0)}
                    </span>
                  </div>
                ))
              : null}
            <div className="flex items-baseline justify-between border-t border-border pt-3">
              <span className="text-sm font-medium">{t('totalLabel')}</span>
              <span className="text-lg font-semibold tabular-nums">{rm(latest?.tp1Amount ?? 0)}</span>
            </div>
            {latest?.categories?.remarks ? (
              <p className="text-xs text-muted-foreground">
                {t('remarksLabel')}: {latest.categories.remarks}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {latest ? t(isSubmitted ? 'historicalSubmitted' : 'historicalDraft') : t('historicalNone')}
            </p>
          </div>
        ) : (
          <>
            {/* One editable sectioned form (id) reused by Save-draft / Submit; when a submitted row exists
                the fields prefill from it and Submit records a correction. */}
            <form id="tp1-form" className="space-y-5">
              <input type="hidden" name="assessmentYear" value={selectedYear} />

              <div className="space-y-4">
                {TP1_CATEGORY_KEYS.map((key) => (
                  <label key={key} className="block text-sm">
                    <span className="mb-1 block font-medium">{t(`categories.${key}.label`)}</span>
                    <span className="mb-1 block text-xs text-muted-foreground">{t(`categories.${key}.help`)}</span>
                    <input
                      type="number"
                      name={`cat_${key}`}
                      min="0"
                      step="0.01"
                      defaultValue={catValue(key)}
                      placeholder="0.00"
                      className={inputCls}
                    />
                  </label>
                ))}
              </div>

              <label className="block text-sm">
                <span className="mb-1 block font-medium">{t('remarksLabel')}</span>
                <textarea
                  name="remarks"
                  rows={3}
                  defaultValue={remarksValue ?? ''}
                  placeholder={t('remarksPlaceholder')}
                  className={inputCls}
                />
              </label>

              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t('totalNote')}
              </p>
            </form>

            {isSubmitted ? (
              <div className="space-y-3">
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
                  {t('submittedNotice')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" variant="secondary" formAction={mySaveTp1Draft} form="tp1-form">
                    {t('saveDraft')}
                  </Button>
                  {/* A correction is just another submitted row; latest-submitted wins. */}
                  <Button type="submit" formAction={mySubmitTp1} form="tp1-form">
                    {t('submitCorrection')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="secondary" formAction={mySaveTp1Draft} form="tp1-form">
                  {t('saveDraft')}
                </Button>
                <Button type="submit" formAction={mySubmitTp1} form="tp1-form">
                  {t('submit')}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">{t('historyNote')}</p>
    </div>
  );
}
