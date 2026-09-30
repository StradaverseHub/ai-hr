/**
 * r302 (board 6c9802c9) · MY LEAVE — THE DASHBOARD, THE RING, UPCOMING LEAVE, THE HISTORY TABS AND VIEW, RENDERED.
 *
 * All of it is client state or client-only markup: the ring's arcs, the Details and View side-sheets, the tab
 * bar. A server render and a curl of /leave see none of the panels, so a MISSING_MESSAGE or FORMATTING_ERROR in
 * them would pass tsc, the suite, `next build` and a dev-server log (CLAUDE.md §8). This file mounts the real
 * components under the SHIPPING catalogues, in all six locales, with next-intl's onError collected and asserted
 * empty — and clicks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import { MyLeaveDashboard, type MyLeaveDashboardCard } from '../components/leave/my-leave-dashboard';
import { LeaveBalanceRing, ringDrawable, ringSegments } from '../components/leave/leave-balance-ring';
import { UpcomingLeave } from '../components/leave/upcoming-leave';
import { LeaveHistoryCards, type LeaveHistoryEntry } from '../components/leave/leave-history-cards';
import type { LeaveEntitlementBreakdown } from '../core/read';
import { formatDays } from '../lib/day-format';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];
type MyLeaveMsgs = (typeof en)['leave']['myLeave'];
const ml = (loc: Locale) => (CATALOGUES[loc] as unknown as { leave: { myLeave: MyLeaveMsgs } }).leave.myLeave;
/**
 * 7da0a4e7 (r340) — THIS GUARD PINNED LABELS THIS ROUND DELIBERATELY CHANGED, SO IT IS UPDATED, NOT
 * LOOSENED. The reporter found the same figure named three different things across screens; the names
 * now live once, in lib/leave-figure-labels.ts, under the shared `leaveFigure` namespace. My Leave's own
 * `canApplyFor` ("You can apply for") and `earnedSoFar` ("Earned so far") were two of those private
 * names. The assertions below still read the expected words out of the CATALOGUE rather than hardcoding
 * them — they just read them from the namespace that now owns them, so all six locales stay pinned.
 */
const lf = (loc: Locale) =>
  (CATALOGUES[loc] as unknown as { leaveFigure: Record<string, string> }).leaveFigure;

afterEach(() => cleanup());

function mount(loc: Locale, node: React.ReactNode) {
  const errors: string[] = [];
  const view = render(
    <NextIntlClientProvider locale={loc} messages={CATALOGUES[loc]} onError={(e) => errors.push(String((e as Error).message ?? e))}>
      {node}
    </NextIntlClientProvider>,
  );
  return { view, errors };
}

const breakdown = (over: Partial<LeaveEntitlementBreakdown> = {}): LeaveEntitlementBreakdown =>
  ({
    leaveTypeId: 'lt-annual',
    leaveType: 'Annual Leave',
    asOf: '2026-12-31',
    cycleStart: '2026-01-01',
    eligibleDays: 14,
    // 845903a3 (r313) — joined before the leave year, so nothing prorates: the Entitlement line
    // shows the band itself, which keeps this fixture's figures exactly as they were.
    entitlement: { annualEntitlementDays: 14, prorated: false, eligibleCalendarDays: null,
      daysInLeaveYear: null, unroundedEntitlementDays: 14, displayEntitlementDays: 14, roundingApplied: false },
    entitlementStatus: 'granted',
    entitlementTemplateName: 'Annual — all staff',
    currentYearEntitlement: 10.5,
    currentYearEntitlementRounded: 10.5, // r335: no rounding rule in this fixture
    monthlyAccruedToDate: 10.5,
    carriedForward: 0,
    carryForwardRemaining: 0,
    carryForwardExpiryDate: null,
    forfeited: 0,
    otherAdjustments: 0,
    balance: 7.5,
    pendingApproval: 2,
    broughtForward: 0,
    configAdjustments: 0,
    systemAdjustments: 0,
    forfeitedThisCycle: 0,
    takenThisCycle: 3,
    configAdjustmentItems: [],
    adjustments: 0,
    totalEntitlement: 10.5,
    totalAvailable: 5.5,
    transactions: [],
    essView: {
      eligible: true,
      ytdEntitled: true,
      broughtForward: true,
      adjustment: true,
      total: true,
      taken: true,
      pendingApproval: true,
      forfeited: true,
      available: true,
    },
    formulaExplanations: {},
    ...over,
  }) as LeaveEntitlementBreakdown;

