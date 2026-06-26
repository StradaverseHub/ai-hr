import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { getTp1, listTp1Years } from '@/core/tax-relief';
import { Button, Card, ErrorBanner, PageHeader, inputCls } from '@/components/ui';
import { mySaveTp1Draft, mySubmitTp1 } from '../actions';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Self Personal Tax Relief — LHDN TP1 yearly self-service (ADR-0050, #1.1.3). The employee declares ONE
 * annual TP1 amount per assessment year; the latest submitted feeds monthly PCB. A submitted year is
 * read-only with a "Submit correction" affordance (a correction is just a new submitted row).
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
  const years = await listTp1Years(s);
  // Year options: every year the employee already has a row for, plus the current assessment year.
  const yearOptions = Array.from(new Set([currentYear, ...years])).sort((a, b) => b - a);
  const selectedYear =
    spYear && /^\d{4}$/.test(spYear) ? Number(spYear) : currentYear;

  const latest = await getTp1(s, { assessmentYear: selectedYear });
  const isSubmitted = latest?.status === 'submitted';
  const isHistorical = selectedYear < currentYear;
  // A past assessment year is read-only (historical view); the current year is editable.
  const readOnly = isHistorical;
  const amountValue = latest ? latest.tp1Amount.toFixed(2) : '';

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link href="/me" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
        ← {t('backToWorkspace')}
      </Link>
      <PageHeader title={t('title')} description={t('intro')} />

      <ErrorBanner message={error} />

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
          <div className="rounded-md border border-border bg-muted/40 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">{t('amountLabel')}</span>
              <span className="text-lg font-semibold tabular-nums">{rm(latest?.tp1Amount ?? 0)}</span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {latest ? t(isSubmitted ? 'historicalSubmitted' : 'historicalDraft') : t('historicalNone')}
            </p>
          </div>
        ) : (
          <form className="space-y-4">
            <input type="hidden" name="assessmentYear" value={selectedYear} />
            <label className="block text-sm">
              <span className="mb-1 block font-medium">{t('amountLabel')}</span>
              <input
                type="number"
                name="tp1Amount"
                min="0"
                step="0.01"
                defaultValue={amountValue}
                placeholder="0.00"
                className={inputCls}
                readOnly={isSubmitted}
              />
            </label>

            {isSubmitted ? (
              <div className="space-y-3">
                <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
                  {t('submittedNotice')}
                </p>
                {/* A correction is just another submitted row; latest-submitted wins. */}
                <details className="rounded-md border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium">{t('submitCorrection')}</summary>
                  <div className="mt-3 space-y-3">
                    <label className="block text-sm">
                      <span className="mb-1 block font-medium">{t('correctedAmountLabel')}</span>
                      <input
                        type="number"
                        name="tp1Amount"
                        min="0"
                        step="0.01"
                        defaultValue={amountValue}
                        placeholder="0.00"
                        className={inputCls}
                        form="tp1-correction"
                      />
                    </label>
                    <Button type="submit" formAction={mySubmitTp1} form="tp1-correction">
                      {t('submitCorrection')}
                    </Button>
                  </div>
                </details>
                <form id="tp1-correction" className="hidden">
                  <input type="hidden" name="assessmentYear" value={selectedYear} />
                </form>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="secondary" formAction={mySaveTp1Draft}>
                  {t('saveDraft')}
                </Button>
                <Button type="submit" formAction={mySubmitTp1}>
                  {t('submit')}
                </Button>
              </div>
            )}
          </form>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">{t('historyNote')}</p>
    </div>
  );
}
