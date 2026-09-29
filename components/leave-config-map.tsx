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
  /**
   * r279 (3fbf7a02) — `balanceHealth` (`/admin/leave-config/balance-health`), a SIBLING of the two
   * Entitlements tabs and not a third one of them.
   *
   * The traffic-light listing — which leave types can produce a balance at all, and what is missing
   * before the rest can — was drawn at page level on the Leave types tab and named NOWHERE in the menu.
   * The screen that explains a 0.00 balance was the screen you had to already know about before you
   * could find it, so it takes a fly-out row of its own, directly under Entitlements, and a group of its
   * own here. A THIRD ITEM in the entitlements group would have been the wrong shape: it reads EVERY
   * leave type at once, which is the one thing neither of that row's two tabs does.
   */
  | 'balanceHealth'
  | 'approvalChain'
  | 'replacementLeave'
  | 'payrollImpact'
  | 'generateEntitlement'
  /**
   * r281 (09386e29) — `earnedAccrual` (`/admin/leave-config/earned-accrual`), a NEIGHBOUR of Generate
   * Entitlement and not a section inside it.
   *
   * Run earned accrual was filed underneath the generation wizard, which is the one operation it must
   * never be confused with: Generate Entitlement CREATES a leave year's entitlement, while this tops up
   * what has already been earned and not yet posted. Filing the second inside the first put an operator
   * one scroll away from the wrong button. It is run regularly (fifteen recorded runs, the latest the day
   * before this round), so it takes a row of its own — directly after Generate Entitlement, so the two
   * stay neighbours without one being filed inside the other.
   */
  | 'earnedAccrual'
  | 'adjustments'
  /**
   * 3fb1a611 (r299) — `leaveCredit` (`/admin/leave-config/leave-credit`) and `leaveCreditRules`
   * (`/admin/leave-config/leave-credit/rules`): the Credits and Rules TABS of the Leave Credit row, directly
   * after Leave Adjustments. Credits lists every Replacement Leave credit movement (earned through a request,
   * added by HR, used, reversed, expired) with its history; Rules is the replacement-leave policy that left
   * Company rules. Two routes, the house shape for a row with tabs (Leave Adjustments' two are the precedent),
   * so the tab row is this component's and no page draws a strip of its own.
   */
  | 'leaveCredit'
  | 'leaveCreditRules'
  | 'importLeaveData'
  /**
   * 3f15ffdb (r362) — `leaveHistoryImport` (`/admin/leave-config/history-import`), the RECORD half of a
   * migration, a row and a group of its own directly after Leave Adjustments.
   *
   * A GROUP OF ONE, not a third tab of the `adjustments` group, and the distinction is the item. A tab
   * there would inherit that row's heading and description — "adjust balances" — which is precisely
   * what this tool must never be read as doing: an imported record moves no balance at all. Taking a
   * group of its own is also what this component's own rule requires (every fly-out row whose
   * destination lives under app/admin/leave-config IS a group, one for one, in order), and it is what
   * makes `leaveConfigPageHeader` give the page its OWN row heading. The tab strip draws nothing for a
   * group of one — Balance Health, Run earned accrual and Special Setting are the precedents.
   *
   * Its sibling `importLeaveData` keeps its id, its route and its stored role configs and changes only
   * its LABEL, to "Leave Balance Import": two near-identical names for two tools that do opposite
   * things is the confusion the pair would otherwise create.
   */
  | 'leaveHistoryImport'
  | 'entitlementArchive'
  | 'ledgerArchive'
  /**
   * r281 (a73d1e14) — `specialSetting` (`/admin/leave-config/special-setting`), the LAST row, holding
   * Half Day Deduction.
   *
   * The reporter drew three levels — Leave Config, then Special Setting, then Half Day Deduction under
   * it. THE RAIL IS TWO LEVELS: `NavChildDescriptor` (packs/registry.ts) carries href/labelKey/icon and
   * no `children`, so a row cannot hold a row. The answer is the house's own single-screen shape:
   * Special Setting is the ROW and Half Day Deduction is the page it opens — same destination, same
   * grouping, one click instead of two. The plan says this to the reporter in those words and offers
   * reject-and-say-so.
   *
   * ⚠️ THE ID IS THE ROW, NOT THE SETTING, and that is deliberate. A second special setting later becomes
   * a second ITEM in this group, and the tab strip appears by itself with the row's name unchanged. An id
   * named for the half-day rule would have had to be renamed on that day, which is the rename of a screen
   * the customer has already learned that this component exists to avoid.
   */
  | 'specialSetting';

