'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ShiftImportIssue } from '@/lib/shift-import-workbook';
import { btnPrimary, Card } from '@/components/ui';

const endpoint = '/admin/attendance/shift-import';
type Preview = { fingerprint: string; total: number; issues: ShiftImportIssue[]; rows: { row: number; code: string; update: boolean }[] };
type Summary = { created: number; updated: number; skipped: number; failed: number; issues: ShiftImportIssue[] };

export function ShiftImportPanel() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const creates = preview?.rows.filter(row => !row.update).length ?? 0;
  const updates = (preview?.rows.length ?? 0) - creates;

  async function run(operation: 'preview' | 'confirm' | 'errors') {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const data = new FormData();
      data.set('file', file);
      data.set('operation', operation);
      if (operation === 'confirm' && preview) data.set('fingerprint', preview.fingerprint);
      const response = await fetch(endpoint, { method: 'POST', body: data });
      if (operation === 'errors' && response.ok) {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = 'Shift_Import_Errors.xlsx';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'The workbook could not be processed.');
      if (operation === 'preview') {
        setPreview(result.preview);
        setSummary(null);
      } else {
        setSummary(result.summary);
        setPreview(null);
        router.refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The workbook could not be processed.');
    } finally {
      setBusy(false);
    }
  }

  const issues = summary?.issues ?? preview?.issues ?? [];
  return <Card className="p-4">
    <details>
      <summary className="cursor-pointer font-medium">Import shifts from Excel</summary>
      <div className="mt-4 space-y-3 text-sm">
        <a className="text-primary underline" href={endpoint + '/template'}>Download Excel template</a>
        <label className="block">Completed workbook
          <input type="file" accept=".xlsx" className="ml-2" disabled={busy}
            onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); setSummary(null); setError(''); }} />
        </label>
        <button type="button" className={btnPrimary} disabled={!file || busy} onClick={() => void run('preview')}>Preview import</button>
        {busy && <p role="status">Processing workbook…</p>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {preview && <div className="space-y-2">
          <p role="status">{preview.total} shifts found. {creates} to create, {updates} to update, {preview.total - preview.rows.length} to skip.</p>
          <ul className="max-h-48 list-disc overflow-y-auto pl-5">
            {preview.rows.map(row => <li key={row.row}>Row {row.row} · {row.code} · {row.update ? 'Update' : 'Create'}</li>)}
          </ul>
          <button type="button" className={btnPrimary} disabled={busy || !preview.rows.length} onClick={() => void run('confirm')}>Confirm create and update</button>
          {issues.length > 0 && <button type="button" className="ml-3 text-primary underline" disabled={busy} onClick={() => void run('errors')}>Download errors</button>}
        </div>}
        {summary && <p role="status">Created {summary.created}, updated {summary.updated}, skipped {summary.skipped}, failed {summary.failed}.</p>}
        {issues.length > 0 && <ul className="max-h-48 list-disc overflow-y-auto pl-5">
          {issues.map((issue, index) => <li key={index}>{issue.sheet} · Row {issue.row} · {issue.field} · {issue.message}</li>)}
        </ul>}
      </div>
    </details>
  </Card>;
}
