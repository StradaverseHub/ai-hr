/**
 * r402 (item f3cf2444) — THE IN-APP STATUTORY PDF VIEWER, RENDERED.
 *
 * The reporter asked for Preview to open the form inside the system, full width, with the form's name and
 * the Version choice along the top. The property everything else rests on is that the frame shows the
 * EXISTING inline route with EXACTLY the parameters the download uses — otherwise the document on screen
 * is not the one the Download button saves. So these cases build the URLs the way the two viewer pages do
 * (`viewerQuery`) and read them back off the rendered markup: the frame's source, the new-tab link, the
 * download and Back must all carry one query string.
 *
 * The viewer is generic (the EPF / SOCSO / LHDN items embed it next), so the slots are exercised too.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { StatutoryPdfViewer, pdfFrameSrc } from '../components/statutory-pdf-viewer';
import { StatutoryVersionSwitch } from '../components/statutory-version-switch';
import { viewerIds, viewerPairs, viewerQuery } from '../app/payroll/statutory-forms/viewer-params';

const COMPANY = '33333333-3333-4333-8333-333333333333';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function eaViewer(lang: string) {
  const params = { companyId: COMPANY, year: '2025', lang, ids: [A, B] };
  const query = viewerQuery(params);
  return {
    params,
    query,
    ui: (
      <StatutoryPdfViewer
        title="Form C.P.8A (EA)"
        subtitle="Demo Sdn Bhd · 2025"
        pdfUrl={`/payroll/statutory-forms/ea/preview?${query}`}
        downloads={[{ href: `/payroll/statutory-forms/ea/download?${query}`, label: 'Download' }]}
        back={{ href: `/payroll/statutory-forms/ea?${query}`, label: 'Back' }}
        openInNewTabLabel="Open in new tab"
        frameTitle="Form C.P.8A (EA) — preview"
        controls={
          <StatutoryVersionSwitch
            action="/payroll/statutory-forms/ea/view"
            name="lang"
            value={lang}
            options={[
              { value: 'en', label: 'English' },
              { value: 'ms', label: 'Bahasa Malaysia' },
            ]}
            hidden={viewerPairs(params, { withLang: false })}
            label="Version"
            submitLabel="Show this version"
          />
        }
      />
    ),
  };
}

describe('r402 · the viewer frames the EXISTING inline route, with exactly the download’s parameters', () => {
  it('the iframe src is the preview route + the params (+ only a fit-width fragment)', () => {
    const { ui, query } = eaViewer('ms');
    const { container } = render(ui);
    const frame = container.querySelector('iframe')!;
    expect(frame, 'a frame, not <embed>/<object> (CSP object-src none)').toBeTruthy();
    expect(container.querySelector('embed, object')).toBeNull();
    const src = frame.getAttribute('src')!;
    const [base, fragment] = src.split('#');
    expect(base).toBe(`/payroll/statutory-forms/ea/preview?${query}`);
    expect(fragment, 'the fragment never reaches the server; it only asks the viewer to fit the width').toBe('view=FitH');
    expect(src).toBe(pdfFrameSrc(`/payroll/statutory-forms/ea/preview?${query}`));
    // The params themselves, read back — the version chosen and every ticked person.
    const q = new URL(base, 'https://x.local').searchParams;
    expect(q.get('companyId')).toBe(COMPANY);
    expect(q.get('year')).toBe('2025');
    expect(q.get('lang')).toBe('ms');
    expect(q.getAll('id')).toEqual([A, B]);
    expect(frame.getAttribute('title')).toBe('Form C.P.8A (EA) — preview');
  });

  it('Download, Open in new tab and Back all carry the SAME query as the frame', () => {
    const { ui, query } = eaViewer('en');
    render(ui);
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(`/payroll/statutory-forms/ea/download?${query}`);
    const tab = screen.getByRole('link', { name: 'Open in new tab' });
    expect(tab.getAttribute('href')).toBe(`/payroll/statutory-forms/ea/preview?${query}`);
    expect(tab.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe(`/payroll/statutory-forms/ea?${query}`);
    expect(screen.getByRole('heading', { level: 1, name: 'Form C.P.8A (EA)' })).toBeTruthy();
  });

  it('keeps the page at A4 proportions and the full width of its container', () => {
    const { ui } = eaViewer('en');
    const { container } = render(ui);
    const cls = container.querySelector('iframe')!.getAttribute('class')!;
    expect(cls).toContain('aspect-[210/297]');
    expect(cls).toContain('w-full');
    expect(container.querySelector('[data-statutory-pdf-viewer]')!.getAttribute('class')).toContain('w-full');
  });
});

describe('r402 · the Version switch re-submits the same view with the other language', () => {
  it('posts back to the viewer carrying company, year and every ticked person, and the chosen version', () => {
    const { ui } = eaViewer('en');
    render(ui);
    const select = screen.getByRole('combobox', { name: 'Version' }) as HTMLSelectElement;
    expect(select.value).toBe('en');
    expect([...select.options].map((o) => o.value)).toEqual(['en', 'ms']);
    const form = select.closest('form')!;
    expect(form.getAttribute('action')).toBe('/payroll/statutory-forms/ea/view');
    expect(form.getAttribute('method')).toBe('get');
    select.value = 'ms';
    const fd = new FormData(form);
    expect(fd.get('companyId')).toBe(COMPANY);
    expect(fd.get('year')).toBe('2025');
    expect(fd.getAll('id')).toEqual([A, B]);
    // ONE lang — the switch's own — never a stale hidden copy of the old one beside it.
    expect(fd.getAll('lang')).toEqual(['ms']);
    expect(screen.getByRole('button', { name: 'Show this version' })).toBeTruthy();
  });
});

describe('r402 · the viewer is generic: several downloads and an optional side panel', () => {
  it('renders the first download as primary, the rest beside it, and the side panel slot', () => {
    render(
      <StatutoryPdfViewer
        title="Borang A"
        pdfUrl="/payroll/borang-a/preview.pdf?companyId=c&period=2025-01"
        downloads={[
          { href: '/payroll/borang-a/pdf?x=1', label: 'Download PDF' },
          { href: '/payroll/borang-a/file?x=1', label: 'Download upload file' },
        ]}
        back={{ href: '/payroll/statutory-forms', label: 'Back' }}
        openInNewTabLabel="Open in new tab"
        frameTitle="Borang A — preview"
        sidePanel={<p>Totals panel</p>}
      />,
    );
    expect(screen.getByRole('link', { name: 'Download PDF' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download upload file' })).toBeTruthy();
    expect(screen.getByText('Totals panel').closest('aside')).toBeTruthy();
    // No Version switch unless a caller passes one.
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('r402 · viewer params are shape-checked and de-duplicated', () => {
  it('drops anything that is not a UUID and keeps the first of each', () => {
    expect(viewerIds([A, 'not-a-uuid', B, A])).toEqual([A, B]);
    expect(viewerIds(A)).toEqual([A]);
    expect(viewerIds(undefined)).toEqual([]);
  });
  it('orders the query company, year, lang, form extras, then the ids', () => {
    expect(
      viewerQuery({ companyId: 'c', year: '2025', lang: 'ms', ids: [A], extra: [{ name: 'selectedDate', value: '2026-02-01' }] }),
    ).toBe(`companyId=c&year=2025&lang=ms&selectedDate=2026-02-01&id=${A}`);
  });
});
