/**
 * 31e39d74 — THE RENDER CHECK, in all six locales, because a dev-server log cannot reach these surfaces.
 *
 * Both new surfaces resolve their i18n key through a MAP INDEXED BY THE STATUS
 * (`ENTITLEMENT_STATUS_LABEL_KEY[status]`, `PANEL_STATUS_COPY[status]`), not through a string literal. That
 * is deliberate — one mapping means the grid, the admin grid, the export and the panel cannot label the
 * same state three ways — but it is invisible to every static check this repo has:
 *
 *   · `scripts/i18n-check.mjs` and i18n-coverage check A prove the six catalogues hold the same keys with
 *     the same placeholders. They cannot prove a COMPONENT asks for a key that exists.
 *   · i18n-coverage check C only reads literal `t('a.b')` calls, and skips multi-namespace files entirely —
 *     so it sees neither `tt(ENTITLEMENT_STATUS_LABEL_KEY[…])` nor the balance table at all.
 *   · a missing key here paints `MISSING_MESSAGE` in the browser and still returns 200, passes tsc, passes
 *     the suite and passes `next build`. That is AGENTS rule 6, and this file is how it is answered when a
 *     dev server is not available (precedent: test/r191-panel-order-locales.dom.test.tsx).
 *
 * Also asserted here, and not statically assertable anywhere else: the caption appears ONLY for the states
 * that need announcing, and stays absent for the ones that do not.
 *
 * ⚠️ r209 CHANGED WHICH STATES THOSE ARE, and the original sentence here is worth keeping alongside the
 * correction rather than overwriting: "a banner on every leave type a tenant has not configured would bury
 * the two that matter, which is the same failure as saying nothing." That reasoning kept `not_configured`
 * silent — and `not_configured` was ALSO the answer for "six entitlement tables exist and no eligibility
 * rule reaches you", which is what one rule expiring on 13 August 2026 did to an entire tenant. Six days of
 * 0.00 with nothing on any screen. So the state was SPLIT: the un-actionable half kept its name and its
 * silence, and the three actionable ones are announced.
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
import { LeaveBalanceTable } from '../components/leave/leave-balance-table';
import type { EntitlementBreakdownData } from '../components/leave/EntitlementBreakdown';
import type { LeaveBalanceRow } from '../components/leave/leave-balance-row';
import {
  ENTITLEMENT_STATUS_LABEL_KEY,
  entitlementStatusNeedsNotice,
  type EntitlementStatus,
} from '../lib/entitlement-status';

/** Every status the union can hold, and the subset that paints a caption. Derived from the predicate
 *  rather than listed, so a status added to the union without copy fails HERE — the render — instead of
 *  reaching a browser as `MISSING_MESSAGE` or a crash on a `Partial<Record<…>>` lookup. */
const ALL_STATUSES: EntitlementStatus[] = [
  'granted',
  'not_generated',
  'earned_accrual',
  'zero_entitlement',
  'earning_method_missing',
  // r209 — the three states that split `not_configured` apart and named the max-balance clamp. Added here
  // rather than to a separate file precisely because this file is the render check: each one resolves its
  // copy through the same status-indexed map, so a locale missing one paints MISSING_MESSAGE behind a 200.
  'no_entitlement_table',
  'no_eligibility_match',
  'capped_by_max_balance',
  'not_configured',
];
const ANNOUNCED = ALL_STATUSES.filter(entitlementStatusNeedsNotice);
const SILENT = ALL_STATUSES.filter((s) => !entitlementStatusNeedsNotice(s));

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

const breakdown = (status: EntitlementStatus): EntitlementBreakdownData => ({
  leaveTypeId: 'lt-hosp',
  leaveType: 'Hospitalization Leave',
  asOf: '2026-08-17',
  cycleStart: '2026-01-01',
  eligibleDays: 60,
  entitlementStatus: status,
  entitlementTemplateName: 'Hospitalization — all staff',
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
});

const row = (status: EntitlementStatus): LeaveBalanceRow => ({
  leaveTypeId: 'lt-hosp',
  leaveType: 'Hospitalization Leave',
  visual: { color: null, icon: null, code: 'HOSP' },
  available: 0,
  taken: 0,
  broughtForward: 0,
  adjustment: 0,
  overutilized: 0,
  ytdEntitled: 0,
  entitlementStatus: status,
  balance: 0,
});

function renderPanel(locale: Locale, status: EntitlementStatus) {
  return render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <LeaveDetailsPanel
        data={breakdown(status)}
        summary={{ available: 0 }}
        visual={{ color: null, icon: null, code: 'HOSP' }}
        asOf="2026-08-17"
        action="/leave"
        open
        onOpenChange={() => {}}
        hideTrigger
      />
    </NextIntlClientProvider>,
  );
}