/**
 * 10b59703 — GROUPED BY THE ROWS OF THE LEFT SUBMENU, and nothing else.
 *
 * ⚠️ 5ca446db (r269) — THE FLY-OUT HAS ONE MORE ROW THAN THIS MAP HAS GROUPS, AND THAT IS CORRECT.
 * (r279: seven rows, six groups. The counts move; the RULE below does not, which is why it is written as
 * a rule rather than as two numbers. Every row whose destination is a page under
 * `app/admin/leave-config/**` IS a group here, one for one, in the same order — including a row that owns
 * a single screen, whose tab row then renders nothing. The ONE row that is not a group is the one whose
 * destination is not a Leave Config page at all:)
 * The LAST row ("Employee Leave Inquiry", packs/leave/index.ts LEAVE_ADMIN_NAV, last child) opens
 * `/leave/employee-balances` — a LEAVE INQUIRY screen that is not a Leave Config screen: it has no page
 * under `app/admin/leave-config/**`, it is registered on its own `leaveEmployeeBalances` permission
 * column rather than on `leaveConfig`, and its heading comes from its own PageHeader
 * (`leave.inquiry.balancesTitle`), not from `leaveConfigPageHeader`. Adding a group for it here would make
 * `leaveConfigPageHeader` claim a page it does not own and would break
 * test/leave-config-map.test.ts's "every screen here IS a declared route on its screen key". The
 * row↔group agreement below is therefore pinned as "the map groups ARE the rows whose destinations live
 * under the module, in order", with the one exception named explicitly — see
 * test/leave-config-map.test.ts and test/r266-leave-config-rows.test.ts.
 * This note is here because the next person WILL assume the row belongs in this list.
 *
 * Until r266 the groups were configure / run / history and the component rendered ALL nine screens as a
 * pill row on every page — fourteen navigation controls on the Entitlements landing before the content
 * started, five of them duplicating a submenu row beside them, and two screens each named twice on one
 * page ("Configuration record" in the header, "Entitlement archive" in the pills). The reporter's
 * instruction was that the submenu IS the navigation. So:
 *
 *   · a group is a submenu ROW (`packs/leave/index.ts` LEAVE_ADMIN_NAV, same order, same set);
 *   · the first item of every group is the row's own href — that agreement is pinned by
 *     test/leave-config-map.test.ts, not derived, for the same reason the permission registry is not
 *     derived from (see the header above);
 *   · `LeaveConfigMap` renders ONLY the current group's items, as the page's own tab row, and renders
 *     nothing at all when the row owns one screen (Generate Entitlement, Approval Workflow, Company rules);
 *   · the page HEADING is the ROW's label (`leaveConfigRowTitle`), and the map item label is the TAB's
 *     label. One screen, one name, in exactly one place each.
 *
 * `leaveConfigScreenHref` is unchanged: every cross-screen link still resolves through the one list.
 */
export type LeaveConfigGroupId =
  | 'entitlements'
  // r279 (3fbf7a02) — a one-screen row, like `generate`, `approval` and `companyRules` below it: the
  // tab row renders nothing for it, and the group exists so the page reads its heading and description
  // through the same helper every other Leave Config page does.
  | 'balanceHealth'
  | 'adjustments'
  // 3f15ffdb (r362) — a one-screen row directly after Leave Adjustments (see the screen id's note
  // above for why it is a group of its own rather than a third tab of `adjustments`).
  | 'leaveHistoryImport'
  // 3fb1a611 (r299) — a one-screen row directly after Leave Adjustments (see the screen id's note above).
  | 'leaveCredit'
  | 'generate'
  // r281 (09386e29) — a one-screen row, like `generate` above it: Run earned accrual is an execution of
  // its own rather than a section of the generator, and the group exists so its page reads its heading
  // and description through the same helper every other Leave Config page does.
  | 'earnedAccrual'
  | 'approval'
  | 'companyRules'
  // r281 (a73d1e14) — LAST, after Employee Leave Inquiry, where the reporter drew it. A one-screen row
  // like `generate`, `earnedAccrual` and `companyRules`: the tab strip draws nothing for it today and
  // appears on its own the day a second special setting joins the group.
  | 'specialSetting';

