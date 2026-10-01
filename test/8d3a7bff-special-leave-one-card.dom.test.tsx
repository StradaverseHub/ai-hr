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
 * ⚠️ r355 (SAME ITEM, DECISION REVERSED ON THE LINK — NOT ON THE CARDS). r341 shipped the one-card fold and
 * kept 76dbcaa1's "View details" link at the foot of the merged block. The reporter contested the round on
 * the PAGE behind that link: it repeated the heading they had just clicked, led with the policy limits, had
 * no way back, and — once r341 had moved the tile's figures onto the card — told them almost nothing new. The
 * page (app/leave/shared/[groupId]/page.tsx) is deleted and its route deregistered from lib/permissions.ts.
 *
 * WHAT CHANGED IN THIS FILE, and what deliberately did not:
 *   · the old cases asserted the link was PRESENT with href '/leave/shared/g-special' in all six locales and
 *     its text on the no-cap card. Those are now their exact inverse — the block contains NO anchor at all —
 *     because the claim they pinned ("the folded reasons keep a way in") was withdrawn, not merely relaxed.
 *     A deleted case would have left a reinstated link green.
 *   · in its place, `usedLine`: the ONE figure the deleted page held that the card did not. That is the
 *     substitution the reporter was promised, so it is asserted per locale rather than once in English.
 *   · everything about the CARD SET (a), the cap (e) and Marriage Leave (d) is untouched. r341's fold is
 *     live and this round does not revisit it.
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
import type { SharedLeaveGroupEntry } from '../components/leave/shared-leave-group-entry';
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

const CEILING = { available: 8, limit: 10, cap: 3, used: 2 } as const;

const ceilingLines = (loc: Locale): PooledCeilingLines => ({
  availableLabel: formatDays(CEILING.available),
  limitLabel: fill(slg(loc).ofLimit, { limit: formatDays(CEILING.limit) }),
  membersLine: fill(slg(loc).sharedAcross, {
    types: 'Caregiver, Compassionate, Examination, Graduation, Marriage, Natural Disaster, Study',
  }),
  capLine: fill(slg(loc).maxPerApplication, { days: formatDays(CEILING.cap) }),
  // r355 — the figure that moved off the deleted page and onto the card. `detailsHref`/`detailsLabel` stood
  // here; the type no longer has them, so a reinstated link cannot be built without failing tsc first.
  usedLine: fill(slg(loc).usedThisYear, { days: formatDays(CEILING.used) }),
});

/**
 * The cards the server hands over as KEPT. MRL is production's 177-day case.
 *
 * ⚠️ r343 (1478c281) — EXM IS NOW A HYPOTHETICAL HERE, NOT PRODUCTION'S SHAPE. A member holding 0.00 no longer
 * draws a card at all (the gate in core/read.ts; test/1478c281-empty-member-cards.test.ts), so the server
 * never hands this component such a card for a member of a placed group. It is kept as a fixture on purpose:
 * this file pins the RENDER given a card, and a 0.00 card still reaches it by other routes (an ungrouped type,
 * or the same type once its group placement is Hidden), where it must still print its figures and its lines.
 */
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
  // r355 — `detailsHref`/`detailsLabel` were on this fixture too and are off `SharedLeaveGroupEntry` now.
  // The standalone tile never RENDERED them (my-leave-dashboard draws no anchor in a group tile), so nothing
  // this arm could reach has been taken away; the fields were dead weight the type still demanded.
});

const titles = () => [
  ...screen.queryAllByTestId('leave-ring-card').map((c) => c.getAttribute('aria-label')),
  ...screen.queryAllByTestId('leave-type-card').map((c) => c.getAttribute('aria-label')),
];
// r378: drawable and neutral cards share the same article identity; the frame is not a type selector.
const cardNamed = (name: string) => screen.getByRole('article', { name });

