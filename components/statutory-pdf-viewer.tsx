import Link from 'next/link';
import type { ReactNode } from 'react';
import { btnGhost, btnPrimary } from '@/components/ui';
import { StatutoryPdfFrame } from './statutory-pdf-frame';

/**
 * r402 (item f3cf2444) — THE IN-APP VIEWER FOR A STATUTORY PDF, written once for every form that has one.
 *
 * WHAT THE REPORTER ASKED FOR. Preview used to open the form in a separate browser tab. They asked for it
 * to open inside the system, across the full width, with the form's name and the Version choice along the
 * top, and with the form scaled to fit the width rather than stretched. This is that screen's whole
 * layout; a page supplies the words and the URLs.
 *
 * ⚠️ IT RENDERS NO DOCUMENT OF ITS OWN. The body is an <iframe> of the form's EXISTING inline route — the
 * download's own bytes served `inline` — so the operator is looking at the file they will send, drawn by
 * the one renderer that draws it. An HTML rendition here would be a second renderer of a statutory form
 * (lib/ea-pdf.ts refuses one in as many words). An <iframe> rather than <embed>/<object> because the CSP
 * says `object-src 'none'` and `frame-ancestors 'self'` (next.config.ts): a same-origin frame is allowed,
 * a plugin element is not.
 *
 * ⚠️ AND IT GRANTS NOTHING. The framed route runs its own gate (scopedAdmin, shapes, scope, allowlists) on
 * every load, and the download link is that form's existing download route. A page that renders this
 * viewer must still check scope before printing a company name in the header, because the header is
 * this page's, not the PDF's.
 *
 * GENERIC ON PURPOSE — the EPF Borang A, SOCSO Borang 8A and LHDN CP39 / CP22A items embed it next:
 *   • `title` / `subtitle` — the form's name and what it is for (company · period), already translated;
 *   • `pdfUrl` — the inline route WITH its query string; the frame and "Open in new tab" both use it;
 *   • `downloads` — one or more download links; the first is the primary action (Borang A has a PDF and
 *     an upload file, CP39 a PDF and a text file);
 *   • `controls` — anything that belongs beside the title, e.g. `StatutoryVersionSwitch`;
 *   • `sidePanel` — an optional column beside the document (a checklist, totals, notes) that stacks under
 *     it on a phone;
 *   • `back` — where Back goes. A link, not `history.back()`, so it works from a pasted URL too.
 * No string lives in this file: every caller passes its own, in the viewer's language.
 *
 * Server component: nothing here needs state. The frame is a small client island (`./statutory-pdf-frame`)
 * only because it has to watch what the frame loaded.
 *
 * THEMES. Classic uses the house buttons and a muted backdrop; Monolith's look is appended as `monolith:`
 * utilities, which do not match at all in Classic (the r400 pattern).
 */
export type StatutoryPdfDownload = { href: string; label: string };

export type StatutoryPdfViewerProps = {
  /** The form's name, translated ("Form C.P.8A (EA)"). */
  title: string;
  /** One line under/after the title — company and period. */
  subtitle?: string;
  /** The form's inline PDF route, query string included. */
  pdfUrl: string;
  /** Download links; the first renders as the primary button. */
  downloads: StatutoryPdfDownload[];
  back: { href: string; label: string };
  /** "Open in new tab" — some phone and tablet browsers show only the first page of a framed PDF. */
  openInNewTabLabel: string;
  /** The frame's accessible name. */
  frameTitle: string;
  /** Controls beside the title, e.g. the Version switch. */
  controls?: ReactNode;
  /** An optional column beside the document. */
  sidePanel?: ReactNode;
};

/**
 * The frame's source: the inline route exactly, plus a PDF open parameter asking the browser's viewer to
 * fit the page to the frame's WIDTH. A fragment never reaches the server, so the request is byte-for-byte
 * the existing preview's. Browsers that ignore the parameter still show the same file.
 */
export const pdfFrameSrc = (pdfUrl: string) => `${pdfUrl}#view=FitH`;

const MONO_PILL =
  'monolith:h-11 monolith:rounded-full monolith:border monolith:border-ink monolith:bg-ink monolith:px-5 monolith:text-[14px] monolith:font-semibold monolith:text-bone monolith:hover:bg-ink/85';
const MONO_TXT =
  'monolith:h-auto monolith:min-h-11 monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-ink monolith:bg-transparent monolith:px-0.5 monolith:text-[15px] monolith:font-medium monolith:text-ink monolith:hover:border-signal-text monolith:hover:bg-transparent monolith:hover:text-signal-text';

export function StatutoryPdfViewer({
  title,
  subtitle,
  pdfUrl,
  downloads,
  back,
  openInNewTabLabel,
  frameTitle,
  controls,
  sidePanel,
}: StatutoryPdfViewerProps) {
  const [primary, ...rest] = downloads;
  return (
    <div data-statutory-pdf-viewer className="w-full space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-border pb-4 monolith:border-ink">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight monolith:text-[20px] monolith:font-medium">{title}</h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground monolith:font-mono monolith:text-[11px] monolith:uppercase monolith:tracking-[0.12em] monolith:text-mid">
              {subtitle}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {controls}
          {primary && (
            <a href={primary.href} className={`${btnPrimary} ${MONO_PILL}`}>
              {primary.label}
            </a>
          )}
          {rest.map((d) => (
            <a key={d.href} href={d.href} className={`${btnGhost} ${MONO_TXT}`}>
              {d.label}
            </a>
          ))}
          <Link href={back.href} className={`${btnGhost} ${MONO_TXT}`}>
            {back.label}
          </Link>
        </div>
      </header>

      <div className={sidePanel ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]' : undefined}>
        <div className="space-y-3 rounded-lg bg-muted/40 p-2 sm:p-6 monolith:rounded-none monolith:bg-pressed">
          {/* ONE A4 PAGE AT ITS TRUE SHAPE: the frame keeps the 210:297 ratio at every width, so the browser
              scales the page to fit rather than stretching it. Wider than a page would be useful only for
              squinting at a cell, so it stops at 64rem; a second page scrolls inside the frame. */}
          <StatutoryPdfFrame
            src={pdfFrameSrc(pdfUrl)}
            inlinePath={pdfUrl.split('?')[0]}
            title={frameTitle}
            className="mx-auto block aspect-[210/297] w-full max-w-5xl border border-border bg-white shadow-sm monolith:border-hairline monolith:shadow-none"
          />
          <p className="text-center">
            <a
              href={pdfUrl}
              target="_blank"
              rel="noopener"
              className="text-sm text-primary underline-offset-4 hover:underline monolith:border-b monolith:border-ink monolith:text-ink monolith:no-underline"
            >
              {openInNewTabLabel}
            </a>
          </p>
        </div>
        {sidePanel && <aside className="min-w-0 space-y-4">{sidePanel}</aside>}
      </div>
    </div>
  );
}
