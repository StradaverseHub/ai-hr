/**
 * 2a57a007 (r340) — THE EXPLAIN PANEL, THE PLAN'S THIRD SURFACE, RENDERED IN ALL SIX LOCALES.
 *
 * The approved plan promised the reporter "the same in the Explain popup and in the CSV/Excel export, so the
 * three cannot disagree", and its build notes said THREE SURFACES OR NONE. The grid and the export were built
 * first: a pooled borrower's Entitlement and Earned to Date read 0.00 and it names no entitlement table. The
 * panel was not, and one click away it printed the POOL's Entitlement (7.00 on the reporter's screen) under a
 * grid row reading 0.00 — the original complaint, relocated.
 *
 * ⚠️ WHAT THE FIX IS, AND WHAT IT DELIBERATELY IS NOT. §1 of the panel is ONE CLOSING COLUMN
 * (`broughtForward + earned + adjustments = Total`, `Total − taken − pending − forfeited = Balance`). Zeroing
 * two of its addends for a borrower would make the column contradict its own Total AND would make
 * `explainLeaveSummary`'s sum-guard fire — correctly — on a panel where nothing is wrong. That guard is a
 * correctness guard, so it is neither bypassed nor silenced. Instead the pool's arithmetic stays whole and is
 * ATTRIBUTED: the borrower's own fact (its two figures are nothing, and the days come from the pool) is STATED
 * once above the column and once on each of the two lines it is about.
 *
 * ⚠️ WHY A DOM TEST AND NOT THE §8 RENDER CHECK — the same reason test/2a57a007-pool-explain-panel.dom.test.tsx
 * gives: the panel is a Radix Dialog behind a click, so a GET of the page finds these sentences only in the RSC
 * script payload, which §8 says proves nothing. Opened here under the SHIPPING catalogues, with next-intl's
 * `onError` collected and required empty.
 *
 * ⚠️ i18n/request.ts DEEP-MERGES each locale over English, so a key missing from ta.json renders the ENGLISH
 * string and an `onError`-only assertion would pass over it. Each locale is asserted against ITS OWN catalogue
 * string; the six are asserted distinct in test/2a57a007-borrower-entitlement-columns.test.ts.
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

const POOL_NAME = 'Annual Leave';

/** The pool as core/read.ts builds it — the SAME descriptor rides on both halves of a pool. */
const POOL: SharedLeaveBalanceInfo = {
  sourceLeaveTypeId: 'lt-annual',
  sourceLeaveTypeName: POOL_NAME,
  contributingLeaveTypes: [POOL_NAME, 'Emergency Leave'],
  contributions: [{ leaveTypeId: 'lt-el', leaveType: 'Emergency Leave', code: 'EL', share: 1, pendingShare: 0 }],
};

const DERIVATION: LeaveSummaryDerivation = {
  entitlement: {
    tableName: 'Executive Annual Leave',
    via: 'sole_table',
    schemeName: null,
    winReason: 'sole_candidate',
    hiredOn: '2023-05-02',
    serviceYears: 2,
    band: { fromYears: 2, toYears: 5 },
    days: 7,
  },
  earned: {
    method: 'up_front',
    leaveYear: 'calendar',
    leaveYearOverride: null,
    cycleEnd: '2026-12-31',
    rounding: 'none',
    joinYear: null,
    credits: [{ effectiveOn: '2026-01-01', days: 7, kind: 'grant' }],
  },
  carry: { rule: 'off', maxDays: 0, percent: null },
  adjustments: { manual: [], system: [] },
  taken: { leaveDays: 1, other: [] },
  pending: [],
  forfeited: [],
};

/**
 * THE POOL'S BREAKDOWN — which is what a BORROWER's row is handed (`balanceStoryTypeId`), and the whole reason
 * the panel cannot tell the two rows apart by itself. Figures are the reporter's: 7.00 entitlement, 1.00 taken.
 */
const DATA: EntitlementBreakdownData = {
  leaveTypeId: 'lt-annual',
  leaveType: POOL_NAME,
  asOf: '2026-12-31',
  cycleStart: '2026-01-01',
  eligibleDays: 7,
  entitlement: {
    annualEntitlementDays: 7,
    prorated: false,
    eligibleCalendarDays: null,
    daysInLeaveYear: null,
    unroundedEntitlementDays: 7,
    displayEntitlementDays: 7,
    roundingApplied: false,
  },
  entitlementStatus: 'granted',
  entitlementTemplateName: 'Executive Annual Leave',
  currentYearEntitlement: 7,
  currentYearEntitlementRounded: 7,
  monthlyAccruedToDate: 7,
  carriedForward: 0,
  carryForwardRemaining: 0,
  carryForwardExpiryDate: null,
  forfeited: 0,
  otherAdjustments: 0,
  balance: 6,
  pendingApproval: 0,
  broughtForward: 0,
  configAdjustments: 0,
  systemAdjustments: 0,
  forfeitedThisCycle: 0,
  takenThisCycle: 1,
  configAdjustmentItems: [],
  adjustments: 0,
  totalEntitlement: 7,
  totalAvailable: 6,
  transactions: [],
  essView: {},
  formulaExplanations: {},
  derivation: DERIVATION,
};

