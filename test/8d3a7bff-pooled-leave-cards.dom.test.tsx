/**
 * 8d3a7bff · "SPECIAL LEAVE" TWICE — THE TWO HALVES OF A SHARED BALANCE, TOLD APART.
 *
 * THE REPORTED FAULT AND WHY THE OBVIOUS FIX IS WRONG. The reporter saw two cards both saying "Special
 * Leave" and asked for one to be removed. Production says otherwise: exactly ONE leave type matches Special
 * Leave (code SP, role NULL, not archived, `balance_source_type_id` NULL) and it carries 79 `leave_ledger`
 * rows summing to 790.00 days. The second card is COMPASSIONATE LEAVE spending the Special Leave pot —
 * `leave_type.balance_source_type_id` — which is a deliberate setting, and the account has exactly two such
 * pairs: EL → AL and CPL → SP. Removing the second card would take Compassionate Leave, and the days the
 * employee may spend on it, off their screen entirely. Neither card may disappear.
 *
 * WHY THEY LOOKED IDENTICAL, which is the real defect. `balanceStoryTypeId` (lib/shared-leave-balance.ts)
 * returns the POOL's id for a borrower on purpose, so `core/my-leave.ts` builds the borrower's card from the
 * POOL's `leaveEntitlementBreakdown`, and `leaveTypeApplySummary` resolves the borrower to the same source
 * ledger and the same pooled reservation. Entitlement, Earned so far, Taken, Pending and Balance on the
 * borrower were therefore the pool's figures, digit for digit — two cards with one set of numbers.
 *
 * ⚠️ THE FIGURES ARE NOT WHAT CHANGED, AND MUST NOT BE. lib/shared-leave-balance.ts records what the naive
 * alternative produced: a borrower reading its OWN empty breakdown — "YTD Entitled 0.00 … Balance 10.00" —
 * under a red notice telling HR to create an entitlement table, i.e. to do the one thing that would stop it
 * borrowing. So this file pins the change as PRESENTATION ONLY, and the invariance half is the load-bearing
 * half: the pool's card and every ordinary type are asserted figure for figure as they render today.
 *
 * The fixtures carry BOTH production pairs. A fix covering only CPL → SP leaves the identical complaint live
 * on Annual Leave — where the pool is the RING card — so both are asserted, in all six locales, with
 * next-intl's onError collected and required empty (i18n/request.ts deep-merges each locale over English, so
 * a missing key renders English rather than MISSING_MESSAGE: presence is asserted explicitly too).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import { MyLeaveDashboard, type MyLeaveDashboardCard } from '../components/leave/my-leave-dashboard';
import type { LeaveEntitlementBreakdown } from '../core/read';
import type { SharedLeaveBalanceInfo } from '../lib/shared-leave-balance';
import { formatDays } from '../lib/day-format';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];
type MyLeaveMsgs = (typeof en)['leave']['myLeave'];
const ml = (loc: Locale) => (CATALOGUES[loc] as unknown as { leave: { myLeave: MyLeaveMsgs } }).leave.myLeave;

/** 7da0a4e7 — the shared figure names. This guard pins labels the round deliberately standardised, so it
 *  is updated rather than loosened, and still reads its expected words out of the catalogue. */
const lf = (loc: Locale) =>
  (CATALOGUES[loc] as unknown as { leaveFigure: Record<string, string> }).leaveFigure;
afterEach(() => cleanup());

function mount(loc: Locale, node: React.ReactNode) {
  const errors: string[] = [];
  const view = render(
    <NextIntlClientProvider locale={loc} messages={CATALOGUES[loc]} onError={(e) => errors.push(String((e as Error).message ?? e))}>
      {node}
    </NextIntlClientProvider>,
  );
  return { view, errors };
}

/** The interpolation next-intl will do, done here, so each locale is asserted against ITS OWN sentence. */
const fill = (pattern: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), pattern);

const breakdown = (over: Partial<LeaveEntitlementBreakdown> = {}): LeaveEntitlementBreakdown =>
  ({
    leaveTypeId: 'lt-sp',
    leaveType: 'Special Leave',
    asOf: '2026-12-31',
    cycleStart: '2026-01-01',
    eligibleDays: 12,
    entitlement: { annualEntitlementDays: 12, prorated: false, eligibleCalendarDays: null,
      daysInLeaveYear: null, unroundedEntitlementDays: 12, displayEntitlementDays: 12, roundingApplied: false },
    entitlementStatus: 'granted',
    entitlementTemplateName: 'Special — all staff',
    currentYearEntitlement: 12,
    currentYearEntitlementRounded: 12,
    monthlyAccruedToDate: 12,
    carriedForward: 0,
    carryForwardRemaining: 0,
    carryForwardExpiryDate: null,
    forfeited: 0,
    otherAdjustments: 0,
    balance: 8,
    pendingApproval: 1,
    broughtForward: 0,
    configAdjustments: 0,
    systemAdjustments: 0,
    forfeitedThisCycle: 0,
    takenThisCycle: 4,
    configAdjustmentItems: [],
    adjustments: 0,
    totalEntitlement: 12,
    totalAvailable: 7,
    transactions: [],
    essView: {
      eligible: true, ytdEntitled: true, broughtForward: true, adjustment: true,
      total: true, taken: true, pendingApproval: true, forfeited: true, available: true,
    },
    formulaExplanations: {},
    ...over,
  }) as LeaveEntitlementBreakdown;

