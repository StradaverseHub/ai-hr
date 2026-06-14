'use client';

import { useTranslations } from 'next-intl';

type Col = { key: string; label: string };

/** Client-side CSV export of an already-rendered report table (Layer A — no server round-trip). */
export function DownloadCsv({
  columns,
  rows,
  filename,
}: {
  columns: Col[];
  rows: Record<string, unknown>[];
  filename: string;
}) {
  const t = useTranslations('components.downloadCsv');
  function download() {
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      columns.map((c) => esc(c.label)).join(','),
      ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(',')),
    ].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <button
      type="button"
      onClick={download}
      className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
    >
      {t('button')}
    </button>
  );
}
