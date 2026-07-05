'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { inputCls } from '@/components/ui';

/**
 * Overtime report export control (Overtime Rate Config, #e410da83). A format picker (CSV / XLSX / PDF) +
 * download link to the admin-gated route app/attendance/ot-report/export. Rendered only for admins on the
 * attendance month-summary block; the route re-checks admin + company scope, so this is UI convenience only.
 */
export function OtReportExport({
  month,
  labels,
}: {
  month: string;
  labels: { export: string; csv: string; xlsx: string; pdf: string; format: string };
}) {
  const [format, setFormat] = useState<'csv' | 'xlsx' | 'pdf'>('csv');
  const href = `/attendance/ot-report/export?month=${encodeURIComponent(month)}&format=${format}`;
  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="ot-report-format">
        {labels.format}
      </label>
      <select
        id="ot-report-format"
        aria-label={labels.format}
        value={format}
        onChange={(e) => setFormat(e.target.value as 'csv' | 'xlsx' | 'pdf')}
        className={`${inputCls} h-7 w-auto py-0 text-xs`}
      >
        <option value="csv">{labels.csv}</option>
        <option value="xlsx">{labels.xlsx}</option>
        <option value="pdf">{labels.pdf}</option>
      </select>
      <a
        href={href}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <Download className="size-3.5" />
        {labels.export}
      </a>
    </div>
  );
}
