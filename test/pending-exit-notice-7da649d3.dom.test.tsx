/** 7da649d3 — the Employment tab's notice for a scheduled exit and the "scheduled" provenance under the
 * Resignation Information dates, rendered with the actual components in all six locales. Rev 2 (owner decision
 * 2026-11-25): the notice names the Resignation Date and the last working day, and payroll pays up to the
 * Resignation Date; the Termination's former "Resignation Date" box reads "Tender Resignation Date". Fictional data
 * only; the database behaviour is proven in scheduled-termination-exit-dates-7da649d3.test.ts. */
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
import { personnelFormLabel } from '../lib/personnel-form-contract';
import { MOVEMENT_FORM_IDS } from '../lib/movement-form-contract';

const locales = { en, ms, zh, ta, th, vi: viMessages };
// The reporter's example: Resignation Date 20-Nov-2026, Last Working Day 10-Nov-2026 (annual leave cleared after it).
const termination: PendingExit = { id: 'fictional-exit', label: 'Termination', behaviour: 'termination', effectiveDate: '2026-11-20', lastWorkingDate: '2026-11-10', resignationDate: '2026-11-20' };
const messageAt = (messages: unknown, key: string): string | undefined => {
  const value = key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), messages);
  return typeof value === 'string' ? value : undefined;
};
const href = (id: string) => `/admin/personnel/fictional-employment?tab=careerMovement&movement=${id}`;
afterEach(cleanup);

describe('7da649d3 pending exit notice', () => {
  it('names the Resignation Date and last working day, the kept placement and payroll to the Resignation Date, in every locale', () => {
    for (const [locale, messages] of Object.entries(locales)) {
      const info = messages.people.detail.employmentInfo;
      expect(info.pendingExitPayroll, locale).toContain('{date}');
      const { unmount } = render(<NextIntlClientProvider locale={locale} messages={messages}><PendingExitNotice exit={termination} /></NextIntlClientProvider>);
      const notice = screen.getByRole('region', { name: info.pendingExitTitle.replace('{kind}', 'Termination') });
      const items = within(notice).getAllByRole('listitem').map((item) => item.textContent);
      expect(items, locale).toEqual([
        info.pendingExitLastDay.replace('{lastDay}', '10-Nov-2026').replace('{date}', '20-Nov-2026'),
        info.pendingExitPlacement,
        info.pendingExitPayroll.replace('{date}', '20-Nov-2026'),
      ]);
      unmount();
    }
  });

  it('reads as the approved English copy: pay runs to the Resignation Date, not the earlier last working day', () => {
    render(<NextIntlClientProvider locale="en" messages={en}><PendingExitNotice exit={termination} /></NextIntlClientProvider>);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Resignation Date 20-Nov-2026 · last working day 10-Nov-2026',
      'Department, position and direct superior stay the same until then',
      'Payroll pays up to the Resignation Date 20-Nov-2026',
    ]);
    expect(en.people.detail.employmentInfo.resignationMovementNote).toContain('payroll pays up to the Resignation Date');
    expect(en.people.detail.employmentInfo.resignationMovementNote).toContain('Serving Notice until the last working day');
  });

  it('shows a resignation without the placement line; with no Resignation Date recorded it names only the last working day', () => {
    const { rerender } = render(<NextIntlClientProvider locale="en" messages={en}><PendingExitNotice exit={{ ...termination, label: 'Resignation', behaviour: 'resignation', effectiveDate: '2026-10-20' }} /></NextIntlClientProvider>);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Resignation Date 20-Nov-2026 · last working day 10-Nov-2026', 'Payroll pays up to the Resignation Date 20-Nov-2026']);
    rerender(<NextIntlClientProvider locale="en" messages={en}><PendingExitNotice exit={{ ...termination, label: 'Resignation', behaviour: 'resignation', effectiveDate: '2026-10-20', resignationDate: null }} /></NextIntlClientProvider>);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Last working day 10-Nov-2026']);
  });

  it("relabels the Termination's tender box \"Tender Resignation Date\" in every locale, with the new date hints", () => {
    const id = MOVEMENT_FORM_IDS.resignationDate;
    expect(personnelFormLabel(id, (_key, fallback) => fallback)).toBe('Tender Resignation Date');
    for (const [locale, messages] of Object.entries(locales)) {
      const info = messages.people.detail.employmentInfo, form = messages.people.detail.movement.form as unknown as Record<string, string | undefined>;
      const shown = personnelFormLabel(id, (key, fallback) => messageAt(messages, key) ?? fallback);
      // The same words the Employment tab uses for the Tender Resignation Date, and not the Resignation Date's.
      expect(shown, locale).toBe(info.tenderResignationDate);
      expect(shown, locale).not.toBe(info.resignationDate);
      for (const key of ['tenderResignationDateHint', 'lastWorkingDayHint', 'terminationEffectiveDateHint']) expect(form[key]?.trim(), `${locale} ${key}`).toBeTruthy();
    }
    expect(personnelFormLabel(id, (key, fallback) => messageAt(en, key) ?? fallback)).toBe('Tender Resignation Date');
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
