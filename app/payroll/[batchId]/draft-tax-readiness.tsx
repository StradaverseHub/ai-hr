'use client';

import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react';
import {useTranslations} from 'next-intl';
import Link from 'next/link';
import {Button, Card, EmployeeCode} from '@/components/ui';
import type {DraftTaxStatus} from '@/core/payroll-draft-tax-readiness';
import {getDraftTaxCheck, startDraftTaxCheck} from './draft-tax-actions';

const PAGE_SIZE = 30;
const TaxCheckContext = createContext<(disabled: boolean) => void>(() => {});
const ProcessDisabledContext = createContext(false);

export function DraftTaxCheckScope({children, enabled}: {children: ReactNode; enabled: boolean}) {
  const [disabled, setDisabled] = useState(enabled);
  return <TaxCheckContext.Provider value={setDisabled}>
    <ProcessDisabledContext.Provider value={disabled}>{children}</ProcessDisabledContext.Provider>
  </TaxCheckContext.Provider>;
}

export function DraftTaxProcessControl({children}: {children: ReactNode}) {
  const disabled = useContext(ProcessDisabledContext);
  return <fieldset className="contents" disabled={disabled} aria-describedby="draft-tax-readiness-status">{children}</fieldset>;
}

export function DraftTaxReadiness({batchId, companyId, payPeriod}: {batchId: string; companyId: string; payPeriod: string}) {
  const t = useTranslations('draftPayrollTaxReadiness');
  const setProcessDisabled = useContext(TaxCheckContext);
  const [job, setJob] = useState<string | null>(null);
  const [status, setStatus] = useState<DraftTaxStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [offset, setOffset] = useState(0);
  // 016276b7 — a blocker no longer disables Process: processing holds exactly those employees for income tax review and
  // processes everyone else. Process still waits for a running check, so its answer is on screen before the click.
  useEffect(() => {
    setProcessDisabled(busy || Boolean(job && !status && !failed)
      || status?.state === 'checking' || status?.state === 'waiting');
  }, [busy, failed, job, setProcessDisabled, status]);

  useEffect(() => {
    if (!job) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const result = await getDraftTaxCheck(batchId, job!, offset).catch(() => null);
      if (!active) return;
      if (!result || result.state === 'failed') {
        setFailed(true);
        setStatus(null);
        return;
      }
      setStatus(result);
      if (result.state !== 'done') timer = setTimeout(poll, 1500);
    }
    void poll();
    return () => {active = false; clearTimeout(timer);};
  }, [batchId, job, offset]);

  const check = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    setStatus(null);
    setJob(null);
    setOffset(0);
    const id = await startDraftTaxCheck(batchId, crypto.randomUUID()).catch(() => null);
    setJob(id);
    setFailed(!id);
    setBusy(false);
  }, [batchId]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void check();
  }, [check]);

  const checking = busy || (!failed && Boolean(job) && status?.state !== 'done');
  const [year, month] = payPeriod.split('-');
  function reviewHref(id: string, affected: string) {
    return '/payroll/income-tax-recalculation?' + new URLSearchParams({
      company: companyId, year, month: String(Math.max(1, Number(month) - 1, Number(affected.slice(5)))), employee: id,
    });
  }

  return <Card className="space-y-4 p-4" aria-labelledby="draft-tax-readiness-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="draft-tax-readiness-title" className="font-semibold">{t('title')}</h2>
        <p id="draft-tax-readiness-status" role="status" className="mt-1 text-sm text-muted-foreground">
          {failed ? t('failed') : status?.state === 'waiting' ? t('waiting') : checking ? t('checking')
            : status?.state === 'done' ? status.blockers ? t('blocked', {count: status.blockers}) : t('clear') : t('intro')}
        </p>
      </div>
      <Button type="button" variant="outline" onClick={check} disabled={checking}>{t(job ? 'again' : 'check')}</Button>
    </div>
    {status?.state === 'done' && status.blockers > 0 && <>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead><tr className="border-b border-border">
            <th scope="col" className="p-2">{t('employee')}</th>
            <th scope="col" className="p-2">{t('month')}</th>
            <th scope="col" className="p-2">{t('nextStep')}</th>
          </tr></thead>
          <tbody>{status.rows.map(row => <tr key={row.employmentId} className="border-b border-border align-top">
            <th scope="row" className="p-2 font-normal"><EmployeeCode code={row.employeeCode}/> {row.name}</th>
            <td className="whitespace-nowrap p-2">{row.period}</td>
            <td className="space-y-1 p-2">
              <p>{t(row.kind)}</p>
              {status.canReviewTax ? <Link href={reviewHref(row.employmentId, row.period)} className="font-medium text-primary underline">{t('review')}</Link>
                : <p>{t('askAdmin')}</p>}
            </td>
          </tr>)}</tbody>
        </table>
      </div>
      {status.blockers > PAGE_SIZE && <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" disabled={offset === 0} onClick={() => setOffset(offset - PAGE_SIZE)}>{t('previous')}</Button>
        <Button type="button" variant="outline" disabled={offset + PAGE_SIZE >= status.blockers} onClick={() => setOffset(offset + PAGE_SIZE)}>{t('next')}</Button>
      </div>}
    </>}
  </Card>;
}
