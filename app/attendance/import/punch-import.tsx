'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { DownloadTemplate } from '@/components/download-template';
import { attendancePunchTemplate } from '@/lib/import-template';
import type { PunchImportResult } from '@/core/attendance';
import { dryRunPunchImportAction, commitPunchImportAction } from './actions';

const SAMPLE = `staff_id,timestamp
E1001,2026-07-01 08:02:00
E1001,2026-07-01 17:31:00
E1001,2026-07-02 07:58:00
E1001,2026-07-02 18:45:00
E1002,2026-07-01 22:00:00
E1002,2026-07-02 06:05:00`;

type Phase = 'idle' | 'previewed' | 'done';

const hm = (mins: number | null): string =>
  mins == null ? '—' : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

export function PunchImport() {
  const t = useTranslations('attendance.import');
  const router = useRouter();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<PunchImportResult | null>(null);
  const [committed, setCommitted] = useState<PunchImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setPreview(null);
    setCommitted(null);
    setPhase('idle');
    setError(null);
  };

  const dryRun = () =>
    startTransition(async () => {
      setError(null);
      try {
        const r = await dryRunPunchImportAction(csv);
        setPreview(r);
        setCommitted(null);
        setPhase('previewed');
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const commit = () =>
    startTransition(async () => {
      setError(null);
      try {
        const r = await commitPunchImportAction(csv);
        setCommitted(r);
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const shown = committed ?? preview;
  const sourceLabel = (s: PunchImportResult['preview'][number]['source']) =>
    s === 'roster-shift'
      ? t('srcRoster')
      : s === 'roster-rest'
        ? t('srcRest')
        : s === 'default-shift'
          ? t('srcDefaultShift')
          : s === 'default-shift-rest'
            ? t('srcDefaultShiftRest')
            : t('srcPolicy');

  return (
    <div className="space-y-6">
      <Card className="p-5">
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

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={dryRun} disabled={pending || !csv.trim()}>
            {pending && phase !== 'done' ? t('checking') : t('dryRun')}
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
          <DownloadTemplate spec={attendancePunchTemplate} />
          <span className="ml-auto text-xs text-muted-foreground">{t('matchHint')}</span>
        </div>

        <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">{t('rosterHint')}</p>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {committed && (
        <Card className="overflow-hidden border-emerald-200 dark:border-emerald-500/30">
          <div className="flex items-center gap-3 border-b border-border bg-emerald-50/60 px-4 py-3 dark:bg-emerald-500/10">
            <h2 className="text-sm font-semibold">{t('importedCount', { count: committed.imported })}</h2>
            <Link href="/attendance" className="ml-auto text-sm text-primary hover:underline">
              {t('viewAttendance')}
            </Link>
            <button
              type="button"
              className="text-sm text-muted-foreground hover:text-foreground"
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

      {shown && (shown.unmatchedRefs.length > 0 || shown.parseErrors.length > 0) && (
        <div className="space-y-2">
          {shown.unmatchedRefs.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              <span className="font-medium">{t('unmatched', { count: shown.unmatchedRefs.length })}</span>{' '}
              {shown.unmatchedRefs.slice(0, 12).map((r) => (
                <code key={r} className="mx-0.5">
                  {r}
                </code>
              ))}
              {shown.unmatchedRefs.length > 12 && ` +${shown.unmatchedRefs.length - 12}`}
              <span className="mt-1 block text-xs text-amber-700/80 dark:text-amber-300/70">{t('unmatchedHint')}</span>
            </div>
          )}
          {shown.parseErrors.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
              <span className="font-medium">{t('parseIssues', { count: shown.parseErrors.length })}</span>
              <ul className="mt-1 space-y-0.5">
                {shown.parseErrors.slice(0, 8).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {preview && !committed && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">
              {t('preview')} ·{' '}
              <span className="text-emerald-600 dark:text-emerald-400">
                {t('daysCount', { count: preview.reconciledDays })}
              </span>{' '}
              <span className="text-muted-foreground">{t('fromPunches', { count: preview.matchedPunches })}</span>
            </h2>
            <Button onClick={commit} disabled={pending || preview.reconciledDays === 0} size="sm">
              {pending ? t('importing') : t('commit', { count: preview.reconciledDays })}
            </Button>
          </div>

          {preview.reconciledDays === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('nothingToImport')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('colDate')}</th>
                    <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                    <th className="px-4 py-2 font-medium">{t('colIn')}</th>
                    <th className="px-4 py-2 font-medium">{t('colOut')}</th>
                    <th className="px-4 py-2 font-medium">{t('colWorked')}</th>
                    <th className="px-4 py-2 font-medium">{t('colOt')}</th>
                    <th className="px-4 py-2 font-medium">{t('colSchedule')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {preview.preview.map((r) => (
                    <tr key={`${r.employmentId}-${r.date}`}>
                      <td className="px-4 py-2 tabular-nums text-muted-foreground">{r.date}</td>
                      <td className="px-4 py-2 font-medium">{r.name}</td>
                      <td className="px-4 py-2 tabular-nums">{r.checkIn.slice(0, 5)}</td>
                      <td className="px-4 py-2 tabular-nums">
                        {r.checkOut ? (
                          r.checkOut.slice(0, 5)
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400">{t('noCheckout')}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 tabular-nums">{hm(r.workedMinutes)}</td>
                      <td className="px-4 py-2 tabular-nums">
                        {r.otMinutes ? <span className="text-indigo-600 dark:text-indigo-400">{hm(r.otMinutes)}</span> : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{sourceLabel(r.source)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
