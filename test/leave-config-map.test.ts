/**
 * a6fe37fc — THE LEAVE CONFIGURATION MAP, AND THE ONE PROPERTY THAT MAKES IT SAFE TO DECLARE TWICE.
 *
 * `components/leave-config-map.tsx` declares the area's screens in its own list rather than deriving them
 * from `lib/permissions.ts`. That is deliberate — the registry is an ACCESS-CONTROL list whose order and
 * membership answer "what may this role open", so deriving a customer-facing menu from it would let a
 * permissions edit silently reorder the menu or publish a route nobody meant to advertise.
 *
 * ⚠️ THE COST OF TWO LISTS IS THAT THEY CAN DISAGREE, AND THIS FILE IS THE PRICE PAID FOR IT. A menu entry
 * pointing at a route the guard does not cover is a link an admin clicks and is refused; a route on the
 * screen key that never reaches the menu is a screen nobody can find, which is the whole defect a6fe37fc
 * exists to fix. So: every href on the map must be a declared route on `leaveConfig` or `leaveApproval`.
 * The lists stay separate; their AGREEMENT is enforced here.
 *
 * The retired redirect stubs are asserted absent for the same reason in reverse — listing a redirect as a
 * destination is how a menu starts describing screens that do not exist.
 */
import { describe, expect, it } from 'vitest';
import { LEAVE_CONFIG_MAP, type LeaveConfigScreenId } from '../components/leave-config-map';
import { SCREENS } from '../lib/permissions';
import { leavePack } from '../packs/leave';

const declaredRoutes = new Set(
  SCREENS.filter((s) => s.screenKey === 'leaveConfig' || s.screenKey === 'leaveApproval').flatMap(
    (s) => [...s.routes, s.href],
  ),
);

const mapItems = LEAVE_CONFIG_MAP.flatMap((g) => g.items);

