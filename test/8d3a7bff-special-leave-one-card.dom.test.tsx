/**
 * r341 · 8d3a7bff — ONE "Special Leave" CARD ON SCREEN, WITH THE CEILING ON IT.
 *
 * The server half (which type draws a card, which group merges onto which card) is pinned in
 * test/8d3a7bff-special-leave-one-card.test.ts. This is the SCREEN half, and it answers the reporter's own
 * words: how many cards headed "Special Leave" does My Leave draw, and does the removed stacked-layers tile's
 * information survive the removal?
 *
 *   (a) exactly ONE card for the pool: the type card is present and NO group tile is drawn beside it;
 *   (e) the per-application cap is on that card, and it is the group's `max_days_per_application`;
 *   (d) Marriage Leave's card is drawn WITH its balance and names the ceiling it counts towards.
 *
 * ⚠️ A GROUP WITH NOTHING TO MERGE ONTO STILL DRAWS ITS TILE, and that arm is asserted too: `pnpm db:seed`
 * configures no pooled type and no shared group, so on a freshly seeded tenant this feature is entirely the
 * unmerged branch — the one a test that only covered the merge would leave unguarded.
 *
 * Six locales, with next-intl's onError collected and required empty. i18n/request.ts deep-merges each locale
 * over English, so a missing key renders English rather than MISSING_MESSAGE: presence is asserted per
 * catalogue as well. The two new keys carry ENGLISH TEXT in all six by this project's convention for new
 * strings, so they are asserted PRESENT and IDENTICAL rather than distinct — claiming six translations we did
 * not have made would be the lie a distinctness assertion tells here.
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

import {
  MyLeaveDashboard,
  type MyLeaveDashboardCard,
  type PooledCeilingLines,
} from '../components/leave/my-leave-dashboard';
import type { SharedLeaveGroupEntry } from '../components/leave/shared-leave-group-cards';
import type { LeaveEntitlementBreakdown } from '../core/read';
import type { SharedLeaveBalanceInfo } from '../lib/shared-leave-balance';
import { formatDays } from '../lib/day-format';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];
const slg = (loc: Locale) =>
  (CATALOGUES[loc] as unknown as { me: { sharedLeaveGroups: Record<string, string> } }).me.sharedLeaveGroups;

afterEach(() => cleanup());

function mount(loc: Locale, node: React.ReactNode) {
  const errors: string[] = [];
  render(
    <NextIntlClientProvider
      locale={loc}
      messages={CATALOGUES[loc]}
      onError={(e) => errors.push(String((e as Error).message ?? e))}
    >
      {node}
    </NextIntlClientProvider>,
  );
  return { errors };
}

/** The interpolation next-intl will do, done here, so each locale is asserted against ITS OWN sentence. */
const fill = (pattern: string, vars: Record<string, string>) =>
  Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), pattern);

const breakdown = (over: Partial<LeaveEntitlementBreakdown> = {}): LeaveEntitlementBreakdown =>
  ({
    leaveTypeId: 'lt-sp', leaveType: 'Special Leave', asOf: '2026-12-31', cycleStart: '2026-01-01',
    eligibleDays: 10,
    entitlement: { annualEntitlementDays: 10, prorated: false, eligibleCalendarDays: null, daysInLeaveYear: null,
      unroundedEntitlementDays: 10, displayEntitlementDays: 10, roundingApplied: false },
    entitlementStatus: 'granted', entitlementTemplateName: 'Special — all staff',
    currentYearEntitlement: 10, currentYearEntitlementRounded: 10, monthlyAccruedToDate: 10,
    carriedForward: 0, carryForwardRemaining: 0, carryForwardExpiryDate: null, forfeited: 0, otherAdjustments: 0,
    balance: 8, pendingApproval: 0, broughtForward: 0, configAdjustments: 0, systemAdjustments: 0,
    forfeitedThisCycle: 0, takenThisCycle: 2, configAdjustmentItems: [], adjustments: 0,
    totalEntitlement: 10, totalAvailable: 8, transactions: [],
    essView: { eligible: true, ytdEntitled: true, broughtForward: true, adjustment: true, total: true,
      taken: true, pendingApproval: true, forfeited: true, available: true },
    formulaExplanations: {},
    ...over,
  }) as LeaveEntitlementBreakdown;

