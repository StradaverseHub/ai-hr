import { requireAdmin } from '@/lib/authz';
import { PageHeader } from '@/components/ui';
import { LeaveConfigMap, leaveConfigPageHeader } from '@/components/leave-config-map';
import { leaveConfigHealthAll } from '@/lib/leave-config-health';
import { LeaveConfigHealthCard } from '@/components/leave/leave-config-health';
import { loadEntitlementTablesData } from '../../leave/entitlements/templates/entitlement-tables-block';

/**
 * r279 (3fbf7a02) — LEAVE BALANCE HEALTH GETS ITS OWN ADDRESS.
 *
 * THE COMPLAINT, and it is a navigation one. This listing is the screen that answers "why does this
 * balance read 0.00" — which types have no entitlement table, which have no earning method, which
 * benefit scheme expired. It was drawn at page level on the Leave types tab
 * (`/admin/leave-config/types`), below the tab row and above the workspace, and NOTHING in the menu
 * said it existed. To reach it you had to already know it was there and scroll for it: the screen that
 * explains a missing balance was the screen you had to be told about first. It has a fly-out row now
 * (packs/leave/index.ts LEAVE_ADMIN_NAV, second child, directly under Entitlements because it answers
 * the question you ask about entitlements) and this page is where that row lands.
 *
 * ⚠️ A MOUNT POINT AND A MENU ROW — NOTHING ELSE. `lib/leave-config-health.ts` is untouched: no new
 * finding, no reworded finding, no change to what counts as Ready / Needs attention / Cannot grant. The
 * table on this page is the SAME `LeaveConfigHealthCard` the Leave types tab drew, rendered from the
 * same derivation over the same loader, so "it only changes address" is a claim about one component
 * with one definition rather than a promise about two copies.
 *
 * ⚠️ THE PER-TYPE NOTICE STAYS WHERE IT IS, and that is the whole reason this move is safe. The scoped
 * arm of the ternary in `app/admin/leave/entitlements/templates/entitlement-tables-block.tsx`
 * (`LeaveConfigHealthNotice`) shows ONE leave type's findings beside that type's own entitlement
 * tables, and it is untouched here. A warning on a different screen from the thing it is about gets
 * ignored — the disclosed cost of moving the full list is that it is now further from the tables you
 * would edit to clear it, and the per-type notice plus the fact that every row on this page NAMES the
 * table or scheme at fault is what covers that.
 *
 * ⚠️ ONE LOADER, NOT A SECOND READ PATH. `loadEntitlementTablesData` is the same page-level load the
 * Leave types tab and the Entitlement tables tab run, and it is deliberately reused rather than
 * narrowed to the five inputs the derivation takes: a bespoke reader here would be a second way to
 * assemble the same facts, free to drift from the one the tables themselves are drawn from — and this
 * card's only value is that it cannot disagree with them. It costs reads this page does not strictly
 * need; that is the price of one answer.
 *
 * ⚠️ ITS OWN MAP GROUP, OF ONE — A SIBLING ROW, NOT A THIRD TAB OF ENTITLEMENTS. The Entitlements group
 * keeps its two tabs (Leave types · Entitlement tables); Balance Health is its own group next to it,
 * because it reads EVERY leave type at once, which is the one thing neither of those tabs does. A group
 * of one renders NO tab row (`LeaveConfigMap` returns null below two items), exactly as Generate
 * Entitlement, Approval Workflow and Company rules already do — so the group buys the two things the
 * module is built on rather than any furniture: this page's heading and description come from its ROW
 * through `leaveConfigPageHeader` (r266's heading-equals-row rule, one helper for every page in the
 * area), and the row↔group agreement stays 1:1 in both directions, which is what
 * test/leave-config-map.test.ts and test/r266-leave-config-rows.test.ts assert. A page here WITHOUT a
 * group would have been the only Leave Config page outside that convention and would have forced a
 * named exception into both of those guards.
 *
 * SERVER COMPONENT, and the card it mounts is one too: no client island, no props crossing a boundary
 * (components/leave/leave-config-health.tsx's header says why that is worth writing down —
 * test/server-client-boundary.test.ts).
 */
export default async function LeaveConfigBalanceHealthPage() {
  const s = await requireAdmin();
  const header = await leaveConfigPageHeader('balanceHealth');
  const data = await loadEntitlementTablesData(s);
  // Read, never recomputed: the same call the Leave types tab makes, over the same loaded data, so the
  // badge on a leave type in that workspace and the row for it here are one derivation (IA §3.1 F2).
  const rows = leaveConfigHealthAll({
    leaveTypes: data.leaveTypes,
    templates: data.templates,
    rules: data.rules,
    grades: data.activeGrades,
    today: data.today,
  });

  return (
    <div className="space-y-6">
      {/* The heading is the fly-out ROW that opened this page and the description is the row's, both read
          through the one helper every Leave Config page uses, so the menu and the page cannot come to say
          different things (r266 10b59703). */}
      <PageHeader title={header.title} description={header.description} />
      {/* `current="balanceHealth"` because this IS that row's only screen — so this renders NOTHING (a tab
          row of one is furniture). It is mounted anyway, like every other single-screen page in the area:
          the day this row gains a second screen, the strip appears without anybody remembering to add it. */}
      <LeaveConfigMap current="balanceHealth" />
      <LeaveConfigHealthCard rows={rows} />
    </div>
  );
}