describe('a6fe37fc — the leave configuration map', () => {
  it('points only at routes the permission registry actually declares', () => {
    const undeclared = mapItems.filter((i) => !declaredRoutes.has(i.href)).map((i) => i.href);
    // A menu entry outside the screen key's routes is a link that renders and then refuses.
    expect(undeclared).toEqual([]);
  });

  it('leaves the retired redirect stubs off the map', () => {
    // df00b85f, 1e4eb8af and f1b994e3 retired the first three; a6fe37fc Round 5 added ten more, one per
    // commit. They keep bookmarks working and are NOT screens — listing a redirect as a destination is
    // how a menu starts describing screens that do not exist. None of the fourteen is ever deleted.
    const stubs = [
      '/admin/leave',
      '/admin/leave/application-rules',
      '/admin/leave/audit',
      '/admin/leave/entitlements',
      '/admin/leave/entitlements/templates',
      '/admin/leave/entitlements/archive',
      '/admin/leave/entitlements/ledger-archive',
      '/admin/leave/adjustments',
      '/admin/leave/generate',
      '/admin/leave/import',
      '/admin/leave/payroll',
      '/admin/leave/replacement',
      '/admin/leave/approval',
    ];
    const listed = mapItems.filter((i) => stubs.includes(i.href)).map((i) => i.href);
    expect(listed).toEqual([]);
  });

  it('lists every screen exactly once, so no entry can be reached from two groups', () => {
    const ids = mapItems.map((i) => i.id);
    expect(ids.length).toBe(new Set(ids).size);
    const hrefs = mapItems.map((i) => i.href);
    expect(hrefs.length).toBe(new Set(hrefs).size);
  });

  it('covers every leaveConfig route that is a real screen', () => {
    // The reverse direction, and the one that catches a screen going missing from the menu later. Only
    // `/admin/leave/entitlements` appears as both an href and a route, hence the set.
    //
    // ⚠️ THE ONE EXEMPTION, AND IT IS TEMPORARY BY CONSTRUCTION. a6fe37fc rebuilds this area as a new
    // module under `/admin/leave-config/`, one screen per round, each built ALONGSIDE the old one so
    // that "something works at every point" (docs/design/a6fe37fc-migration-order.md). A new screen is
    // registered in `lib/permissions.ts` the moment its guarded page lands — test/function-access.test.ts
    // requires exactly that — but it must NOT appear on this map yet: the map is the customer's menu,
    // and the menu moves at the Round 5 cutover, one commit per screen, together with the redirect stub
    // that empties the old page. Listing a half-migrated screen beside the one it will replace would put
    // two entries with the same name in front of the administrator.
    // The exemption is written as a PREFIX, not a list of routes, because Rounds 3 and 4 add six more of
    // them; it disappears when Round 5 moves the hrefs, at which point every `/admin/leave-config/` route
    // IS on the map and this filter matches nothing. Each new screen's own shape test pins that it is
    // deliberately absent (test/leave-config-types-tabs.test.ts for the first of them), so the absence is
    // asserted somewhere rather than merely tolerated here.
    // ⚠️ THE EXEMPTION RETIRED AT THE ROUND 5 CUTOVER, EXACTLY AS IT SAID IT WOULD: "it disappears when
    // Round 5 moves the hrefs, at which point every `/admin/leave-config/` route IS on the map and this
    // filter matches nothing." The filter matched nothing — and then the old module emptied too, so the
    // non-exempt half went to zero and the non-vacuity assertion below it went red. That is the exemption
    // asking to be removed rather than a defect, so it is removed and the case becomes the STRONGER thing
    // it was always a placeholder for: every leaveConfig route is on the menu, full stop.
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    const onMap = new Set(mapItems.map((i) => i.href));
    const missing = leaveConfig.routes.filter((r) => !onMap.has(r));
    expect(
      missing,
      'a route on the leaveConfig screen key that the menu never reaches is a screen nobody can find — ' +
        'the defect a6fe37fc exists to fix',
    ).toEqual([]);
    // Non-vacuity, asserted on the module that is actually live: the whole new module is registered.
    expect(leaveConfig.routes.length).toBeGreaterThan(5);
    expect(leaveConfig.routes.every((r) => r.startsWith('/admin/leave-config/'))).toBe(true);
    // …and the ten old addresses are ALL off the registry, because every one of them is a stub now.
    for (const stub of [
      '/admin/leave/entitlements',
      '/admin/leave/entitlements/templates',
      '/admin/leave/entitlements/archive',
      '/admin/leave/entitlements/ledger-archive',
      '/admin/leave/adjustments',
      '/admin/leave/generate',
      '/admin/leave/import',
      '/admin/leave/payroll',
      '/admin/leave/replacement',
    ]) {
      expect(leaveConfig.routes, `${stub} is a redirect stub and must not be registered`).not.toContain(stub);
    }
  });

  it('10b59703 — groups the screens by the five submenu rows, each group leading with its row\'s own href', () => {
    // `groups the screens by what the administrator is doing` (configure / run / history) STOOD HERE and
    // is DELIBERATELY REPLACED: the reporter's instruction was that the left submenu IS the navigation,
    // so a group is now a submenu ROW. This is AGREEMENT, not derivation — the map's own header says why
    // the list is declared rather than derived — and it is pinned in both directions: every group is a
    // row of LEAVE_ADMIN_NAV (same order), and every row is a group. The first item of a group is the
    // row's href, so the row and the tab it lands on are the same screen.
    const rows = leavePack.navNodes!.find((n) => n.group === 'admin')!.children;
    expect(LEAVE_CONFIG_MAP.map((g) => g.navKey)).toEqual(rows.map((r) => r.labelKey));
    expect(LEAVE_CONFIG_MAP.map((g) => g.items[0].href)).toEqual(rows.map((r) => r.href));
    expect(LEAVE_CONFIG_MAP.map((g) => g.id)).toEqual(['entitlements', 'adjustments', 'generate', 'approval', 'companyRules']);
    const byGroup = Object.fromEntries(LEAVE_CONFIG_MAP.map((g) => [g.id, g.items.map((i) => i.id)]));
    // The two rows with tabs, exactly as the approved pictures draw them; the other three own one screen.
    expect(byGroup.entitlements).toEqual<LeaveConfigScreenId[]>(['leaveTypes', 'entitlementTables', 'entitlementArchive']);
    expect(byGroup.adjustments).toEqual<LeaveConfigScreenId[]>(['adjustments', 'ledgerArchive', 'importLeaveData']);
    expect(byGroup.generate).toEqual<LeaveConfigScreenId[]>(['generateEntitlement']);
    expect(byGroup.approval).toEqual<LeaveConfigScreenId[]>(['approvalChain']);
    expect(byGroup.companyRules).toEqual<LeaveConfigScreenId[]>(['companyRules']);
  });
});
