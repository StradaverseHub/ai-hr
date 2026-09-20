/**
 * r285 — what the Explain panel ACTUALLY PRINTS on the two renamed rows, in all six locales.
 *
 * WHY A DOM TEST AND NOT THE DEV-SERVER LOG. The panel is a Radix Dialog rendered through a Portal: nothing
 * of it exists in the HTML a curl receives until somebody clicks Explain. A dev-server render of
 * /leave/employee-balances therefore proves the GRID's headers and proves the page resolves its catalogue,
 * and can say nothing at all about the two rows this item is about. And the RSC payload carries the whole
 * message catalogue, so grepping the fetched HTML for "Full Entitlement" would have found it either way
 * (CLAUDE.md §8: a key is not a screen).
 *
 * So this opens the real panel and reads the two rows off the rendered document — against the REAL
 * catalogue for each locale, which is also what proves the rename did not leave a `MISSING_MESSAGE` in one
 * of the five non-English files.
 *
 * Scope note, inherited from its neighbours: jsdom applies no CSS and computes no layout. This catches what
 * a reader sees as text, not how it looks.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { LeaveDetailsPanel } from '../components/leave/LeaveDetailsPanel';
import type { EntitlementBreakdownData } from '../components/leave/EntitlementBreakdown';

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

/**
 * The r285 production shape, so the two rows print DISTINGUISHABLE figures and the column closes:
 * Full Entitlement 18.00 over Earned to Date 5.50, ledger −6.50, pending 4.00 (bounded), available −10.50.
 */
const DATA: EntitlementBreakdownData = {
  leaveTypeId: 'lt-annual',
  leaveType: 'Annual Leave',
  asOf: '2026-08-04',
  cycleStart: '2026-01-01',
  eligibleDays: 18,
  // 845903a3 (r313) — this fixture's employee joined before the leave year, so nothing prorates:
  // the Entitlement line shows the band figure itself, which is what it showed before r313.
  entitlement: { annualEntitlementDays: 18, prorated: false, eligibleCalendarDays: null,
    daysInLeaveYear: null, unroundedEntitlementDays: 18, displayEntitlementDays: 18, roundingApplied: false },
  entitlementStatus: 'granted',
  entitlementTemplateName: null,
  currentYearEntitlement: 5.5,
  monthlyAccruedToDate: 5.5,
  carriedForward: 0,
  carryForwardRemaining: 0,
  carryForwardExpiryDate: null,
  forfeited: 0,
  otherAdjustments: 0,
  balance: -6.5,
  pendingApproval: 4,
  broughtForward: 0,
  configAdjustments: 0,
  systemAdjustments: 0,
  forfeitedThisCycle: 0,
  takenThisCycle: 12,
  configAdjustmentItems: [],
  adjustments: 0,
  totalEntitlement: 5.5,
  totalAvailable: -10.5,
  transactions: [],
  essView: {},
};

/**
 * r303 (31492f74) UPDATED THIS MOUNT to the one Employee Balances now renders: the HR explanation switch is on, and
 * the breakdown carries the working it is rendered from (the r285 production shape, itemised). The row assertions
 * below are unchanged — the label and figure of each line are exactly what they were; the sentences sit beneath
 * the row, not inside it — and the no-MISSING_MESSAGE assertion now also covers every sentence under the nine lines.
 */
async function openPanel(locale: string, messages: Record<string, unknown>) {
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <LeaveDetailsPanel
        data={{
          ...DATA,
          derivation: {
            entitlement: { tableName: 'Annual', via: 'sole_table', schemeName: null, winReason: null, hiredOn: '2024-01-01', serviceYears: 2, band: { fromYears: 0, toYears: null }, days: 18 },
            earned: { method: 'earned_monthly', leaveYear: 'calendar', leaveYearOverride: null, cycleEnd: '2026-12-31', rounding: 'none', joinYear: null, credits: [{ effectiveOn: '2026-01-01', days: 5.5, kind: 'grant' }] },
            carry: { rule: 'off', maxDays: 0, percent: null },
            adjustments: { manual: [], system: [] },
            taken: { leaveDays: 12, other: [] },
            pending: [{ startDate: '2026-08-03', endDate: '2026-08-06', days: 4 }],
            forfeited: [],
          },
        }}
        summary={{ available: -10.5 }}
        visual={{ color: null, icon: null, code: 'ANNUAL' }}
        asOf="2026-08-04"
        action="/leave/employee-balances"
        hrExplanation={{ sharedBalance: null }}
      />
    </NextIntlClientProvider>,
  );
  const dict = messages as unknown as typeof en;
  await userEvent.setup().click(screen.getByRole('button', { name: dict.leave.breakdown.viewBreakdown }));
  return within(await screen.findByRole('dialog'));
}

