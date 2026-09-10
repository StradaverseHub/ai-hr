/**
 * a6fe37fc — THE MAP OF THE LEAVE CONFIGURATION AREA.
 *
 * ═══ THE TWO DEFECTS THIS EXISTS FOR, both measured rather than assumed ═══
 *
 *  1. **Nine screens and no list of them anywhere.** They are reachable only from inline links on other
 *     pages, and several from nowhere at all. The reporter's item (a6fe37fc) asked for the module to be
 *     rebuilt from scratch; the audit found the feature surface complete and this — not the engine —
 *     is the part that was genuinely wrong.
 *  2. **Four screens all rendered the heading "Leave configuration".** `/admin/leave/adjustments`,
 *     `/generate`, `/payroll` and `/replacement` each called `getTranslations('admin.leave')` and
 *     `t('pageTitle')`, so the heading could not tell you which screen you were on.
 *
 * ═══ ⚠️ THE LABEL AND THE PAGE HEADING ARE THE SAME STRING, ON PURPOSE ═══
 *
 * Each screen's heading now reads `admin.leaveConfigMap.item.<id>` — the very key this map renders. A
 * separate title key per page would let the menu and the heading drift the first time either was edited,
 * and "the menu says one thing and the page says another" is the defect this component was built to end,
 * not one to reintroduce one level down.
 *
 * ═══ ⚠️ THE LIST IS DECLARED HERE AND IS **NOT** DERIVED FROM `lib/permissions.ts` ═══
 *
 * That registry lists the same routes, and reusing it would look like the DRY choice. It is not: it is an
 * ACCESS-CONTROL registry whose membership and order answer "what may this role open", so deriving the
 * menu from it would make a permissions edit silently reorder or remove a menu entry, and a route added
 * for access reasons would appear in the customer's navigation unannounced. Two lists, two purposes.
 * `test/leave-config-map.test.ts` pins that every screen here IS a declared route on its screen key, which
 * is the property worth enforcing — agreement, not a shared source.
 *
 * ═══ ⚠️ IT IS ADDITIVE. IT MUST NOT REPLACE THE LEFT RAIL ═══
 *
 * On `/admin/leave/entitlements` the left rail is the leave-type list — the only way to choose a leave
 * type. The first draft of the mockup put this map there and quietly removed that. It renders ABOVE the
 * workspace and changes nothing below it.
 *
 * ═══ WHAT IS DELIBERATELY ABSENT ═══
 *
 * `/admin/leave`, `/admin/leave/application-rules` and `/admin/leave/audit` are redirect stubs (df00b85f,
 * 1e4eb8af, f1b994e3). They keep old bookmarks working and are not screens, so they are not on the map —
 * listing a redirect as a destination is how a menu starts lying about what exists.
 *
 * SERVER COMPONENT, and it must stay one: plain links and one `getTranslations`. r123 took a production
 * tab down by handing a closure across the server/client boundary and
 * `test/server-client-boundary.test.ts` pins the class.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/** Every screen in the area. The id is also its label key and its page heading. */
