/**
 * 76dbcaa1 — Special Leave: one pooled entitlement, and the reasons that draw on it.
 *
 * ⚠️ MOST OF THIS ITEM WAS ALREADY BUILT, and the plan said so before it was approved. Measured on
 * production first: `leave_shared_group` already holds ONE group, "Special Leave", 10.00 days with a 3.00
 * per-application cap, and `leave_shared_group_member` already holds exactly the six types the ticket
 * lists (CGL, CPL, EXM, GD, NDL, STD). The pooled card on My Leave already existed (46afcc48). The engine
 * already enforces the shared ceiling. What was missing was a way IN to the reasons, and a picker that
 * did not read as seven unrelated entitlements.
 *
 * WHAT THIS FILE PINS
 *   1. the members are exposed with their IDS, from the same pass that builds the names, so the picker
 *      and the card can never disagree about who is in the pool;
 *   2. the picker groups a pooled type under its pool and still posts ONE leaveTypeId;
 *   3. — r355: WAS "the details screen is the employee's own, resolves through `myEmployment`, and 404s a
 *      group the viewer has none of". THE DETAILS SCREEN IS DELETED, so that claim is replaced by its
 *      inverse: the file is gone, the route is deregistered, nothing links to it, and the one figure it
 *      held alone is on the card instead. See the section head below for why.
 *   4. `?type=` is seeded, never trusted — an id the subject may not take falls back.
 *
 * ⚠️ r355 (8d3a7bff) — WHY THIS FILE CHANGED AT ALL, since 76dbcaa1 is not the item being built. It read
 * app/leave/shared/[groupId]/page.tsx AT MODULE LEVEL (the key-grep below was a `describe`-body statement),
 * so the deletion did not fail an assertion here — it threw during collection and took the picker guards,
 * which are still live and still correct, down with it. The structural guards on that file are rewritten as
 * guards on its ABSENCE rather than dropped: a reinstated orphan page must fail something.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** r355 — the page this item built, now DELETED. Kept as a constant because its absence is asserted. */
const DETAIL = 'app/leave/shared/[groupId]/page.tsx';
const FIELDS = 'components/leave-duration-fields.tsx';
const GROUP = 'core/leave-shared-group.ts';
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

describe('76dbcaa1 · the members carry their ids, from one pass', () => {
  it('members and memberNames are built from the SAME list', () => {
    const src = codeOnly(read(GROUP));
    expect(src).toContain('memberNames: mine.map(');
    expect(src).toContain('members: mine.map(');
    // Hidden members are in both: hiding a balance card is a presentation choice, never an entitlement
    // one, and a reason list that dropped half the pot would describe a different pot.
    expect(read(GROUP)).toContain('includeHidden: true');
  });
});

describe('76dbcaa1 · the picker groups a pooled type under its pool', () => {
  it('renders an optgroup per pool, and ungrouped types stay where they were', () => {
    const src = codeOnly(read(FIELDS));
    expect(src).toContain('<optgroup');
    expect(src, 'ungrouped types are rendered on their own').toContain('.filter((x) => !x.groupName)');
  });

  it('still posts ONE leaveTypeId — the grouping is a label, not a second control', () => {
    const src = codeOnly(read(FIELDS));
    expect((src.match(/name="leaveTypeId"/g) ?? []).length, 'exactly one posted field').toBe(1);
    expect(src, 'no second name for a group').not.toContain('name="sharedGroupId"');
  });

  /** A stale or hand-typed `?type=` must not preselect something the subject cannot take. */
  it('seeds the selection from defaultTypeId but falls back when it is not on offer', () => {
    const src = codeOnly(read(FIELDS));
    expect(src).toContain('types.some((t) => t.id === defaultTypeId)');
    expect(src).toContain('types[0]?.id');
  });
});

/**
 * r355 (8d3a7bff) — THE DETAILS SCREEN IS GONE, AND THIS SECTION IS THE OLD ONE INVERTED.
 *
 * WHAT IT USED TO CLAIM, case by case, and why each claim was withdrawn rather than relaxed:
 *   · "resolves the signed-in employee and never takes one as a parameter" — true of the page while it
 *     existed, and it is exactly why the reporter's reading of it as an admin/configuration screen was a
 *     misreading of a correct page. The misreading was still the defect: it led with the policy limits under
 *     a heading repeating the card just clicked, with no way back. Removed on that ground, not on a bug.
 *   · "404s a group the viewer has none of" / "shows what is drawable with the ceiling as context" — both
 *     statements about a file that no longer exists. Kept as a single assertion that it does NOT exist,
 *     because an orphan page reachable by URL with no link to it is the failure mode r355 is closing.
 *   · "each reason links into the EXISTING apply form, not a second write path" — this is the one that had
 *     to be re-proved somewhere else before the page could go, and it was: the Request Leave picker groups
 *     every pooled reason under its pool (the <optgroup> cases above, unchanged). The page's Apply buttons
 *     pointed INTO that same form, so they were a shortcut to it, never the only way to it.
 *   · "rides the leave column in the access grid" — INVERTED, and this is the bidirectional half. Deleting
 *     the page without deleting the route from lib/permissions.ts leaves test/function-access.test.ts's
 *     "no stale routes" red; keeping the route without the page leaves "reverse completeness" red. Both
 *     halves are asserted here too so this file says why the entry went, not just that it did.
 */
