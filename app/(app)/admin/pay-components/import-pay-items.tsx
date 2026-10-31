'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button, inputCls } from '@/components/ui';
import { PAY_ITEM_COLUMNS, PAY_ITEM_MAX_BYTES, type PayItemPreview, type PayItemPreviewRow, type PayItemVocabulary, type PayItemField } from '@/lib/pay-component-import';
import { payCalculationStatus } from '@/lib/pay-component-contract';
import { payItemIssueMessage } from '@/lib/pay-item-import-messages';

const ENDPOINT = '/admin/pay-components/import';
export function ImportPayItems() {
  const t = useTranslations('payComponents'), rule = useTranslations('payRule'), router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null), [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PayItemPreview | null>(null), [vocabulary, setVocabulary] = useState<PayItemVocabulary>({});
  const [created, setCreated] = useState<number | null>(null);
  const stepHeading = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (preview || created != null) stepHeading.current?.focus(); }, [preview, created]);
  const issue = (code: string) => payItemIssueMessage(code, t, rule);
  function data(operation: string) {
    const body = new FormData(); if (file) body.set('file', file);
    body.set('operation', operation); body.set('fileSha256', preview?.fileSha256 ?? ''); return body;
  }
  async function send(operation: 'preview' | 'confirm') {
    if (!file || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(ENDPOINT, { method: 'POST', body: data(operation) });
      const result = await response.json();
      if (!response.ok || !result.ok) { setError(typeof result.error === 'string' ? result.error : t('importFailed')); return; }
      if (operation === 'preview') { setPreview(result.preview); setVocabulary(result.vocabulary); }
      else { setCreated(result.created); toast.success(t('importCreated', { count: result.created })); router.refresh(); }
    } catch { setError(t('importFailed')); }
    finally { setBusy(false); }
  }
  async function downloadErrors() {
    if (busy) return; setBusy(true); setError(null);
    try {
      const response = await fetch(ENDPOINT, { method: 'POST', body: data('errors') });
      if (!response.ok) { const result = await response.json(); setError(typeof result.error === 'string' ? result.error : t('importFailed')); return; }
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
      link.href = url; link.download = 'PayItems_Import_Result.xlsx'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError(t('importFailed')); }
    finally { setBusy(false); }
  }
  function normalized(row: PayItemPreviewRow, field: PayItemField): string {
    let value: unknown = field === 'archived' ? row.archived ? 'inactive' : 'active' : field === 'inputKind' ? row.input.pendingInputKind ?? 'fixed' : row.input[field as keyof typeof row.input];
    if (typeof value === 'boolean') value = value ? 'Y' : 'N';
    const text = String(value ?? '');
    return (vocabulary[field]?.find(choice => choice.value === text)?.label ?? text) || '—';
  }
  function reset() { setFile(null); setPreview(null); setCreated(null); setError(null); }
  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (!value) reset(); } }}>
    <Dialog.Trigger asChild><Button type="button" variant="outline" size="sm">{t('importExcel')}</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <Dialog.Content aria-describedby="pay-item-import-description" className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-6xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg sm:p-6">
        <div className="flex items-start justify-between gap-3"><Dialog.Title className="text-lg font-semibold">{t('importExcel')}</Dialog.Title><Dialog.Close asChild><Button variant="ghost" size="sm" disabled={busy} aria-label={t('cancelEdit')}>✕</Button></Dialog.Close></div>
        <Dialog.Description id="pay-item-import-description" className="mt-2 text-sm text-muted-foreground">{t('importDescription')}</Dialog.Description>
        <p ref={stepHeading} tabIndex={-1} className="my-4 text-xs font-medium" aria-live="polite">{created != null ? t('importStepDone') : preview ? t('importStepCheck') : t('importStepUpload')}</p>
        {error && <p role="alert" className="my-3 rounded-xl border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
        {created != null ? <div className="space-y-4"><p role="status">{t('importCreated', { count: created })}</p><Button onClick={() => { setOpen(false); reset(); }}>{t('importClose')}</Button></div> : <>
          {!preview ? <div className="space-y-4">
            <a className="inline-block text-sm font-medium text-primary underline" href="/admin/pay-components/template">{t('downloadTemplate')}</a>
            <label className="block rounded-xl border border-dashed border-border p-5 text-sm"><span className="mb-2 block font-medium">{t('importUploadLabel')}</span><input type="file" accept=".xlsx" className={inputCls} disabled={busy} onChange={event => {
              const selected = event.target.files?.[0] ?? null; setError(null); setFile(null);
              if (selected && (!/\.xlsx$/i.test(selected.name) || selected.size > PAY_ITEM_MAX_BYTES)) setError(t(selected.size > PAY_ITEM_MAX_BYTES ? 'importFile_tooLarge' : 'importFile_invalidWorkbook'));
              else setFile(selected);
            }} /><span className="mt-2 block text-xs text-muted-foreground">{t('importLimits')}</span></label>
            <Button disabled={!file || busy} onClick={() => send('preview')}>{busy ? t('importWorking') : t('importCheck')}</Button>
          </div> : <div className="space-y-4">
            <p className="text-sm" role="status">{t('importCounts', { total: preview.total, valid: preview.valid, errors: preview.errors })}</p>
            <div className="max-h-[55dvh] overflow-auto rounded-lg border border-border"><table className="w-full min-w-[600px] text-left text-sm"><thead className="sticky top-0 bg-muted"><tr>{[t('importRow'), t('colCode'), t('colLabel'), t('colStatus'), t('importMessages')].map((label, i) => <th key={i} className="p-2 font-medium">{label}</th>)}</tr></thead><tbody>
              {preview.rows.map(row => <Fragment key={row.row}><tr className="border-t border-border"><td className="p-2">{row.row}</td><td className={`p-2 font-mono ${row.errors.some(e => e.field === 'code') ? 'bg-destructive/10' : ''}`}>{row.input.code || '—'}</td><td className={`p-2 ${row.errors.some(e => e.field === 'label') ? 'bg-destructive/10' : ''}`}>{row.input.label || '—'}</td><td className="p-2">{row.errors.length ? t('importError') : t('importValid')}{row.input.pendingInputKind && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">{t(payCalculationStatus(row.input.pendingInputKind))}</span>}</td><td className="p-2"><ul>{row.errors.map((e, i) => <li key={i} className="text-destructive">{PAY_ITEM_COLUMNS.find(([field]) => field === e.field)?.[1] ?? e.field}: {issue(e.code)}</li>)}</ul>{row.warnings.length > 0 && <div className="mt-2 text-amber-700 dark:text-amber-300"><p className="font-medium">{t('importWarnings')}</p><ul>{row.warnings.map(warning => <li key={warning}>{issue(warning)}</li>)}</ul></div>}</td></tr>
                <tr><td colSpan={5} className="border-b border-border px-2 pb-2"><details><summary className="cursor-pointer text-xs font-medium text-primary">{t('importSettings')}</summary><dl className="mt-2 grid gap-2 sm:grid-cols-3">{PAY_ITEM_COLUMNS.map(([field, label]) => <div key={field} className={`rounded-md p-2 text-xs ${row.errors.some(e => e.field === field) ? 'bg-destructive/10' : 'bg-muted/40'}`}><dt className="text-muted-foreground">{label}</dt><dd className="break-words font-medium">{normalized(row, field)}</dd></div>)}</dl></details></td></tr></Fragment>)}
            </tbody></table></div>
            <div className="flex flex-wrap justify-end gap-3"><Button variant="outline" disabled={busy} onClick={reset}>{t('importChooseAgain')}</Button><Button variant="outline" disabled={busy} onClick={downloadErrors}>{t('importDownloadErrors')}</Button><Button disabled={busy || preview.errors > 0} onClick={() => send('confirm')}>{busy ? t('importWorking') : t('importConfirm')}</Button></div>
          </div>}
        </>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