async function openPanel(loc: EmployeePanelLocale, entitlementFromPool: string | null) {
  const errors: string[] = [];
  render(
    <NextIntlClientProvider
      locale={loc}
      messages={EMPLOYEE_PANEL_CATALOGUES[loc]}
      onError={(e) => errors.push(`${(e as { code?: string }).code ?? ''} ${String((e as Error).message ?? e)}`)}
    >
      <EntitlementBreakdown
        data={DATA}
        summary={{ available: 6 }}
        visual={{ color: null, icon: null, code: 'EL' }}
        asOf="2026-12-31"
        action="/leave/employee-balances"
        triggerLabel="Explain"
        hrExplanation={{ sharedBalance: POOL, entitlementFromPool }}
      />
    </NextIntlClientProvider>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Explain' }));
  const dialog = await screen.findByRole('dialog');
  return { panel: within(dialog), errors };
}

/** A message out of the locale's OWN catalogue, with `{placeholders}` resolved the way the panel resolves them. */
const fromCatalogue = (loc: EmployeePanelLocale, dotted: string, vars: Record<string, string>) => {
  const breakdown = (EMPLOYEE_PANEL_CATALOGUES[loc] as unknown as {
    leave: { breakdown: Record<string, unknown> };
  }).leave.breakdown;
  const raw = dotted.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], breakdown);
  expect(typeof raw, `${loc}: leave.breakdown.${dotted} missing`).toBe('string');
  return String(raw).replace(/\{(\w+)\}/g, (m, n) => vars[n] ?? m);
};

describe('2a57a007 (r340): the Explain panel on a BORROWER states the borrower’s own entitlement', () => {
  for (const loc of LOCALES) {
    it(`${loc}: the statement names the pool, both entitlement lines say whose working follows, no i18n errors`, async () => {
      const { panel, errors } = await openPanel(loc, POOL_NAME);

      // (1) Above the column, before any figure is read, in the locale's own words.
      const stated = panel.getByTestId('panel-pooled-entitlement');
      expect(stated.textContent, `[${loc}] the panel states the borrower’s own entitlement`).toBe(
        fromCatalogue(loc, 'pooledOwnEntitlement', { pool: POOL_NAME }),
      );

      // (2) And on each of the two lines that are statements about the leave TYPE rather than the ledger.
      const sentence = fromCatalogue(loc, 'explain.pooledOwnEntitlement', { source: POOL_NAME });
      for (const line of ['eligible', 'ytdEntitled'] as const) {
        expect(panel.getByTestId(`leave-explain-${line}`).textContent, `[${loc}] the ${line} line`).toContain(sentence);
      }

      // (3) The sum-guard is NOT firing: the pool's arithmetic was left whole, so the itemised lists still
      //     reach their figures. "The records behind 7.00 could not be listed…" on a panel where nothing is
      //     wrong is exactly what zeroing the figures here would have produced.
      const couldNotBeListed = fromCatalogue(loc, 'explain.itemsDoNotAddUp', { figure: '7.00' });
      for (const line of ['eligible', 'ytdEntitled'] as const) {
        expect(
          panel.getByTestId(`leave-explain-${line}`).textContent,
          `[${loc}] the sum-guard must not have been made to fire on the ${line} line`,
        ).not.toContain(couldNotBeListed.slice(0, 20));
      }

      expect(errors, `[${loc}] next-intl errors`).toEqual([]);
    });
  }

  it('the POOL’s OWN row is byte-identical — it borrows from nothing, so nothing is stated', async () => {
    const { panel, errors } = await openPanel('en', null);
    expect(panel.queryByTestId('panel-pooled-entitlement'), 'the pool does not borrow from itself').toBeNull();
    const sentence = fromCatalogue('en', 'explain.pooledOwnEntitlement', { source: POOL_NAME });
    for (const line of ['eligible', 'ytdEntitled'] as const) {
      expect(panel.getByTestId(`leave-explain-${line}`).textContent).not.toContain(sentence);
    }
    // …and it keeps the sentence it already had, which says whose figures a pooled row shows.
    expect(panel.getByTestId('leave-explain-eligible').textContent).toContain(
      fromCatalogue('en', 'explain.poolFigures', { source: POOL_NAME, others: 'Emergency Leave' }),
    );
    expect(errors).toEqual([]);
  });

  /**
   * THE FIGURES ARE STILL THE POOL'S, AND THAT IS THE DESIGN, NOT AN OVERSIGHT. A reader who could no longer
   * see the pool's working could not check the borrower's days at all — and the column would stop closing.
   * What must be true is that nothing on this panel reads as THIS leave type's own entitlement, which (1) and
   * (2) above are what establish.
   */
  it('the pool’s own working is still shown, attributed rather than deleted', async () => {
    const { panel } = await openPanel('en', POOL_NAME);
    expect(panel.getByTestId('leave-explain-eligible').textContent, 'the pool’s table is still named').toContain(
      'Executive Annual Leave',
    );
    expect(panel.getByTestId('panel-pooled-entitlement').textContent, 'and the statement above it names the pool').toContain(
      POOL_NAME,
    );
  });
});
