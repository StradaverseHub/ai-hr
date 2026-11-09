'use client';

import { ActionButton } from '@/components/ui/action-button';
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useLocale, useTranslations } from 'next-intl';
import { Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import type { BankPaymentCategory, BankPaymentOptions, BankPaymentPreview, BankPaymentRequest } from '@/localization/country-pack';
import type { SelectionOption } from './download-dialog';

type Props = {
  group: 'salary' | 'bankStatutory';
  formats: { id: string; label: string; description: string; verification: string; testIndicator: boolean }[];
  endpoint: string;
  companies: SelectionOption[];
  months: SelectionOption[];
  defaultPeriodKey: string;
  defaultPaymentDate: string;
};
const categoryLabels = {
  kwsp: 'bankCategoryKwsp', socso: 'bankCategorySocso', lhdn: 'bankCategoryLhdn', zakat: 'bankCategoryZakat',
} as const;
const accountIssueLabels = {
  missing: 'bankAccountsNotSetUp',
  incompatible: 'bankAccountIncompatible',
  'multiple-primary': 'bankMultiplePrimary',
  'statutory-account': 'bankStatutoryAccountMissing',
} as const;

/** Preview and generation share one exact request; generation retries retain the same idempotency key. */
export function BankDownloadDialog(p: Props) {
  const t = useTranslations('payroll.paymentSubmission');
  const mb = useTranslations('maybankPayment');
  const locale = useLocale();
  const salary = p.group === 'salary';
  const heading = t(salary ? 'bankSalaryPayment' : 'bankStatutoryPayment');
  const [open, setOpen] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [statutoryCategory, setStatutoryCategory] = useState<Exclude<BankPaymentCategory, 'salary'> | ''>('');
  const category = salary ? 'salary' : statutoryCategory;
  const [options, setOptions] = useState<BankPaymentOptions | null>(null);
  const [optionsVersion, setOptionsVersion] = useState(0);
  const [periodKey, setPeriodKey] = useState('');
  const [bankProfileId, setBankProfileId] = useState('');
  const [run, setRun] = useState('');
  const [paymentDate, setPaymentDate] = useState(p.defaultPaymentDate);
  const [testFile, setTestFile] = useState(true);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState(false);
  const [preview, setPreview] = useState<{ summary: BankPaymentPreview; input: BankPaymentRequest; signature: string; requestKey: string } | null>(null);
  const inFlight = useRef(false);
  const epoch = useRef(0);

  const chosenAccount = options?.accounts.find(account => account.id === bankProfileId);
  const selectedFormat = p.formats.find(format => format.id === chosenAccount?.formatId);
  const years = [...new Set(options?.periods.map(period => period.periodKey.slice(0, 4)))];
  const year = periodKey.slice(0, 4);
  const months = options?.periods.filter(period => period.periodKey.slice(0, 4) === year) ?? [];
  const selectedPeriod = options?.periods.find(period => period.periodKey === periodKey);
  const runs = selectedPeriod?.runs ?? [];
  const input: BankPaymentRequest | null = selectedFormat && selectedPeriod && paymentDate &&
    (!salary || runs.some(candidate => String(candidate.runSeq) === run))
    ? {
      formatId: selectedFormat.id, companyId, bankProfileId, periodKey, paymentDate,
      testFile: selectedFormat.testIndicator && testFile, reference,
      ...(salary ? { runSeq: Number(run) } : {}),
    }
    : null;
  const signature = JSON.stringify(input);
  const canDownload = !!input && !!preview && preview.signature === signature;

  const clear = () => {
    epoch.current++;
    setPreview(null);
    setError('');
    setGenerated(false);
  };
  const change = (fn: () => void) => { clear(); fn(); };
  const clearOptions = () => {
    setOptions(null);
    setBankProfileId('');
    setPeriodKey('');
    setRun('');
    setTestFile(true);
  };
  const refreshOptions = () => {
    clearOptions();
    setOptionsVersion(version => version + 1);
  };

  useEffect(() => {
    if (!open || !companyId || !category) return;
    const controller = new AbortController();
    const q = new URLSearchParams({ operation: 'options', category, companyId });
    void (async () => {
      try {
        const response = await fetch(p.endpoint + '?' + q, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error((await response.json()).error || t('bankRequestFailed'));
        const data: BankPaymentOptions = await response.json();
        if (controller.signal.aborted) return;
        setOptions(data);
        setBankProfileId(data.configuredAccountId ?? '');
        setPeriodKey(data.periods.find(period => period.periodKey === p.defaultPeriodKey)?.periodKey ??
          data.periods[0]?.periodKey ?? '');
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : t('bankRequestFailed'));
      }
    })();
    return () => controller.abort();
  }, [open, companyId, category, optionsVersion, p.endpoint, p.defaultPeriodKey, t]);

  async function validate() {
    if (inFlight.current || !input) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setPreview(null);
    setGenerated(false);
    const started = epoch.current;
    try {
      const q = new URLSearchParams({ operation: 'preview', ...Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)])) });
      const response = await fetch(p.endpoint + '?' + q, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && started === epoch.current) refreshOptions();
        throw new Error(data.error || t('bankRequestFailed'));
      }
      if (started === epoch.current) {
        setPreview({ summary: data, input, signature, requestKey: crypto.randomUUID() });
      }
    } catch (e) { if (started === epoch.current) setError(e instanceof Error ? e.message : t('bankRequestFailed')); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function download() {
    if (inFlight.current || !preview || !canDownload) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setGenerated(false);
    const started = epoch.current;
    try {
      const response = await fetch(p.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...preview.input, expectedDigest: preview.summary.digest, requestKey: preview.requestKey }) });
      if (!response.ok) {
        const data = await response.json();
        if (response.status === 409 && started === epoch.current) {
          setPreview(null);
          refreshOptions();
        }
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

  return <Dialog.Root open={open} onOpenChange={(next) => {
    if (inFlight.current) return;
    clear();
    clearOptions();
    setCompanyId('');
    setStatutoryCategory('');
    setPaymentDate(p.defaultPaymentDate);
    setReference('');
    setOpen(next);
  }}>
    <Dialog.Trigger asChild><button type="button" className={btnPrimary} aria-label={t('bankDownloadAction', { payment: heading })}>{t('download')}</button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-6 shadow-xl">
        <Dialog.Title className="text-lg font-semibold">{t('bankDownloadAction', { payment: heading })}</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('bankSelectionIntro')}</Dialog.Description>
        <fieldset disabled={busy} className="mt-4 grid grid-cols-2 gap-4 disabled:opacity-70">
          <div className="col-span-2"><Field label={t('company')}>
            <select aria-label={t('company')} className={inputCls} value={companyId} onChange={(e) => change(() => { clearOptions(); setCompanyId(e.target.value); })}>
              <option value="">{t('bankChooseCompany')}</option>
              {p.companies.map(company => <option key={company.value} value={company.value}>{company.label}</option>)}
            </select>
          </Field></div>
          {!salary && <div className="col-span-2"><Field label={t('bankPaymentType')}>
            <select aria-label={t('bankPaymentType')} className={inputCls} disabled={!companyId} value={statutoryCategory} onChange={(e) => {
              const value = e.target.value;
              change(() => {
                clearOptions();
                setStatutoryCategory(Object.hasOwn(categoryLabels, value) ? value as keyof typeof categoryLabels : '');
              });
            }}>
              <option value="">{t('bankChooseCategory')}</option>
              {Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
          </Field></div>}
          {options && <>
            {options.accounts.length > 0 && <div className="col-span-2"><Field label={t('bankAccount')}>
              <select aria-label={t('bankAccount')} className={inputCls} value={bankProfileId} onChange={(e) => change(() => { setBankProfileId(e.target.value); setTestFile(true); })}>
                {!options.configuredAccountId && <option value="">{t('bankChooseAccount')}</option>}
                {options.accounts.map(account => <option key={account.id} value={account.id}>
                  {[account.bankName, account.label === account.bankName ? '' : account.label, account.accountNumber,
                    account.id === options.configuredAccountId && !options.usesStatutoryAccount ? t('bankPrimaryAccount') : ''].filter(Boolean).join(' · ')}
                </option>)}
              </select>
            </Field></div>}
            {years.length > 0 && <>
              <Field label={t('year')}><select aria-label={t('year')} className={inputCls} value={year} onChange={(e) => change(() => {
                setPeriodKey(options.periods.find(period => period.periodKey.slice(0, 4) === e.target.value)?.periodKey ?? '');
                setRun('');
              })}>{years.map(value => <option key={value}>{value}</option>)}</select></Field>
              <Field label={t('month')}><select aria-label={t('month')} className={inputCls} value={periodKey} onChange={(e) => change(() => { setPeriodKey(e.target.value); setRun(''); })}>
                {months.map(period => <option key={period.periodKey} value={period.periodKey}>
                  {p.months.find(month => month.value === period.periodKey.slice(5))?.label ?? period.periodKey.slice(5)}
                </option>)}
              </select></Field>
              <div className="col-span-2"><Field label={t('payCycle')}>
                {salary ? <select aria-label={t('payCycle')} className={inputCls} value={run} onChange={(e) => change(() => setRun(e.target.value))}>
                  <option value="">{t('bankChooseRun')}</option>
                  {runs.map(candidate => <option key={candidate.runSeq} value={candidate.runSeq}>
                    {candidate.cycleName || t('payCycleRun', { seq: candidate.runSeq })} · {candidate.runType}
                  </option>)}
                </select> : <input aria-label={t('payCycle')} className={inputCls} readOnly value={t('bankWholeMonth')} />}
              </Field></div>
            </>}
            {selectedFormat && <>
              <Field label={t('bankPaymentDate')}><input aria-label={t('bankPaymentDate')} className={inputCls} type="date" required value={paymentDate} onChange={(e) => change(() => setPaymentDate(e.target.value))} /></Field>
              <Field label={t('bankReference')}><input aria-label={t('bankReference')} className={inputCls} maxLength={16} value={reference} onChange={(e) => change(() => setReference(e.target.value))} /></Field>
              {selectedFormat.testIndicator && <div className="col-span-2"><Field label={t('bankFileMode')}>
                <select aria-label={t('bankFileMode')} className={inputCls} value={testFile ? 'test' : 'live'} onChange={(e) => change(() => setTestFile(e.target.value === 'test'))}>
                  <option value="test">{t('bankTestFile')}</option><option value="live">{t('bankLiveFile')}</option>
                </select>
              </Field></div>}
            </>}
          </>}
        </fieldset>
        {companyId && category && !options && !error && <p role="status" className="mt-3 text-sm">{t('bankLoadingOptions')}</p>}
        {options?.accountIssue && <p className="mt-3 text-sm text-muted-foreground">{t(accountIssueLabels[options.accountIssue])}</p>}
        {options?.usesStatutoryAccount && !options.accountIssue && <p className="mt-3 text-sm text-muted-foreground">{t('bankStatutoryAccountSelected')}</p>}
        {options && !options.periods.length && <p className="mt-3 text-sm text-muted-foreground">{t('bankNoClosedRuns')}</p>}
        {options && options.periods.length > 0 && <p className="mt-3 text-sm text-muted-foreground">{t('bankClosedPeriods')}</p>}
        {selectedFormat && <div className="mt-3 space-y-1 text-sm text-muted-foreground">
          <p className="font-medium">{selectedFormat.label}</p>
          <p>{selectedFormat.description}</p>
          <p>{selectedFormat.verification}</p>
          {(selectedFormat.id === 'my.ocbc.lhdn' || selectedFormat.id === 'my.ocbc.zakat') && <p>{t('ocbcBlankHashNotice')}</p>}
          {selectedFormat.id.startsWith('my.maybank74.') && <p>{mb('downloadNotice')}</p>}
        </div>}
        {preview && canDownload && <div role="status" data-bank-preview className="mt-4 rounded-lg border bg-muted/40 p-4 text-sm">
          <p className="font-medium">{t('bankPreviewTitle')}</p>
          <p>{preview.summary.companyName} · {selectedFormat?.label}</p>
          <p>{preview.summary.periodKey} · {preview.summary.paymentDate}</p>
          <p>{t('bankPreviewTotals', { count: preview.summary.recordCount, total: formatMoney(preview.summary.totalCents / 100, 'MYR', locale) })}</p>
          {selectedFormat?.testIndicator && <p>{testFile ? t('bankTestFile') : t('bankLiveFile')}</p>}
        </div>}
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        {generated && <p role="status" className="mt-3 text-sm">{t('bankGenerated')}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Dialog.Close asChild><ActionButton aria-busy={busy} type="button" disabled={busy} className={btnGhost}>{t('cancel')}</ActionButton></Dialog.Close>
          <ActionButton aria-busy={busy} type="button" className={canDownload ? btnGhost : btnPrimary} disabled={!input || busy} onClick={validate}>{t('bankPreview')}</ActionButton>
          {canDownload && <ActionButton aria-busy={busy} type="button" className={btnPrimary} disabled={busy} onClick={download}>{t('download')}</ActionButton>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