describe('r355 · the details screen and its route are gone, and nothing points at them', () => {
  it('the page file does not exist', () => {
    expect(existsSync(root + DETAIL), `${DETAIL} must stay deleted`).toBe(false);
  });

  it('the route is deregistered from the access grid, and the leave column keeps its one label', () => {
    const perms = read('lib/permissions.ts');
    // ⚠️ THE CODE, NOT THE COMMENTARY. lib/permissions.ts explains in prose WHY the entry was removed and
    // names the route while doing so, so a bare `not.toContain` would fail against correct code.
    expect(codeOnly(perms), 'no registered route for the deleted page').not.toContain("'/leave/shared/[groupId]'");
    expect(codeOnly(perms), 'and the leave column still carries /leave itself and /leave/credit').toContain(
      "routes: ['/leave', '/leave/credit']",
    );
    // Unchanged from 76dbcaa1: the point of riding an existing column was that a second one would repeat
    // this label. Removing the sub-route must not have minted one on the way out.
    expect((perms.match(/labelKey: 'nav.myAbsence'/g) ?? []).length, 'one My Absence column').toBe(1);
  });

  it('no employee surface links to /leave/shared any more', () => {
    for (const f of ['app/leave/page.tsx', 'components/leave/my-leave-dashboard.tsx', 'components/leave/shared-leave-group-cards.tsx']) {
      expect(codeOnly(read(f)), `${f} must not build a /leave/shared href`).not.toContain('/leave/shared');
    }
    // The card's link was the ONE runtime entry point, so the two fields that carried it are off the type.
    // A reinstated link cannot be built without failing tsc first, which is the guard that outlives a grep.
    const dash = codeOnly(read('components/leave/my-leave-dashboard.tsx'));
    expect(dash, 'no detailsHref on PooledCeilingLines').not.toContain('detailsHref');
    expect(dash, 'and the pooled block imports no router link').not.toContain("from 'next/link'");
  });

  it('the one figure the page held alone is on the merged card instead', () => {
    // `usedThisYear` was unique to that page: `sharedLeaveGroupBalances` has exactly two callers and the
    // surviving one never read `usedDays`. Losing it was the only real cost of the deletion, so the move is
    // pinned across BOTH files in the contract — the RSC that builds the line and the card that draws it.
    expect(codeOnly(read('app/leave/page.tsx'))).toContain("tMe('sharedLeaveGroups.usedThisYear'");
    expect(codeOnly(read('app/leave/page.tsx')), 'the group cycle figure, not a card figure').toContain(
      'merged.usedDays',
    );
    expect(codeOnly(read('components/leave/my-leave-dashboard.tsx'))).toContain('c.pooledCeiling.usedLine');
  });
});

/**
 * r355 — WAS "every string it renders exists in all six locales", a grep of the page for `t('…')` keys.
 *
 * With the page gone there is nothing to grep, and the honest replacement is the other half of the same
 * concern: those keys must be RETIRED IN PLACE, not deleted. i18n/request.ts deep-merges each locale over
 * English, so dropping a key from en.json alone leaves the Malay and Chinese sentences still rendering while
 * the English one vanishes — the one-sided deletion this convention exists to prevent.
 */
describe('r355 · the strings that page rendered are retired in place, in all six catalogues', () => {
  const RETIRED = ['detailDescription', 'remaining', 'reasonsHeading', 'reasonsHelp', 'applyForReason', 'viewDetails'];

  it.each(LOCALES)('%s keeps every retired key, marked as retired', (loc) => {
    const bag = JSON.parse(read(`messages/${loc}.json`)).me.sharedLeaveGroups as Record<string, unknown>;
    for (const k of RETIRED) {
      expect(typeof bag[k], `${loc}: me.sharedLeaveGroups.${k} must still exist`).toBe('string');
      expect(String(bag[k]), `${loc}: ${k} must be marked retired, not left reading as live copy`).toMatch(
        /^\[retired r355 —/,
      );
    }
    // `usedThisYear` is the opposite case: it MOVED to the card rather than being retired, so it must stay
    // live and translated. It is the whole reason the deletion costs the reporter nothing.
    expect(typeof bag.usedThisYear, `${loc}: usedThisYear stays live`).toBe('string');
    expect(String(bag.usedThisYear), `${loc}: usedThisYear must not be retired`).not.toContain('[retired');
    expect(String(bag.usedThisYear), `${loc}: and must keep its placeholder`).toContain('{days}');
  });
});
