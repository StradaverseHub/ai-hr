'use client';

import { useTranslations } from 'next-intl';

/** Triggers the browser print dialog (Save as PDF). Hidden in the printed output itself. */
export function PrintButton({ label }: { label?: string }) {
  const t = useTranslations('components.printButton');
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted print:hidden"
    >
      {label ?? t('print')}
    </button>
  );
}
