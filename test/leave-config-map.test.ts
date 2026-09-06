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
    // df00b85f, 1e4eb8af and f1b994e3 retired these. They keep bookmarks working and are NOT screens.
    const stubs = ['/admin/leave', '/admin/leave/application-rules', '/admin/leave/audit'];
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
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    const onMap = new Set(mapItems.map((i) => i.href));
    const missing = leaveConfig.routes.filter((r) => !onMap.has(r));
    expect(missing).toEqual([]);
  });

  it('groups the screens by what the administrator is doing', () => {
    // Pinned because the grouping IS the deliverable: a flat list is what the reporter complained about.
    expect(LEAVE_CONFIG_MAP.map((g) => g.id)).toEqual(['configure', 'run', 'history']);
    const byGroup = Object.fromEntries(LEAVE_CONFIG_MAP.map((g) => [g.id, g.items.map((i) => i.id)]));
    // History is read-only and must not acquire a screen that writes.
    expect(byGroup.history).toEqual<LeaveConfigScreenId[]>(['entitlementArchive', 'ledgerArchive']);
    expect(byGroup.run).toContain<LeaveConfigScreenId>('generateEntitlement');
    expect(byGroup.configure).toContain<LeaveConfigScreenId>('leaveTypes');
  });
});
