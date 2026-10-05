/**
 * r389 bc3e203d · LEAVE CREDIT HISTORY — what the island DRAWS from the rows the server hands it.
 *
 * The rows here are literal fixtures in the exact shape `listOwnLeaveCreditHistory` returns (the DB half is
 * test/r389-leave-credit-history.test.ts, which drives the kernel). This file pins the screen's promises
 * that no read can see: "—" for expiry and credit status unless approved, the orange days-left line at 30
 * and not at 31, Cancel on a pending row only and naming every date it withdraws, the read-only View panel
 * (the stored attendance snapshot or "Not recorded with this request", the single approval step with its
 * remarks, the credit's usage by date and leave type, a settlement in days and never money), and the filter
 * form's switch to the Approved tab when a Credit Status is chosen. Then it renders all of it in six
 * locales and fails on any missing message — the MISSING_MESSAGE class that passes tsc and the suite.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import zh from '../messages/zh.json';
const { push } = vi.hoisted(() => ({ push: vi.fn((_url: string) => undefined) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
import { LeaveCreditHistoryFilterForm, LeaveCreditHistoryTable } from '../components/leave/leave-credit-history';
import { dmy, type CreditHistoryLine, type CreditHistoryFilters } from '../lib/leave-credit-history';

const TODAY = '2026-10-05';
const plus = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const RL = '11111111-2222-4333-8444-555555555555';
const base = {
  fromTime: null,
  toTime: null,
  hours: null,
  days: 1,
  decidedOn: null,
  decidedTime: null,
  decidedByName: null,
  decisionNote: null,
  reason: 'Month-end payroll closing',
  shiftEnd: null,
  actualClockOut: null,
  eligibleMinutes: 480,
  credit: null,
} as const;
const line = (over: Partial<CreditHistoryLine> & Pick<CreditHistoryLine, 'lineId' | 'requestId' | 'workedDate' | 'approvalStatus'>): CreditHistoryLine => ({
  ...base,
  requestRef: over.requestId.replace(/-/g, '').slice(0, 8).toUpperCase(),
  dayType: 'rest_day',
  submittedOn: over.workedDate,
  ...over,
});

const PENDING = line({
  lineId: 'l-pend',
  requestId: '3f9a2c1d-0000-4000-8000-000000000001',
  workedDate: '2026-09-26',
  approvalStatus: 'pending',
  dayType: 'workday',
  fromTime: '18:00:00',
  toTime: '22:00:00',
  hours: 4,
  days: 0.5,
  shiftEnd: '18:00:00',
  actualClockOut: '22:05:00',
  eligibleMinutes: 240,
});
// A second date in the SAME pending request: Cancel must name both.
const PENDING_TWIN = line({ lineId: 'l-pend-2', requestId: PENDING.requestId, workedDate: '2026-09-27', approvalStatus: 'pending' });
const REJECTED = line({
  lineId: 'l-rej',
  requestId: '4a000000-0000-4000-8000-000000000002',
  workedDate: '2026-09-06',
  approvalStatus: 'rejected',
  decidedOn: '2026-09-08',
  decidedTime: '10:15',
  decisionNote: 'You were rostered to work that day.',
});
const USED = line({
  lineId: 'l-used',
  requestId: '5b000000-0000-4000-8000-000000000003',
  workedDate: '2026-08-28',
  approvalStatus: 'approved',
  decidedOn: '2026-09-01',
  decidedTime: '09:42',
  decidedByName: 'Daniel Tan',
  decisionNote: 'Approved — month-end closing.',
  credit: {
    accrualId: 'a-used',
    status: 'used',
    expiresOn: '2026-11-28',
    daysCredited: 1,
    used: 1,
    remaining: 0,
    settled: null,
    reversedOn: null,
    usage: [{ leaveRequestId: 'lr-1', startDate: '2026-09-12', endDate: '2026-09-12', leaveTypeId: RL, days: 1 }],
  },
});
const AVAILABLE_30 = line({
  lineId: 'l-av30',
  requestId: '6c000000-0000-4000-8000-000000000004',
  workedDate: '2026-07-30',
  approvalStatus: 'approved',
  decidedOn: '2026-07-31',
  decidedTime: '12:00',
  credit: { accrualId: 'a30', status: 'available', expiresOn: plus(30), daysCredited: 1, used: 0, remaining: 1, settled: null, reversedOn: null, usage: [] },
});
const AVAILABLE_31 = line({
  lineId: 'l-av31',
  requestId: '6d000000-0000-4000-8000-000000000005',
  workedDate: '2026-07-29',
  approvalStatus: 'approved',
  credit: { accrualId: 'a31', status: 'available', expiresOn: plus(31), daysCredited: 1, used: 0, remaining: 1, settled: null, reversedOn: null, usage: [] },
});
const PAID_OUT = line({
  lineId: 'l-paid',
  requestId: '7e000000-0000-4000-8000-000000000006',
  workedDate: '2026-05-01',
  dayType: 'holiday',
  approvalStatus: 'approved',
  credit: { accrualId: 'ap', status: 'paid_out', expiresOn: '2026-08-01', daysCredited: 1, used: 0, remaining: 0, settled: { kind: 'paid_out', days: 1, on: '2026-08-02' }, reversedOn: null, usage: [] },
});
const EXPIRED = line({
  lineId: 'l-exp',
  requestId: '8f000000-0000-4000-8000-000000000007',
  workedDate: '2026-04-01',
  dayType: 'off_day',
  approvalStatus: 'approved',
  credit: { accrualId: 'ae', status: 'expired', expiresOn: '2026-07-01', daysCredited: 0.5, used: 0, remaining: 0, settled: { kind: 'expired', days: 0.5, on: '2026-07-02' }, reversedOn: null, usage: [] },
});
const ROWS = [PENDING, PENDING_TWIN, REJECTED, USED, AVAILABLE_30, AVAILABLE_31, PAID_OUT, EXPIRED];

const CATALOGUES = { en, ms, ta, th, vi: viMessages, zh } as const;
type Locale = keyof typeof CATALOGUES;
const noop = async () => {};

function show(locale: Locale = 'en', errors: string[] = []) {
  return render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]} onError={(e) => errors.push(`${e.code}: ${e.message}`)} getMessageFallback={({ key }) => `!!${key}`}>
      <LeaveCreditHistoryTable
        rows={ROWS}
        today={TODAY}
        leaveTypeNames={{ [RL]: 'Replacement Leave' }}
        requestDates={{ [PENDING.requestId]: [PENDING.workedDate, PENDING_TWIN.workedDate] }}
        cancelAction={noop}
        back="tab=all&size=20"
      />
    </NextIntlClientProvider>,
  );
}
const tableRows = () => within(screen.getByTestId('lch-table')).getAllByTestId('lch-row');
const rowOf = (l: CreditHistoryLine) => tableRows().find((r) => r.textContent?.includes(dmy(l.workedDate)))!;

describe('r389 · the Leave Credit History table', () => {
  it('draws the reporter’s columns, "—" for expiry and credit status unless approved, and badges by kind', () => {
    show();
    const heads = within(screen.getByTestId('lch-table')).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Date Worked', 'Day Type', 'Extended Hours', 'Credit Days', 'Expiry Date', 'Applied On', 'Approval Status', 'Credit Status', 'Action']);
    expect(tableRows()).toHaveLength(ROWS.length);
    const pend = rowOf(PENDING);
    expect(pend.textContent).toContain('Working day');
    expect(pend.textContent).toContain('18:00 – 22:00 · 4.0h');
    expect(pend.textContent).toContain('0.50');
    expect(within(pend).queryByTestId('lch-credit-badge')).toBeNull();
    expect(within(pend).getAllByText('—').length).toBeGreaterThanOrEqual(2); // expiry + credit status
    const used = rowOf(USED);
    expect(within(used).getByTestId('lch-approval-badge').textContent).toBe('Approved');
    expect(within(used).getByTestId('lch-credit-badge').textContent).toBe('Used');
    expect(used.textContent).toContain('28/11/2026');
    expect(rowOf(PAID_OUT).textContent).toContain('Public holiday');
    expect(within(rowOf(PAID_OUT)).getByTestId('lch-credit-badge').textContent).toBe('Paid out');
    expect(within(rowOf(EXPIRED)).getByTestId('lch-credit-badge').textContent).toBe('Expired');
  });

  it('shows the orange days-left line on an Available credit at 30 days, and not at 31', () => {
    show();
    expect(within(rowOf(AVAILABLE_30)).getByTestId('lch-days-left').textContent).toBe('30 days left');
    expect(within(rowOf(AVAILABLE_31)).queryByTestId('lch-days-left')).toBeNull();
    expect(within(screen.getByTestId('lch-table')).getAllByTestId('lch-days-left')).toHaveLength(1);
  });

  it('offers Cancel on pending rows only, and the confirmation names every date it withdraws', () => {
    show();
    const table = screen.getByTestId('lch-table');
    const cancels = within(table).getAllByTestId('lch-cancel');
    expect(cancels).toHaveLength(2); // the two dates of the one pending request
    expect(within(rowOf(USED)).queryByTestId('lch-cancel')).toBeNull();
    expect(within(rowOf(REJECTED)).queryByTestId('lch-cancel')).toBeNull();
    const form = cancels[0].closest('form')!;
    expect((form.querySelector('input[name="requestId"]') as HTMLInputElement).value).toBe(PENDING.requestId);
    expect((form.querySelector('input[name="back"]') as HTMLInputElement).value).toBe('tab=all&size=20');
    fireEvent.click(cancels[0]);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Cancel this Leave Credit request?');
    expect(dialog.textContent).toContain('26/09/2026, 27/09/2026');
  });

  it('View on a pending ordinary-day row: the stored attendance snapshot, one waiting approval step, no credit yet', () => {
    show();
    fireEvent.click(within(rowOf(PENDING)).getByTestId('lch-view'));
    const panel = screen.getByRole('dialog');
    expect(panel.textContent).toContain('Leave Credit request · Request 3F9A2C1D');
    const att = within(panel).getByTestId('lch-attendance');
    expect(att.textContent).toContain('18:00');
    expect(att.textContent).toContain('22:05');
    expect(att.textContent).toContain('240');
    expect(att.textContent).not.toContain('Not recorded with this request');
    const appr = within(panel).getByTestId('lch-approval');
    expect(appr.textContent).toContain('Waiting for approval');
    // Undecided: the level, and no name.
    expect(within(appr).getByTestId('lch-approval-level').textContent).toBe('Level 1');
    expect(within(panel).getByTestId('lch-usage').textContent).toContain('A credit is created only when the request is approved.');
  });

  it('View on a used rest-day credit: "Not recorded" where there is no snapshot, remarks, and usage by date and leave type', () => {
    show();
    fireEvent.click(within(rowOf(USED)).getByTestId('lch-view'));
    const panel = screen.getByRole('dialog');
    const att = within(panel).getByTestId('lch-attendance');
    expect(within(att).getAllByText('Not recorded with this request')).toHaveLength(2); // shift end + clock-out
    const appr = within(panel).getByTestId('lch-approval');
    expect(appr.textContent).toContain('Approved · 01/09/2026 09:42');
    // r389 / migration 0512 — the approver's name beside the level, as the approved mockup draws it.
    expect(within(appr).getByTestId('lch-approval-level').textContent).toBe('Level 1 · Daniel Tan');
    expect(appr.textContent).toContain('Approved — month-end closing.');
    expect(within(panel).getByTestId('lch-usage-used').textContent).toMatch(/^1\.00 days?$/);
    expect(within(panel).getByTestId('lch-usage-remaining').textContent).toMatch(/^0\.00 days?$/);
    const usage = within(panel).getByTestId('lch-usage-list');
    expect(usage.textContent).toMatch(/1\.00 days? · 12\/09\/2026 · Replacement Leave/);
    // Named by its date and leave type — never by a made-up reference.
    expect(usage.textContent).not.toMatch(/L-\d+/);
  });

  it('View on a paid-out and an expired credit: the settlement in days, and no money anywhere', () => {
    show();
    fireEvent.click(within(rowOf(PAID_OUT)).getByTestId('lch-view'));
    let panel = screen.getByRole('dialog');
    expect(within(panel).getByTestId('lch-settled').textContent).toMatch(/^Paid out instead of taken: 1\.00 days?\. The credit expired and was settled on 02\/08\/2026\.$/);
    expect(panel.textContent).not.toMatch(/RM|MYR|\$/);
    fireEvent.click(within(panel).getAllByRole('button', { name: 'Close' })[0]);
    fireEvent.click(within(rowOf(EXPIRED)).getByTestId('lch-view'));
    panel = screen.getAllByRole('dialog').at(-1)!;
    expect(within(panel).getByTestId('lch-settled').textContent).toMatch(/^Forfeited: 0\.50 days?\. The credit expired and was settled on 02\/07\/2026\.$/);
  });

  it('renders the table and every panel in all six locales without a missing or broken message', () => {
    for (const locale of Object.keys(CATALOGUES) as Locale[]) {
      const errors: string[] = [];
      const view = show(locale, errors);
      for (const l of [PENDING, USED, PAID_OUT, EXPIRED, REJECTED]) {
        fireEvent.click(within(rowOf(l)).getByTestId('lch-view'));
      }
      expect(errors, locale).toEqual([]);
      expect(document.body.textContent, locale).not.toContain('!!');
      view.unmount();
    }
  });
});

describe('r389 · the filter form', () => {
  // The page hands the form the CURRENT year already selected when the address names none (the default).
  const filters = (over: Partial<CreditHistoryFilters> = {}): CreditHistoryFilters => ({ tab: 'pending', creditStatus: null, dayType: null, year: 2026, from: null, to: null, ...over });
  const showForm = (f: CreditHistoryFilters) =>
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <LeaveCreditHistoryFilterForm filters={f} years={[2026, 2025]} size={20} clearHref="/leave/credit?size=20" />
      </NextIntlClientProvider>,
    );

  it('the Year starts on the year the page selected, offers All, and applying drops every empty field from the address', () => {
    push.mockClear();
    showForm(filters());
    const form = screen.getByTestId('lch-filter-form');
    const year = within(form).getByLabelText('Year') as HTMLSelectElement;
    expect(year.value).toBe('2026');
    expect([...year.options].map((o) => [o.value, o.textContent])).toEqual([
      ['all', 'All'],
      ['2026', '2026'],
      ['2025', '2025'],
    ]);
    fireEvent.submit(form);
    expect(push).toHaveBeenLastCalledWith('/leave/credit?tab=pending&size=20&year=2026');
    // All years is a VALUE, kept in the address — dropping it would read as the default year.
    fireEvent.change(year, { target: { value: 'all' } });
    fireEvent.change(within(form).getByLabelText('Credit Status'), { target: { value: 'used' } });
    fireEvent.submit(form);
    expect(push).toHaveBeenLastCalledWith('/leave/credit?tab=approved&size=20&credit=used&year=all');
    expect(push.mock.calls.every(([url]) => !/=(&|$)/.test(url))).toBe(true);
  });

  it('an address on All years opens the form on All', () => {
    showForm(filters({ year: null }));
    expect((within(screen.getByTestId('lch-filter-form')).getByLabelText('Year') as HTMLSelectElement).value).toBe('all');
  });

  it('choosing a Credit Status switches the applied tab to Approved; choosing All gives the tab back', () => {
    showForm(filters());
    const form = screen.getByTestId('lch-filter-form');
    const tab = () => (form.querySelector('input[name="tab"]') as HTMLInputElement | null)?.value;
    expect(tab()).toBe('pending');
    const credit = within(form).getByLabelText('Credit Status') as HTMLSelectElement;
    expect([...credit.options].map((o) => o.textContent)).toEqual(['All', 'Available', 'Used', 'Expired', 'Paid out', 'Reversed']);
    fireEvent.change(credit, { target: { value: 'available' } });
    expect(tab()).toBe('approved');
    fireEvent.change(credit, { target: { value: '' } });
    expect(tab()).toBe('pending');
    expect([...(within(form).getByLabelText('Day Type') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'All',
      'Working day',
      'Rest day',
      'Off day',
      'Public holiday',
    ]);
    expect((form.querySelector('input[name="size"]') as HTMLInputElement).value).toBe('20');
    expect(within(form).getByRole('link', { name: 'Clear' })).toHaveAttribute('href', '/leave/credit?size=20');
    expect(form).toHaveAttribute('method', 'GET');
    expect(form).toHaveAttribute('action', '/leave/credit');
  });
});
