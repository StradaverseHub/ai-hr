'use client';

/**
 * Card wrapper for a single analytics chart: title + the chart (passed as children) + a per-chart image
 * export menu (PNG / JPEG / PDF). Reuses the design-system Card; the export menu calls lib/chart-export
 * against the chart's stable SVG `id`. Client component (the export menu is interactive).
 */
import { useState } from 'react';
import { Card } from '@/components/ui';
import { exportChart, type ChartImageFormat } from '@/lib/chart-export';

const FORMATS: { fmt: ChartImageFormat; label: string }[] = [
  { fmt: 'png', label: 'PNG' },
  { fmt: 'jpeg', label: 'JPEG' },
  { fmt: 'pdf', label: 'PDF' },
];

export function ChartCard({
  title,
  svgId,
  filenameBase,
  exportLabel,
  footnote,
  emptyLabel,
  isEmpty = false,
  children,
}: {
  title: string;
  svgId: string;
  filenameBase: string;
  exportLabel: string;
  footnote?: string;
  emptyLabel?: string;
  isEmpty?: boolean;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);

  const onExport = async (fmt: ChartImageFormat) => {
    setBusy(true);
    try {
      await exportChart(svgId, fmt, filenameBase);
    } catch {
      // Best-effort: a failed raster shouldn't break the page; the on-screen chart is the source of truth.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {!isEmpty && (
          <div className="inline-flex items-center gap-1.5" aria-label={exportLabel}>
            {FORMATS.map(({ fmt, label }) => (
              <button
                key={fmt}
                type="button"
                disabled={busy}
                onClick={() => onExport(fmt)}
                className="rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                ↓ {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="p-4">
        {isEmpty ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{emptyLabel}</div>
        ) : (
          children
        )}
        {footnote && !isEmpty && <p className="mt-2 text-[11px] text-muted-foreground">{footnote}</p>}
      </div>
    </Card>
  );
}