/**
 * One summary ROW, as text: its label and its figure together. Reading the figure alone is ambiguous here
 * on purpose — the fixture's Earned to Date and Total are both 5.50, exactly as they are for an employee
 * with no carry and no adjustments — and "5.50 appears somewhere in the panel" would not notice the two
 * rows swapping.
 */
const row = (panel: ReturnType<typeof within>, label: string) =>
  panel.getByText(label).parentElement!.textContent ?? '';

describe('r285: the Explain panel prints the grid’s words on the two rows the reporter read twice', () => {
  for (const [loc, messages] of LOCALES) {
    it(`${loc}: the panel shows the grid's Full Entitlement / Earned to Date wording`, async () => {
      const dict = messages as unknown as typeof en;
      const panel = await openPanel(loc, messages as unknown as Record<string, unknown>);
      const full = dict.me.leaveBalanceTable.colFullEntitlement;
      const earned = dict.me.leaveBalanceTable.colYtdEntitled;
      // The GRID's own strings, resolved on the PANEL — the thing the reporter asked for.
      expect(panel.getByText(full), `[${loc}] Full Entitlement row`).toBeInTheDocument();
      expect(panel.getByText(earned), `[${loc}] Earned to Date row`).toBeInTheDocument();
      // A rename that lost a catalogue entry paints this instead of a label, returns 200, and is green
      // through tsc, the suite and `next build`.
      expect(panel.queryByText(/MISSING_MESSAGE/)).toBeNull();
      // r303: and the HR mount's sentence under the last line closes onto the same printed figure.
      expect(panel.getByTestId('leave-explain-available').textContent).toContain('-10.50');
    });
  }

  it('English: the old panel-only wording is gone from the rendered panel', async () => {
    const panel = await openPanel('en', en as unknown as Record<string, unknown>);
    // 845903a3 (r313) — the label lost the word "Full": the column is prorated now, so it no longer shows the whole year for a mid-year joiner. The PAIRING this file exists to pin is unchanged — the panel and the grid must still read the SAME words — so the assertion is updated, not dropped.
    expect(panel.getByText('Entitlement')).toBeInTheDocument();
    expect(panel.getByText('Earned to Date')).toBeInTheDocument();
    expect(panel.queryByText('Eligible (full year entitlement)')).toBeNull();
    expect(panel.queryByText('YTD entitled')).toBeNull();
  });

  it('English: the two rows carry their OWN figures, so the rename did not swap them', async () => {
    const panel = await openPanel('en', en as unknown as Record<string, unknown>);
    // 18.00 is the full-year band; 5.50 is what has been earned by the as-at date. Reading the same number
    // twice under two names is the defect; reading the WRONG number under the right name would be worse.
    expect(row(panel, 'Entitlement')).toContain('18.00');
    expect(row(panel, 'Earned to Date')).toContain('5.50');
  });

  it('English: the pending line is the bounded 4.00 and the column reaches the printed −10.50', async () => {
    const panel = await openPanel('en', en as unknown as Record<string, unknown>);
    // 5.50 − 12.00 taken − 4.00 pending − 0 forfeited = −10.50, which is also the Available Balance line.
    // The rows that are NOT this item's are still the leave-apply popup's shared strings.
    expect(row(panel, en.leave.breakdown.field.pendingApproval)).toContain('4.00');
    expect(row(panel, en.leave.breakdown.field.availableBalance)).toContain('10.50');
    expect(row(panel, en.leave.breakdown.field.taken)).toContain('12.00');
  });
});
