/**
 * r212 (8ebf77ae) — THE RENDER CHECK for "No eligibility rule reaches you, and here is why", in all six
 * locales, because a dev-server log cannot reach a Radix side-sheet.
 *
 * The five rule states resolve their copy through a map indexed by the STATE
 * (`RULE_STATE_COPY[state]`, LeaveDetailsPanel.tsx), not through a string literal — one mapping so the
 * admin explain panel and the employee's own panel cannot describe the same configuration two ways. That
 * is exactly the shape every static check in this repo is blind to (see r196's own header): a missing key
 * paints `MISSING_MESSAGE` in the browser and still returns 200, passes tsc, passes the suite and passes
 * `next build`. AGENTS rule 6.
 *
 * ALSO PINNED HERE, and not statically assertable anywhere:
 *   · the prop is OPTIONAL and absent is a legitimate value — a caller that has not loaded the explanation
 *     renders exactly what it rendered before this item, which is what makes it safe to land ahead of the
 *     screens that will pass it;
 *   · an EXPIRED rule never borrows the "you are not in it" sentence. Those two call for opposite actions,
 *     and flattening them is what left a whole tenant reading 0.00 for six days after one `valid_to`
 *     passed;
 *   · the employee's own value survives the `{value}` placeholder in every catalogue — a locale that
 *     dropped it would render "Does not match your Employment Type" with the useful half missing.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import { LeaveDetailsPanel } from '../components/leave/LeaveDetailsPanel';
import type { EntitlementBreakdownData } from '../components/leave/EntitlementBreakdown';
import type { EligibilityNotice, EligibilityRuleNotice } from '../lib/entitlement-status';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

/** Every state the union can hold — listed here so a sixth added without copy fails at the RENDER. */
const ALL_STATES: EligibilityRuleNotice['state'][] = [
  'matched',
  'in_force',
  'expired',
  'not_yet',
  'table_stopped',
];

const breakdown: EntitlementBreakdownData = {
  leaveTypeId: 'lt-med',
  leaveType: 'Medical Leave',
  asOf: '2026-08-20',
  cycleStart: '2026-01-01',
  eligibleDays: 0,
  entitlementStatus: 'no_eligibility_match',
  entitlementTemplateName: null,
  currentYearEntitlement: 0,
  monthlyAccruedToDate: null,
  carriedForward: 0,
  carryForwardRemaining: 0,
  carryForwardExpiryDate: null,
  forfeited: 0,
  otherAdjustments: 0,
  balance: 0,
  pendingApproval: 0,
  broughtForward: 0,
  configAdjustments: 0,
  systemAdjustments: 0,
  forfeitedThisCycle: 0,
  takenThisCycle: 0,
  configAdjustmentItems: [],
  adjustments: 0,
  totalEntitlement: 0,
  totalAvailable: 0,
  transactions: [],
  essView: {},
};

const rule = (over: Partial<EligibilityRuleNotice> = {}): EligibilityRuleNotice => ({
  name: 'CONTRACT - GRADE H - 18',
  state: 'in_force',
  validFrom: '2026-01-01',
  validTo: null,
  tableName: 'Contract Grade H',
  failingAxisLabel: 'Employment Type',
  failingAxisValue: 'full_time',
  failsOnCombination: false,
  href: null,
  ...over,
});

const notice = (over: Partial<EligibilityNotice> = {}): EligibilityNotice => ({
  soleTableApplies: false,
  activeAtDate: true,
  winningRuleName: null,
  winningTableName: null,
  usesUndatedAxis: false,
  rules: [rule()],
  ...over,
});

function renderPanel(locale: Locale, eligibility?: EligibilityNotice) {
  return render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <LeaveDetailsPanel
        data={breakdown}
        summary={{ available: 0 }}
        visual={{ color: null, icon: null, code: 'MED' }}
        asOf="2026-08-20"
        action="/leave"
        eligibility={eligibility}
        open
        onOpenChange={() => {}}
        hideTrigger
      />
    </NextIntlClientProvider>,
  );
}

