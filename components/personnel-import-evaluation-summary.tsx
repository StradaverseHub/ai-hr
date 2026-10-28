'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from './ui';
import { EmployeeImportEvaluationReceiptSchema } from '@/lib/personnel-import-evaluation';
import { summarizePersonnelImportEvaluations, type ImportLatencySummary, type ImportReportedMetric } from '@/lib/personnel-import-evaluation-summary';
/** Current browser's finite validated metadata window, not a production benchmark dataset. */
export function PersonnelImportEvaluationSummary({ receipts, companyId, activeCohortId, windowIncomplete = false }: {
    receipts: readonly unknown[];
    companyId: string;
    activeCohortId?: string | null;
    windowIncomplete?: boolean;
}) {
    const t = useTranslations('people.import.evaluationSummary'), [chosen, setChosen] = useState(activeCohortId ?? '');
    useEffect(() => setChosen(activeCohortId ?? ''), [activeCohortId, companyId]);
    const groups = new Map<string, string>();
    for (const raw of receipts.length <= 256 ? receipts : []) {
        const parsed = EmployeeImportEvaluationReceiptSchema.safeParse(raw);
        if (parsed.success && parsed.data.companyId === companyId && (!groups.has(parsed.data.cohortId) || Date.parse(parsed.data.createdAt)<Date.parse(groups.get(parsed.data.cohortId)!)))
            groups.set(parsed.data.cohortId, parsed.data.createdAt);
    }
    const cohortId = groups.has(chosen) ? chosen : [...groups.keys()][0] ?? '', summary = summarizePersonnelImportEvaluations(receipts, companyId, cohortId, windowIncomplete);
    const time = (value: number | null) => value === null ? t('unavailable') : `${String(value)} ${t('milliseconds')}`;
    const percentile = (value: ImportLatencySummary) => `${t('p50')}: ${time(value.p50)} · ${t('p95')}: ${time(value.p95)} · ${t('samples')}: ${value.samples} · ${t('missing')}: ${value.missing}`;
    const metric = (value: ImportReportedMetric) => `${value.total === null ? t('unknown') : value.total} (${t('known')}: ${value.known}; ${t('unknown')}: ${value.unknown})`;
    return <section className="mt-5 space-y-3 border-t border-border pt-4" aria-label={t('title')}><h4 className="font-semibold">{t('title')}</h4><p className="text-sm text-muted-foreground">{t('scope')}</p>
  {(summary.invalidReceipts > 0 || summary.conflictingAttempts > 0 || summary.inputOverflow) && <p role="alert" className="text-sm">{t('invalidEvidence', { invalid: summary.invalidReceipts, conflicts: summary.conflictingAttempts })}</p>}
  {summary.windowIncomplete && <p role="status" className="text-sm">{t('windowIncomplete')}</p>}
  {groups.size === 0 ? <p className="text-sm">{t('empty')}</p> : <><label className="block text-sm font-medium">{t('comparison')}<select className={`${inputCls} mt-1`} value={cohortId} onChange={e => setChosen(e.target.value)}>{[...groups].map(([id, date]) => <option key={id} value={id}>{t('groupAt', { date: new Date(date).toLocaleString() })}</option>)}</select></label>
  <p className="text-xs text-muted-foreground">{t('successDefinition')} {t('percentileRule')}</p>
  <div className="grid gap-4 lg:grid-cols-2">{summary.modes.map(mode => <article key={mode.mode} className="space-y-3 rounded-md border border-border p-3"><h5 className="font-medium">{t(mode.mode)}</h5><dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
   <dt>{t('workflows')}</dt><dd>{mode.workflows}</dd><dt>{t('committed')}</dt><dd>{mode.committed}</dd><dt>{t('successful')}</dt><dd>{mode.successful}</dd><dt>{t('partial')}</dt><dd>{mode.partial}</dd><dt>{t('unfinished')}</dt><dd>{mode.unfinished}</dd>
   <dt>{t('imported')}</dt><dd>{mode.canonicalRows.imported}</dd><dt>{t('failedRows')}</dt><dd>{mode.canonicalRows.failed}</dd><dt>{t('skippedRows')}</dt><dd>{mode.canonicalRows.skipped}</dd><dt>{t('admittedCalls')}</dt><dd>{mode.admittedRuns}</dd><dt>{t('failedCalls')}</dt><dd>{mode.failedRuns}</dd><dt>{t('pendingCalls')}</dt><dd>{mode.pendingRuns}</dd><dt>{t('reused')}</dt><dd>{mode.reusedProposals}</dd>
   <dt>{t('totalCost')}</dt><dd className="break-all">{mode.cost.totalCredits ?? t('unknown')} {mode.cost.unit ? t('credits') : ''}</dd><dt>{t('costPerSuccess')}</dt><dd className="break-all">{mode.cost.mean ? <>{mode.cost.mean.exactDecimal ?? `${mode.cost.mean.totalCredits} ÷ ${mode.cost.mean.successfulWorkflows}`} {mode.cost.unit ? t('credits') : ''}{mode.cost.mean.exactDecimal === null && <span className="block text-xs">{t('exactRatio')}</span>}</> : t(mode.cost.reason)}</dd><dt>{t('unknownCostJobs')}</dt><dd>{mode.cost.unknownWorkflows}</dd>
  </dl><p className="text-xs text-muted-foreground">{t('costScope')}</p>
  <div className="space-y-2 text-sm"><p><strong>{t('workflowLatency')}</strong><br />{percentile(mode.workflowLatency)}</p><p><strong>{t('providerWorkflowLatency')}</strong><br />{percentile(mode.providerWorkflowLatency)}</p><p><strong>{t('providerCallLatency')}</strong><br />{mode.providerCallEvidence === 'complete_single_call_jobs' ? percentile(mode.providerCallLatency) : t(mode.providerCallEvidence)}</p></div>
  <details><summary className="cursor-pointer text-sm font-medium">{t('reportedDetails')}</summary><p className="my-2 text-xs text-muted-foreground">{t('reportedScope')}</p><dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm"><dt>{t('qualityReports')}</dt><dd>{mode.humanQuality.reports}</dd><dt>{t('verified')}</dt><dd>{metric(mode.humanQuality.verified)}</dd><dt>{t('errors')}</dt><dd>{metric(mode.humanQuality.errors)}</dd><dt>{t('duplicates')}</dt><dd>{metric(mode.humanQuality.duplicates)}</dd><dt>{t('rework')}</dt><dd>{metric(mode.humanQuality.rework)}</dd><dt>{t('correctionObservations')}</dt><dd>{mode.corrections.observations}</dd><dt>{t('mappingChanges')}</dt><dd>{metric(mode.corrections.mappingChanges)}</dd><dt>{t('editedRows')}</dt><dd>{metric(mode.corrections.editedRows)}</dd><dt>{t('focusTotal')}</dt><dd>{mode.handling.focusObservations ? time(mode.handling.focusMilliseconds) : t('unknown')} ({mode.handling.focusObservations})</dd><dt>{t('attestedTotal')}</dt><dd>{mode.handling.attestedObservations ? time(mode.handling.attestedMilliseconds) : t('unknown')} ({mode.handling.attestedObservations})</dd><dt>{t('unknownHandling')}</dt><dd>{mode.handling.unknownObservations}</dd><dt>{t('ambiguousObservations')}</dt><dd>{mode.ambiguousObservations}</dd></dl></details>
  </article>)}</div></>}
 </section>;
}
