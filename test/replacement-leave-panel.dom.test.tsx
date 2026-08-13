/**
 * Replacement Leave gets its OWN employee panel (feedback 00307068) — a rendering test, because the defect
 * was a rendering one.
 *
 * THE REPORTED DEFECT. An employee clicked the Replacement Leave card on My Leave and got the same nine-line
 * Leave Balance Summary (Eligible → YTD Entitled → … → Available Balance) that Annual and Medical get. That
 * layout cannot answer the question Replacement Leave raises, because Replacement Leave is not a yearly
 * allowance: it is a stack of separately earned credits, each approved on its own day and each lapsing on
 * its own date. The employee saw one lumped figure and could not tell how it was built up or which piece was
 * about to run out.
 *
 * A SOURCE-GREP TEST WOULD NOT HAVE CAUGHT IT AND WOULD NOT PROVE THE FIX. The whole defect lives in which
 * component a card mounts, so the assertion has to be "what does a reader SEE after clicking". This renders
 * the real LeaveCards island in jsdom and clicks the real card.
 *
 * BOTH DIRECTIONS ARE ASSERTED, and the second is the one that protects everyone else: Annual Leave must
 * still open the nine-line summary, unchanged. "Every other leave type keeps its current configuration
 * completely untouched" is half of what the reporter asked for, and it is the half a regression would hit.
 *
 * Scope note (inherited from client-pager.dom.test.tsx): jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic, not a visual regression.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { LeaveCards, type LeaveCardEntry } from '../components/leave/leave-cards';
import type { EntitlementBreakdownData } from '../components/leave/EntitlementBreakdown';
import { REPLACEMENT_COLUMN_KEYS } from '../core/ess-view';

// A breakdown envelope good enough for either panel to mount. The figures are the same reconciling fixture
// test/leave-details-panel.test.ts uses, so the summary path renders real numbers rather than em-dashes.
const breakdown = (leaveTypeId: string, leaveType: string): EntitlementBreakdownData => ({
  leaveTypeId,
  leaveType,
  asOf: '2026-08-03',
  cycleStart: '2026-01-01',
  eligibleDays: 20,
  currentYearEntitlement: 12,
  monthlyAccruedToDate: 2,
  carriedForward: 4,
  carryForwardRemaining: 3,
  carryForwardExpiryDate: null,
  forfeited: 1,
  otherAdjustments: 5,
  balance: 17,
  pendingApproval: 1,
  broughtForward: 5,
  configAdjustments: 4,
  systemAdjustments: 1,
  forfeitedThisCycle: 3,
  takenThisCycle: 2,
  configAdjustmentItems: [],
  adjustments: 5,
  totalEntitlement: 22,
  totalAvailable: 16,
  transactions: [],
  essView: {},
});

const card = (over: Partial<LeaveCardEntry> & Pick<LeaveCardEntry, 'leaveTypeId' | 'leaveType' | 'code'>): LeaveCardEntry => ({
  color: null,
  icon: null,
  remaining: 2,
  panel: {
    data: breakdown(over.leaveTypeId, over.leaveType),
    summary: { available: 2 },
    visual: { color: null, icon: null, code: over.code },
    asOf: '2026-08-03',
  },
  replacement: null,
  ...over,
});

/** Two banked credits: one still active, one already fully used — the "clearly marked" case. */
const CREDITS = [
  {
    id: 'a1',
    workedDate: '2026-07-04',
    expiresOn: '2026-11-01',
    daysCredited: 1,
    daysTaken: 0,
    status: 'active' as const,
    remaining: 1,
    requestedOn: '2026-07-05',
    approvedOn: '2026-08-03T02:00:00.000Z',
    otMinutes: 480,
  },
  {
    id: 'a2',
    workedDate: '2026-05-02',
    expiresOn: '2026-09-01',
    daysCredited: 1,
    daysTaken: 1,
    status: 'taken' as const,
    remaining: 0,
    requestedOn: '2026-05-03',
    approvedOn: '2026-06-03T02:00:00.000Z',
    otMinutes: 480,
  },
];

const ANNUAL = card({ leaveTypeId: 'lt-annual', leaveType: 'Annual Leave', code: 'ANNUAL' });
const REPLACEMENT = card({
  leaveTypeId: 'lt-rl',
  leaveType: 'Replacement Leave',
  code: 'REPLACEMENT',
  replacement: { rows: CREDITS, leaveUnit: 'day', explanations: {}, pendingDays: 0 },
});

function renderCards(entries: LeaveCardEntry[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LeaveCards entries={entries} />
    </NextIntlClientProvider>,
  );
}

const openCard = async (name: string) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: new RegExp(name) }));
};