/** next-intl paints the key path when a key does not resolve; a namespace leaking into the DOM is the
 *  same defect wearing a different hat. */
const looksUnresolved = (text: string) =>
  /MISSING_MESSAGE/.test(text) || /leave\.breakdown\./.test(text) || /\beligibilityState[A-Z]/.test(text);

describe('r212: the eligibility explanation renders in every locale', () => {
  for (const locale of LOCALES) {
    it(`[${locale}] every rule state resolves, and the rule is named`, () => {
      for (const state of ALL_STATES) {
        const { unmount } = renderPanel(locale, notice({ rules: [rule({ state, validTo: '2026-08-13' })] }));
        const box = screen.getByRole('status');
        const text = box.textContent ?? '';
        expect(looksUnresolved(text), `${locale}/${state} unresolved key`).toBe(false);
        // The rule's NAME is user data and must survive verbatim — an explanation that says a rule missed
        // you without saying WHICH rule is the silence this item exists to end.
        expect(text, `${locale}/${state} rule name`).toContain('CONTRACT - GRADE H - 18');
        unmount();
      }
    });

    it(`[${locale}] the failing axis and the employee's own value both survive their placeholders`, () => {
      const { unmount } = renderPanel(locale, notice());
      const text = screen.getByRole('status').textContent ?? '';
      expect(text, `${locale} axis`).toContain('Employment Type');
      expect(text, `${locale} value`).toContain('full_time');
      unmount();
    });

    it(`[${locale}] the sole-table case says no rule is needed`, () => {
      const { unmount } = renderPanel(locale, notice({ soleTableApplies: true, rules: [] }));
      const text = screen.getByRole('status').textContent ?? '';
      const copy = (CATALOGUES[locale] as unknown as {
        leave: { breakdown: Record<string, string> };
      }).leave.breakdown.eligibilitySoleTable;
      expect(looksUnresolved(text)).toBe(false);
      expect(text, `${locale} sole table`).toContain(copy);
      unmount();
    });
  }

  it('the prop is OPTIONAL: without it the panel renders exactly the pre-r212 notice', () => {
    const { unmount } = renderPanel('en', undefined);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain(en.leave.breakdown.statusNoEligibilityMatchTitle);
    expect(text).not.toContain(en.leave.breakdown.eligibilityRulesTitle);
    unmount();
  });

  it('an EXPIRED rule never borrows the "you are not in it" sentence', () => {
    // THE FINDING, AT THE RENDER. An expired rule matches nobody whatever their details are, so naming an
    // axis beside it would send an administrator to edit criteria that cannot change the outcome.
    const { unmount } = renderPanel(
      'en',
      notice({
        rules: [
          rule({ state: 'expired', validTo: '2026-08-13', failingAxisLabel: null, failingAxisValue: null }),
        ],
      }),
    );
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('2026-08-13');
    expect(text).not.toContain(en.leave.breakdown.eligibilityStateInForce);
    expect(text).not.toContain('Employment Type');
    unmount();
  });

  it('an axis with no nameable value renders the axis alone, never a bare label with a dangling colon', () => {
    // `failingAxisValue` is null for the id-shaped axes (department, grade, position…): quoting the
    // employee's own would put a UUID on screen. The screen says less rather than saying it badly.
    const { unmount } = renderPanel(
      'en',
      notice({ rules: [rule({ failingAxisLabel: 'Department', failingAxisValue: null })] }),
    );
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('Does not match your Department');
    expect(text).not.toContain('Does not match your Department:');
    unmount();
  });

  it('the undated-axis caveat is shown only when a rule actually narrows by one', () => {
    const off = renderPanel('en', notice({ usesUndatedAxis: false }));
    expect(screen.getByRole('status').textContent ?? '').not.toContain(
      en.leave.breakdown.eligibilityUndatedNote,
    );
    off.unmount();

    const on = renderPanel('en', notice({ usesUndatedAxis: true }));
    expect(screen.getByRole('status').textContent ?? '').toContain(en.leave.breakdown.eligibilityUndatedNote);
    on.unmount();
  });
});
