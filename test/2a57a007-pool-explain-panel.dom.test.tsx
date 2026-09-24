/**
 * 2a57a007 — THE EXPLAIN PANEL'S PER-TYPE SHARE BREAKDOWN, RENDERED, IN ALL SIX LOCALES.
 *
 * WHY A DOM TEST RATHER THAN THE §8 RENDER CHECK. The panel is a Radix Dialog behind a click: the §8
 * render check of Employee Balances (run for this item under the devdb lock, with a pooled leave type
 * seeded because `db/seed.ts` configures none) found these sentences ONLY in the RSC script payload and
 * never in the markup a GET delivers — which CLAUDE.md §8 says proves nothing. So the panel is opened
 * here, under the SHIPPING catalogues, with next-intl's `onError` collected and required empty.
 *
 * ⚠️ i18n/request.ts DEEP-MERGES each locale over English, so a key missing from ta.json renders the
 * ENGLISH sentence rather than MISSING_MESSAGE and an `onError`-only assertion would pass over it. Each
 * locale is therefore asserted against ITS OWN catalogue string, and the six are asserted distinct in
 * test/2a57a007-el-shared-pool-display.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import { EntitlementBreakdown, type EntitlementBreakdownData } from '../components/leave/EntitlementBreakdown';
import type { LeaveSummaryDerivation } from '../lib/leave-summary-explain';
import type { SharedLeaveBalanceInfo } from '../lib/shared-leave-balance';
import { EMPLOYEE_PANEL_CATALOGUES, type EmployeePanelLocale } from './helpers/r303-employee-leave-panel';

const LOCALES = Object.keys(EMPLOYEE_PANEL_CATALOGUES) as EmployeePanelLocale[];

/** The pool as core/read.ts builds it: two borrowers, positive figures, itemised. */
const POOL: SharedLeaveBalanceInfo = {
  sourceLeaveTypeId: 'lt-annual',
  sourceLeaveTypeName: 'Annual Leave',
  contributingLeaveTypes: ['Annual Leave', 'Emergency Leave', 'Compassionate Leave'],
  contributions: [
    { leaveTypeId: 'lt-cpl', leaveType: 'Compassionate Leave', code: 'CPL', share: 3, pendingShare: 2 },
    { leaveTypeId: 'lt-el', leaveType: 'Emergency Leave', code: 'EL', share: 1, pendingShare: 0 },
  ],
};

const DERIVATION: LeaveSummaryDerivation = {
  entitlement: {
    tableName: 'Annual — all staff',
    via: 'sole_table',
    schemeName: null,
    winReason: 'sole_candidate',
    hiredOn: '2023-05-02',
    serviceYears: 2,
    band: { fromYears: 2, toYears: 5 },
    days: 14,
  },
  earned: {
    method: 'up_front',
    leaveYear: 'calendar',
    leaveYearOverride: null,
    cycleEnd: '2026-12-31',
    rounding: 'none',
    joinYear: null,
    credits: [{ effectiveOn: '2026-01-01', days: 14, kind: 'grant' }],
  },
  carry: { rule: 'off', maxDays: 0, percent: null },
  adjustments: { manual: [], system: [] },
  // The pool's own Taken is 4.00: the days its two borrowers drew (3 + 1). Nothing was filed on the pool.
  taken: { leaveDays: 4, other: [] },
  pending: [{ startDate: '2026-12-01', endDate: '2026-12-02', days: 2 }],
  forfeited: [],
};

const DATA: EntitlementBreakdownData = {
  leaveTypeId: 'lt-annual',
  leaveType: 'Annual Leave',
  asOf: '2026-12-31',
  cycleStart: '2026-01-01',
  eligibleDays: 14,
  entitlement: {
    annualEntitlementDays: 14,
    prorated: false,
    eligibleCalendarDays: null,
    daysInLeaveYear: null,
    unroundedEntitlementDays: 14,
    displayEntitlementDays: 14,
    roundingApplied: false,
  },
  entitlementStatus: 'granted',
  entitlementTemplateName: 'Annual — all staff',
  currentYearEntitlement: 14,
  currentYearEntitlementRounded: 14,
  monthlyAccruedToDate: 14,
  carriedForward: 0,
  carryForwardRemaining: 0,
  carryForwardExpiryDate: null,
  forfeited: 0,
  otherAdjustments: 0,
  balance: 10,
  pendingApproval: 2,
  broughtForward: 0,
  configAdjustments: 0,
  systemAdjustments: 0,
  forfeitedThisCycle: 0,
  takenThisCycle: 4,
  configAdjustmentItems: [],
  adjustments: 0,
  totalEntitlement: 14,
  totalAvailable: 8,
  transactions: [],
  essView: {},
  formulaExplanations: {},
  derivation: DERIVATION,
};