const card = (over: Partial<MyLeaveDashboardCard> = {}): MyLeaveDashboardCard => ({
  leaveTypeId: 'lt-sp', leaveType: 'Special Leave', code: 'SP', color: null, icon: null, role: null,
  placement: 'secondary', annualLeave: false, cycleStart: '2026-01-01', cycleEnd: '2026-12-31',
  asOf: '2026-12-31', isCurrentCycle: true, entitlement: 10, earnedSoFar: 10, taken: 2, pending: 0,
  balance: 8, canApplyFor: 8, remaining: 8, balanceIncludesLater: null, expiringSoon: null,
  hasEntitlement: true, takenOnly: false, entitlementStatus: 'granted', sharedBalance: null,
  essView: { available: true, taken: true }, breakdown: breakdown(),
  ...over,
});

/** The pool, exactly as core/read.ts builds it: `sharedBalance.sourceLeaveTypeId` is its own id. */
const SP_POOL: SharedLeaveBalanceInfo = {
  sourceLeaveTypeId: 'lt-sp',
  sourceLeaveTypeName: 'Special Leave',
  contributingLeaveTypes: ['Special Leave', 'Compassionate Leave', 'Natural Disaster Leave'],
  contributions: [
    { leaveTypeId: 'lt-cpl', leaveType: 'Compassionate Leave', code: 'CPL', share: 2, pendingShare: 0 },
    { leaveTypeId: 'lt-ndl', leaveType: 'Natural Disaster Leave', code: 'NDL', share: 0, pendingShare: 0 },
  ],
};

const CEILING = { available: 8, limit: 10, cap: 3 } as const;

const ceilingLines = (loc: Locale): PooledCeilingLines => ({
  limitLine: fill(slg(loc).pooledLimitLine, {
    available: formatDays(CEILING.available),
    limit: formatDays(CEILING.limit),
  }),
  membersLine: fill(slg(loc).sharedAcross, {
    types: 'Caregiver, Compassionate, Examination, Graduation, Marriage, Natural Disaster, Study',
  }),
  capLine: fill(slg(loc).maxPerApplication, { days: formatDays(CEILING.cap) }),
  detailsHref: '/leave/shared/g-special',
  detailsLabel: slg(loc).viewDetails,
});

/** The five that keep their own cards. MRL is production's 177-day case; EXM is the 0.00 case. */
const keepers = (loc: Locale) => [
  card({
    leaveTypeId: 'lt-mrl', leaveType: 'Marriage Leave', code: 'MRL',
    entitlement: 3, earnedSoFar: 3, taken: 0, pending: 0, balance: 3, canApplyFor: 3, remaining: 3,
    breakdown: breakdown({ leaveTypeId: 'lt-mrl', leaveType: 'Marriage Leave' }),
    ceilingLines: [fill(slg(loc).alsoCountsToward, { group: 'Special Leave' })],
  }),
  card({
    leaveTypeId: 'lt-exm', leaveType: 'Examination Leave', code: 'EXM',
    entitlement: 0, earnedSoFar: 0, taken: 0, pending: 0, balance: 0, canApplyFor: 0, remaining: 0,
    breakdown: breakdown({ leaveTypeId: 'lt-exm', leaveType: 'Examination Leave' }),
    ceilingLines: [fill(slg(loc).alsoCountsToward, { group: 'Special Leave' })],
  }),
];

/** The screen as the server hands it over: the pool card carrying the merged ceiling, plus the keepers.
 *  The two borrowers are ABSENT — core/read.ts folded them, and that is asserted server-side. */
