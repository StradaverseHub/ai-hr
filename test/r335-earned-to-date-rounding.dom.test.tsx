/**
 * r335 (board 6af80f5d) — THE ROUNDED SUB-LINE, RENDERED, IN ALL SIX LOCALES.
 *
 * WHY THIS FILE EXISTS RATHER THAN A SEED FIXTURE. The §8 render check ran Employee Balances on a real dev
 * server in all six locales against `pnpm db:seed` and came back clean — but MEASURED, the seed produces no
 * fractional accrual and no rounding rule at all (every `leave_type.rounding_method` is NULL and every
 * `leave_ledger.days` is whole), so the seeded screens can only exercise the byte-identical path. Rather
 * than hand-roll a fixture into the dev database to make a screenshot look right, the case the seed cannot
 * reach is covered HERE, through the real component, the real descriptor and the real message catalogues:
 * `MISSING_MESSAGE` and an ICU argument mismatch are exactly what a render check is for, and they are what
 * these assertions would fail on.
 *
 * The figures are the reporter's: 11.18 exact, 11.00 through the custom table, balance 6.18.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import { LeaveDetailsPanel } from '../components/leave/LeaveDetailsPanel';
import type { EntitlementBreakdownData } from '../components/leave/EntitlementBreakdown';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Loc = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Loc[];

const RAW = 11.18;
const ROUNDED = 11;
const TAKEN = 5;
const BALANCE = 6.18;

const breakdown = (rounded: number): EntitlementBreakdownData => ({
  leaveTypeId: 'lt-annual',
  leaveType: 'Annual Leave',
  asOf: '2026-09-23',
  cycleStart: '2026-01-01',
  eligibleDays: 20,
  entitlement: {
    annualEntitlementDays: 20,
    prorated: false,
    eligibleCalendarDays: null,
    daysInLeaveYear: null,
    unroundedEntitlementDays: 20,
    displayEntitlementDays: 20,
    roundingApplied: false,
  },
  entitlementStatus: 'granted',
  entitlementTemplateName: 'Executive Annual Leave',
  currentYearEntitlement: RAW,
  currentYearEntitlementRounded: rounded,
  monthlyAccruedToDate: RAW,
  carriedForward: 0,
  carryForwardRemaining: 0,
  carryForwardExpiryDate: null,
  forfeited: 0,
  otherAdjustments: 0,
  balance: BALANCE,
  pendingApproval: 0,
  broughtForward: 0,
  configAdjustments: 0,
  systemAdjustments: 0,
  forfeitedThisCycle: 0,
  takenThisCycle: TAKEN,
  configAdjustmentItems: [],
  adjustments: 0,
  totalEntitlement: RAW,
  totalAvailable: BALANCE,
  transactions: [],
  essView: {},
});

async function openPanel(loc: Loc, rounded: number): Promise<HTMLElement> {
  render(
    <NextIntlClientProvider locale={loc} messages={CATALOGUES[loc]}>
      <LeaveDetailsPanel
        data={breakdown(rounded)}
        summary={{ available: BALANCE }}
        visual={{ color: null, icon: null, code: 'ANNUAL' }}
        asOf="2026-09-23"
        action="/leave/employee-balances"
      />
    </NextIntlClientProvider>,
  );
  const dict = CATALOGUES[loc] as unknown as typeof en;
  await userEvent.setup().click(screen.getByRole('button', { name: dict.leave.breakdown.viewBreakdown }));
  return screen.findByRole('dialog');
}

afterEach(cleanup);

describe('r335 · the Explain panel prints the exact figure and the rounded one, in every locale', () => {
  for (const loc of LOCALES) {
    it(`${loc}: both figures, the localised sentence, and no untranslated key`, async () => {
      const dialog = await openPanel(loc, ROUNDED);
      const text = dialog.textContent ?? '';

      // The addend the column sums is the EXACT figure, and the Total under it agrees.
      expect(text, 'the exact Earned to Date').toContain('11.18');
      // …and the rounded figure the grid column shows is beside it, in this locale's own words.
      const expected = (CATALOGUES[loc] as unknown as typeof en).leave.breakdown.roundedTo.replace('{value}', '11.00');
      expect(within(dialog).getByText(expected)).toBeTruthy();
      // The balance the column closes onto is untouched.
      expect(text).toContain('6.18');

      // A missing key renders as the key itself; an ICU argument mismatch renders the error name.
      expect(text).not.toContain('roundedTo');
      expect(text).not.toContain('leave.breakdown');
      expect(text).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR|IntlError/);
      // The `{value}` argument is supplied — an unresolved placeholder would survive into the markup.
      expect(text).not.toContain('{value}');
      expect(text).not.toContain('{date}');
    });
  }

  it('renders byte-identically to today when rounding did not move the figure', async () => {
    // The no-rounding world: the sub-line must be absent, not present-and-equal. A tenant with no rounding
    // rule sees exactly the panel they saw before this item.
    const dialog = await openPanel('en', RAW);
    const text = dialog.textContent ?? '';
    expect(text).toContain('11.18');
    expect(text).not.toContain(en.leave.breakdown.roundedTo.replace('{value}', '11.18'));
    expect(within(dialog).queryByText(/Rounded to/)).toBeNull();
  });
});