/** The `nav.*` key of the submenu row each group IS — the heading of every page in the group. */
export type LeaveConfigRowNavKey =
  | 'leaveEntitlements'
  | 'leaveBalanceHealth'
  | 'leaveAdjustments'
  | 'leaveHistoryImport'
  | 'leaveCredit'
  | 'leaveGenerate'
  | 'leaveEarnedAccrual'
  | 'leaveApprovalWorkflow'
  | 'leaveCompanyRules'
  | 'leaveSpecialSetting';

type Group = {
  id: LeaveConfigGroupId;
  navKey: LeaveConfigRowNavKey;
  items: { id: LeaveConfigScreenId; href: string }[];
};

export const LEAVE_CONFIG_MAP: Group[] = [
  {
    id: 'entitlements',
    navKey: 'leaveEntitlements',
    items: [
      { id: 'leaveTypes', href: '/admin/leave-config/types' },
      { id: 'entitlementTables', href: '/admin/leave-config/entitlement-tables' },
      // 7f69bd71 — `{ id: 'entitlementArchive', href: '/admin/leave-config/records/entitlement' }` STOOD
      // HERE (10b59703's third tab) and is DELIBERATELY GONE: the reporter's complaint was that a
      // read-only record has no business sitting beside the two tabs somebody uses every day. The record
      // is the Configuration sub-tab of the Reset records sub-screen now (`leaveConfigRecordHref`), and
      // the old address is a redirect stub that lands there with `?capture=` kept.
    ],
  },
  // r279 (3fbf7a02) — ONE SCREEN, ITS OWN ROW, SECOND. The tab row renders nothing for a group of one
  // (see `LeaveConfigMap` below), so this entry buys exactly two things and they are the two the module
  // is built on: the page's heading is its ROW's `nav` label through `leaveConfigPageHeader`, and the
  // row↔group agreement stays 1:1 in both directions — which is what test/leave-config-map.test.ts and
  // test/r266-leave-config-rows.test.ts assert, and what a mapless row would have forced an exception to.
  { id: 'balanceHealth', navKey: 'leaveBalanceHealth', items: [{ id: 'balanceHealth', href: '/admin/leave-config/balance-health' }] },
  {
    id: 'adjustments',
    navKey: 'leaveAdjustments',
    items: [
      { id: 'adjustments', href: '/admin/leave-config/adjustments' },
      // 7f69bd71 — `{ id: 'ledgerArchive', href: '/admin/leave-config/records/balances' }` STOOD HERE
      // (10b59703's second tab) and is DELIBERATELY GONE for the same reason as its sibling above. The
      // balance record is the Balances sub-tab of the Reset records sub-screen, reached from one small
      // link at the foot of Adjust balances — still one click away on the day somebody needs a figure
      // from before a reset, and out of the way every other day.
      // 10b59703 — Import loads balance MOVEMENTS (opening balances, carry-forward, ad-hoc credits —
      // core/leave-import.ts writes leave_ledger rows). That is an adjustment by file, so it moved out
      // of the Entitlements header and under this row.
      // 3f15ffdb (r362) — the phrase "historical leave" STOOD IN THAT LIST and is deliberately gone,
      // along with the tab's old label: past leave RECORDS are the job of the Leave History Data Import
      // row below, which writes leave_request rows and moves no balance. Two tools, one job each.
      { id: 'importLeaveData', href: '/admin/leave-config/import' },
    ],
  },
  // 3f15ffdb (r362) — LEAVE HISTORY DATA IMPORT, ONE SCREEN, ITS OWN ROW, DIRECTLY AFTER LEAVE
  // ADJUSTMENTS. The tab row renders nothing for a group of one (see `LeaveConfigMap` below), so this
  // entry buys the same two things Balance Health's does: the page's heading is its ROW's `nav` label
  // through `leaveConfigPageHeader`, and the row↔group agreement stays 1:1 in both directions. The
  // alternative — a third tab of the group above — was the wrong shape and is the whole point of the
  // item: that row is called Leave Adjustments and describes itself as adjusting balances, and this
  // tool adjusts none. Immediately after it because a migration loads the balances, then the records.
  {
    id: 'leaveHistoryImport',
    navKey: 'leaveHistoryImport',
    items: [{ id: 'leaveHistoryImport', href: '/admin/leave-config/history-import' }],
  },
  // 3fb1a611 (r299) — LEAVE CREDIT, ITS OWN ROW, DIRECTLY AFTER LEAVE ADJUSTMENTS, with two tabs: Credits and
  // Rules. The row is gated on the `toil` module in the sidebar (MODULE_OF_HREF); both pages also check it.
  {
    id: 'leaveCredit',
    navKey: 'leaveCredit',
    items: [
      { id: 'leaveCredit', href: '/admin/leave-config/leave-credit' },
      { id: 'leaveCreditRules', href: '/admin/leave-config/leave-credit/rules' },
    ],
  },
  { id: 'generate', navKey: 'leaveGenerate', items: [{ id: 'generateEntitlement', href: '/admin/leave-config/generate' }] },
  // r281 (09386e29) — ONE SCREEN, ITS OWN ROW, IMMEDIATELY AFTER GENERATE ENTITLEMENT. The tab row draws
  // nothing for a group of one, so this entry buys the same two things the Balance Health group buys: the
  // page's heading is its ROW's `nav` label through `leaveConfigPageHeader`, and the row↔group agreement
  // stays 1:1 in both directions. A THIRD OPTION — a second tab of the `generate` group — was the wrong
  // shape and is the whole point of the item: a tab strip would put the two operations back on one screen,
  // which is the confusion between creating entitlement and topping it up that this separates.
  { id: 'earnedAccrual', navKey: 'leaveEarnedAccrual', items: [{ id: 'earnedAccrual', href: '/admin/leave-config/earned-accrual' }] },
  { id: 'approval', navKey: 'leaveApprovalWorkflow', items: [{ id: 'approvalChain', href: '/admin/leave-config/approval-chains' }] },
  // a6fe37fc ROUND 5 (cutover) — `replacementLeave` and `payrollImpact` are DELIBERATELY absent: their
  // screens were absorbed into Company rules, whose page renders `leaveConfigScreenTitle()` of each as a
  // section heading. Two entries reaching one screen is what this component exists to stop.
  { id: 'companyRules', navKey: 'leaveCompanyRules', items: [{ id: 'companyRules', href: '/admin/leave-config/company-rules' }] },
  // r281 (a73d1e14) — LAST, AFTER EMPLOYEE LEAVE INQUIRY, which is where the reporter drew it. That row
  // is not a group here (its destination is not a Leave Config page), so this group follows Company rules
  // in THIS list while its row follows the inquiry row in the fly-out — the two orders still agree,
  // because the agreement is asserted over the rows whose destinations live under the module.
  { id: 'specialSetting', navKey: 'leaveSpecialSetting', items: [{ id: 'specialSetting', href: '/admin/leave-config/special-setting' }] },
];

