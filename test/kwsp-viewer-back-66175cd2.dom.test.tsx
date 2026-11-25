/**
 * Board 66175cd2 (plan r1, commit 2) — A CLEAR BACK BUTTON AT THE TOP LEFT OF BORANG A AND BBCD.
 *
 * `StatutoryPdfViewer` draws Back first in the header, before the form's name, when a page asks for
 * `backPlacement="leading"` — and nowhere else on the header, so there is one way back, not two. Every other
 * form keeps the trailing link it had (the default). The href is the caller's: Borang A and BBCD pass the
 * criteria step re-opened on the same company, year, month and payroll cycles. All data is fictional.
 */
import { describe, expect, it, vi } from 'vitest';
import { render as mount, screen } from '@testing-library/react';
import * as React from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { criteriaReturnHref } from '../app/payroll/statutory-forms/criteria';

const render = (ui: React.ReactElement) => mount(<NextIntlClientProvider locale="en" messages={en}>{ui}</NextIntlClientProvider>);

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { StatutoryPdfViewer } from '../components/statutory-pdf-viewer';

const COMPANY = '33333333-3333-4333-8333-333333333333';
const BACK = criteriaReturnHref('my.borang-a', { companyId: COMPANY, year: '2026', month: '10', runSeqs: [1, 3] });

function viewer(backPlacement?: 'leading' | 'trailing') {
  return (
    <StatutoryPdfViewer
      title="Borang A — monthly contribution form (KWSP)"
      subtitle="Contoh Teknologi Sdn Bhd · October 2026"
      pdfUrl="/payroll/borang-a/pdf?companyId=c&periodKey=2026-10&disposition=inline"
      downloads={[{ href: '/payroll/borang-a/pdf?companyId=c&periodKey=2026-10', label: 'Download the form' }]}
      back={{ href: BACK, label: en.payroll.statutoryForms.viewer_back }}
      backPlacement={backPlacement}
      openInNewTabLabel="Open in new tab"
      frameTitle="Borang A — preview"
    />
  );
}

describe('66175cd2 — Back on Borang A and BBCD', () => {
  it('keeps company, year, month and every ticked payroll cycle on the way back', () => {
    expect(BACK).toBe(`/payroll/statutory-forms/open?form=my.borang-a&companyId=${COMPANY}&year=2026&month=10&run=1&run=3`);
  });

  it('draws Back first in the header, before the form name, as the one way back', () => {
    const { container } = render(viewer('leading'));
    const back = screen.getByRole('link', { name: /Back/ });
    expect(back.getAttribute('href')).toBe(BACK);
    expect(back.getAttribute('data-viewer-back')).toBe('leading');
    expect(back.textContent).toContain('←');
    const header = container.querySelector('header')!;
    const heading = screen.getByRole('heading', { name: 'Borang A — monthly contribution form (KWSP)' });
    // In document order, Back comes before the title…
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and before the downloads, and it is the header's only Back.
    const links = [...header.querySelectorAll('a')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());
    expect(links[0]).toBe('← Back');
    expect(links.filter((l) => l?.includes('Back'))).toHaveLength(1);
  });

  it('leaves every other form’s trailing link exactly where it was', () => {
    const { container } = render(viewer());
    const header = container.querySelector('header')!;
    const links = [...header.querySelectorAll('a')].map((a) => a.textContent?.trim() ?? '');
    // The download first, Back last and plain, as before 66175cd2.
    expect(links[0]).toContain('Download the form');
    expect(links[links.length - 1]).toBe('Back');
    expect(links.filter((l) => l.includes('Back'))).toHaveLength(1);
    expect(header.querySelector('[data-viewer-back]')).toBeNull();
  });
});