const card = (over: Partial<MyLeaveDashboardCard> = {}): MyLeaveDashboardCard => ({
  leaveTypeId: 'lt-annual',
  leaveType: 'Annual Leave',
  code: 'ANNUAL',
  color: null,
  icon: null,
  role: 'annual',
  placement: 'primary',
  annualLeave: true,
  cycleStart: '2026-01-01',
  cycleEnd: '2026-12-31',
  asOf: '2026-12-31',
  isCurrentCycle: true,
  entitlement: 14,
  earnedSoFar: 10.5,
  taken: 3,
  pending: 2,
  balance: 7.5,
  canApplyFor: 5.5,
  remaining: 5.5,
  balanceIncludesLater: null,
  expiringSoon: null,
  hasEntitlement: true,
  takenOnly: false,
  entitlementStatus: 'granted',
  sharedBalance: null,
  essView: { available: true, taken: true },
  breakdown: breakdown(),
  ...over,
});

const medical = card({
  leaveTypeId: 'lt-sick',
  leaveType: 'Medical Leave',
  code: 'SICK',
  role: 'sick',
  annualLeave: false,
  entitlement: 14,
  earnedSoFar: 14,
  taken: 1,
  pending: 0,
  balance: 13,
  canApplyFor: 13,
  remaining: 13,
  breakdown: breakdown({ leaveTypeId: 'lt-sick', leaveType: 'Medical Leave' }),
});
const unpaid = card({
  leaveTypeId: 'lt-unpaid',
  leaveType: 'Unpaid Leave',
  code: 'UNPAID',
  role: null,
  placement: 'secondary',
  annualLeave: false,
  entitlement: null,
  earnedSoFar: null,
  taken: 2,
  pending: null,
  balance: null,
  canApplyFor: null,
  remaining: null,
  hasEntitlement: false,
  takenOnly: true,
  entitlementStatus: 'no_entitlement_table',
  breakdown: breakdown({ leaveTypeId: 'lt-unpaid', leaveType: 'Unpaid Leave', entitlementStatus: 'no_entitlement_table' }),
});

