import { getTranslations } from 'next-intl/server';
import { TP1_CATEGORY_KEYS } from '@/db/schema';
import { Button, Card, inputCls } from '@/components/ui';
import type { Tp1Row } from '@/core/tax-relief';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Tp1Action = (formData: FormData) => void | Promise<void>;

/**
 * Shared LHDN TP1 declaration form (Standardize-TP1, item 0cde61f3). ONE sectioned per-category form —
 * the SAME layout, fields, help text, validation copy, and Save/Submit affordances — rendered on BOTH the
 * employee Self-Service screen (/me/tax-relief) and the HR admin-on-behalf screen
 * (/payroll/transactions/tp1). Extracting it here is what guarantees the two surfaces stay byte-identical:
 * a wording or field change lands in one place. The only per-page differences are injected as props:
 * the Save/Submit server actions and any extra hidden inputs (e.g. the admin screen's employmentId).
 *
 * The server always recomputes the annual total from the categories (see core/tax-relief resolveInput);
 * the client never sends the total — this form only carries `assessmentYear`, the `cat_<key>` amounts,
 * `remarks`, and the caller's hidden fields.
 */
export async function Tp1DeclarationForm({
  selectedYear,
  latest,
  readOnly,
  saveDraftAction,
  submitAction,
  hiddenFields,
}: {
  selectedYear: number;
  latest: Tp1Row | null;
  readOnly: boolean;
  saveDraftAction: Tp1Action;
  submitAction: Tp1Action;
  /** Extra hidden inputs rendered inside the editable form (e.g. { employmentId } for the HR screen). */
  hiddenFields?: Record<string, string>;
}) {
  const t = await getTranslations('taxRelief');
  const isSubmitted = latest?.status === 'submitted';

  // Prefill each category input from the latest row's breakdown; legacy scalar-only rows have no
  // breakdown, so those categories start empty and can be re-entered per section.
  const cats = latest?.categories ?? null;
  const catValue = (key: string) => {
    const v = cats ? (cats as Record<string, unknown>)[key] : undefined;
    return v == null || v === '' ? '' : Number(v).toFixed(2);
  };
  const remarksValue = cats?.remarks ?? '';
  const extraHidden = Object.entries(hiddenFields ?? {});

  return (
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
          {/* One editable sectioned form reused by Save-draft / Submit; when a submitted row exists the
              fields prefill from it and Submit records a correction. */}
          <form id="tp1-form" className="space-y-5">
            <input type="hidden" name="assessmentYear" value={selectedYear} />
            {extraHidden.map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}

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
                <Button type="submit" variant="secondary" formAction={saveDraftAction} form="tp1-form">
                  {t('saveDraft')}
                </Button>
                {/* A correction is just another submitted row; latest-submitted wins. */}
                <Button type="submit" formAction={submitAction} form="tp1-form">
                  {t('submitCorrection')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="secondary" formAction={saveDraftAction} form="tp1-form">
                {t('saveDraft')}
              </Button>
              <Button type="submit" formAction={submitAction} form="tp1-form">
                {t('submit')}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
