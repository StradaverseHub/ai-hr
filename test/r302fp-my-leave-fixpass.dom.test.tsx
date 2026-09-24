/**
 * r302 fix pass (board 6c9802c9) · MY LEAVE, RENDERED — the ring legend is the ring (D5), the card and its Details
 * agree (D2), the "includes later leave years" line (D1) and a per-date rejection's localized date list (D7).
 * Every arm is mounted under the SHIPPING catalogues with next-intl's onError collected.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import { LeaveHistoryCards, type LeaveHistoryEntry } from '../components/leave/leave-history-cards';
import type { LeaveEntitlementBreakdown } from '../core/read';
import { formatDays } from '../lib/day-format';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];
type MyLeaveMsgs = Record<string, string>;
const ml = (loc: Locale) => (CATALOGUES[loc] as unknown as { leave: { myLeave: MyLeaveMsgs } }).leave.myLeave;

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
    entitlementTemplateName: null,
    currentYearEntitlement: 14,
    currentYearEntitlementRounded: 14, // r335: no rounding rule in this fixture
    monthlyAccruedToDate: 14,
    carriedForward: 0,
    carryForwardRemaining: 0,
    carryForwardExpiryDate: null,
    forfeited: 0,
    otherAdjustments: 0,
    balance: 14,
    pendingApproval: 0,
    broughtForward: 0,
    configAdjustments: 0,
    systemAdjustments: 0,
    forfeitedThisCycle: 0,
    takenThisCycle: 0,
    configAdjustmentItems: [],
    adjustments: 0,
    totalEntitlement: 14,
    totalAvailable: 14,
    transactions: [],
    essView: { eligible: true, ytdEntitled: true, broughtForward: true, adjustment: true, total: true, taken: true, pendingApproval: true, forfeited: true, available: true },
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
  earnedSoFar: 14,
  taken: 0,
  pending: 0,
  balance: 14,
  canApplyFor: 14,
  remaining: 14,
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

// ── D5 · the ring ───────────────────────────────────────────────────────────────────────────────────────────

const hexToRgb = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const CIRCUMFERENCE = 2 * Math.PI * 42;
const num = (s: string | null | undefined) => (s == null ? Number.NaN : Number(s.replace(/[^\d.-]/g, '')));

/**
 * Reads the ring card the way a person does: every legend row that carries a colour swatch, and every arc in the
 * SVG. Then asserts the decision — each legend entry is labelled as its arc and shows exactly the arc's value; arc
 * lengths are proportional to the legend values; the legend values sum to the ring total.
 */
function auditRing(ring: HTMLElement) {
  const legend = [...ring.querySelectorAll<HTMLElement>('span[aria-hidden]')]
    .filter((s) => s.style.background)
    .map((s) => {
      const row = s.parentElement!;
      return {
        color: s.style.background,
        label: (row.querySelector('dt') ?? row).textContent!.trim(),
        valueText: row.querySelector('dd')?.textContent ?? null,
      };
    });
  const arcs = [...ring.querySelectorAll('circle[data-segment]')].map((c) => ({
    color: hexToRgb(c.getAttribute('stroke')!),
    len: Number(c.getAttribute('stroke-dasharray')!.split(' ')[0]),
    title: c.querySelector('title')?.textContent ?? null,
  }));
  expect(legend.length, 'the ring has a legend').toBeGreaterThan(0);
  const values = legend.map((l) => num(l.valueText));
  const arcsIn = (color: string) => arcs.filter((a) => a.color === color);
  // First the defect as a person sees it: a legend colour with a figure must have an arc in that colour.
  legend.forEach((l, i) => {
    if (values[i] > 0) expect(arcsIn(l.color), `"${l.label}" ${l.valueText} has exactly one arc in its colour`).toHaveLength(1);
    if (values[i] === 0) expect(arcsIn(l.color), `"${l.label}" is 0 — no arc`).toHaveLength(0);
  });
  for (const l of legend) expect(l.valueText, `legend "${l.label}" shows the value of its arc`).not.toBeNull();
  const legendTotal = values.reduce((a, v) => a + v, 0);
  const drawn = arcs.reduce((a, arc) => a + arc.len, 0);
  expect(drawn, 'the arcs close the ring').toBeCloseTo(CIRCUMFERENCE, 6);
  legend.forEach((l, i) => {
    if (values[i] === 0) return;
    const [arc] = arcsIn(l.color);
    expect(arc.len / CIRCUMFERENCE, `"${l.label}" arc length ∝ its legend value`).toBeCloseTo(values[i] / legendTotal, 6);
    expect(arc.title, 'the arc is labelled exactly as its legend entry').toBe(`${l.label} ${l.valueText}`);
  });
  // No arc without a legend entry: the legend values ARE the ring total.
  for (const a of arcs) expect(legend.some((l) => l.color === a.color), 'every arc is in the legend').toBe(true);
  return { legend, arcs, legendTotal };
}