function renderTable(locale: Locale, status: EntitlementStatus) {
  return render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <LeaveBalanceTable rows={[row(status)]} />
    </NextIntlClientProvider>,
  );
}

/** next-intl renders the literal `MISSING_MESSAGE`-flavoured key path when a key does not resolve; a
 *  namespace prefix leaking into the DOM is the same defect wearing a different hat. */
const looksUnresolved = (text: string) =>
  /MISSING_MESSAGE/.test(text) ||
  /leave\.breakdown\./.test(text) ||
  /me\.leaveBalanceTable\./.test(text) ||
  /\bstatus(NotGenerated|EarnedAccrual|ZeroEntitlement|EarningMethodMissing|Generated|NotConfigured)/.test(text);

describe('31e39d74: the not-yet-generated notice resolves in every locale', () => {
  for (const locale of LOCALES) {
    it(`[${locale}] the breakdown panel renders every notice state, and names the table`, () => {
      for (const status of ANNOUNCED) {
        const { unmount, container } = renderPanel(locale, status);
        const notice = screen.getByRole('status');
        expect(notice.textContent ?? '', `${locale}/${status} title+body`).not.toBe('');
        expect(looksUnresolved(notice.textContent ?? ''), `${locale}/${status} unresolved key`).toBe(false);
        // The table name is user data and must survive verbatim through the {name} placeholder — a locale
        // whose translation dropped the placeholder would render the sentence without the table.
        expect(notice.textContent, `${locale}/${status} table name`).toContain('Hospitalization — all staff');
        expect(looksUnresolved(container.textContent ?? ''), `${locale}/${status} panel body`).toBe(false);
        unmount();
      }
    });

    it(`[${locale}] the balance grid captions the YTD Entitled cell without losing the figure`, () => {
      for (const status of ANNOUNCED) {
        const { unmount, container } = renderTable(locale, status);
        const text = container.textContent ?? '';
        expect(looksUnresolved(text), `${locale}/${status} unresolved key`).toBe(false);
        // The caption is ADDED, not substituted: the figure keeps its cell (YTD Entitled can be non-zero
        // for an ungenerated type that has a carry-in, so replacing it would be a second wrong reading).
        expect(text).toContain('0.00');
        // And it is a real translated string, not the English one leaking into five other catalogues.
        const label = (CATALOGUES[locale] as unknown as {
          me: { leaveBalanceTable: Record<string, string> };
        }).me.leaveBalanceTable[ENTITLEMENT_STATUS_LABEL_KEY[status]];
        expect(text, `${locale}/${status} label`).toContain(label);
        unmount();
      }
    });
  }

  it('an earned type is never captioned with the Generate Entitlement instruction', () => {
    // THE FINDING, AT THE RENDER. `earned_accrual` is the branch a year-open logs `earned_method` and
    // skips; borrowing `not_generated`'s copy here would put "Run Generate Entitlement" in front of every
    // employee whose Annual Leave accrues monthly, from cycle rollover until the first accrual lands.
    const panel = renderPanel('en', 'earned_accrual');
    const notice = screen.getByRole('status').textContent ?? '';
    expect(notice).toContain(en.leave.breakdown.statusEarnedAccrualTitle);
    expect(notice).not.toContain(en.leave.breakdown.statusNotGeneratedTitle);
    panel.unmount();

    const table = renderTable('en', 'earned_accrual');
    const text = table.container.textContent ?? '';
    expect(text).toContain(en.me.leaveBalanceTable.statusEarnedAccrual);
    expect(text.includes(en.me.leaveBalanceTable.statusNotGenerated)).toBe(false);
    table.unmount();
  });

  it('says NOTHING for the two states that need no announcement', () => {
    for (const status of SILENT) {
      const panel = renderPanel('en', status);
      expect(screen.queryByRole('status'), `panel/${status}`).toBeNull();
      panel.unmount();

      const table = renderTable('en', status);
      const text = table.container.textContent ?? '';
      for (const announced of ANNOUNCED) {
        const label = en.me.leaveBalanceTable[
          ENTITLEMENT_STATUS_LABEL_KEY[announced] as keyof typeof en.me.leaveBalanceTable
        ] as string;
        expect(text.includes(label), `table/${status} must not show ${announced}`).toBe(false);
      }
      // The figure is still there — suppressing the caption must not suppress the row.
      expect(text).toContain('0.00');
      table.unmount();
    }
  });
});