describe('THE DASHBOARD, in every locale', () => {
  it.each(LOCALES)('%s — the ring for Annual Leave, a smaller card for Medical, Taken only for Unpaid; Details opens without an As-at form', async (loc) => {
    const L = ml(loc);
    const { errors } = mount(loc, <MyLeaveDashboard cards={[card(), medical, unpaid]} locale={loc} />);

    // ONE ring, and it is Annual Leave's.
    const rings = screen.getAllByTestId('leave-ring-card');
    expect(rings).toHaveLength(1);
    const ring = rings[0];
    expect(within(ring).getByText('Annual Leave')).toBeTruthy();
    expect(within(ring).getAllByTestId('leave-balance-ring')).toHaveLength(1);
    // The legend is the text equivalent: every figure is printed, with its label. UPDATED BY the r302 fix pass
    // (verifier defect 5): the legend is the ring's arcs — Taken, Pending approval, You can apply for, Not earned
    // yet. test/r302fp-my-leave-fixpass.dom.test.tsx measures arcs against it.
    //
    // UPDATED AGAIN BY cac9a3a1 (r369), and the claim it retires is quoted because the prose outlives the kernel:
    // "Balance is the big number in the middle, labelled Balance". It was, and Balance is gross of pending while
    // the green arc around it is the available figure — so the card stated two figures for one thing (the reporter
    // read 11.50 in the middle and 10.50 in the Available Balance row). The middle is now that row itself.
    for (const [label, value] of [
      [L.entitlement, 14],
      [lf(loc).earnedToDate, 10.5],
      [L.taken, 3],
      [L.pendingApproval, 2],
      [lf(loc).availableBalance, 5.5],
      [L.notEarnedYet, 3.5],
    ] as const) {
      const dt = within(ring).getByText(label, { selector: 'dt' });
      expect(dt.parentElement!.querySelector('dd')!.textContent).toBe(formatDays(value));
    }
    // cac9a3a1 — the centre is the Available Balance row's own value (5.50 on this fixture, not the 7.50 Balance),
    // under the green arc's own name. Read off the same overlay a person looks at, caption included.
    const centreBox = within(ring).getByTestId('leave-balance-ring').querySelector('div[aria-hidden="true"]')!;
    const centreSpans = [...centreBox.querySelectorAll('span')];
    expect(centreSpans[0].textContent).toBe(formatDays(5.5));
    expect(centreSpans[1].textContent).toBe((L.centreCaption as string).replace('{label}', lf(loc).availableBalance));
    expect(centreSpans[0].textContent, 'the retired Balance figure is not in the middle').not.toBe(formatDays(7.5));
    // "You can apply for" prints the card's figure verbatim (the Apply popup's, on the server).
    expect(within(ring).getByTestId('can-apply-for').textContent).toContain(lf(loc).availableBalance);
    expect(within(ring).getByTestId('can-apply-for').textContent).toContain(formatDays(5.5));
    // The SVG carries a one-sentence label for screen readers.
    expect(within(ring).getByRole('img').getAttribute('aria-label')).toContain('Annual Leave');

    // Medical: a smaller card, no ring, same figures.
    const cards = screen.getAllByTestId('leave-type-card');
    const med = cards.find((c) => within(c).queryByText('Medical Leave'))!;
    expect(within(med).queryByTestId('leave-balance-ring')).toBeNull();
    expect(within(med).getByText(formatDays(13), { selector: 'p' })).toBeTruthy();
    expect(within(med).getByText(L.entitlement)).toBeTruthy();
    // Unpaid: Taken only — no Balance line, no Entitlement, no "You can apply for".
    const un = cards.find((c) => within(c).queryByText('Unpaid Leave'))!;
    expect(within(un).getByText(L.takenOnlyCaption)).toBeTruthy();
    expect(within(un).getByText(formatDays(2))).toBeTruthy();
    expect(within(un).queryByText(L.balance)).toBeNull();
    expect(within(un).queryByText(L.entitlement)).toBeNull();
    expect(within(un).queryByTestId('can-apply-for')).toBeNull();

    // Details → the Leave Summary side-sheet for THAT year, and no As-at form (the Year selector replaced it).
    await userEvent.click(within(ring).getByRole('button', { name: L.detailsFor.replace('{type}', 'Annual Leave') }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('input[name="asOf"]')).toBeNull();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('a figure HR hid prints an em dash, and the ring is not drawn from the others', () => {
    const hidden = card({ balance: null, canApplyFor: null, remaining: null });
    expect(ringDrawable(hidden)).toBe(false);
    mount('en', <MyLeaveDashboard cards={[hidden]} locale="en" />);
    expect(screen.queryByTestId('leave-balance-ring')).toBeNull();
    const c = screen.getByTestId('leave-type-card');
    expect(within(c).getByText('—', { selector: 'p' })).toBeTruthy();
    expect(within(c).queryByTestId('can-apply-for')).toBeNull();
  });

  it('an earlier year shows no "You can apply for"; an anniversary cycle shows its own dates', () => {
    mount('en', <MyLeaveDashboard cards={[card({ isCurrentCycle: false, canApplyFor: null, annualLeave: false, cycleStart: '2025-10-01', cycleEnd: '2026-09-30' })]} locale="en" />);
    expect(screen.queryByTestId('can-apply-for')).toBeNull();
    expect(screen.getByText(/^Leave year .*2025 – .*2026$/)).toBeTruthy();
  });

  it('no cards at all: a sentence, no invented figures', () => {
    mount('en', <MyLeaveDashboard cards={[]} locale="en" />);
    expect(screen.getByText(en.leave.myLeave.noCards)).toBeTruthy();
  });
});

describe('THE RING draws what the figures say, and nothing for a hidden figure', () => {
  // UPDATED BY the r302 fix pass (verifier defect 5): the third arc is the card's own "You can apply for" (an
  // earlier year's remaining available), not Balance − Pending worked out here; Not earned yet is listed only when
  // there is any; and an overdrawn figure is not drawn as a zero arc beside a legend that says −2 — the ring is not
  // drawn at all (the card prints the figures instead).
  it('arcs for taken, pending, you can apply for and not-yet-earned; zero arcs are not drawn', () => {
    expect(ringSegments({ entitlement: 14, earnedSoFar: 10.5, taken: 3, pending: 2, balance: 7.5, remaining: 5.5 })).toEqual([
      { key: 'taken', value: 3 },
      { key: 'pending', value: 2 },
      { key: 'available', value: 5.5 },
      { key: 'unearned', value: 3.5 },
    ]);
    const full = { entitlement: 14, earnedSoFar: 14, taken: 0, pending: 0, balance: 14, remaining: 14 };
    const { container } = render(
      <LeaveBalanceRing segments={ringSegments(full).map((s) => ({ ...s, label: s.key, display: formatDays(s.value) }))} label="x" centre="14.00" centreCaption="Balance" />,
    );
    expect([...container.querySelectorAll('circle[data-segment]')].map((c) => c.getAttribute('data-segment'))).toEqual(['available']);
    // An overdrawn "You can apply for" is not an arc at all: no ring.
    expect(ringDrawable({ entitlement: 14, earnedSoFar: 14, taken: 16, pending: 0, balance: -2, remaining: -2 })).toBe(false);
    expect(ringSegments({ entitlement: 14, earnedSoFar: 14, taken: 16, pending: 0, balance: -2, remaining: -2 })).toEqual([]);
    expect(ringSegments({ entitlement: 14, earnedSoFar: 14, taken: 1, pending: null, balance: 13, remaining: 13 })).toEqual([]);
  });
});

describe('UPCOMING LEAVE, in every locale', () => {
  it.each(LOCALES)('%s — dates, days and status per row; a sentence when there is none', (loc) => {
    const leave = (CATALOGUES[loc] as unknown as { leave: { status: Record<string, string> } }).leave;
    const { errors, view } = mount(
      loc,
      <UpcomingLeave
        locale={loc}
        rows={[
          { id: 'a', leaveType: 'Annual Leave', startDate: '2026-10-12', endDate: '2026-10-14', days: 3, statusKey: 'approved', statusLabel: leave.status.approved },
          { id: 'b', leaveType: 'Medical Leave', startDate: '2026-11-02', endDate: '2026-11-02', days: 0.5, statusKey: 'pending', statusLabel: leave.status.pending },
        ]}
      />,
    );
    const items = within(screen.getByTestId('upcoming-leave')).getAllByRole('listitem');
    expect(items.map((li) => within(li).getAllByText(/Leave$/)[0].textContent)).toEqual(['Annual Leave', 'Medical Leave']);
    expect(within(items[0]).getByText(leave.status.approved)).toBeTruthy();
    expect(items[0].textContent).toContain(formatDays(3));
    expect(items[1].textContent).toContain(formatDays(0.5));
    view.unmount();
    mount(loc, <UpcomingLeave locale={loc} rows={[]} />);
    expect(screen.getByText(ml(loc).upcomingEmpty)).toBeTruthy();
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

const entry = (over: Partial<LeaveHistoryEntry> = {}): LeaveHistoryEntry => ({
  id: 'lr-1',
  leaveType: 'Annual Leave',
  groupLabel: null,
  startDate: '2026-10-12',
  endDate: '2026-10-14',
  days: 3,
  appliedOn: '2026-09-01',
  reason: 'Family trip',
  splitRows: null,
  sessionSuffix: null,
  sessionLabel: 'Full day',
  statusKey: 'pending',
  statusLabel: 'Pending',
  approverLine: 'Waiting for Dora Head · Level 2 of 2',
  approvalProgress: [
    { label: 'Submitted', detail: '01 Sep 2026, 09:00', state: 'done' },
    { label: 'Level 1 · Direct manager · Marcus Manager', detail: 'Approved 02 Sep 2026, 10:00', state: 'done' },
    { label: 'Level 2 · Department Head · Dora Head', detail: 'Waiting for approval', state: 'current' },
    { label: 'Approved', detail: null, state: 'upcoming' },
  ],
  rejectionReason: null,
  cancellation: null,
  cancelPendingLabel: null,
  cancelProgress: null,
  documentHref: null,
  documentLabel: null,
  actions: null,
  dateOutcome: null,
  ...over,
});

describe('MY LEAVE HISTORY — tabs, rows and View, in every locale', () => {
  it.each(LOCALES)('%s — four tab links, the row’s approver line, and View with progress, reason and submitted date', async (loc) => {
    const L = ml(loc);
    const leave = (CATALOGUES[loc] as unknown as { leave: { status: Record<string, string>; viewDetails: string } }).leave;
    const tabs = (['pending', 'approved', 'rejected', 'cancelled'] as const).map((k, i) => ({
      key: k,
      label: leave.status[k],
      count: i + 1,
      href: `/leave?hTab=${k}`,
      active: k === 'pending',
    }));
    const { errors } = mount(loc, <LeaveHistoryCards entries={[entry()]} locale={loc} tabs={tabs} emptyLabel={L.emptyPending} />);

    const nav = screen.getByRole('navigation', { name: L.historyTabsLabel });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/leave?hTab=pending', '/leave?hTab=approved', '/leave?hTab=rejected', '/leave?hTab=cancelled']);
    expect(links.map((a) => a.getAttribute('aria-current'))).toEqual(['page', null, null, null]);

    const row = screen.getByTestId('leave-history-row');
    expect(within(row).getByText('Waiting for Dora Head · Level 2 of 2')).toBeTruthy();
    expect(within(row).getByText('Pending')).toBeTruthy();
    expect(row.textContent).toContain(formatDays(3));
    // No action, document link or outcome on the row itself.
    expect(within(row).queryByRole('link')).toBeNull();

    await userEvent.click(within(row).getByRole('button', { name: leave.viewDetails }));
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByText(L.reason, { selector: 'dt' })).toBeTruthy();
    expect(within(panel).getByText('Family trip')).toBeTruthy();
    expect(within(panel).getByText(L.submitted, { selector: 'dt' })).toBeTruthy();
    expect(within(panel).getByText(L.approvalProgress)).toBeTruthy();
    const progress = within(within(panel).getByTestId('approval-progress')).getAllByRole('listitem');
    expect(progress).toHaveLength(4);
    // The current level is the highlighted one.
    expect(progress.map((li) => li.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
    expect(progress[2].textContent).toContain('Dora Head');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('a rejection shows its reason; a cancellation shows who and when; an empty tab says so', async () => {
    const { view } = mount(
      'en',
      <LeaveHistoryCards
        locale="en"
        entries={[
          entry({ id: 'r', statusKey: 'rejected', statusLabel: 'Rejected', approverLine: 'Rejected by Marcus Manager', rejectionReason: 'Year-end close' }),
          entry({
            id: 'c',
            leaveType: 'Medical Leave',
            statusKey: 'cancelled',
            statusLabel: 'Cancelled',
            approverLine: 'Cancelled by Hana HR',
            cancellation: { lines: ['Cancelled by Hana HR · 03 Sep 2026, 11:00'], reason: 'Duplicate application' },
          }),
        ]}
      />,
    );
    const rows = screen.getAllByTestId('leave-history-row');
    await userEvent.click(within(rows[0]).getByRole('button', { name: en.leave.viewDetails }));
    let panel = screen.getByRole('dialog');
    expect(within(panel).getByText(en.leave.myLeave.rejectionReason)).toBeTruthy();
    expect(within(panel).getByText('Year-end close')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(rows[1]).getByRole('button', { name: en.leave.viewDetails }));
    panel = screen.getByRole('dialog');
    expect(within(panel).getByText('Cancelled by Hana HR · 03 Sep 2026, 11:00')).toBeTruthy();
    expect(within(panel).getByText('Reason: Duplicate application')).toBeTruthy();
    view.unmount();

    mount('en', <LeaveHistoryCards locale="en" entries={[]} tabs={[]} emptyLabel={en.leave.myLeave.emptyCancelled} />);
    expect(screen.getByText(en.leave.myLeave.emptyCancelled)).toBeTruthy();
  });
});
