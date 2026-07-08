'use client';

/**
 * Per-report action menu (client island) for the hub list — favourite/share toggles, duplicate, delete
 * (with confirm), and the four export formats. Extracted to a client component so the interactive menu
 * open/close state and the delete confirm live client-side; the mutating actions are server actions
 * invoked via <form action={...}> so no client fetch/handler crosses the RSC boundary.
 */
import { useState } from 'react';
import {
  toggleFavouriteAction,
  setSharedAction,
  duplicateReportAction,
  deleteReportAction,
} from './actions';

type Labels = {
  favourite: string;
  unfavourite: string;
  share: string;
  unshare: string;
  duplicate: string;
  delete: string;
  deleteConfirm: string;
  exportCsv: string;
  exportXlsx: string;
  exportPdf: string;
  exportDocx: string;
};

export function ReportRowActions({
  id,
  isFavourite,
  shared,
  labels,
}: {
  id: string;
  isFavourite: boolean;
  shared: boolean;
  labels: Labels;
}) {
  const [open, setOpen] = useState(false);
  const item = 'block w-full px-3 py-1.5 text-left text-sm hover:bg-accent/60';
  const exportHref = (fmt: string) => `/reports/export?id=${encodeURIComponent(id)}&format=${fmt}`;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label="Actions"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md px-2 py-1 text-muted-foreground transition hover:bg-accent/60 hover:text-foreground"
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            <form action={toggleFavouriteAction}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="next" value={String(!isFavourite)} />
              <button type="submit" className={item}>
                {isFavourite ? labels.unfavourite : labels.favourite}
              </button>
            </form>
            <form action={setSharedAction}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="next" value={String(!shared)} />
              <button type="submit" className={item}>
                {shared ? labels.unshare : labels.share}
              </button>
            </form>
            <form action={duplicateReportAction}>
              <input type="hidden" name="id" value={id} />
              <button type="submit" className={item}>
                {labels.duplicate}
              </button>
            </form>
            <div className="border-t border-border" />
            <a className={item} href={exportHref('csv')}>{labels.exportCsv}</a>
            <a className={item} href={exportHref('xlsx')}>{labels.exportXlsx}</a>
            <a className={item} href={exportHref('pdf')}>{labels.exportPdf}</a>
            <a className={item} href={exportHref('docx')}>{labels.exportDocx}</a>
            <div className="border-t border-border" />
            <form
              action={deleteReportAction}
              onSubmit={(e) => {
                if (!confirm(labels.deleteConfirm)) e.preventDefault();
              }}
            >
              <input type="hidden" name="id" value={id} />
              <button type="submit" className={`${item} text-red-600 dark:text-red-400`}>
                {labels.delete}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
