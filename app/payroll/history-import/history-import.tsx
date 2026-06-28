'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { DownloadTemplate } from '@/components/download-template';
import { payrollHistoryTemplate } from '@/lib/import-template';
import {
  PAYROLL_HISTORY_COLUMNS,
  type HistoryImportPreview,
  type HistoryImportResult,
} from '@/lib/payroll-history-import-schema';
import { validateHistoryImportAction, commitHistoryImportAction } from './actions';

const SAMPLE = `email,period,basic_salary,gross_pay,epf_employee,epf_employer,socso_employee,socso_employer,eis_employee,eis_employer,pcb,net_pay,allowance,overtime_pay,bonus,employer_cost,total_deductions
nadia@demo.test,2024-06,5200,5600,616.00,728.00,24.75,86.65,9.90,9.90,180.00,4769.35,400,0,0,6424.55,830.65
ravi@demo.test,2024-06,9800,10400,1078.00,1274.00,24.75,86.65,9.90,9.90,520.00,8767.35,600,0,0,11770.55,1632.65`;

type Phase = 'idle' | 'previewed' | 'done';

export function HistoryImport({
  companies,
  defaultCompanyId,
}: {
  companies: { id: string; name: string }[];
  defaultCompanyId: string;
}) {
  const t = useTranslations('payroll.historyImport');
  const router = useRouter();
  const [companyId, setCompanyId] = useState(defaultCompanyId);
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<HistoryImportPreview | null>(null);
  const [result, setResult] = useState<HistoryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [pending, startTransition] = useTransition();

  // Any edit invalidates a stale preview/result — force a fresh validate before importing.
  const reset = () => {
    setPreview(null);
    setResult(null);
    setPhase('idle');
    setError(null);
  };

  const validate = () =>
    startTransition(async () => {
      setError(null);
      try {
        const p = await validateHistoryImportAction(csv, companyId);
        setPreview(p);
        setResult(null);
        setPhase('previewed');
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const commit = () =>
    startTransition(async () => {
      setError(null);
      try {
        const r = await commitHistoryImportAction(csv, companyId);
        setResult(r);
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const company = companies.find((c) => c.id === companyId);

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[260px_1fr]">
          <Field label={t('targetCompany')}>
            <select
              className={inputCls}
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                reset();
              }}
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('csvData')}>
            <textarea
              className={`${inputCls} h-44 resize-y font-mono text-xs leading-relaxed`}
              placeholder={t('csvPlaceholder')}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                reset();
              }}
              spellCheck={false}
            />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={validate} disabled={pending || !csv.trim()}>
            {pending && phase !== 'done' ? t('validating') : t('validate')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setCsv(SAMPLE);
              reset();
            }}
            disabled={pending}
          >
            {t('loadSample')}
          </Button>
          <DownloadTemplate spec={payrollHistoryTemplate} />
          <span className="ml-auto text-xs text-muted-foreground">
            {t('resolveHint', { company: company?.name ?? t('theCompany') })}
          </span>
        </div>

        <details className="mt-4 border-t border-border pt-3 text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">
            {t('columnReference')}
          </summary>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 font-medium text-foreground">{t('required')}</div>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
                {PAYROLL_HISTORY_COLUMNS.required.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 font-medium text-foreground">{t('optional')}</div>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
                {PAYROLL_HISTORY_COLUMNS.optional.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-2 text-muted-foreground">{t('emptyMonthHint')}</p>
          {/* #31 — document the allowance/OT/bonus split expectation + the EA-overwrite fix path. */}
          <p className="mt-2 text-muted-foreground">{t('eaSplitHint')}</p>
          {/* #30 — document the CP38 column so migrated months stay CP39-complete. */}
          <p className="mt-2 text-muted-foreground">{t('cp38Hint')}</p>
        </details>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {result && (
        <Card className="overflow-hidden border-emerald-200 dark:border-emerald-500/30">
          <div className="border-b border-border bg-emerald-50/60 px-4 py-3 dark:bg-emerald-500/10">
            <h2 className="text-sm font-semibold">
              {t('importedCount', { count: result.imported })}
              {result.skipped > 0 && ` · ${t('skippedCount', { count: result.skipped })}`}
              {result.failed.length > 0 && ` · ${t('failedCount', { count: result.failed.length })}`}
            </h2>
          </div>
          {result.failed.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {result.failed.map((f) => (
                <li key={`${f.rowNum}-${f.period}`} className="px-4 py-2">
                  <span className="text-muted-foreground">{t('row', { num: f.rowNum })}</span> ·{' '}
                  {f.email} · {f.period} —{' '}
                  <span className="text-red-600 dark:text-red-400">{f.message}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3 px-4 py-3 text-sm">
            <Link href="/payroll" className="text-primary hover:underline">
              {t('viewPayroll')}
            </Link>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setCsv('');
                reset();
              }}
            >
              {t('importAnother')}
            </button>
          </div>
        </Card>
      )}

      {preview && !result && <PreviewTable preview={preview} onImport={commit} busy={pending} />}
    </div>
  );
}

function PreviewTable({
  preview,
  onImport,
  busy,
}: {
  preview: HistoryImportPreview;
  onImport: () => void;
  busy: boolean;
}) {
  const t = useTranslations('payroll.historyImport');
  const errorCount = preview.total - preview.validCount - preview.skippedCount;
  // #31 — elevate the EA Part-B split warning (the importer prefixes it with "⚠") above the per-row note so
  // a migrator can't miss that the EA itemisation will collapse to "basic". Count the affected ROW numbers.
  const splitWarnRows = preview.rows.filter((r) => r.warnings.some((w) => w.startsWith('⚠'))).map((r) => r.rowNum);
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">
          {t('preview')} ·{' '}
          <span className="text-emerald-600 dark:text-emerald-400">
            {t('readyCount', { count: preview.validCount })}
          </span>
          {preview.skippedCount > 0 && (
            <>
              {' · '}
              <span className="text-amber-600 dark:text-amber-400">
                {t('skippedCount', { count: preview.skippedCount })}
              </span>
            </>
          )}
          {errorCount > 0 && (
            <>
              {' · '}
              <span className="text-red-600 dark:text-red-400">
                {t('withErrorsCount', { count: errorCount })}
              </span>
            </>
          )}
        </h2>
        <Button onClick={onImport} disabled={busy || preview.validCount === 0} size="sm">
          {busy ? t('importing') : t('importValid', { count: preview.validCount })}
        </Button>
      </div>

      {preview.missingColumns.length > 0 && (
        <div className="border-b border-border bg-red-50/60 px-4 py-2.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-400">
          {t('missingColumns', { count: preview.missingColumns.length })}{' '}
          {preview.missingColumns.map((c) => (
            <code key={c} className="mx-0.5">
              {c}
            </code>
          ))}
        </div>
      )}

      {/* #31 — prominent EA Part-B split banner: gross≠basic rows with no allowance/OT/bonus split will
          itemise entirely under "basic". Surfaced here (not buried in the per-row note) with the fix path. */}
      {splitWarnRows.length > 0 && (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
          <span className="font-semibold">⚠ {t('eaSplitWarningTitle')}</span>{' '}
          {t('eaSplitWarningBody', { rows: splitWarnRows.join(', '), count: splitWarnRows.length })}
        </div>
      )}

      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="w-12 px-4 py-2 font-medium">#</th>
            <th className="px-4 py-2 font-medium">{t('colEmail')}</th>
            <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
            <th className="px-4 py-2 font-medium">{t('colResult')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {preview.rows.map((r) => (
            <tr
              key={`${r.rowNum}`}
              className={r.ok ? '' : r.skipped ? 'bg-amber-50/40 dark:bg-amber-500/5' : 'bg-red-50/40 dark:bg-red-500/5'}
            >
              <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.rowNum}</td>
              <td className="px-4 py-2 font-medium">{r.email || <span className="text-muted-foreground">—</span>}</td>
              <td className="px-4 py-2 text-muted-foreground">{r.period || '—'}</td>
              <td className="px-4 py-2">
                {r.ok ? (
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    {t('ready')}
                    {r.warnings.length > 0 && (
                      <span className="text-amber-600 dark:text-amber-400">· {r.warnings.join('; ')}</span>
                    )}
                  </span>
                ) : r.skipped ? (
                  <span className="text-amber-600 dark:text-amber-400">{t('skipped')}{r.warnings.length > 0 && ` · ${r.warnings.join('; ')}`}</span>
                ) : (
                  <span className="text-red-600 dark:text-red-400">{r.errors.join('; ')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