const base = (over: Partial<MyLeaveDashboardCard> = {}): MyLeaveDashboardCard => ({
  leaveTypeId: 'lt-sp',
  leaveType: 'Special Leave',
  code: 'SP',
  color: null,
  icon: null,
  role: null,
  placement: 'secondary',
  annualLeave: false,
  cycleStart: '2026-01-01',
  cycleEnd: '2026-12-31',
  asOf: '2026-12-31',
  isCurrentCycle: true,
  entitlement: 12,
  earnedSoFar: 12,
  taken: 4,
  pending: 1,
  balance: 8,
  canApplyFor: 7,
  remaining: 7,
  balanceIncludesLater: null,
  expiringSoon: null,
  hasEntitlement: true,
  takenOnly: false,
  entitlementStatus: 'granted',
  sharedBalance: null,
  essView: { available: true, taken: true },
  breakdown: breakdown(),
  ...over,
});

// ── PAIR 1 · CPL → SP. The pool is an ordinary (non-ring) card. ────────────────────────────────────────────
const SP_POOL: SharedLeaveBalanceInfo = {
  sourceLeaveTypeId: 'lt-sp',
  sourceLeaveTypeName: 'Special Leave',
  contributingLeaveTypes: ['Special Leave', 'Compassionate Leave'],
};
const specialLeave = base({ sharedBalance: SP_POOL });
/** THE SECOND CARD AS THE SERVER REALLY BUILDS IT: every figure is the pool's, because the borrower's card is
 *  built from the POOL's breakdown and the POOL's apply summary. Only the title and the pool link differ. */
const compassionate = base({
  leaveTypeId: 'lt-cpl',
  leaveType: 'Compassionate Leave',
  code: 'CPL',
  sharedBalance: SP_POOL,
});

// ── PAIR 2 · EL → AL. The pool is the RING card. Same arrangement, same complaint if it is missed. ─────────
const AL_POOL: SharedLeaveBalanceInfo = {
  sourceLeaveTypeId: 'lt-annual',
  sourceLeaveTypeName: 'Annual Leave',
  contributingLeaveTypes: ['Annual Leave', 'Emergency Leave'],
};
const annual = base({
  leaveTypeId: 'lt-annual',
  leaveType: 'Annual Leave',
  code: 'ANNUAL',
  role: 'annual',
  placement: 'primary',
  annualLeave: true,
  entitlement: 14,
  earnedSoFar: 10.5,
  taken: 3,
  pending: 2,
  balance: 7.5,
  canApplyFor: 5.5,
  remaining: 5.5,
  sharedBalance: AL_POOL,
  breakdown: breakdown({ leaveTypeId: 'lt-annual', leaveType: 'Annual Leave' }),
});
const emergency = base({
  leaveTypeId: 'lt-emergency',
  leaveType: 'Emergency Leave',
  code: 'EL',
  entitlement: 14,
  earnedSoFar: 10.5,
  taken: 3,
  pending: 2,
  balance: 7.5,
  canApplyFor: 5.5,
  remaining: 5.5,
  sharedBalance: AL_POOL,
  breakdown: breakdown({ leaveTypeId: 'lt-annual', leaveType: 'Annual Leave' }),
});

/** An ordinary type: `balanceStoryTypeId`'s identity path. Nothing about it may move. */
const medical = base({
  leaveTypeId: 'lt-sick',
  leaveType: 'Medical Leave',
  code: 'SICK',
  entitlement: 14,
  earnedSoFar: 14,
  taken: 1,
  pending: 0,
  balance: 13,
  canApplyFor: 13,
  remaining: 13,
  breakdown: breakdown({ leaveTypeId: 'lt-sick', leaveType: 'Medical Leave' }),
});

const ALL = [annual, emergency, specialLeave, compassionate, medical];

const cardNamed = (name: string) => screen.getAllByTestId('leave-type-card').find((c) => c.getAttribute('aria-label') === name)!;