const merged = (loc: Locale): MyLeaveDashboardCard[] => [
  card({ sharedBalance: SP_POOL, pooledCeiling: ceilingLines(loc) }),
  ...keepers(loc),
];

/** The unmerged arm: a group that has no pooled member still arrives as its own tile. */
const standaloneTile = (loc: Locale): SharedLeaveGroupEntry => ({
  id: 'g-plain',
  name: 'Study Pool',
  available: 4,
  limitLabel: fill(slg(loc).ofLimit, { limit: formatDays(6) }),
  capLabel: null,
  membersLabel: fill(slg(loc).sharedAcross, { types: 'Study' }),
  detailsHref: '/leave/shared/g-plain',
  detailsLabel: slg(loc).viewDetails,
});

const titles = () => [
  ...screen.queryAllByTestId('leave-ring-card').map((c) => c.getAttribute('aria-label')),
  ...screen.queryAllByTestId('leave-type-card').map((c) => c.getAttribute('aria-label')),
];
const cardNamed = (name: string) =>
  screen.getAllByTestId('leave-type-card').find((c) => c.getAttribute('aria-label') === name)!;

describe('8d3a7bff · the two new strings exist in all six catalogues', () => {
  it('both keys are present, carry their placeholders, and are the same English everywhere', () => {
    for (const loc of LOCALES) {
      const L = slg(loc);
      expect(typeof L.pooledLimitLine, `${loc}.me.sharedLeaveGroups.pooledLimitLine`).toBe('string');
      expect(typeof L.alsoCountsToward, `${loc}.me.sharedLeaveGroups.alsoCountsToward`).toBe('string');
      expect(L.pooledLimitLine, `${loc}: the drawable figure`).toContain('{available}');
      expect(L.pooledLimitLine, `${loc}: the ceiling beside it`).toContain('{limit}');
      expect(L.alsoCountsToward, `${loc}: names the group`).toContain('{group}');
    }
    // NOT a distinctness assertion, deliberately — see this file's header. Awaiting translation, and asserting
    // that plainly is what stops a later reader mistaking English for a finished catalogue.
    for (const key of ['pooledLimitLine', 'alsoCountsToward'] as const) {
      expect(new Set(LOCALES.map((loc) => slg(loc)[key])).size, `${key}: not yet translated`).toBe(1);
    }
  });
});

describe('8d3a7bff · (a) exactly one card for the Special Leave pool', () => {
  it.each(LOCALES)('%s — the type card is there, the stacked-layers tile is not', (loc) => {
    const { errors } = mount(loc, <MyLeaveDashboard cards={merged(loc)} sharedGroups={[]} locale={loc} />);
    expect(errors, `${loc}: next-intl errors`).toEqual([]);

    // ONE card headed Special Leave, not two.
    expect(titles().filter((t) => t === 'Special Leave'), `${loc}: cards named Special Leave`).toHaveLength(1);
    // And no group tile at all: the group tile is the only element with this aria-label shape, so its absence
    // is asserted by the whole card set rather than by hunting for an icon.
    expect(new Set(titles()), `${loc}: the card set`).toEqual(
      new Set(['Special Leave', 'Marriage Leave', 'Examination Leave']),
    );
  });

  it('a group with no pooled member STILL draws its own tile — the seeded shape', () => {
    mount('en', <MyLeaveDashboard cards={merged('en')} sharedGroups={[standaloneTile('en')]} locale="en" />);
    // The tile is not a leave-type card, so it is found by its own name.
    expect(screen.getByLabelText('Study Pool')).toBeTruthy();
    expect(titles(), 'and it is not counted as a leave-type card').not.toContain('Study Pool');
  });
});