describe('D5 · the ring legend is the ring', () => {
  it('Balance 7, Pending 7: no green "Balance 7.00" over an arc that draws nothing — You can apply for 0.00, Pending 7.00', () => {
    const L = ml('en');
    const { errors } = mount('en', <MyLeaveDashboard cards={[card({ pending: 7, balance: 7, canApplyFor: 0, remaining: 0 })]} locale="en" />);
    const ring = screen.getByTestId('leave-ring-card');
    const { legend } = auditRing(ring);
    expect(legend.map((l) => [l.label, l.valueText])).toEqual([
      [L.taken, formatDays(0)],
      [L.pendingApproval, formatDays(7)],
      [L.canApplyFor, formatDays(0)],
    ]);
    // The big centre number stays Balance, labelled Balance.
    const centre = within(screen.getByTestId('leave-balance-ring')).getByText(formatDays(7));
    expect(centre.parentElement!.textContent).toContain(L.balance);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it.each(LOCALES)('%s — taken, pending, you can apply for and not earned yet: every arc ∝ its legend value', (loc) => {
    const L = ml(loc);
    const { errors } = mount(
      loc,
      <MyLeaveDashboard cards={[card({ earnedSoFar: 10.5, taken: 3, pending: 2, balance: 7.5, canApplyFor: 5.5, remaining: 5.5 })]} locale={loc} />,
    );
    const { legend, legendTotal } = auditRing(screen.getByTestId('leave-ring-card'));
    expect(legend.map((l) => l.label)).toEqual([L.taken, L.pendingApproval, L.canApplyFor, L.notEarnedYet]);
    expect(legend.map((l) => l.valueText)).toEqual([3, 2, 5.5, 3.5].map((v) => formatDays(v)));
    expect(legendTotal).toBe(14);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('a past year: the third arc is the year’s remaining available, labelled so — never "You can apply for"', () => {
    const L = ml('en');
    mount('en', <MyLeaveDashboard cards={[card({ isCurrentCycle: false, taken: 9, pending: 1, balance: 5, canApplyFor: null, remaining: 4 })]} locale="en" />);
    const { legend } = auditRing(screen.getByTestId('leave-ring-card'));
    expect(legend.map((l) => [l.label, l.valueText])).toEqual([
      [L.taken, formatDays(9)],
      [L.pendingApproval, formatDays(1)],
      [L.remaining, formatDays(4)],
    ]);
    expect(screen.queryByTestId('can-apply-for')).toBeNull();
  });

  it('a Balance that includes next year’s grant: the legend still sums to the ring', () => {
    mount('en', <MyLeaveDashboard cards={[card({ balance: 28, canApplyFor: 28, remaining: 28, balanceIncludesLater: { span: 'next', granted: 14, booked: 0, itemised: true } })]} locale="en" />);
    const { legendTotal } = auditRing(screen.getByTestId('leave-ring-card'));
    expect(legendTotal).toBe(28);
  });

  it('an overdrawn "You can apply for" cannot be an arc: the card is drawn without the ring, the figure in full', () => {
    mount('en', <MyLeaveDashboard cards={[card({ taken: 16, balance: -2, canApplyFor: -2, remaining: -2 })]} locale="en" />);
    expect(screen.queryByTestId('leave-balance-ring')).toBeNull();
    const c = screen.getByTestId('leave-type-card');
    expect(within(c).getByTestId('can-apply-for').textContent).toContain(formatDays(-2));
  });
});

// ── D1 · the line under Balance ─────────────────────────────────────────────────────────────────────────────

describe('D1 · "Includes next leave year" — itemised, or honestly not', () => {
  it.each(LOCALES)('%s — granted and booked on the ring card and on a small card; the unitemised sentence', (loc) => {
    const L = ml(loc);
    const later = { span: 'next' as const, granted: 14, booked: 2, itemised: true };
    const { errors, view } = mount(
      loc,
      <MyLeaveDashboard
        cards={[
          card({ balance: 26, canApplyFor: 26, remaining: 26, balanceIncludesLater: later }),
          card({ leaveTypeId: 'lt-sick', leaveType: 'Medical Leave', code: 'SICK', role: 'sick', annualLeave: false, balance: 12, canApplyFor: 12, remaining: 12, balanceIncludesLater: { ...later, granted: 0, span: 'later' } }),
        ]}
        locale={loc}
      />,
    );
    const lines = screen.getAllByTestId('balance-includes-later');
    expect(lines).toHaveLength(2);
    expect(within(screen.getByTestId('leave-ring-card')).getByTestId('balance-includes-later').textContent).toContain(formatDays(14));
    expect(lines[0].textContent).toContain(formatDays(2));
    expect(lines[1].textContent, 'only the non-zero parts').not.toContain(formatDays(0));
    expect(lines[1].textContent).toContain(formatDays(2));
    view.unmount();
    mount(loc, <MyLeaveDashboard cards={[card({ balance: 24, canApplyFor: 24, remaining: 24, balanceIncludesLater: { span: 'next', granted: 14, booked: 0, itemised: false } })]} locale={loc} />);
    const other = screen.getByTestId('balance-includes-later');
    expect(other.textContent).toBe(L.laterOther);
    expect(other.textContent).not.toContain(formatDays(14));
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('en wording', () => {
    mount('en', <MyLeaveDashboard cards={[card({ balance: 26, canApplyFor: 26, remaining: 26, balanceIncludesLater: { span: 'next', granted: 14, booked: 2, itemised: true } })]} locale="en" />);
    expect(screen.getByTestId('balance-includes-later').textContent).toBe('Includes next leave year: 14.00 days granted and 2.00 days booked');
  });
});

// ── D2 · the card and its Details side-sheet ────────────────────────────────────────────────────────────────

describe('D2 · the card and its Details side-sheet show the same Pending and the same available figure', () => {
  it('part-unpaid pending: card Pending 5 / You can apply for 0 — the side-sheet reads 5.00 and 0.00', async () => {
    const B = en.leave.breakdown.field;
    // The card as core/my-leave.ts now builds it for the current cycle: its breakdown carries the card's figures.
    const c = card({ entitlement: 5, earnedSoFar: 5, pending: 5, balance: 5, canApplyFor: 0, remaining: 0, breakdown: breakdown({ eligibleDays: 5, currentYearEntitlement: 5, totalEntitlement: 5, balance: 5, pendingApproval: 5, totalAvailable: 0 }) });
    mount('en', <MyLeaveDashboard cards={[c]} locale="en" />);
    const ring = screen.getByTestId('leave-ring-card');
    const cardPending = within(ring).getByText(en.leave.myLeave.pendingApproval, { selector: 'dt' }).parentElement!.querySelector('dd')!.textContent;
    const cardAvailable = within(ring).getByTestId('can-apply-for').querySelector('dd')!.textContent;
    await userEvent.click(within(ring).getByRole('button', { name: en.leave.myLeave.detailsFor.replace('{type}', 'Annual Leave') }));
    const panel = screen.getByRole('dialog');
    const panelValue = (label: string) => {
      const el = within(panel).getByText(label);
      return el.closest('.flex.items-baseline')!.lastElementChild!.textContent;
    };
    expect(panelValue(B.pendingApproval)).toBe(cardPending);
    expect(panelValue(B.availableBalance)).toBe(cardAvailable);
    expect([cardPending, cardAvailable]).toEqual([formatDays(5), formatDays(0)]);
  });
});

// ── D7 · a per-date rejection's reasons ─────────────────────────────────────────────────────────────────────

const entry = (over: Partial<LeaveHistoryEntry> = {}): LeaveHistoryEntry => ({
  id: 'lr-1',
  leaveType: 'Annual Leave',
  groupLabel: null,
  startDate: '2026-10-05',
  endDate: '2026-10-06',
  days: 2,
  appliedOn: '2026-09-01',
  reason: null,
  splitRows: null,
  sessionSuffix: null,
  sessionLabel: 'Full day',
  statusKey: 'rejected',
  statusLabel: 'Rejected',
  approverLine: 'Rejected by Marcus Manager',
  approvalProgress: null,
  rejectionReason: null,
  rejectedDates: null,
  cancellation: null,
  cancelPendingLabel: null,
  cancelProgress: null,
  documentHref: null,
  documentLabel: null,
  actions: null,
  dateOutcome: null,
  ...over,
});

describe('D7 · a per-date rejection lists each date in the viewer’s locale with its own reason', () => {
  it.each(LOCALES)('%s — no raw ISO date; the date formatted as the history formats dates', async (loc) => {
    const L = ml(loc);
    const leave = CATALOGUES[loc] as unknown as { leave: { viewDetails: string } };
    const { errors } = mount(
      loc,
      <LeaveHistoryCards
        locale={loc}
        entries={[entry({ rejectedDates: [{ date: '2026-10-05', reason: 'Short staffed' }, { date: '2026-10-06', reason: 'Audit week' }] })]}
      />,
    );
    await userEvent.click(within(screen.getByTestId('leave-history-row')).getByRole('button', { name: leave.leave.viewDetails }));
    const panel = screen.getByRole('dialog');
    const field = within(panel).getByText(L.rejectionReason, { selector: 'dt' }).parentElement!;
    const items = within(field).getAllByRole('listitem');
    const fmt = (iso: string) => new Intl.DateTimeFormat(loc, { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${iso}T00:00:00`));
    expect(items.map((li) => li.textContent)).toEqual([`${fmt('2026-10-05')} · Short staffed`, `${fmt('2026-10-06')} · Audit week`]);
    expect(field.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

// ── The page hands the islands the fixed data (the RSC is not rendered in a test) ───────────────────────────

describe('app/leave/page.tsx wires the fix pass into the history it builds', () => {
  const page = readFileSync(path.resolve(__dirname, '../app/leave/page.tsx'), 'utf8');
  it('D4: "Partially approved" and the date breakdown come from the application; D3: Applied is the application’s; D7: dates, not the audit string', () => {
    expect(page, 'the status badge reads the application outcome').toContain('isPartiallyApproved(r, approvalTrails.get(r.id))');
    expect(page, 'the history row too').toContain('const isPartial = isPartiallyApproved(r, trail);');
    expect(page, 'the View breakdown is the application’s outcome when there is one').toContain('applicationDateOutcomeRows(applicationOutcome)');
    expect(page, 'a split row’s Applied / Submitted is its application’s').toContain('trail?.submittedAt ?? new Date(r.appliedOn)');
    expect(page, 'a per-date rejection passes its dates to the island').toContain('rejectedDates: rejection && rejection.dates.length > 0 ? rejection.dates : null');
    expect(page, 'the pre-joined ISO reason read is not used on the page').not.toContain('ownLeaveRejectionReasons(');
    expect(page, 'Upcoming rows are asked about too, so their badge agrees').toContain('...upcomingRows.map((r) => r.id)');
  });
});