async function openPool(loc: EmployeePanelLocale) {
  const errors: string[] = [];
  render(
    <NextIntlClientProvider
      locale={loc}
      messages={EMPLOYEE_PANEL_CATALOGUES[loc]}
      onError={(e) => errors.push(`${(e as { code?: string }).code ?? ''} ${String((e as Error).message ?? e)}`)}
    >
      <EntitlementBreakdown
        data={DATA}
        summary={{ available: 8 }}
        visual={{ color: null, icon: null, code: 'ANNUAL' }}
        asOf="2026-12-31"
        action="/leave/employee-balances"
        triggerLabel="Explain"
        hrExplanation={{ sharedBalance: POOL }}
      />
    </NextIntlClientProvider>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Explain' }));
  const dialog = await screen.findByRole('dialog');
  return { panel: within(dialog), errors };
}

/** `leave.breakdown.explain.<key>` out of the locale's OWN catalogue, with placeholders stripped. */
const stem = (loc: EmployeePanelLocale, key: string) => {
  const explain = (EMPLOYEE_PANEL_CATALOGUES[loc] as unknown as {
    leave: { breakdown: { explain: Record<string, string> } };
  }).leave.breakdown.explain;
  const s = explain[key]!;
  expect(typeof s, `${loc}: leave.breakdown.explain.${key} missing`).toBe('string');
  // The intro sentences carry no placeholder, so the whole string is the stem.
  return s;
};

describe('2a57a007: the pool row’s Explain panel itemises Share and Pending Share by leave type', () => {
  for (const loc of LOCALES) {
    it(`${loc}: Taken lists each borrower’s days, Pending Approval lists each borrower’s reservation, no i18n errors`, async () => {
      const { panel, errors } = await openPool(loc);

      const taken = panel.getByTestId('leave-explain-taken');
      expect(taken.textContent, `[${loc}] the Taken line introduces the per-type list`).toContain(
        stem(loc, 'sharedTakenIntro'),
      );
      // One line per contributing type, each naming the TYPE and its OWN figure — never the pool's sum.
      expect(taken.textContent, `[${loc}] Compassionate Leave’s 3.00`).toContain('Compassionate Leave');
      expect(taken.textContent).toContain('3.00');
      expect(taken.textContent, `[${loc}] Emergency Leave’s 1.00`).toContain('Emergency Leave');
      expect(taken.textContent).toContain('1.00');
      // …and the list closes onto the figure it decomposes (4.00 = 3.00 + 1.00), through `addsUpTo`.
      expect(taken.textContent, `[${loc}] the list adds up`).toContain('4.00');

      const pending = panel.getByTestId('leave-explain-pendingApproval');
      expect(pending.textContent, `[${loc}] the Pending Approval line introduces its own list`).toContain(
        stem(loc, 'sharedPendingIntro'),
      );
      expect(pending.textContent).toContain('Compassionate Leave');
      expect(pending.textContent, `[${loc}] a borrower with nothing pending is not listed`).not.toContain(
        'Emergency Leave',
      );

      expect(errors, `[${loc}] next-intl errors`).toEqual([]);
    });
  }

  it('an UNPOOLED row’s panel gains neither list — the untouched path stays untouched', async () => {
    const errors: string[] = [];
    render(
      <NextIntlClientProvider locale="en" messages={EMPLOYEE_PANEL_CATALOGUES.en} onError={(e) => errors.push(String(e))}>
        <EntitlementBreakdown
          data={DATA}
          summary={{ available: 8 }}
          visual={{ color: null, icon: null, code: 'ANNUAL' }}
          asOf="2026-12-31"
          action="/leave/employee-balances"
          triggerLabel="Explain"
          hrExplanation={{ sharedBalance: null }}
        />
      </NextIntlClientProvider>,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Explain' }));
    const panel = within(await screen.findByRole('dialog'));
    expect(panel.getByTestId('leave-explain-taken').textContent).not.toContain(stem('en', 'sharedTakenIntro'));
    expect(panel.getByTestId('leave-explain-pendingApproval').textContent).not.toContain(stem('en', 'sharedPendingIntro'));
    expect(errors).toEqual([]);
  });
});
