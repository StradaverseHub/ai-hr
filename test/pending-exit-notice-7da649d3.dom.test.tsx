/** 7da649d3 — the Employment tab's notice for a scheduled exit and the "scheduled" provenance under the
 * Resignation Information dates, rendered with the actual components in all six locales. Fictional data only;
 * the database behaviour is proven in scheduled-termination-exit-dates-7da649d3.test.ts. */
vi.mock('next/link', () => ({
  __esModule: true,
  // A plain anchor: the App Router Link needs a router context this render has no provider for.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, ...rest }: any) => <a href={String(href)} {...rest}>{children}</a>,
}));
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json'; import ms from '../messages/ms.json'; import zh from '../messages/zh.json';
import ta from '../messages/ta.json'; import th from '../messages/th.json'; import viMessages from '../messages/vi.json';
import { PendingExitNotice, ResignationSourceNote, type PendingExit } from '../app/admin/personnel/[employmentId]/pending-exit-notice';

const locales = { en, ms, zh, ta, th, vi: viMessages };
const termination: PendingExit = { id: 'fictional-exit', label: 'Termination', behaviour: 'termination', effectiveDate: '2026-11-20', lastWorkingDate: '2026-11-20' };
const href = (id: string) => `/admin/personnel/fictional-employment?tab=careerMovement&movement=${id}`;
afterEach(cleanup);

describe('7da649d3 pending exit notice', () => {
  it('names the last working day, the kept placement and payroll to that day, in every locale', () => {
    for (const [locale, messages] of Object.entries(locales)) {
      const info = messages.people.detail.employmentInfo;
      const { unmount } = render(<NextIntlClientProvider locale={locale} messages={messages}><PendingExitNotice exit={termination} /></NextIntlClientProvider>);
      const notice = screen.getByRole('region', { name: info.pendingExitTitle.replace('{kind}', 'Termination') });
      const items = within(notice).getAllByRole('listitem').map((item) => item.textContent);
      expect(items, locale).toEqual([
        info.pendingExitLastDay.replace('{lastDay}', '20-Nov-2026').replace('{date}', '20-Nov-2026'),
        info.pendingExitPlacement,
        info.pendingExitPayroll,
      ]);
      unmount();
    }
  });

  it('shows a resignation without the placement line, and the termination date beside the last working day', () => {
    const { rerender } = render(<NextIntlClientProvider locale="en" messages={en}><PendingExitNotice exit={{ ...termination, label: 'Resignation', behaviour: 'resignation', effectiveDate: '2026-10-20' }} /></NextIntlClientProvider>);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Last working day 20-Nov-2026', 'Payroll pays up to the last working day']);
    rerender(<NextIntlClientProvider locale="en" messages={en}><PendingExitNotice exit={{ ...termination, effectiveDate: '2026-11-21' }} /></NextIntlClientProvider>);
    expect(screen.getByRole('region', { name: 'Termination scheduled' }).textContent).toContain('Last working day 20-Nov-2026 · employment ends 21-Nov-2026');
  });

  it('marks a scheduled date as scheduled in Movement with its effective date, and keeps the other sources', () => {
    for (const [locale, messages] of Object.entries(locales)) {
      const copy = messages.people.detail.resignationInformation;
      const { unmount } = render(<NextIntlClientProvider locale={locale} messages={messages}>
        <ResignationSourceNote source={{ kind: 'scheduled', movementId: 'fictional-exit', effectiveDate: '2026-11-20' }} href={href} />
      </NextIntlClientProvider>);
      const link = screen.getByRole('link', { name: copy.scheduledSource.replace('{date}', '20-Nov-2026') });
      expect(link, locale).toHaveAttribute('href', href('fictional-exit'));
      unmount();
    }
    render(<NextIntlClientProvider locale="en" messages={en}>
      <ResignationSourceNote source={{ kind: 'movement', movementId: 'applied-exit', effectiveDate: '2026-10-01' }} href={href} />
      <ResignationSourceNote source={{ kind: 'legacy' }} href={href} />
      <ResignationSourceNote source={undefined} href={href} />
    </NextIntlClientProvider>);
    expect(screen.getByRole('link', { name: 'Movement event · 01-Oct-2026' })).toHaveAttribute('href', href('applied-exit'));
    expect(screen.getByText(en.people.detail.resignationInformation.legacySource)).toBeInTheDocument();
    expect(screen.getByText(en.people.detail.resignationInformation.emptySource)).toBeInTheDocument();
  });
});
