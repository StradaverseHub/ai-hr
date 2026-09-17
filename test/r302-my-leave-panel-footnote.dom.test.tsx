/**
 * r302 hand-fix (second verification, defect 2) — the Details column opened from a My Leave card ADDS UP, and when
 * the card's Balance also counts rows dated after this leave year the panel says so under its column, in six locales.
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
import type { LeaveEntitlementBreakdown } from '../core/read';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
afterEach(() => cleanup());

const breakdown = (over: Partial<LeaveEntitlementBreakdown> = {}): LeaveEntitlementBreakdown =>
  ({
    leaveTypeId: 'lt-annual', leaveType: 'Annual Leave', asOf: '2026-12-31', cycleStart: '2026-01-01', eligibleDays: 14, entitlementStatus: 'granted', entitlementTemplateName: null,
    currentYearEntitlement: 14, monthlyAccruedToDate: 14, carriedForward: 0, carryForwardRemaining: 0, carryForwardExpiryDate: null, forfeited: 0, otherAdjustments: 0, balance: 14,
    pendingApproval: 0, broughtForward: 0, configAdjustments: 0, systemAdjustments: 0, forfeitedThisCycle: 0, takenThisCycle: 0, configAdjustmentItems: [], adjustments: 0,
    totalEntitlement: 14, totalAvailable: 14, transactions: [],
    essView: { eligible: true, ytdEntitled: true, broughtForward: true, adjustment: true, total: true, taken: true, pendingApproval: true, forfeited: true, available: true },
    formulaExplanations: {}, ...over,
  }) as LeaveEntitlementBreakdown;

const card = (over: Partial<MyLeaveDashboardCard> = {}): MyLeaveDashboardCard => ({
  leaveTypeId: 'lt-annual', leaveType: 'Annual Leave', code: 'ANNUAL', color: null, icon: null, role: 'annual', placement: 'primary', annualLeave: true,
  cycleStart: '2026-01-01', cycleEnd: '2026-12-31', asOf: '2026-12-31', isCurrentCycle: true, entitlement: 14, earnedSoFar: 14, taken: 0, pending: 0, balance: 14,
  canApplyFor: 14, remaining: 14, balanceIncludesLater: null, expiringSoon: null, hasEntitlement: true, takenOnly: false, entitlementStatus: 'granted', sharedBalance: null,
  essView: { available: true, taken: true }, breakdown: breakdown(), ...over,
});


describe('the Details panel under a card whose Balance counts next leave year', () => {
  for (const loc of Object.keys(CATALOGUES) as Locale[]) {
    it(`${loc}: footnote present; no footnote without later rows`, async () => {
      const m = (CATALOGUES[loc] as unknown as { leave: { myLeave: Record<string, string> } }).leave.myLeave;
      const errors: string[] = [];
      // This year: Total 14, Pending 1 ⇒ Available 13. The card also counts next year's 14 granted and 2 booked.
      const withLater = card({
        pending: 1, balance: 26, canApplyFor: 25, remaining: 25,
        balanceIncludesLater: { span: 'next', granted: 14, booked: 2, itemised: true },
        breakdown: breakdown({ pendingApproval: 1, totalAvailable: 13 }),
      });
      const view = render(
        <NextIntlClientProvider locale={loc} messages={CATALOGUES[loc]} onError={(e) => errors.push(String((e as Error).message ?? e))}>
          <MyLeaveDashboard cards={[withLater]} locale={loc} />
        </NextIntlClientProvider>,
      );
      const host = screen.queryByTestId('leave-ring-card') ?? screen.getByTestId('leave-type-card');
      await userEvent.click(within(host).getByRole('button', { name: m.detailsFor.replace('{type}', withLater.leaveType) }));
      const note = within(screen.getByRole('dialog')).getByTestId('panel-footnote');
      expect(note.textContent ?? '').toMatch(/14/);
      expect(note.textContent ?? '').toMatch(/2/);
      expect(errors, 'no MISSING_MESSAGE / FORMATTING_ERROR').toEqual([]);
      view.unmount();

      render(
        <NextIntlClientProvider locale={loc} messages={CATALOGUES[loc]}>
          <MyLeaveDashboard cards={[card()]} locale={loc} />
        </NextIntlClientProvider>,
      );
      const host2 = screen.queryByTestId('leave-ring-card') ?? screen.getByTestId('leave-type-card');
      await userEvent.click(within(host2).getByRole('button', { name: m.detailsFor.replace('{type}', 'Annual Leave') }));
      expect(within(screen.getByRole('dialog')).queryByTestId('panel-footnote')).toBeNull();
    });
  }
});
