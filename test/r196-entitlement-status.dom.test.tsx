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
 * Also asserted here, and not statically assertable anywhere else: the caption appears ONLY for the two
 * states that need announcing. A banner on every leave type a tenant has not configured would bury the
 * two that matter, which is the same failure as saying nothing.
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
import type { EntitlementStatus } from '../lib/entitlement-status';

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
  /\bstatus(NotGenerated|EarningMethodMissing|Generated|NotConfigured)/.test(text);

describe('31e39d74: the not-yet-generated notice resolves in every locale', () => {
  for (const locale of LOCALES) {
    it(`[${locale}] the breakdown panel renders both notice states, and names the table`, () => {
      for (const status of ['not_generated', 'earning_method_missing'] as const) {
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
      const { unmount, container } = renderTable(locale, 'not_generated');
      const text = container.textContent ?? '';
      expect(looksUnresolved(text), `${locale} unresolved key`).toBe(false);
      // The caption is ADDED, not substituted: the figure keeps its cell (YTD Entitled can be non-zero for
      // an ungenerated type that has a carry-in, so replacing it would be a second wrong reading).
      expect(text).toContain('0.00');
      // And it is a real translated string, not the English one leaking into five other catalogues.
      const label = (CATALOGUES[locale] as unknown as {
        me: { leaveBalanceTable: Record<string, string> };
      }).me.leaveBalanceTable.statusNotGenerated;
      expect(text, `${locale} label`).toContain(label);
      unmount();
    });
  }

  it('says NOTHING for the two states that need no announcement', () => {
    for (const status of ['granted', 'not_configured'] as const) {
      const panel = renderPanel('en', status);
      expect(screen.queryByRole('status'), `panel/${status}`).toBeNull();
      panel.unmount();

      const table = renderTable('en', status);
      const text = table.container.textContent ?? '';
      expect(text.includes(en.me.leaveBalanceTable.statusNotGenerated), `table/${status}`).toBe(false);
      expect(text.includes(en.me.leaveBalanceTable.statusEarningMethodMissing), `table/${status}`).toBe(false);
      // The figure is still there — suppressing the caption must not suppress the row.
      expect(text).toContain('0.00');
      table.unmount();
    }
  });
});
