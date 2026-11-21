/**
 * 82748f92 — People › Configuration › Settings. The six People setup pages that used to be separate rows under
 * People › Configuration, now the cards on /admin/settings/people (in the order the rows had).
 *
 * Dependency-free on purpose: the client shell (lib/navigation/shell-inventory.ts, components/sidebar.tsx) and the
 * server hub page (app/admin/settings/people/page.tsx) both read it. Every href is the page the row opened
 * before; none of them moved, and each page keeps its own guard and lib/permissions.ts column.
 *
 * `labelKey` is the section's existing `nav` label (the command bar still finds it by that name). `key` names the
 * `peopleSettingsHub.<key>` message group holding the card's title, description and button. `gate` mirrors what
 * the destination page itself requires:
 * - 'admin': requireAdmin / scopedAdmin, the same admin floor the six rows had (adminOnly).
 * - 'peopleGeneral': admin AND app.people_general_can_configure() (a group-wide administrator); the General page
 *   redirects anyone else home, so its card and search alias are hidden from them.
 */
export type PeopleSettingsGate = 'admin' | 'peopleGeneral';
export const PEOPLE_SETTINGS_HREF = '/admin/settings/people';
export const PEOPLE_SETTINGS_SECTIONS = [
  { key: 'employeeId', href: '/admin/settings/employee-id', labelKey: 'employeeIdConfig', gate: 'admin' },
  { key: 'general', href: '/admin/settings/people-general', labelKey: 'peopleGeneral', gate: 'peopleGeneral' },
  { key: 'systemLabels', href: '/admin/settings/system-labels', labelKey: 'systemLabels', gate: 'admin' },
  { key: 'movement', href: '/admin/settings/movement', labelKey: 'movementSettings', gate: 'admin' },
  { key: 'hiringDefaults', href: '/admin/settings/hiring-defaults', labelKey: 'hiringDefaults', gate: 'admin' },
  { key: 'changeRequests', href: '/admin/settings/profile-requests', labelKey: 'profileRequestSettings', gate: 'admin' },
] as const satisfies readonly { key: string; href: string; labelKey: string; gate: PeopleSettingsGate }[];

/** The sections this viewer may open. Pure; the caller supplies facts it already resolved. */
export function visiblePeopleSettingsSections(facts: { isAdmin: boolean; canConfigurePeopleGeneral: boolean }) {
  if (!facts.isAdmin) return [];
  return PEOPLE_SETTINGS_SECTIONS.filter((section) => section.gate === 'admin' || facts.canConfigurePeopleGeneral);
}
