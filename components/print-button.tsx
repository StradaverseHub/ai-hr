'use client';

/** Triggers the browser print dialog (Save as PDF). Hidden in the printed output itself. */
export function PrintButton({ label = 'Print / Save PDF' }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted print:hidden"
    >
      {label}
    </button>
  );
}