describe('8d3a7bff · the two new strings exist in all six catalogues', () => {
  it('the ONE new key carries its placeholder, and the ceiling line reuses the TRANSLATED ofLimit', () => {
    for (const loc of LOCALES) {
      const L = slg(loc);
      expect(typeof L.alsoCountsToward, `${loc}.me.sharedLeaveGroups.alsoCountsToward`).toBe('string');
      expect(L.alsoCountsToward, `${loc}: names the group`).toContain('{group}');
      // The merged card's ceiling line is composed from `ofLimit`, which every catalogue already
      // translates. A NEW combined string would have been English-until-translated AND would have
      // replaced a localised line — a zh employee reading English where they used to read Chinese.
      expect(typeof L.ofLimit, `${loc}.me.sharedLeaveGroups.ofLimit`).toBe('string');
      expect(L.ofLimit, `${loc}: the ceiling`).toContain('{limit}');
    }
    // `alsoCountsToward` IS new information with no existing key to compose from, so it ships English in
    // all six and says so. Asserting that plainly is what stops a later reader mistaking it for finished.
    expect(new Set(LOCALES.map((loc) => slg(loc).alsoCountsToward)).size, 'alsoCountsToward: not yet translated').toBe(1);
    // `ofLimit` is the opposite case and MUST stay distinct — this is the regression guard for the
    // localisation defect this file's first cut shipped.
    expect(
      new Set(LOCALES.map((loc) => slg(loc).ofLimit)).size,
      'ofLimit must remain translated per locale, not collapsed to English',
    ).toBeGreaterThan(1);
  });

  /**
   * r355 — THE KEY THAT MOVED IS THE KEY THAT MOVED, not a new English sentence.
   *
   * `usedThisYear` was written for the deleted page and is translated in all six catalogues. Re-using it on
   * the card is what makes this substitution free for a Malay or Chinese reader; a freshly minted combined
   * string would have been English-until-translated. So its per-locale distinctness is pinned here for the
   * same reason `ofLimit`'s is above.
   */
  it('usedThisYear carries its placeholder and is genuinely translated, not collapsed to English', () => {
    for (const loc of LOCALES) {
      const L = slg(loc);
      expect(typeof L.usedThisYear, `${loc}.me.sharedLeaveGroups.usedThisYear`).toBe('string');
      expect(L.usedThisYear, `${loc}: names the figure`).toContain('{days}');
    }
    expect(
      new Set(LOCALES.map((loc) => slg(loc).usedThisYear)).size,
      'usedThisYear must stay translated per locale — it is a REUSED key, not a new one',
    ).toBeGreaterThan(1);
  });

  /**
   * r355 — THERE ARE THREE "View details" KEYS AND ONLY ONE OF THEM WAS RETIRED.
   *
   * `me.sharedLeaveGroups.viewDetails` was the NAVIGATING one and is retired with its page (that the six
   * retired keys stay present in all six catalogues rather than being deleted is pinned in
   * test/76dbcaa1-special-leave.test.ts, which owns the case this replaces). `leave.viewDetails` opens the
   * leave-history card's own expander and `leave.myLeave.details` opens this component's in-page balance
   * panel — both still rendered, both must stay live copy. Retiring either by name-match would blank a
   * control that works, which is the mistake this case exists to catch.
   */
  it('the other two "View details" keys are LIVE copy and must not be retired with it', () => {
    const live = (loc: Locale) =>
      CATALOGUES[loc] as unknown as { leave: { viewDetails?: string; myLeave: { details?: string } } };
    for (const loc of LOCALES) {
      for (const [label, v] of [
        ['leave.viewDetails', live(loc).leave.viewDetails],
        ['leave.myLeave.details', live(loc).leave.myLeave.details],
      ] as const) {
        expect(typeof v, `${loc}: ${label} must still exist`).toBe('string');
        expect(v, `${loc}: ${label} is an in-page panel and must NOT be retired`).not.toContain('[retired');
      }
    }
    // And the one that WAS retired is a different key, so this case cannot pass by them all being equal.
    expect(slg('en').viewDetails, 'the navigating key is the retired one').toMatch(/^\[retired r355 —/);
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
  it.each(LOCALES)('%s — the ceiling, the members, the 3.00-day cap and what has gone this year', (loc) => {
    const { errors } = mount(loc, <MyLeaveDashboard cards={merged(loc)} sharedGroups={[]} locale={loc} />);
    expect(errors, `${loc}: next-intl errors`).toEqual([]);

    const sp = cardNamed('Special Leave');
    const block = within(sp).getByTestId('pooled-ceiling');
    const L = slg(loc);

    // The drawable pooled figure WITH the ceiling beside it — never the ceiling in place of it (46afcc48).
    expect(block.textContent, `${loc}: the drawable pooled figure`).toContain(formatDays(8));
    expect(block.textContent, `${loc}: the ceiling beside it, in this locale's own words`).toContain(
      fill(L.ofLimit, { limit: formatDays(10) }),
    );
    // (e) THE CAP, and it is the group's configured figure rather than a constant.
    expect(block.textContent, `${loc}: the per-application cap`).toContain(
      fill(L.maxPerApplication, { days: formatDays(CEILING.cap) }),
    );
    expect(block.textContent, `${loc}: who shares it`).toContain('Compassionate');

    // ── r355, THE REVERSAL ───────────────────────────────────────────────────────────────────────────────
    // WAS: `within(block).getByText(L.viewDetails)` with href '/leave/shared/g-special', in all six locales.
    // The page that href opened is deleted, so the claim is now its inverse and is asserted STRUCTURALLY:
    // no anchor anywhere in the block, whatever its label. Checking only that the words "View details" are
    // absent would pass a link relabelled to anything else.
    expect(within(block).queryAllByRole('link'), `${loc}: the pooled block must navigate nowhere`).toEqual([]);
    expect(block.querySelectorAll('a').length, `${loc}: not even an unlabelled anchor`).toBe(0);
    expect(block.textContent, `${loc}: and the retired label is not rendered either`).not.toContain(
      en.me.sharedLeaveGroups.viewDetails,
    );
    // AND IN ITS PLACE, the one figure the deleted page held alone — per locale, because `usedThisYear` is
    // genuinely translated and a regression to English would be invisible to an en-only assertion.
    expect(
      within(block).getByTestId('pooled-used').textContent,
      `${loc}: what has gone from the pool this year`,
    ).toBe(fill(L.usedThisYear, { days: formatDays(CEILING.used) }));
  });

  it('a group with NO cap prints no cap line, and prints nothing in its place', () => {
    const noCap = [card({ sharedBalance: SP_POOL, pooledCeiling: { ...ceilingLines('en'), capLine: null } })];
    mount('en', <MyLeaveDashboard cards={noCap} sharedGroups={[]} locale="en" />);
    const block = within(cardNamed('Special Leave')).getByTestId('pooled-ceiling');
    expect(block.textContent).not.toContain('application');
    // r355 — WAS `toContain(en.me.sharedLeaveGroups.viewDetails)`: with the cap line absent the link was the
    // proof the block had not collapsed. The used line is that proof now, and the link must still be absent.
    expect(block.textContent).toContain(fill(en.me.sharedLeaveGroups.usedThisYear, { days: formatDays(CEILING.used) }));
    expect(block.querySelectorAll('a').length, 'no cap is not a reason to grow a link').toBe(0);
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
    // ITS OWN DAYS, on its own card.
    // ⚠️ THIS FILE CANNOT CATCH A WIDENED HIDING RULE, AND SAYING OTHERWISE WOULD BE THE SAME MISTAKE THE
    // ROUND WAS FIXING. The component is handed `cards` directly and never sees the server gate, so
    // widening core/read.ts back to group membership leaves every assertion here green. The guard that
    // DOES fail is the server test — test/8d3a7bff-special-leave-one-card.ts, "a member that holds its
    // own days must keep its card" — verified by applying the widening and watching exactly that
    // assertion fail. What this file pins is the RENDER: given a kept card, it draws the balance and the
    // ceiling line rather than swallowing them.
    // Its drawable frame centres Available Balance; the separate gross Balance row still holds its own days.
    const balanceLabel = CATALOGUES[loc].leave.myLeave.balance;
    const balance = within(mrl).getByText(balanceLabel, {selector:'dt'});
    expect(balance.parentElement!.querySelector('dd')!.textContent, `${loc}: MRL own balance`).toBe(formatDays(3));
    expect(within(mrl).getByTestId('leave-balance-ring').querySelector('div[aria-hidden="true"]')!.textContent).toBe(`${formatDays(3)}${CATALOGUES[loc].leaveFigure.availableBalance}`);
    // THE CONNECTION, without the balance disappearing.
    expect(within(mrl).getByTestId('ceiling-membership').textContent, `${loc}: MRL ceiling line`).toBe(
      fill(slg(loc).alsoCountsToward, { group: 'Special Leave' }),
    );
    // And it is NOT given the pool's ceiling block — those figures belong to the card that holds the pot.
    expect(within(mrl).queryByTestId('pooled-ceiling'), `${loc}: MRL must not print the pooled ceiling`).toBeNull();

    // A 0.00 card, WHEREVER it came from, says the same thing as a card holding days — see `keepers` above for
    // why r343 means a placed group's empty member is no longer one of the routes it can come from.
    const exm = cardNamed('Examination Leave');
    expect(within(exm).getByText(formatDays(0), {selector:'p'}).textContent, `${loc}: EXM own balance`).toBe(formatDays(0));
    expect(within(exm).getByTestId('leave-balance-ring').querySelectorAll('[data-segment]'), `${loc}: a zero-entitlement member has a neutral frame`).toHaveLength(0);
    expect(within(exm).getByTestId('ceiling-membership').textContent, `${loc}: EXM ceiling line`).toBe(
      fill(slg(loc).alsoCountsToward, { group: 'Special Leave' }),
    );
  });
});