/** The dl rows of a small card, as label → printed value, in DOM order. */
const dlRows = (el: HTMLElement): [string, string][] =>
  [...el.querySelectorAll('dl > div')].map((d) => [d.querySelector('dt')!.textContent!, d.querySelector('dd')!.textContent!]);

describe('8d3a7bff · the two halves of a shared balance read differently', () => {
  it('both new captions exist in all six catalogues (deep-merge would otherwise hide a gap behind English)', () => {
    for (const loc of LOCALES) {
      const L = ml(loc) as unknown as Record<string, string>;
      expect(typeof L.sharedFromPool, `${loc}.leave.myLeave.sharedFromPool`).toBe('string');
      expect(typeof L.sharedPoolHolder, `${loc}.leave.myLeave.sharedPoolHolder`).toBe('string');
      expect(L.sharedFromPool, `${loc}.sharedFromPool names the pool`).toContain('{pool}');
      expect(L.sharedPoolHolder, `${loc}.sharedPoolHolder names the sharers`).toContain('{types}');
    }
    // Six DISTINCT sentences: a locale that merely inherits English is a translation that was not done.
    for (const key of ['sharedFromPool', 'sharedPoolHolder'] as const) {
      const seen = new Set(LOCALES.map((loc) => (ml(loc) as unknown as Record<string, string>)[key]));
      expect(seen.size, `${key} is the same string in two locales`).toBe(LOCALES.length);
    }
  });

  it.each(LOCALES)(
    '%s — (a) a BORROWER names its pool and repeats none of the pool\'s entitlement figures; (d) for BOTH pairs',
    (loc) => {
      const L = ml(loc) as unknown as Record<string, string>;
      const { errors } = mount(loc, <MyLeaveDashboard cards={ALL} locale={loc} />);
      expect(errors, `${loc}: next-intl errors`).toEqual([]);

      for (const [name, poolName, applyFor] of [
        ['Compassionate Leave', 'Special Leave', 7],
        ['Emergency Leave', 'Annual Leave', 5.5],
      ] as const) {
        const el = cardNamed(name);

        // NAMES ITS POOL, in this locale's own words.
        expect(within(el).getByTestId('shared-balance-caption').textContent, `${loc}: ${name} pool caption`).toBe(
          fill(L.sharedFromPool, { pool: poolName }),
        );

        // DOES NOT REPEAT THE POOL'S ENTITLEMENT AS ITS OWN. The pool's Entitlement / Earned so far / Taken /
        // Pending / Balance are gone from this card; it prints one figure, and it is the applyable one.
        expect(dlRows(el), `${loc}: ${name} still prints the pool's breakdown rows`).toEqual([]);
        for (const label of [L.entitlement, lf(loc).earnedToDate, L.balance] as string[]) {
          expect(within(el).queryByText(label), `${loc}: ${name} repeats "${label}"`).toBeNull();
        }

        // SHOWS WHAT CAN BE APPLIED FOR, and only that.
        const headline = within(el).getByTestId('can-apply-for');
        expect(headline.textContent, `${loc}: ${name} headline figure`).toBe(formatDays(applyFor));
        expect(headline.nextElementSibling!.textContent, `${loc}: ${name} headline caption`).toBe(lf(loc).availableBalance);
      }
    },
  );

  it.each(LOCALES)('%s — (b) the POOL still states plainly that the days are shared, and with what', (loc) => {
    const L = ml(loc) as unknown as Record<string, string>;
    const { errors } = mount(loc, <MyLeaveDashboard cards={ALL} locale={loc} />);
    expect(errors, `${loc}: next-intl errors`).toEqual([]);

    // CPL → SP: the pool is a small card.
    expect(within(cardNamed('Special Leave')).getByTestId('shared-balance-caption').textContent, `${loc}: SP caption`).toBe(
      fill(L.sharedPoolHolder, { types: 'Compassionate Leave' }),
    );
    // EL → AL: the pool is the ring card. Same sentence, same shape.
    const ring = screen.getAllByTestId('leave-ring-card')[0];
    expect(ring.getAttribute('aria-label')).toBe('Annual Leave');
    expect(within(ring).getByTestId('shared-balance-caption').textContent, `${loc}: AL caption`).toBe(
      fill(L.sharedPoolHolder, { types: 'Emergency Leave' }),
    );
  });

  it.each(LOCALES)('%s — (b) the POOL\'s entitlement, earned and balance are byte-identical to today', (loc) => {
    const L = ml(loc) as unknown as Record<string, string>;
    mount(loc, <MyLeaveDashboard cards={ALL} locale={loc} />);

    // The pool small card, figure for figure, in the order it renders today.
    const sp = cardNamed('Special Leave');
    expect(sp.querySelector('p')!.textContent, `${loc}: SP headline`).toBe(formatDays(8));
    expect(sp.querySelector('p')!.nextElementSibling!.textContent, `${loc}: SP headline caption`).toBe(L.balance);
    expect(dlRows(sp), `${loc}: SP breakdown rows`).toEqual([
      [L.entitlement, formatDays(12)],
      [lf(loc).earnedToDate, formatDays(12)],
      [L.taken, formatDays(4)],
      [L.pending, formatDays(1)],
    ]);
    expect(within(sp).getByTestId('can-apply-for').textContent, `${loc}: SP can apply for`).toBe(`${lf(loc).availableBalance}${formatDays(7)}`);

    // The pool ring card's own two lines above its legend.
    const ring = screen.getAllByTestId('leave-ring-card')[0];
    for (const [label, value] of [
      [L.entitlement, 14],
      [lf(loc).earnedToDate, 10.5],
    ] as const) {
      const dt = within(ring).getByText(label, { selector: 'dt' });
      expect(dt.parentElement!.querySelector('dd')!.textContent, `${loc}: AL ${label}`).toBe(formatDays(value));
    }
    // cac9a3a1 (r369) — UPDATED, with the claim it retires quoted: this line read `toContain(formatDays(7.5))`,
    // i.e. the pool ring card's BALANCE in the middle of the ring. Balance is gross of pending; the green arc the
    // centre sits inside is the available figure (5.50 here), so the two disagreed. The pool's FIGURES are still
    // byte-identical to the day this file was written — which is this arm's whole job — only which of them the
    // middle of the ring repeats has changed.
    expect(within(ring).getByTestId('leave-balance-ring').textContent, `${loc}: AL ring centre`).toContain(formatDays(5.5));
    expect(
      within(ring).getByTestId('leave-balance-ring').querySelector('div[aria-hidden="true"]')!.textContent,
      `${loc}: AL ring centre is the available figure, not the balance`,
    ).toBe(`${formatDays(5.5)}${(ml(loc) as unknown as Record<string, string>).centreCaption.replace('{label}', lf(loc).availableBalance)}`);
  });

  it.each(LOCALES)('%s — (c) an ordinary unpooled type is byte-identical to today, and says nothing about a pool', (loc) => {
    const L = ml(loc) as unknown as Record<string, string>;
    const { errors } = mount(loc, <MyLeaveDashboard cards={ALL} locale={loc} />);
    expect(errors, `${loc}: next-intl errors`).toEqual([]);

    const med = cardNamed('Medical Leave');
    expect(within(med).queryByTestId('shared-balance-caption'), `${loc}: Medical Leave mentions a pool`).toBeNull();
    expect(med.querySelector('p')!.textContent, `${loc}: Medical headline`).toBe(formatDays(13));
    expect(med.querySelector('p')!.nextElementSibling!.textContent, `${loc}: Medical headline caption`).toBe(L.balance);
    expect(dlRows(med), `${loc}: Medical breakdown rows`).toEqual([
      [L.entitlement, formatDays(14)],
      [lf(loc).earnedToDate, formatDays(14)],
      [L.taken, formatDays(1)],
      [L.pending, formatDays(0)],
    ]);
    expect(within(med).getByTestId('can-apply-for').textContent, `${loc}: Medical can apply for`).toBe(
      `${lf(loc).availableBalance}${formatDays(13)}`,
    );
  });

  it('neither card disappears: five types in, five cards out', () => {
    mount('en', <MyLeaveDashboard cards={ALL} locale="en" />);
    const titles = [
      ...screen.getAllByTestId('leave-ring-card').map((c) => c.getAttribute('aria-label')),
      ...screen.getAllByTestId('leave-type-card').map((c) => c.getAttribute('aria-label')),
    ];
    expect(new Set(titles)).toEqual(
      new Set(['Annual Leave', 'Emergency Leave', 'Special Leave', 'Compassionate Leave', 'Medical Leave']),
    );
  });

  it('an earlier leave year: the borrower shows that year\'s Remaining, still under its pool\'s name', () => {
    const past = { ...compassionate, isCurrentCycle: false, canApplyFor: null, remaining: 3 };
    mount('en', <MyLeaveDashboard cards={[{ ...specialLeave, isCurrentCycle: false, canApplyFor: null }, past]} locale="en" />);
    const el = cardNamed('Compassionate Leave');
    expect(within(el).queryByTestId('can-apply-for')).toBeNull();
    expect(el.querySelector('p')!.textContent).toBe(formatDays(3));
    expect(el.querySelector('p')!.nextElementSibling!.textContent).toBe(en.leave.myLeave.remaining);
    expect(within(el).getByTestId('shared-balance-caption').textContent).toBe('These days come from the Special Leave balance.');
  });
});