export type LeaveConfigScreenId =
  /**
   * a6fe37fc — `companyRules` JOINED THE MAP AT THE ROUND 5 CUTOVER, one line, exactly as planned.
   *
   * Round 3 built it as a screen id with NO map entry: it is the one genuinely new destination in the
   * redesign (IA §2.0.3) — four settings that belong to a company or the tenant, then spread across three
   * screens and one step inside every leave type — and it was live ALONGSIDE those surfaces, so listing
   * it beside the ones it would absorb would have put two entries for one job in front of the
   * administrator. Carrying the id early is what made this a one-line addition rather than a rename of a
   * screen the customer had already learned.
   *
   * `replacementLeave` and `payrollImpact` are now the ids with no map entry, for the mirror-image
   * reason: their screens are gone and their settings are ON Company rules, so the ids survive only as
   * the SECTION headings there (`leaveConfigScreenTitle('replacementLeave')`).
   *
   * ── the Round 3 note this replaces, kept because it explains why the id existed before the entry ──
   *
   * `/admin/leave-config/company-rules` is the one genuinely new destination in the redesign (IA §2.0.3):
   * four settings that belong to a company or the tenant, today spread across three screens and one step
   * inside every leave type. It is built ALONGSIDE those surfaces and replaces none of them yet, so it is
   * deliberately absent from `LEAVE_CONFIG_MAP` below — the map is the customer's MENU and the menu moves
   * at the Round 5 cutover, one commit per screen. Listing a half-migrated screen beside the ones it will
   * absorb would put two entries for one job in front of the administrator.
   *
   * The id exists now for two reasons that both cost a round if deferred: the new page must be able to
   * render the map at all (every leave-config screen reaching every other is the defect this component
   * was built for), and `leaveConfigScreenTitle('companyRules')` gives that page its heading from the
   * SAME key the menu entry will use — so Round 5 adds one line to the list rather than renaming a
   * screen the customer has already learned. Every other id below is on the map; this one joins it there.
   */
  | 'companyRules'
  | 'leaveTypes'
  | 'entitlementTables'
  | 'approvalChain'
  | 'replacementLeave'
  | 'payrollImpact'
  | 'generateEntitlement'
  | 'adjustments'
  | 'importLeaveData'
  | 'entitlementArchive'
  | 'ledgerArchive';

type Group = { id: 'configure' | 'run' | 'history'; items: { id: LeaveConfigScreenId; href: string }[] };

/**
 * Grouped by WHAT YOU ARE DOING, which is the distinction the flat list lost: decide what the rules are,
 * run a one-off job, or read what already happened. `configure` first because it is where an administrator
 * spends their time; `history` last because it is the only read-only group.
 */
export const LEAVE_CONFIG_MAP: Group[] = [
  {
    id: 'configure',
    items: [
      { id: 'leaveTypes', href: '/admin/leave-config/types' },
      { id: 'entitlementTables', href: '/admin/leave-config/entitlement-tables' },
      { id: 'approvalChain', href: '/admin/leave-config/approval-chains' },
      // a6fe37fc ROUND 5 (cutover) — `{ id: 'replacementLeave', href: '/admin/leave/replacement' }` STOOD
      // HERE and is DELIBERATELY GONE, replaced by the screen that ABSORBED it. Replacement leave is a
      // COMPANY rule, not a property of a leave type, and IA §2.0.3 gathers the four company/tenant
      // settings onto one destination instead of leaving them on four surfaces. The id survives (the
      // Company rules page renders `leaveConfigScreenTitle('replacementLeave')` as that section's
      // heading, so the section is still called what the menu used to call the screen), it just has no
      // map entry of its own any more — two entries reaching one screen is what this component exists to
      // stop.
      { id: 'companyRules', href: '/admin/leave-config/company-rules' },
      // a6fe37fc ROUND 5 (cutover) — `{ id: 'payrollImpact', href: '/admin/leave/payroll' }` STOOD HERE
      // and is DELIBERATELY GONE. Payroll Related was never one subject: its per-leave-type "Send to
      // payroll module" switch is a property of the TYPE (tab 1 of Leave types) and its encashment policy
      // is a COMPANY rule (Company rules, one entry above). The id survives — nothing renders it as a
      // section heading today, but it is the label key for a screen the customer knew by name, and
      // deleting an id costs nothing to keep and something to get wrong.
    ],
  },
  {
    id: 'run',
    items: [
      { id: 'generateEntitlement', href: '/admin/leave-config/generate' },
      { id: 'adjustments', href: '/admin/leave-config/adjustments' },
      { id: 'importLeaveData', href: '/admin/leave-config/import' },
    ],
  },
  {
    id: 'history',
    items: [
      { id: 'entitlementArchive', href: '/admin/leave-config/records/entitlement' },
      { id: 'ledgerArchive', href: '/admin/leave-config/records/balances' },
    ],
  },
];