/**
 * a6fe37fc ROUND 3 (r259 finding 3) — THE ADDRESS THE MAP GIVES A SCREEN, so a link to a screen can
 * never disagree with the menu entry for it. Every cross-screen link inside the module resolves through
 * here, so it points where the MAP points.
 *
 * `replacementLeave` and `payrollImpact` are excluded by TYPE, not by a runtime fallback: their screens
 * were absorbed into Company rules, so asking this function for their address is a mistake tsc should
 * refuse rather than one this function should paper over with a guessed href.
 *
 * 7f69bd71 — `entitlementArchive` and `ledgerArchive` join that exclusion: they are no longer tabs of any
 * row, so they have no group, no row heading and no map href. The ids survive as the LABELS of the two
 * sub-tabs on the Reset records sub-screen (`leaveConfigScreenTitle`, which takes the wider union), and
 * the address of each record resolves through `leaveConfigRecordHref` below — one source, as before.
 */
export type MappedLeaveConfigScreenId = Exclude<
  LeaveConfigScreenId,
  'replacementLeave' | 'payrollImpact' | 'entitlementArchive' | 'ledgerArchive'
>;

/**
 * 7f69bd71 — THE RESET RECORDS SUB-SCREEN (`/admin/leave-config/records`). Not a row and not a tab: a
 * sub-screen of the Leave Adjustments row, reached from one small link at the foot of Adjust balances,
 * with a back link at the top. It holds the two read-only records as sub-tabs selected by `?record=`:
 *
 *   configuration — the Configuration record (`entitlementArchive`): entitlement tables, eligibility
 *                   rules and, in the older captures, benefit schemes, captured before a reset cleared them;
 *   balances      — the Balance record (`ledgerArchive`): the ledger rows a reset removed.
 *
 * Why a sub-screen and not a third row: the records are records of REMOVALS — the adjustments domain —
 * and the reporter's instruction was that the submenu carries what is used day to day. Why `?record=`
 * and not two routes: one guarded page is one route on the `leaveConfig` key, the picker form on either
 * sub-tab GETs back to the same address, and the two retired tab addresses redirect here with the
 * record named in the query, so `?capture=` rides along unchanged.
 *
 * The Leave Adjustments row owns this path (`ownedSubpaths`, packs/leave/index.ts) so it stays lit
 * while the sub-screen — or either stub on the way through — is open.
 */
