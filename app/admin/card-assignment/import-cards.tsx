'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Button, Card, inputCls } from '@/components/ui';
import { CARD_IMPORT_MAX_BYTES, type CardImportPreview, type CardImportResult, type CardImportRow } from '@/lib/card-import';
import { toCsv } from '@/lib/csv';

export function ImportCards({ company = '' }: { company?: string }) {
  const t = useTranslations('cardImport'), router = useRouter();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CardImportPreview | null>(null), [result, setResult] = useState<CardImportResult | null>(null);
  const [selection, setSelection] = useState<number[]>([]), [confirmed, setConfirmed] = useState(false), [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) heading.current?.focus(); }, [open, preview, result]);
  useEffect(() => { setPreview(null); setResult(null); setSelection([]); setConfirmed(false); setError(''); }, [company]);
  function reset() { setFile(null); setPreview(null); setResult(null); setSelection([]); setConfirmed(false); setError(''); }
  function close() { reset(); setOpen(false); importButton.current?.focus(); }
  function download(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function template(existing: boolean) {
    if (busy) return; setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ existing: existing ? '1' : '0', company });
      const response = await fetch(`/admin/card-assignment/template?${query}`);
      if (!response.ok) { const body = await response.json(); setError(body.error || t('saveFailed')); return; }
      download(await response.blob(), `Card_Assignments_${existing ? 'Existing' : 'Template'}.xlsx`);
    } catch { setError(t('saveFailed')); } finally { setBusy(false); }
  }
  async function send(operation: 'preview' | 'confirm') {
    if (!file || busy) return;
    setBusy(true); setError('');
    try {
      const data = new FormData(); data.set('file', file); data.set('company', company); data.set('operation', operation);
      data.set('receipt', preview?.receipt ?? ''); data.set('selection', JSON.stringify(selection)); data.set('confirmReplacements', String(confirmed));
      const response = await fetch('/admin/card-assignment/import', { method: 'POST', body: data });
      const body = await response.json();
      if (!response.ok || !body.ok) { setError(body.error || t('saveFailed')); return; }
      if (operation === 'preview') {
        setPreview(body.preview); setSelection(body.preview.rows.filter((r: CardImportRow) => !r.issues.length).map((r: CardImportRow) => r.row)); setConfirmed(false);
      } else { setResult(body.result); router.refresh(); }
    } catch { setError(t('saveFailed')); } finally { setBusy(false); }
  }
  function errors() {
    const rows = result?.rows ?? preview?.rows ?? [];
    const csv = toCsv([[t('row'), t('employeeId'), t('cardId'), t('operation'), t('result'), t('reason')], ...rows.map(r => [r.row, r.employeeCode, r.cardId, r.operation, t('result' in r ? String(r.result) : r.issues.length ? 'failed' : r.effect), r.issues.map(issue => t(issue)).join('; ')])]);
    download(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }), 'Card_Assignments_Import_Result.csv');
  }
  const rows = result?.rows ?? preview?.rows ?? [];
  const replacements = preview?.rows.some(r => selection.includes(r.row) && ['replace', 'reset'].includes(r.effect));
  return <section className="space-y-4" aria-label={t('bulkTitle')}>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="secondary" className="min-h-11" disabled={busy} onClick={() => template(false)}>{t('template')}</Button>
      <Button type="button" variant="secondary" className="min-h-11" disabled={busy} onClick={() => template(true)}>{t('existing')}</Button>
      <Button ref={importButton} type="button" className="min-h-11" disabled={busy} aria-expanded={open} aria-controls="card-import-panel" onClick={() => setOpen(true)}>{t('importExcel')}</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {open && <Card id="card-import-panel" className="space-y-4 p-4 sm:p-5" aria-busy={busy}>
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">{t(result ? 'summary' : preview ? 'preview' : 'bulkTitle')}</h2>
      {!preview ? <div className="space-y-4">
        <p className="max-w-prose text-sm text-muted-foreground">{t('description')}</p>
        <label className="block max-w-xl space-y-2 text-sm"><span className="block font-medium">{t('chooseFile')}</span><input type="file" accept=".xlsx" disabled={busy} className={`${inputCls} min-h-11 w-full`} onChange={event => {
          const chosen = event.target.files?.[0] ?? null; setFile(null); setError('');
          if (chosen && (!/\.xlsx$/i.test(chosen.name) || chosen.size > CARD_IMPORT_MAX_BYTES)) setError(t(chosen.size > CARD_IMPORT_MAX_BYTES ? 'tooLarge' : 'invalidWorkbook'));
          else setFile(chosen);
        }} /><span className="block text-muted-foreground">{t('limits')}</span></label>
        <div className="flex flex-wrap gap-2"><Button className="min-h-11" disabled={busy || !file} onClick={() => send('preview')}>{t(busy ? 'working' : 'check')}</Button><Button className="min-h-11" variant="secondary" disabled={busy} onClick={close}>{t('cancel')}</Button></div>
      </div> : <>
        {result ? <p role="status" className="text-sm">{t('totals', { total: result.total, imported: result.imported, updated: result.updated, unchanged: result.unchanged, failed: result.failed, skipped: result.skipped })}</p> : <p role="status" className="text-sm">{t('previewCounts', { total: rows.length, selected: selection.length, failed: rows.filter(r => r.issues.length).length })}</p>}
        <div className="max-h-[55dvh] overflow-auto rounded-lg border border-border"><table className="w-full min-w-[750px] text-left text-sm"><caption className="sr-only">{t('preview')}</caption><thead className="sticky top-0 bg-muted"><tr>{[t('select'), t('row'), t('employeeId'), t('currentCard'), t('proposedCard'), t('operation'), t('review')].map(text => <th key={text} className="p-3 font-medium" scope="col">{text}</th>)}</tr></thead><tbody className="divide-y divide-border">
          {rows.map(row => <tr key={row.row}>
            <td className="p-3">{!result && !row.issues.length && <label className="flex min-h-11 min-w-11 items-center justify-center"><span className="sr-only">{t('selectRow', { row: row.row })}</span><input type="checkbox" disabled={busy} checked={selection.includes(row.row)} onChange={event => setSelection(value => event.target.checked ? [...value, row.row] : value.filter(n => n !== row.row))} /></label>}</td>
            <td className="p-3 tabular-nums">{row.row}</td><td className="p-3"><span className="block font-medium">{row.employeeCode || '—'}</span>{row.employee && <span className="text-muted-foreground">{row.employee}</span>}</td>
            <td className="p-3">{row.previousCard === undefined ? '—' : row.previousCard ?? t('employeeMatching')}</td><td className="p-3">{row.nextCard === undefined ? row.cardId || '—' : row.nextCard ?? t('employeeMatching')}</td><td className="p-3">{['assign', 'replace', 'reset'].includes(row.operation) ? t(row.operation) : row.operation || '—'}</td>
            <td className="max-w-sm p-3">{'result' in row ? <span className="font-medium">{t(String(row.result))}</span> : !row.issues.length && t(row.effect)}<ul className="space-y-1">{row.issues.map(issue => <li key={issue}>{t(issue)}</li>)}</ul></td>
          </tr>)}
        </tbody></table></div>
        {!result && <><p className="text-sm text-muted-foreground">{t('reviewHelp')}</p>{replacements && <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" className="mt-1" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>{t('confirmReplacements')}</span></label>}</>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button className="min-h-11" variant="secondary" disabled={busy} onClick={close}>{t(result ? 'close' : 'cancel')}</Button>
          <Button className="min-h-11" variant="secondary" disabled={busy} onClick={errors}>{t('downloadErrors')}</Button>
          {!result && <Button className="min-h-11" disabled={busy || !selection.length || !!replacements && !confirmed} onClick={() => send('confirm')}>{t(busy ? 'working' : 'confirm')}</Button>}
        </div>
      </>}
    </Card>}
  </section>;
}
