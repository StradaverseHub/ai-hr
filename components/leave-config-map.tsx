/** 010fdbec: the catalogue below still owns screen headers and sibling tabs.
 * Seven destinations are now cards under Leave Settings; operations retain their menu entries. */
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
 * ═══ ⚠️ THE HEADING IS THE SUBMENU ROW'S LABEL; THE MAP ITEM IS THE TAB'S LABEL (10b59703) ═══
 *
 * Until r266 each screen's heading was `admin.leaveConfigMap.item.<id>`, and the left submenu row that
 * opened it said something else ("Entitlements" opened "Leave types"; "Approval Workflow" opened
 * "Approval chain"). The rule is now: every page's heading is its ROW's `nav.*` label
 * (`leaveConfigPageHeader` / `leaveConfigRowTitle`), and `admin.leaveConfigMap.item.<id>` names the TAB
 * inside that row. Still one string per name, still resolved from one place — the drift this component
 * was built to end is not reintroduced one level down; it is closed one level up.
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
import Link from '@/components/intent-link';
import { LEAVE_SETTINGS_DESTINATIONS, LEAVE_SETTINGS_HREF } from '@/packs/leave';
import { getTranslations } from 'next-intl/server';

export * from '@/lib/leave-config-navigation';
import {LEAVE_CONFIG_MAP,leaveConfigGroupOf,type LeaveConfigScreenId,type LeaveConfigGroupId,type MappedLeaveConfigScreenId} from '@/lib/leave-config-navigation';

/** The TAB label for one screen — the string the tab row shows for it (and, on Company rules, the
 *  section heading of an absorbed screen). Not a page heading any more: see `leaveConfigRowTitle`. */
export async function leaveConfigScreenTitle(id: LeaveConfigScreenId): Promise<string> {
  const t = await getTranslations('admin.leaveConfigMap');
  return t(`item.${id}`);
}

/** The heading of every page in a group: the submenu ROW's own label, read from the same `nav` key the
 *  sidebar renders, so the row that opened the page and the heading on it cannot disagree. */
export async function leaveConfigRowTitle(groupId: LeaveConfigGroupId): Promise<string> {
  const t = await getTranslations('nav');
  return t(LEAVE_CONFIG_MAP.find((g) => g.id === groupId)!.navKey);
}

/**
 * The one-line description of what a ROW is responsible for. One key per row, resolved here rather than
 * on each page, so the two tabs of Entitlements (and the two of Leave Adjustments) describe their
 * row in the same words: a tab is a part of the page, not a page with its own summary.
 */
const ROW_DESCRIPTION_KEY: Record<LeaveConfigGroupId, [namespace: string, key: string]> = {
  entitlements: ['admin.leaveConfigTypes', 'rowDescription'],
  balanceHealth: ['admin.leaveConfigBalanceHealth', 'pageDescription'],
  adjustments: ['admin.leaveConfigAdjustments', 'pageDescription'],
  // 3f15ffdb (r362) — its own namespace, the house shape (`admin.leaveConfig<Row>.pageDescription`).
  // It must NOT borrow the Leave Adjustments sentence: that row's sentence is about changing balances,
  // and the one thing this row does not do is change a balance.
  leaveDataImport: ['admin.leaveDataImport', 'pageDescription'],
  leaveHistoryImport: ['admin.leaveConfigHistoryImport', 'pageDescription'],
  // db55d08a (r369) — its own namespace, the house shape. It must NOT borrow either neighbour's
  // sentence: the row above is about loading leave RECORDS (this creates none) and Leave Adjustments is
  // about changing a balance by hand (this states the figure a leave year opens with).
  leaveBfImport: ['admin.leaveConfigBfImport', 'pageDescription'],
  leaveCredit: ['admin.leaveConfigLeaveCredit', 'pageDescription'],
  generate: ['admin.leaveConfigGenerate', 'pageDescription'],
  earnedAccrual: ['admin.leaveConfigEarnedAccrual', 'pageDescription'],
  approval: ['admin.leaveConfigApprovalChains', 'pageDescription'],
  companyRules: ['admin.leaveConfigCompanyRules', 'pageDescription'],
  specialSetting: ['admin.leaveConfigSpecialSetting', 'pageDescription'],
};

/** The PageHeader of any Leave Config screen: its row's title and its row's description. Every page in
 *  the module reads its header through here (test/r266-leave-config-rows.test.ts), which is what makes
 *  "the heading equals the submenu row" a property of the module rather than nine separate promises. */
export async function leaveConfigPageHeader(
  current: MappedLeaveConfigScreenId,
): Promise<{ title: string; description: string }> {
  const group = leaveConfigGroupOf(current);
  const [namespace, key] = ROW_DESCRIPTION_KEY[group.id];
  const t = await getTranslations(namespace);
  return { title: await leaveConfigRowTitle(group.id), description: t(key) };
}

/**
 * THE TAB ROW OF THE CURRENT PAGE — the current row's screens, and only those. Directly under the
 * PageHeader. Renders nothing when the row owns a single screen: a tab row of one is furniture.
 *
 * The look is the leave-type tab strip's (app/admin/leave-config/types/leave-type-tabs.tsx `tabBtn`)
 * without the step numbers, because these are places, not steps. SERVER COMPONENT, plain links, one
 * `getTranslations`, and it must stay one (test/server-client-boundary.test.ts).
 */
export async function LeaveConfigMap({ current }: { current: MappedLeaveConfigScreenId }) {
  const group = leaveConfigGroupOf(current);
  const settings = await getTranslations('leaveSettingsHub');
  const back = LEAVE_SETTINGS_DESTINATIONS.some(row => row.labelKey === group.navKey)
    ? <Link href={LEAVE_SETTINGS_HREF} className="inline-flex min-h-11 w-fit items-center text-sm text-primary underline underline-offset-4">{settings('back')}</Link> : null;
  if (group.items.length < 2) return back;
  const t = await getTranslations('admin.leaveConfigMap');
  const tab = (active: boolean) =>
    `flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
      active
        ? 'border-transparent bg-accent font-semibold text-accent-foreground'
        : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground'
    }`;

  return (
    <>{back}<nav aria-label={t('label')} data-testid="leave-config-tabs">
      <ol className="flex flex-wrap items-center gap-1.5">
        {group.items.map((it, i) => (
          <li key={it.id} className="flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden className="hidden h-px w-3 bg-border sm:block" /> : null}
            {it.id === current ? (
              // The current tab is NOT a link. A link to where you already are is a dead control, and
              // aria-current is what tells a screen reader which tab is the live one.
              <span aria-current="page" className={tab(true)} data-navigation-destination={it.navigationId}>
                {t(`item.${it.id}`)}
              </span>
            ) : (
              <Link href={it.href} className={tab(false)} data-navigation-destination={it.navigationId}>
                {t(`item.${it.id}`)}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav></>
  );
}