export const LEAVE_CONFIG_RECORDS_HREF = '/admin/leave-config/records';
export const LEAVE_CONFIG_RECORD_IDS = ['configuration', 'balances'] as const;
export type LeaveConfigRecordId = (typeof LEAVE_CONFIG_RECORD_IDS)[number];

/** The screen id whose `admin.leaveConfigMap.item.*` string labels each sub-tab. */
export const LEAVE_CONFIG_RECORD_LABEL_ID: Record<LeaveConfigRecordId, LeaveConfigScreenId> = {
  configuration: 'entitlementArchive',
  balances: 'ledgerArchive',
};

/** The address of one record's sub-tab. The stubs, the foot link and the sub-tab strip all resolve
 *  through here, so no file spells the address twice. */
export function leaveConfigRecordHref(record: LeaveConfigRecordId): string {
  return `${LEAVE_CONFIG_RECORDS_HREF}?record=${record}`;
}

/** `?record=` as typed, or the Configuration record for anything else — including nothing at all. An
 *  unknown value is ignored rather than answered with an empty page. */
export function leaveConfigRecordOf(raw: string | undefined): LeaveConfigRecordId {
  return (LEAVE_CONFIG_RECORD_IDS as readonly string[]).includes(raw ?? '')
    ? (raw as LeaveConfigRecordId)
    : 'configuration';
}

const HREF_BY_ID = Object.fromEntries(
  LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => [i.id, i.href] as const),
) as Record<MappedLeaveConfigScreenId, string>;

const GROUP_BY_ID = Object.fromEntries(
  LEAVE_CONFIG_MAP.flatMap((g) => g.items.map((i) => [i.id, g] as const)),
) as Record<MappedLeaveConfigScreenId, Group>;

export function leaveConfigScreenHref(id: MappedLeaveConfigScreenId): string {
  return HREF_BY_ID[id];
}

/** The submenu row a screen belongs to. */
export function leaveConfigGroupOf(id: MappedLeaveConfigScreenId): Group {
  return GROUP_BY_ID[id];
}

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
  leaveHistoryImport: ['admin.leaveConfigHistoryImport', 'pageDescription'],
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
  if (group.items.length < 2) return null;
  const t = await getTranslations('admin.leaveConfigMap');
  const tab = (active: boolean) =>
    `flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
      active
        ? 'border-transparent bg-accent font-semibold text-accent-foreground'
        : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground'
    }`;

  return (
    <nav aria-label={t('label')} data-testid="leave-config-tabs">
      <ol className="flex flex-wrap items-center gap-1.5">
        {group.items.map((it, i) => (
          <li key={it.id} className="flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden className="hidden h-px w-3 bg-border sm:block" /> : null}
            {it.id === current ? (
              // The current tab is NOT a link. A link to where you already are is a dead control, and
              // aria-current is what tells a screen reader which tab is the live one.
              <span aria-current="page" className={tab(true)}>
                {t(`item.${it.id}`)}
              </span>
            ) : (
              <Link href={it.href} className={tab(false)}>
                {t(`item.${it.id}`)}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
