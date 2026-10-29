'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useLocale, useTranslations } from 'next-intl';
import { Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import type { BankPaymentPreview, BankPaymentRequest } from '@/localization/country-pack';
import type { SelectionOption } from './download-dialog';

type Options = { accounts: { id: string; label: string; last4: string }[]; runs: { runSeq: number; cycleName: string | null; runType: string }[] };
type Props = {
  formatId: string; formatLabel: string; periodKind: 'month' | 'month-cycle' | 'month-runs'; testIndicator: boolean;
  endpoint: string; companies: SelectionOption[]; defaultCompanyId: string; years: string[]; defaultYear: string;
  months: SelectionOption[]; defaultMonth: string; defaultPaymentDate: string;
};

/** Preview and generation share one exact request; generation retries retain the same idempotency key. */
export function BankDownloadDialog(p: Props) {
  const t = useTranslations('payroll.paymentSubmission');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [companyId, setCompanyId] = useState(p.defaultCompanyId);
  const [year, setYear] = useState(p.defaultYear);
  const [month, setMonth] = useState(p.defaultMonth);
  const [bankProfileId, setBankProfileId] = useState('');
  const [run, setRun] = useState('');
  const [paymentDate, setPaymentDate] = useState(p.defaultPaymentDate);
  const [testFile, setTestFile] = useState(p.testIndicator);
  const [reference, setReference] = useState('');
  const [options, setOptions] = useState<Options>({ accounts: [], runs: [] });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState(false);
  const [preview, setPreview] = useState<{ summary: BankPaymentPreview; input: BankPaymentRequest; signature: string; requestKey: string } | null>(null);
  const inFlight = useRef(false);
  const epoch = useRef(0);
  const salary = p.periodKind === 'month-cycle';
  const periodKey = `${year}-${month}`;
  const input: BankPaymentRequest = { formatId: p.formatId, companyId, bankProfileId, periodKey, paymentDate,
    testFile: p.testIndicator && testFile, reference, ...(salary && run ? { runSeq: Number(run) } : {}) };
  const signature = JSON.stringify(input);
  const currentSignature = useRef(signature);
  currentSignature.current = signature;
  const clear = () => { epoch.current++; setPreview(null); setError(''); setGenerated(false); };
  const change = (fn: () => void) => { clear(); fn(); };

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setOptions({ accounts: [], runs: [] }); setBankProfileId(''); setRun(''); setLoading(true);
    const q = new URLSearchParams({ operation: 'options', formatId: p.formatId, companyId, periodKey });
    void (async () => {
      try {
        const response = await fetch(`${p.endpoint}?${q}`, { signal: controller.signal, cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t('bankRequestFailed'));
        if (!controller.signal.aborted) setOptions(data);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : t('bankRequestFailed'));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [open, companyId, periodKey, p.formatId, p.endpoint, t]);

  const ready = !loading && !!companyId && !!paymentDate && options.accounts.some((a) => a.id === bankProfileId)
    && (salary ? options.runs.some((r) => String(r.runSeq) === run) : options.runs.length > 0);
  async function validate() {
    if (inFlight.current || !ready) return;
    inFlight.current = true; setBusy(true); setError(''); setPreview(null); setGenerated(false);
    const started = epoch.current;
    try {
      const q = new URLSearchParams({ operation: 'preview', ...Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)])) });
      const response = await fetch(`${p.endpoint}?${q}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('bankRequestFailed'));
      if (started === epoch.current && currentSignature.current === signature) {
        setPreview({ summary: data, input, signature, requestKey: crypto.randomUUID() });
      }
    } catch (e) { if (started === epoch.current) setError(e instanceof Error ? e.message : t('bankRequestFailed')); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function download() {
    if (inFlight.current || !preview || preview.signature !== signature) return;
    inFlight.current = true; setBusy(true); setError(''); setGenerated(false);
    const started = epoch.current;
    try {
      const response = await fetch(p.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...preview.input, expectedDigest: preview.summary.digest, requestKey: preview.requestKey }) });
      if (!response.ok) {
        const data = await response.json();
        if (response.status === 409 && started === epoch.current) setPreview(null);
        throw new Error(data.error || t('bankRequestFailed'));
      }
      const blob = await response.blob();
      const filename = /filename="([A-Za-z0-9._-]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'bank-payment.txt';
      const url = URL.createObjectURL(blob);
      try { const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); }
      finally { URL.revokeObjectURL(url); }
      if (started === epoch.current) setGenerated(true);
    } catch (e) { if (started === epoch.current) setError(e instanceof Error ? e.message : t('bankRequestFailed')); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog.Root open={open} onOpenChange={(next) => { if (busy) return; clear(); setOpen(next); }}>
    <Dialog.Trigger asChild><button type="button" className={btnPrimary}>{t('download')}</button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-6 shadow-xl">
        <Dialog.Title className="text-lg font-semibold">{p.formatLabel}</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('bankSelectionIntro')}</Dialog.Description>
        {(p.formatId === 'my.ocbc.lhdn' || p.formatId === 'my.ocbc.zakat') && <p className="mt-3 text-sm text-muted-foreground">{t('ocbcBlankHashNotice')}</p>}
        <fieldset disabled={busy} className="mt-4 grid grid-cols-2 gap-4 disabled:opacity-70">
          <div className="col-span-2"><Field label={t('company')}><select aria-label={t('company')} className={inputCls} value={companyId} onChange={(e) => change(() => setCompanyId(e.target.value))}>{p.companies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></Field></div>
          <Field label={t('year')}><select aria-label={t('year')} className={inputCls} value={year} onChange={(e) => change(() => setYear(e.target.value))}>{p.years.map((y) => <option key={y}>{y}</option>)}</select></Field>
          <Field label={t('month')}><select aria-label={t('month')} className={inputCls} value={month} onChange={(e) => change(() => setMonth(e.target.value))}>{p.months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
          <div className="col-span-2"><Field label={t('bankAccount')}><select aria-label={t('bankAccount')} className={inputCls} value={bankProfileId} onChange={(e) => change(() => setBankProfileId(e.target.value))}><option value="">{t('bankChooseAccount')}</option>{options.accounts.map((a) => <option key={a.id} value={a.id}>{a.label} · •••• {a.last4}</option>)}</select></Field></div>
          <Field label={t('bankPaymentDate')}><input aria-label={t('bankPaymentDate')} className={inputCls} type="date" required value={paymentDate} onChange={(e) => change(() => setPaymentDate(e.target.value))} /></Field>
          <Field label={t('bankReference')}><input aria-label={t('bankReference')} className={inputCls} maxLength={16} value={reference} onChange={(e) => change(() => setReference(e.target.value))} /></Field>
          {p.testIndicator && <div className="col-span-2"><Field label={t('bankFileMode')}><select aria-label={t('bankFileMode')} className={inputCls} value={testFile ? 'test' : 'live'} onChange={(e) => change(() => setTestFile(e.target.value === 'test'))}><option value="test">{t('bankTestFile')}</option><option value="live">{t('bankLiveFile')}</option></select></Field></div>}
          {salary && <div className="col-span-2"><Field label={t('payCycle')}><select aria-label={t('payCycle')} className={inputCls} value={run} onChange={(e) => change(() => setRun(e.target.value))}><option value="">{t('bankChooseRun')}</option>{options.runs.map((r) => <option key={r.runSeq} value={r.runSeq}>{r.cycleName || t('payCycleRun', { seq: r.runSeq })} · {r.runType}</option>)}</select></Field></div>}
        </fieldset>
        {loading ? <p role="status" className="mt-3 text-sm">{t('payCycleLoading')}</p> : !options.accounts.length ? <p className="mt-3 text-sm text-muted-foreground">{t('bankNoAccounts')}</p> : !options.runs.length ? <p className="mt-3 text-sm text-muted-foreground">{t('bankNoReadyRuns')}</p> : null}
        {preview && preview.signature === signature && <div role="status" data-bank-preview className="mt-4 rounded-lg border bg-muted/40 p-4 text-sm">
          <p className="font-medium">{t('bankPreviewTitle')}</p>
          <p>{preview.summary.companyName} · {p.formatLabel}</p>
          <p>{preview.summary.periodKey} · {preview.summary.paymentDate}</p>
          <p>{t('bankPreviewTotals', { count: preview.summary.recordCount, total: formatMoney(preview.summary.totalCents / 100, 'MYR', locale) })}</p>
          {p.testIndicator && <p>{testFile ? t('bankTestFile') : t('bankLiveFile')}</p>}
        </div>}
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        {generated && <p role="status" className="mt-3 text-sm">{t('bankGenerated')}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Dialog.Close asChild><button type="button" disabled={busy} className={btnGhost}>{t('cancel')}</button></Dialog.Close>
          <button type="button" className={btnGhost} disabled={!ready || busy} onClick={validate}>{t('bankPreview')}</button>
          <button type="button" className={btnPrimary} disabled={busy || !preview || preview.signature !== signature} onClick={download}>{t('download')}</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