describe('8d3a7bff · (e) the per-application cap is on the merged card', () => {
  it.each(LOCALES)('%s — the ceiling, the members and the 3.00-day cap, with the way in to the reasons', (loc) => {
    const { errors } = mount(loc, <MyLeaveDashboard cards={merged(loc)} sharedGroups={[]} locale={loc} />);
    expect(errors, `${loc}: next-intl errors`).toEqual([]);

    const sp = cardNamed('Special Leave');
    const block = within(sp).getByTestId('pooled-ceiling');
    const L = slg(loc);

    // The drawable pooled figure WITH the ceiling beside it — never the ceiling in place of it (46afcc48).
    expect(block.textContent, `${loc}: the pooled limit line`).toContain(
      fill(L.pooledLimitLine, { available: formatDays(8), limit: formatDays(10) }),
    );
    // (e) THE CAP, and it is the group's configured figure rather than a constant.
    expect(block.textContent, `${loc}: the per-application cap`).toContain(
      fill(L.maxPerApplication, { days: formatDays(CEILING.cap) }),
    );
    expect(block.textContent, `${loc}: who shares it`).toContain('Compassionate');
    // The link the vanished tile carried: without it the folded reasons have no Apply page of their own.
    const link = within(block).getByText(L.viewDetails);
    expect(link.getAttribute('href'), `${loc}: details link`).toBe('/leave/shared/g-special');
  });

  it('a group with NO cap prints no cap line, and prints nothing in its place', () => {
    const noCap = [card({ sharedBalance: SP_POOL, pooledCeiling: { ...ceilingLines('en'), capLine: null } })];
    mount('en', <MyLeaveDashboard cards={noCap} sharedGroups={[]} locale="en" />);
    const block = within(cardNamed('Special Leave')).getByTestId('pooled-ceiling');
    expect(block.textContent).not.toContain('application');
    expect(block.textContent).toContain(en.me.sharedLeaveGroups.viewDetails);
  });

  it('an ordinary card with no merged ceiling renders no ceiling block at all', () => {
    mount('en', <MyLeaveDashboard cards={[card({ leaveTypeId: 'lt-sick', leaveType: 'Medical Leave' })]} sharedGroups={[]} locale="en" />);
    expect(within(cardNamed('Medical Leave')).queryByTestId('pooled-ceiling')).toBeNull();
    expect(within(cardNamed('Medical Leave')).queryByTestId('ceiling-membership')).toBeNull();
  });
});

describe('8d3a7bff · (d) Marriage Leave keeps its card, its balance and the connection', () => {
  it.each(LOCALES)('%s — its own balance is printed, and it names the ceiling it counts towards', (loc) => {
    const { errors } = mount(loc, <MyLeaveDashboard cards={merged(loc)} sharedGroups={[]} locale={loc} />);
    expect(errors, `${loc}: next-intl errors`).toEqual([]);

    const mrl = cardNamed('Marriage Leave');
    // ITS OWN DAYS, on its own card. This is the assertion that fails if the hiding rule is widened back to
    // group membership: the card would not be in the DOM for `cardNamed` to find.
    expect(mrl.querySelector('p')!.textContent, `${loc}: MRL headline balance`).toBe(formatDays(3));
    // THE CONNECTION, without the balance disappearing.
    expect(within(mrl).getByTestId('ceiling-membership').textContent, `${loc}: MRL ceiling line`).toBe(
      fill(slg(loc).alsoCountsToward, { group: 'Special Leave' }),
    );
    // And it is NOT given the pool's ceiling block — those figures belong to the card that holds the pot.
    expect(within(mrl).queryByTestId('pooled-ceiling'), `${loc}: MRL must not print the pooled ceiling`).toBeNull();

    // A member at 0.00 today is the same arrangement and says the same thing.
    const exm = cardNamed('Examination Leave');
    expect(exm.querySelector('p')!.textContent, `${loc}: EXM headline balance`).toBe(formatDays(0));
    expect(within(exm).getByTestId('ceiling-membership').textContent, `${loc}: EXM ceiling line`).toBe(
      fill(slg(loc).alsoCountsToward, { group: 'Special Leave' }),
    );
  });
});