describe('00307068 — the Replacement Leave card opens the per-credit table', () => {
  it('shows one row per banked credit, with every column the reporter named', async () => {
    renderCards([ANNUAL, REPLACEMENT]);
    await openCard('Replacement Leave');

    // Every column heading, by the same keys HR configures them under (REPLACEMENT_COLUMN_KEYS), so a
    // heading cannot be renamed in one place and not the other. 5ff7daff added `remaining` ("Available"),
    // and this loop picks it up without being told — which is the property the key set exists for.
    const en = messages.leave.breakdown.replacement.col as Record<string, string>;
    for (const key of REPLACEMENT_COLUMN_KEYS) {
      expect(screen.getByRole('columnheader', { name: new RegExp(en[key]) }), `column ${key}`).toBeInTheDocument();
    }

    // One row per credit (plus the heading row), and the two dates that did not exist before this item.
    expect(screen.getAllByRole('row')).toHaveLength(CREDITS.length + 1);
    expect(screen.getByText('2026-07-05')).toBeInTheDocument(); // Request Date of the active credit
    expect(screen.getByText('2026-08-03')).toBeInTheDocument(); // Approval Date, from the ISO instant
    expect(screen.getByText('2026-11-01')).toBeInTheDocument(); // Expired Date

    // The used-up credit is MARKED — without this the table looks like it contradicts the balance.
    expect(screen.getByText(messages.leave.breakdown.replacement.statusTaken)).toBeInTheDocument();

    // 5ff7daff — the balance above the table is STILL leaveBalances' figure (the half of this case that was
    // always the point), but it now reads as the reporter's TWO STAGES rather than one "Available Balance"
    // line: what is waiting on the line manager, and what has been approved and can be spent.
    expect(screen.getByText(messages.leave.breakdown.replacement.pendingLabel)).toBeInTheDocument();
    expect(screen.getByText(messages.leave.breakdown.replacement.approvedLabel)).toBeInTheDocument();

    // …and NOT the nine-line summary. `Eligible` is the summary's first row and appears nowhere else.
    expect(screen.queryByText(messages.leave.breakdown.field.eligible)).not.toBeInTheDocument();
    expect(screen.queryByText(messages.leave.breakdown.field.ytdEntitled)).not.toBeInTheDocument();
  });

  it('renders the Number column in the leave type’s configured unit', async () => {
    renderCards([
      { ...REPLACEMENT, replacement: { rows: CREDITS, leaveUnit: 'hour', explanations: {}, pendingDays: 0 } },
    ]);
    await openCard('Replacement Leave');
    // 480 OT minutes ⇒ 8.00 hours. Read from the RAW minutes, not re-derived from the rounded day figure.
    expect(screen.getAllByText('8.00').length).toBe(CREDITS.length);
    expect(screen.getAllByText(messages.leave.breakdown.replacement.unitHour).length).toBe(CREDITS.length);
  });

  it('shows the HR-authored wording for a column, and no icon for a column HR left blank', async () => {
    renderCards([
      {
        ...REPLACEMENT,
        replacement: {
          rows: CREDITS,
          leaveUnit: 'day',
          pendingDays: 0,
          explanations: { expiredDate: { description: 'Counted from the day your manager approved it.' } },
        },
      },
    ]);
    await openCard('Replacement Leave');
    // Exactly ONE column carries the info control — the one HR wrote for.
    const infoButtons = screen.getAllByRole('button', { name: messages.leave.breakdown.explanationShow });
    expect(infoButtons).toHaveLength(1);
    await userEvent.setup().click(infoButtons[0]);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Counted from the day your manager approved it.');
  });

  it('says so plainly when nothing has been banked yet', async () => {
    renderCards([{ ...REPLACEMENT, replacement: { rows: [], leaveUnit: 'day', explanations: {}, pendingDays: 0 } }]);
    await openCard('Replacement Leave');
    expect(screen.getByText(messages.leave.breakdown.replacement.empty)).toBeInTheDocument();
  });
});

describe('00307068 — every OTHER leave type is untouched', () => {
  it('Annual Leave still opens the nine-line Leave Balance Summary', async () => {
    renderCards([ANNUAL, REPLACEMENT]);
    await openCard('Annual Leave');

    // The summary rows, still there.
    for (const label of [
      messages.leave.breakdown.field.eligible,
      messages.leave.breakdown.field.ytdEntitled,
      messages.leave.breakdown.field.total,
      messages.leave.breakdown.field.availableBalance,
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // …and NONE of the replacement columns leaked onto it.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(messages.leave.breakdown.replacement.col.approvalDate)).not.toBeInTheDocument();
  });
});