/**
 * a6fe37fc ROUND 3 (r259 finding 3) — THE ADDRESS THE MAP GIVES A SCREEN, so a link to a screen can
 * never disagree with the menu entry for it.
 *
 * ⚠️ THE PREVIEW MODULE HAD TWO NAVIGATION DIRECTIONS AT ONCE. The map on all seven new
 * `/admin/leave-config/` pages links to the OLD addresses, while four of those same pages' back-links
 * pointed back INTO the new module. Each half is defensible alone; together they put two answers to
 * "where is the leave type screen" on one page, and they would have made Round 5 move one set and leave
 * the other — the inverse of the cutover instinct.
 *
 * ⚠️ ONE DIRECTION NOW, AND IT IS **OUT** UNTIL ROUND 5: every cross-screen link inside the module
 * resolves through here, so it points where the MAP points — at the screen that is live today. That is
 * also the choice that survives the cutover untouched: Round 5 empties each old page into a redirect
 * stub aimed at the new module (docs/design/a6fe37fc-migration-order.md → Round 5), so a link resolved
 * here reaches the NEW screen the moment the old one goes, and the cutover moves `LEAVE_CONFIG_MAP`
 * alone rather than hunting inbound links.
 *
 * `companyRules` is excluded by TYPE, not by a runtime fallback: it is the one screen id with no map
 * entry until the cutover, so asking this function for its address is a mistake tsc should refuse rather
 * than one this function should paper over with a guessed href.
 */
export type MappedLeaveConfigScreenId = Exclude<
  LeaveConfigScreenId,
  // a6fe37fc ROUND 5 — the exclusion INVERTED at the cutover. `companyRules` is on the map now;
  // `replacementLeave` and `payrollImpact` are the ids whose screens were absorbed into it, so asking
  // this function for their address is a mistake tsc should refuse rather than one this function should
  // paper over with a guessed href.
  'replacementLeave' | 'payrollImpact'
>;

const HREF_BY_ID = Object.fromEntries(
  LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => [i.id, i.href] as const),
) as Record<MappedLeaveConfigScreenId, string>;

export function leaveConfigScreenHref(id: MappedLeaveConfigScreenId): string {
  return HREF_BY_ID[id];
}

/** The heading for one screen — the SAME string the map shows for it. */
export async function leaveConfigScreenTitle(id: LeaveConfigScreenId): Promise<string> {
  const t = await getTranslations('admin.leaveConfigMap');
  return t(`item.${id}`);
}

export async function LeaveConfigMap({ current }: { current: LeaveConfigScreenId }) {
  const t = await getTranslations('admin.leaveConfigMap');

  return (
    <nav aria-label={t('label')} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm">
      {LEAVE_CONFIG_MAP.map((g, gi) => (
        <span key={g.id} className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {/* A divider between groups, never before the first — a leading rule reads as a broken row. */}
          {gi > 0 ? <span aria-hidden className="mx-1 hidden h-4 w-px bg-border sm:block" /> : null}
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t(`group.${g.id}`)}
          </span>
          {g.items.map((it) =>
            it.id === current ? (
              // The current screen is NOT a link. A link to where you already are is a dead control, and
              // aria-current is what tells a screen reader which of eleven entries is the live one.
              <span
                key={it.id}
                aria-current="page"
                className="rounded-md border border-primary bg-primary/5 px-2.5 py-1 text-xs font-semibold text-primary"
              >
                {t(`item.${it.id}`)}
              </span>
            ) : (
              <Link
                key={it.id}
                href={it.href}
                className="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:border-primary hover:text-primary"
              >
                {t(`item.${it.id}`)}
              </Link>
            ),
          )}
        </span>
      ))}
    </nav>
  );
}
