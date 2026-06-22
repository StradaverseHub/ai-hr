'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, inputCls } from '@/components/ui';
import type { ComponentImportResult } from '@/core/pay-components';
import { commitComponentImportAction, dryRunComponentImportAction } from './import-actions';

const SAMPLE = `employee,component,amount,notes
aisyah@demo.test,HOUSING,800,Fixed housing
meiling@demo.test,OVERTIME,450,
arjun@demo.test,DEDUCTION,120,Staff loan`;

const rm = (n: number | null) =>
  n == null ? '—' : `RM ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Bulk pay-component CSV import for a draft batch (ADR-0035 1D, #12). Dry-run preview → commit. */
export function ComponentImport({ batchId }: { batchId: string }) {
  const t = useTranslations('payroll.batch.componentImport');
  const router = useRouter();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ComponentImportResult | null>(null);
  const [committed, setCommitted] = useState<ComponentImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reset = () => {
    setPreview(null);
    setCommitted(null);
    setError(null);
  };
  const dryRun = () =>
    start(async () => {
      setError(null);
      try {
        setPreview(await dryRunComponentImportAction(batchId, csv));
        setCommitted(null);
      } catch (e) {
        setError((e as Error).message);
      }
    });
  const commit = () =>
    start(async () => {
      setError(null);
      try {
        setCommitted(await commitComponentImportAction(batchId, csv));
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const shown = committed ?? preview;
  return (
    <div className="space-y-4">
      <Field label={t('csvData')}>
        <textarea
          className={`${inputCls} h-32 resize-y font-mono text-xs leading-relaxed`}
          placeholder={t('placeholder')}
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            reset();
          }}
          spellCheck={false}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={dryRun} disabled={pending || !csv.trim()}>
          {pending && !committed ? t('checking') : t('dryRun')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setCsv(SAMPLE);
            reset();
          }}
          disabled={pending}
        >
          {t('loadSample')}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">{t('matchHint')}</span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {committed && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
          {t('importedCount', { count: committed.imported })}
          <button
            type="button"
            className="ml-3 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setCsv('');
              reset();
            }}
          >
            {t('importAnother')}
          </button>
        </div>
      )}

      {shown && shown.rows.length > 0 && !committed && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-medium">
              {t('preview')} · <span className="text-emerald-600 dark:text-emerald-400">{t('validCount', { count: shown.valid })}</span>
              {shown.rows.length > shown.valid && (
                <span className="text-amber-600 dark:text-amber-400"> · {t('errorCount', { count: shown.rows.length - shown.valid })}</span>
              )}
            </span>
            <Button size="sm" onClick={commit} disabled={pending || shown.valid === 0}>
              {pending ? t('importing') : t('commit', { count: shown.valid })}
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="px-3 py-2 font-medium">{t('colComponent')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colAmount')}</th>
                  <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.rows.map((r) => (
                  <tr key={r.line} className={r.ok ? '' : 'bg-red-50/40 dark:bg-red-500/5'}>
                    <td className="px-3 py-1.5">{r.name ?? r.employee}</td>
                    <td className="px-3 py-1.5">{r.componentName ?? r.code}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{rm(r.amount)}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {r.ok ? (
                        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
                      ) : (
                        <span className="text-red-600 dark:text-red-400">{r.error}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
