/**
 * r303 (31492f74) — THE EMPLOYEE'S LEAVE SUMMARY, RENDERED THE WAY MY LEAVE RENDERS IT, AS TEXT.
 *
 * HR's Leave Summary gains per-line sentences in r303; the employee's own side-sheet must not move by a byte.
 * This helper renders the employee mounts and returns the opened dialog's markup, so
 * test/r303-leave-summary-explain.dom.test.tsx can compare it with `test/fixtures/r303-employee-leave-panel.json`
 * — markup captured by THIS helper on the r303 base commit, BEFORE LeaveDetailsPanel was changed.
 *
 * Deliberately a helper and not inline in the test: the capture and the comparison must run the identical
 * rendering code, or a difference could be the harness rather than the panel.
 *
 * The one normalisation is React's `useId` tokens (Radix derives dialog/title ids from them). They count up
 * across every root rendered in the process, so the same markup gets a different number depending on how many
 * tests ran first. Nothing else is touched.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../messages/en.json';
import ms from '../../messages/ms.json';
import ta from '../../messages/ta.json';
import th from '../../messages/th.json';
import vi from '../../messages/vi.json';
import zh from '../../messages/zh.json';

import { MyLeaveDashboard, type MyLeaveDashboardCard } from '../../components/leave/my-leave-dashboard';
import { LeaveDetailsPanel } from '../../components/leave/LeaveDetailsPanel';
import type { LeaveEntitlementBreakdown } from '../../core/read';

export const EMPLOYEE_PANEL_CATALOGUES = { en, ms, ta, th, vi, zh } as const;
export type EmployeePanelLocale = keyof typeof EMPLOYEE_PANEL_CATALOGUES;

/** A breakdown exercising everything the employee panel draws: an ESS-hidden row, two HR explanations (one
 *  description-only), a carry expiry note, a notice-free status, and non-trivial figures. */
export const EMPLOYEE_BREAKDOWN = {
  leaveTypeId: 'lt-annual',
  leaveType: 'Annual Leave',
  asOf: '2026-12-31',
  cycleStart: '2026-01-01',
  eligibleDays: 14,
  // 845903a3 (r313) — the Entitlement line's figure. This fixture's employee joined before the leave
  // year, so nothing prorates and the line shows the band itself: the employee panel is unchanged,
  // which is exactly what the byte-for-byte guard above this helper exists to prove.
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
  currentYearEntitlement: 10.5,
  currentYearEntitlementRounded: 10.5, // r335: no rounding rule in this fixture
  monthlyAccruedToDate: 10.5,
  carriedForward: 2,
  carryForwardRemaining: 0,
  carryForwardExpiryDate: '2026-03-31',
  forfeited: 1,
  otherAdjustments: 1,
  balance: 9.5,
  pendingApproval: 2,
  broughtForward: 3,
  configAdjustments: 1,
  systemAdjustments: 0,
  forfeitedThisCycle: 1,
  takenThisCycle: 4,
  configAdjustmentItems: [{ effectiveOn: '2026-02-01', days: 1, reason: 'CNY 2026' }],
  adjustments: 1,
  totalEntitlement: 14.5,
  totalAvailable: 7.5,
  transactions: [],
  essView: {
    eligible: true,
    ytdEntitled: true,
    broughtForward: true,
    adjustment: false,
    total: true,
    taken: true,
    pendingApproval: true,
    forfeited: true,
    available: true,
  },
  formulaExplanations: {
    taken: { description: 'Approved leave already used.', formula: 'Sum of approved days' },
    eligible: { description: 'Your yearly allowance.' },
  },
} as unknown as LeaveEntitlementBreakdown;

const card = (): MyLeaveDashboardCard =>
  ({
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
    earnedSoFar: 10.5,
    taken: 4,
    pending: 2,
    balance: 9.5,
    canApplyFor: 7.5,
    // r303 integration: fields the My Leave fix pass added to the card (the ring's third arc; the later-rows line).
    remaining: 7.5,
    balanceIncludesLater: null,
    expiringSoon: null,
    hasEntitlement: true,
    takenOnly: false,
    entitlementStatus: 'granted',
    sharedBalance: null,
    essView: { available: true, taken: true },
    breakdown: EMPLOYEE_BREAKDOWN,
  }) as MyLeaveDashboardCard;

export const normaliseIds = (html: string) => html.replace(/«r[0-9a-z]+»|:r[0-9a-z]+:|_r_[0-9a-z]+_/g, '«id»');

type Msgs = typeof en;

/** My Leave: Details on the Annual Leave card, then the HR-authored explanation on Taken opened. */
export async function renderEmployeeDashboardPanel(loc: EmployeePanelLocale): Promise<{ opened: string; tooltip: string }> {
  const dict = EMPLOYEE_PANEL_CATALOGUES[loc] as unknown as Msgs;
  render(
    <NextIntlClientProvider locale={loc} messages={EMPLOYEE_PANEL_CATALOGUES[loc]}>
      <MyLeaveDashboard cards={[card()]} locale={loc} />
    </NextIntlClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: dict.leave.myLeave.detailsFor.replace('{type}', 'Annual Leave') }));
  const dialog = await screen.findByRole('dialog');
  const opened = normaliseIds(dialog.outerHTML);
  await user.click(within(dialog).getAllByRole('button', { name: dict.leave.breakdown.explanationShow })[0]);
  const tooltip = normaliseIds(screen.getByRole('dialog').outerHTML);
  cleanup();
  return { opened, tooltip };
}

/** The uncontrolled employee mount (built-in trigger, as-at form, ESS gating) — the panel's other employee shape. */
export async function renderEmployeeTriggerPanel(loc: EmployeePanelLocale): Promise<string> {
  const dict = EMPLOYEE_PANEL_CATALOGUES[loc] as unknown as Msgs;
  render(
    <NextIntlClientProvider locale={loc} messages={EMPLOYEE_PANEL_CATALOGUES[loc]}>
      <LeaveDetailsPanel
        data={EMPLOYEE_BREAKDOWN}
        summary={{ available: 7.5 }}
        visual={{ color: null, icon: null, code: 'ANNUAL' }}
        asOf="2026-12-31"
        action="/leave"
        applyEssConfig
      />
    </NextIntlClientProvider>,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: dict.leave.breakdown.viewBreakdown }));
  const html = normaliseIds((await screen.findByRole('dialog')).outerHTML);
  cleanup();
  return html;
}
