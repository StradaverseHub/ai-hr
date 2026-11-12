'use client';
/**
 * Recruitment slice 16 — the candidate import screen's two interactive parts: choosing a file and reading the preview (nothing is
 * written until "Start import"), and the running import's progress (the shared bulk-job progress shape, lib/bulk-job: state,
 * percent, steps; Stop). An Excel workbook is turned into CSV text in the browser by the repository's one workbook decoder
 * (lib/spreadsheet), so the server reads and checks plain text only, exactly as for a CSV file.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { bulkJobActive, bulkJobPercent } from '@/lib/bulk-job';
import { btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { CandidateImportJob, ImportPreview, ImportPreviewRow } from '@/packs/recruitment/service';
import { cancelCandidateImportAction, candidateImportStatusAction, previewCandidateImportAction, startCandidateImportAction } from '../../actions';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
type Labels = { fields: Record<string, string> };
type Problem = { problem: string };
const isProblem = (v: unknown): v is Problem => !!v && typeof v === 'object' && 'problem' in v;

async function fileText(file: File): Promise<string> {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const { workbookToCsvText } = await import('@/lib/spreadsheet');
    return workbookToCsvText(await file.arrayBuffer());
  }
  // Strict UTF-8: a file saved in another encoding is refused here, never read with replacement characters.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  return text.replace(/^\uFEFF/, '');
}

/** Choose a file → the full check → the preview → start (with the permission confirmation) or choose another file. */
export function CandidateImportWizard({ companyId, fieldLabels }: { companyId: string; fieldLabels: Labels['fields'] }) {
  const t = useTranslations('recruitment.import');
  const te = useTranslations('recruitment.errors');
  const router = useRouter();
  const [busy, start] = useTransition();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [problem, setProblem] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const operationKey = useRef<string>('');
  const errorText = (code: string) => {
    try { return te(code as 'unexpected'); } catch { return te('unexpected'); }
  };
  const choose = (picked: File | undefined) => {
    setPreview(null); setProblem(''); setConfirmed(false); setFile(null);
    if (!picked) return;
    if (picked.size > MAX_FILE_BYTES) { setProblem(t('fileErrors.import_too_large')); return; }
    start(async () => {
      let text: string;
      try { text = await fileText(picked); } catch (e) {
        setProblem(e instanceof TypeError && !/\.(xlsx|xls)$/i.test(picked.name) ? t('fileErrors.import_bad_encoding') : t('fileErrors.import_file_invalid'));
        return;
      }
      const result = await previewCandidateImportAction({ companyId, text, fileName: picked.name });
      if (isProblem(result)) { setProblem(errorText(result.problem)); return; }
      if (!result.ok) { setProblem(t(`fileErrors.${result.fileError}`)); return; }
      operationKey.current = crypto.randomUUID();
      setFile({ name: picked.name, text });
      setPreview(result);
    });
  };
  const begin = () => {
    if (!file || !preview?.ok) return;
    start(async () => {
      const result = await startCandidateImportAction({ companyId, text: file.text, fileName: file.name, previewHash: preview.previewHash, permissionConfirmed: confirmed,
        operationKey: operationKey.current });
      if (isProblem(result)) { setProblem(errorText(result.problem)); return; }
      router.push(`/recruitment/candidates/import?${new URLSearchParams({ company: companyId, import: result.importId })}`);
    });
  };
  const fieldName = (key: string) => fieldLabels[key] ?? t('unknownField');
  const issueText = (row: ImportPreviewRow) => [
    ...row.issues.map((i) => t('issue', { field: fieldName(i.field), problem: t(`issues.${i.code}`) })),
    ...(row.duplicate === 'existing' ? [t('duplicateExisting')] : row.duplicate === 'file' ? [t('duplicateFile', { row: row.duplicateOfRow ?? 0 })] : []),
    ...(row.job ? [t(`jobResults.${row.job}`)] : []),
  ];
  return (
    <div className="space-y-4">
      <label className="block space-y-2">
        <span className="text-sm font-medium">{t('chooseFile')}</span>
        <input type="file" accept=".csv,.xlsx,.xls,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0])}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-card file:px-3 file:py-1.5 file:text-sm file:font-medium" />
        <span className="block text-xs text-muted-foreground">{t('fileHelp')}</span>
      </label>
      {busy && <p role="status" className="text-sm text-muted-foreground">{preview ? t('starting') : t('checking')}</p>}
      {problem && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{problem}</p>}
      {preview?.ok && (
        <section aria-labelledby="preview-title" className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="space-y-1">
            <h3 id="preview-title" className="text-sm font-semibold">{t('previewTitle', { file: preview.fileName })}</h3>
            <p className="text-xs text-muted-foreground">{t('previewNote')}</p>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {([['rows', preview.rows], ['ready', preview.ready], ['invalid', preview.invalid], ['withJob', preview.withJob], ['toAssign', preview.toAssign],
              ['duplicates', preview.duplicates]] as const).map(([key, n]) => (
              <div key={key} className={cn('rounded-lg border px-3 py-2', key === 'invalid' && n > 0 ? 'border-amber-500/40 bg-amber-500/10' : 'border-border')}>
                <dt className="text-xs text-muted-foreground">{t(`counts.${key}`)}</dt>
                <dd className="text-xl font-semibold tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
          {preview.unknownJobs > 0 && <p className="text-sm">{t('unknownJobsNote', { count: preview.unknownJobs })}</p>}
          {preview.ignoredColumns.length > 0 && <p className="text-sm text-muted-foreground">{t('ignoredColumns', { columns: preview.ignoredColumns.join(', ') })}</p>}
          {preview.issues.length > 0 && (
            <div className="max-h-96 overflow-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{t('issuesCaption')}</caption>
                <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                  <tr><th scope="col" className="px-3 py-2">{t('row')}</th><th scope="col" className="px-3 py-2">{t('name')}</th><th scope="col" className="px-3 py-2">{t('whatHappens')}</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {preview.issues.map((row) => (
                    <tr key={row.rowNum} className="align-top">
                      <td className="px-3 py-2 tabular-nums">{row.rowNum}</td>
                      <td className="px-3 py-2">{row.name ?? '—'}</td>
                      <td className="px-3 py-2">
                        <ul className="space-y-0.5">
                          {issueText(row).map((line) => <li key={line} className={row.issues.length ? 'text-destructive' : ''}>{line}</li>)}
                        </ul>
                        {row.issues.length > 0 && <p className="text-xs text-muted-foreground">{t('notImported')}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.issuesTruncated && <p className="text-xs text-muted-foreground">{t('issuesTruncated', { count: preview.issues.length })}</p>}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 accent-primary" />
            <span>{t('permission')}</span>
          </label>
          <p className="text-xs text-muted-foreground">{t('consentNote')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btnPrimary} disabled={busy || !confirmed || preview.ready === 0} onClick={begin}>
              {t('start', { count: preview.ready })}
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => { setPreview(null); setFile(null); setConfirmed(false); }}>{t('cancelPreview')}</button>
          </div>
        </section>
      )}
    </div>
  );
}

const POLL_MS = 2000;
/** The running import: its state and progress (polled), Stop while it can stop, and a refresh of the page when it ends. */
export function CandidateImportProgress({ importId, initial }: { importId: string; initial: CandidateImportJob }) {
  const t = useTranslations('recruitment.import');
  const te = useTranslations('recruitment.errors');
  const router = useRouter();
  const [job, setJob] = useState(initial);
  const [problem, setProblem] = useState('');
  const [stopping, startStop] = useTransition();
  const active = !!job.job && bulkJobActive(job.job.state);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const next = await candidateImportStatusAction(importId).catch(() => null);
      if (!alive) return;
      if (next && !isProblem(next)) {
        setJob(next);
        if (next.job && !bulkJobActive(next.job.state)) { router.refresh(); return; }
      }
      timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [active, importId, router]);
  const stop = () => startStop(async () => {
    const r = await cancelCandidateImportAction(importId);
    if (isProblem(r)) {
      try { setProblem(te(r.problem as 'unexpected')); } catch { setProblem(te('unexpected')); }
    }
  });
  if (!job.job) return null;
  const state = job.job.state;
  const stateText = t(`state.${state}`);
  return (
    <section aria-live="polite" className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('progressTitle')}</h3>
        <span role="status" className="text-sm">{stateText}</span>
      </div>
      {active && (
        <>
          <progress aria-label={stateText} value={bulkJobPercent(job.job)} max={100} className="h-2 w-full accent-primary" />
          <p className="text-xs text-muted-foreground">{t('progressCount', { done: job.job.stepsDone, total: job.job.stepsTotal || job.fileRows })}</p>
          <p className="text-xs text-muted-foreground">{state === 'queued' && job.worker === 'unavailable' ? t('workerUnavailable') : t('backgroundHelp')}</p>
          {job.job.cancelRequested ? <p className="text-sm">{t('stopRequested')}</p> : (
            <button type="button" className={btnGhost} disabled={stopping} onClick={stop}>{t('stop')}</button>
          )}
        </>
      )}
      {!active && state === 'failed' && job.job.error && <p role="alert" className="text-sm text-destructive">{t('failed')}</p>}
      {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
    </section>
  );
}
