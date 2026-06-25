'use client';

import { useTranslations } from 'next-intl';
import { buildTemplateCsv, type TemplateSpec } from '@/lib/import-template';

/**
 * Download a system-generated CSV upload template (headers + sample rows) for a paste-CSV importer.
 * Pure client-side, read-only — no server round-trip, no DomainEvent (nothing is written).
 * Sits beside the import controls; same button styling as <DownloadCsv />.
 */
export function DownloadTemplate({ spec }: { spec: TemplateSpec }) {
  const t = useTranslations('components.downloadTemplate');
  function download() {
    const csv = buildTemplateCsv(spec);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = spec.filename;
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
