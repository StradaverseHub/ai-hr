/**
 * 645e67c4 — Leave config moves from a horizontal tab strip to the sidebar fly-out.
 *
 * The reporter asked for Replacement Leave "under Leave Configuration… the same navigation style as
 * Leave Type / Leave Adjustments / Generate Entitlement", and then contested `491c499f` in the same
 * words: "move this leave adjustment in the Leave Config left-hand menu from a single line into an
 * expandable group, the same way Payroll and Attendance already work". ONE build answers both.
 *
 * The direct analogue of test/payroll-flyout-nav.test.ts, which guards 1459e116's identical conversion.
 * Three properties are worth a regression guard, and they are the three ways this change could quietly
 * hurt someone:
 *
 *   1. NO BROKEN BOOKMARKS. The node's hrefs must be the retired strip's, character for character.
 *      A renamed route would 404 for anyone who saved a leave-config link.
 *   2. NO DEAD ENTRIES. Every href must resolve to a real route file, and must be a registered route on a
 *      NAMED screen in lib/permissions.ts — a menu row whose route is unregistered is either invisible or
 *      refused by our own access check (the trap 4b0e76ae's tab hit). Four are on the `leaveConfig`
 *      column; Approval Workflow is on `leaveApproval` (0d147b78) and 5ca446db's Employee Leave Inquiry row
 *      is on `leaveEmployeeBalances`, because its destination is a Leave Inquiry screen with its own column
 *      since 20c699f8. The guard names the owning column per child rather than relaxing the rule to
 *      "registered somewhere" — and it was that strengthening which revealed the Approval Workflow case,
 *      which the substring scan it replaced had never checked.
 *   3. THE STRIP IS ACTUALLY GONE. Leaving it behind would give leave two navigations at once, which
 *      is worse than the crowding being fixed.
 *
 * The pack node is imported for real; the sidebar half is a source-text check, the house idiom for
 * `'use client'` module-private structure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { leavePack } from '../packs/leave';
import { LEAVE_CONFIG_MAP, LEAVE_CONFIG_RECORDS_HREF } from '../components/leave-config-map';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
/**
 * Comments are not code. The sidebar legitimately NAMES the retired `LEAVE_CONFIG_ROW` in its
 * provenance comment, and r134 established the rule the hard way: a guard that reports correct code as
 * wrong is worse than no guard. Strip commentary before asserting on structure, so the history can stay
 * written down.
 */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const NODE = leavePack.navNodes!.find((n) => n.group === 'admin')!;

/**
 * The retired components/leave-tabs.tsx destinations, captured VERBATIM from the commit before this
 * change, IN THE STRIP'S OWN ORDER. hrefs are the strip's; only the labelKey namespace moved
 * (admin.leaveTabs → nav). This is the SET AND SEQUENCE the fly-out must carry — no destination lost,
 * no href renamed, no re-sorting.
 *
 * EIGHT, not the six an earlier revision of the plan described: `491c499f` added Leave Adjustments and
 * `4b0e76ae` added Generate Entitlement while this item waited. Listed explicitly rather than asserted
 * as a subset, because a set guard that only checks "contains" stops noticing a deletion.
 */
const RETIRED_STRIP: readonly { href: string; labelKey: string }[] = [
  // df00b85f — `{ '/admin/leave', 'leaveSummary' }` STOOD HERE and is DELIBERATELY GONE, not lost.
  //
  // This list is an exact-set guard, so it fails on a clipped sibling; the only correct way to retire a
  // destination is to delete its line here in the same commit that deletes the row, which is what this is.
  // The two properties the removal has to keep are asserted below by their own tests rather than by this
  // list: the ROUTE still resolves (as a redirect stub, so no bookmark 404s) and Entitlements is now first.
  // a6fe37fc ROUND 5 (cutover) — re-pointed, not deleted. The leave TYPE screen is
  // `/admin/leave-config/types` (five tabs instead of four steps and six sub-steps, IA §2); the old page
  // is a redirect stub and `components/leave-type-panel.tsx` was deleted with it. This list's promises
  // are "no destination lost" and "no re-sorting", and both hold: same row, same label key, same
  // position, and the old address still answers.
  { href: '/admin/leave-config/types', labelKey: 'leaveEntitlements' },
  // a6fe37fc ROUND 5 (cutover) — re-pointed, not deleted (see the Generate entry below).
  { href: '/admin/leave-config/adjustments', labelKey: 'leaveAdjustments' },
  // a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. The two properties this list guards are "no
  // destination lost" and "no re-sorting"; neither is about the literal address. The screen moved to
  // `/admin/leave-config/generate` and the old address is a redirect stub, so pinning the OLD href here
  // would have required the menu to keep pointing at a stub — a bookmark that still works reached through
  // a wasted hop, and a menu row the "every destination is a registered route" case below would reject.
  { href: '/admin/leave-config/generate', labelKey: 'leaveGenerate' },
  // a6fe37fc ROUND 5 (cutover) — re-pointed, not deleted (see the Generate entry below).
  { href: '/admin/leave-config/approval-chains', labelKey: 'leaveApprovalWorkflow' },
  // a6fe37fc ROUND 5 (cutover) — `{ '/admin/leave/payroll', 'leavePayroll' }` STOOD HERE and is
  // DELIBERATELY GONE, not lost. Payroll Related was two settings that were never one subject: the
  // per-leave-type "Send to payroll module" switch is on the Leave types row above (tab 1) and the
  // encashment policy is on the Company rules row below. This list is an exact-set guard, so the only
  // correct way to retire a destination is to delete its line in the commit that does it — which is what
  // this is. The ROUTE still resolves as a stub and the label key is pruned, both asserted below.
  // a6fe37fc ROUND 5 (cutover) — `{ '/admin/leave/replacement', 'leaveReplacement' }` STOOD HERE and is
  // DELIBERATELY REPLACED, not lost. Its screen was ABSORBED: a replacement-leave policy is a COMPANY
  // rule (IA §2.0.3), so the row now names Company rules — the destination that carries that policy plus
  // the half-day deduction, the encashment policy and the shared leave groups. This list is an exact-set
  // guard, so the only correct way to record an absorption is to edit its line in the commit that does
  // it, which is what this is. The ROUTE still resolves as a stub (asserted below) and the old label key
  // is NOT pruned — `nav.leaveReplacement` names the screen inside
  // components/leave/replacement-availability-notice.tsx, a different sentence to a different reader.
  { href: '/admin/leave-config/company-rules', labelKey: 'leaveCompanyRules' },
  // f1b994e3 — `{ '/admin/leave/audit', 'leaveAudit' }` STOOD HERE and is DELIBERATELY GONE, not lost,
  // for the reason the df00b85f note above states: this list is an exact-set guard, so the ONLY correct
  // way to retire a destination is to delete its line here in the same commit that deletes the row. The
  // two properties the removal has to keep have their own tests below: the ROUTE still resolves (as a
  // redirect stub carrying ?module=leave, so no bookmark 404s) and the label key is pruned rather than
  // left as an untranslatable orphan.
] as const;

/**
 * 5ca446db (r269) — DESTINATIONS ADDED SINCE THE STRIP WAS RETIRED, in the order they were added.
 *
 * The exact-set guard below compares `children` to RETIRED_STRIP **followed by this list**, so the two
 * promises the strip list carries ("no destination lost", "no re-sorting") keep their exact-set teeth while
 * a genuinely NEW row can be added by naming it here, in the commit that adds it — the same discipline the
 * `STOOD HERE` notes above apply to removals, in the other direction.
 *
 * · Employee Leave Inquiry — the reporter's second request for it ("add a new function under Leave Config:
 *   Leave Inquiry", item 1ff969ed, then this item). It is the ONLY child whose destination is not a Leave
 *   Config screen: it opens the existing Leave Inquiry surface at its unchanged `/leave/employee-balances`
 *   address, which is why it is absent from LEAVE_CONFIG_MAP and registered on its own permission column
 *   (both pinned by their own cases below). It replaces the single underlined link that used to sit in the
 *   Entitlements page header.
 */
const ADDED_SINCE: readonly { href: string; labelKey: string }[] = [
  { href: '/leave/employee-balances', labelKey: 'employeeLeaveInquiry' },
  // r281 (a73d1e14) — Special Setting, appended BELOW the inquiry row because that is where the reporter
  // drew it. It holds Half Day Deduction, which came off Company rules. The rail is two levels deep
  // (`NavChildDescriptor` has no `children`), so the sketch's third level is the PAGE this row opens
  // rather than a nested row; the plan says that to the reporter and offers reject-and-say-so.
  { href: '/admin/leave-config/special-setting', labelKey: 'leaveSpecialSetting' },
] as const;

/**
 * r279 (3fbf7a02) — A ROW ADDED SINCE THE STRIP RETIRED THAT DOES **NOT** GO AT THE END.
 *
 * ADDED_SINCE above is appended, because the inquiry row was asked for "at the bottom, after Company
 * rules". Leave Balance Health was asked for in a different place and the place is the point: it answers
 * the question you ask ABOUT entitlements — can this leave type produce a balance at all — so it sits
 * directly under Entitlements, whose first tab it was drawn on until this round. Naming it in its own
 * list with its own insertion point keeps RETIRED_STRIP meaning exactly what it has always meant (the
 * retired strip, in the strip's order, nothing lost and nothing re-sorted) instead of smuggling a new
 * destination into it, which is the one edit that list cannot survive honestly.
 */
const ADDED_AFTER_ENTITLEMENTS: readonly { href: string; labelKey: string }[] = [
  { href: '/admin/leave-config/balance-health', labelKey: 'leaveBalanceHealth' },
] as const;

/**
 * r281 (09386e29) — A ROW ADDED SINCE THE STRIP RETIRED THAT GOES IMMEDIATELY AFTER GENERATE ENTITLEMENT,
 * and again the place is the point.
 *
 * Run earned accrual was a card filed UNDERNEATH the generation wizard on the Generate Entitlement page.
 * That page CREATES a leave year's entitlement; this tool posts only what has already been earned and is
 * not yet on the ledger, so filing one inside the other put the operator one scroll from the operation it
 * must never be confused with. It is a NEIGHBOUR of Generate Entitlement now, not a section of it — and
 * naming it in its own list with its own insertion point keeps RETIRED_STRIP meaning exactly what it has
 * always meant instead of smuggling a new destination into it.
 */
const ADDED_AFTER_GENERATE: readonly { href: string; labelKey: string }[] = [
  { href: '/admin/leave-config/earned-accrual', labelKey: 'leaveEarnedAccrual' },
] as const;

/**
 * 3fb1a611 (r299) — A ROW ADDED IMMEDIATELY AFTER LEAVE ADJUSTMENTS, and the place is the point once more.
 *
 * Leave Credit is where Replacement Leave balances change now — every credit earned, added by HR, used,
 * reversed or expired, plus the Rules tab that took the replacement-leave policy off Company rules. Leave
 * Adjustments refuses the Replacement Leave type and points here, so the two are neighbours. Named in its own
 * list with its own insertion point, for the reason the two lists above give. It is the one row of this node
 * gated on a module (`toil`): components/sidebar.tsx maps it by hand, pinned in test/r299-leave-credit-screens.
 */
const ADDED_AFTER_ADJUSTMENTS: readonly { href: string; labelKey: string }[] = [
  /**
   * 3f15ffdb (r362) — LEAVE HISTORY DATA IMPORT, spliced in BEFORE Leave Credit, and the order within
   * this list is the answer to a question the reporter asked directly.
   *
   * They asked for an import function under Leave Config and could not find one, because the importer
   * that exists is the hidden second TAB of the Leave Adjustments row above — and it loads BALANCES,
   * not records, so it would not have answered them anyway. This row is the record half, and it sits
   * immediately behind the row that owns the balance half: a migration loads the balances, then the
   * records, and this node's header says the order of the menu is the order of the work.
   */
  { href: '/admin/leave-config/history-import', labelKey: 'leaveHistoryImport' },
  /**
   * db55d08a (r369) — LEAVE B/F DATA IMPORT, spliced in directly behind the record importer and still
   * BEFORE Leave Credit, and the order within this list is again the answer to the reporter's own question.
   *
   * They asked for a sibling of Leave History Data Import for the OPENING FIGURE, and were right to.
   * Brought Forward is DERIVED (`sum(leave_ledger.days) where effective_on < cycleStart`) and no field
   * holds it, so the only existing route to it is the BALANCE importer, where the uploader must know two
   * unwritten rules — date the line in the PREVIOUS leave year, and make it an `adjustment`. An `accrual`
   * dated inside the year instead satisfies `yearOpenMarkerCond` and makes Generate Entitlement grant that
   * employee nothing for the whole year. This row is the tool that knows those rules.
   *
   * Immediately behind the record importer because the order of the menu is the order of the work, and the
   * reporter's go-live sequence is: generate the entitlements, load B/F, load the leave taken.
   */
  { href: '/admin/leave-config/bf-import', labelKey: 'leaveBfImport' },
  { href: '/admin/leave-config/leave-credit', labelKey: 'leaveCredit' },
] as const;

/**
 * The fly-out's children, EXACTLY: the retired strip in its own order, with each row added since spliced
 * in at the position its round chose. Still an exact-set guard — a deletion, a rename or a re-sort all
 * fail it — and a genuinely new row is added by naming it above, in the commit that adds it.
 */
const EXPECTED_CHILDREN: readonly { href: string; labelKey: string }[] = [
  RETIRED_STRIP[0],
  ...ADDED_AFTER_ENTITLEMENTS,
  // Leave Adjustments, then the row r299 spliced in behind it, then Generate Entitlement and the row r281
  // spliced in behind that.
  RETIRED_STRIP[1],
  ...ADDED_AFTER_ADJUSTMENTS,
  RETIRED_STRIP[2],
  ...ADDED_AFTER_GENERATE,
  ...RETIRED_STRIP.slice(3),
  ...ADDED_SINCE,
];

/** The child r269 added, resolved from the node so a rename here cannot silently pass. */
const INQUIRY_ROW = NODE.children.find((c) => c.labelKey === 'employeeLeaveInquiry')!;
/** The child r279 added, resolved the same way. */
const BALANCE_HEALTH_ROW = NODE.children.find((c) => c.labelKey === 'leaveBalanceHealth')!;
/** The child r281 added, resolved the same way. */
const EARNED_ACCRUAL_ROW = NODE.children.find((c) => c.labelKey === 'leaveEarnedAccrual')!;

/** href → the route file that must exist for it to be a live destination. */
const routeFile = (href: string) => `app${href}/page.tsx`;

describe('645e67c4 — Leave config is a sidebar fly-out, not a tab strip', () => {
  it('carries every retired tab destination, same hrefs, same order, plus what was added since at its own position — no broken bookmarks', () => {
    // r279 (3fbf7a02) — UPDATED, NOT LOOSENED. The comparison was `[...RETIRED_STRIP, ...ADDED_SINCE]`;
    // it is EXPECTED_CHILDREN now, which is the same thing with one row spliced in after Entitlements.
    // The splice is pinned rather than assumed: RETIRED_STRIP[0] must still be the Entitlements row, or
    // the new row would silently land somewhere else and this list would still read as correct.
    expect(RETIRED_STRIP[0], 'the splice point moved').toEqual({
      href: '/admin/leave-config/types',
      labelKey: 'leaveEntitlements',
    });
    // r281 — the SECOND splice point, pinned the same way and for the same reason: Run earned accrual
    // goes directly behind Generate Entitlement, so the entry it is spliced behind must still be that row.
    expect(RETIRED_STRIP[2], 'the second splice point moved').toEqual({
      href: '/admin/leave-config/generate',
      labelKey: 'leaveGenerate',
    });
    // r299 — the THIRD splice point: Leave Credit goes directly behind Leave Adjustments.
    expect(RETIRED_STRIP[1], 'the third splice point moved').toEqual({
      href: '/admin/leave-config/adjustments',
      labelKey: 'leaveAdjustments',
    });
    expect(NODE.children.map((c) => ({ href: c.href, labelKey: c.labelKey }))).toEqual(EXPECTED_CHILDREN);
    expect(NODE.labelKey).toBe('leaveConfig');
    expect(NODE.group).toBe('admin');
  });

  it('every destination is a real page AND registered on a NAMED permission screen — no dead entries', () => {
    // 5ca446db (r269) — UPDATED, NOT LOOSENED, and in fact strengthened. This used to be a substring scan of
    // lib/permissions.ts for the href, which the doc comment described as "registered on the leaveConfig
    // screen" but never actually checked. It now resolves the REGISTRY and names the owning screen key for
    // every child, so the one child that is deliberately on a different column has to say so out loud.
    const OWNING_SCREEN: Record<string, string> = {
      // Five Leave Config destinations on the one leaveConfig column…
      '/admin/leave-config/types': 'leaveConfig',
      // r279 (3fbf7a02) — Leave Balance Health is the fifth, and it is on `leaveConfig` ON PURPOSE: it
      // is the listing that WAS the Leave types tab, so anybody who could open that tab could already
      // read it. A screen key of its own would invent a permission for a page that moved address.
      '/admin/leave-config/balance-health': 'leaveConfig',
      '/admin/leave-config/adjustments': 'leaveConfig',
      // 3fb1a611 (r299) — Leave Credit is on `leaveConfig`, like every Leave Config destination (the map guard
      // requires it). It replaces the retired `toilPolicy` column, whose only route (/admin/toil) is a redirect
      // stub to this page now; both were requireAdmin, so no role gained or lost reach.
      // 3f15ffdb (r362) — Leave History Data Import is on `leaveConfig` like every other Leave Config
      // destination, and NOT on a key of its own. A screen key "may key stored role configs"
      // (lib/permissions.ts head), so minting one for a sibling of the balance importer would create a
      // permission nobody has been granted and split one area's access in two. Same requireAdmin guard,
      // and the run log is admin-only at the row level by RLS (migration 0490) on top of it.
      '/admin/leave-config/history-import': 'leaveConfig',
      '/admin/leave-config/leave-credit': 'leaveConfig',
      '/admin/leave-config/generate': 'leaveConfig',
        // r281 (09386e29) — Run earned accrual is on `leaveConfig` ON PURPOSE: it WAS a section of the
        // Generate Entitlement page, so anybody who could open that screen could already run it. A screen
        // key of its own would invent a permission for a card that changed address.
        '/admin/leave-config/earned-accrual': 'leaveConfig',
      '/admin/leave-config/company-rules': 'leaveConfig',
      // …and Approval Workflow, which has answered to the SEPARATE `leaveApproval` column since 0d147b78
      // absorbed the standalone approval-chain route. The substring scan this case replaced could not see
      // that, so the old doc comment's "registered on the leaveConfig screen" was already untrue for this
      // row before r269; it is written down here rather than quietly generalised away.
      '/admin/leave-config/approval-chains': 'leaveApproval',
      // THE EXCEPTION, named rather than tolerated: the Employee Leave Inquiry row opens a LEAVE INQUIRY
      // screen, which has carried its own scopedAdmin matrix column since 20c699f8. ⚠️ The first version of
      // this note said an admin could have leaveEmployeeBalances "revoked in Security & Permissions"; the
      // verify pass showed that cannot happen — canReach is derived from the guard and the access grid is
      // presentational. The real, pre-existing exposure is app/layout.tsx's wider isAdmin (it ORs in the
      // payroll and perf-comp partners), which shows every adminOnly row to a non-admin partner who is then
      // redirected at the page. Disclosed, predates this row, not fixed here with a bespoke flag.
      '/leave/employee-balances': 'leaveEmployeeBalances',
        // r281 (a73d1e14) — Special Setting is on `leaveConfig`, like every other Leave Config
        // destination: the half-day card it holds was already behind that column on Company rules, so a
        // screen key of its own would invent a permission for a card that changed address.
        '/admin/leave-config/special-setting': 'leaveConfig',
      // db55d08a (r369) — Leave B/F Data Import, on `leaveConfig` like both importers beside it. A
      // screenKey of its own would invent a permission NOBODY HAS BEEN GRANTED and split one area's
      // access in two: anyone who could open Leave Balance Import could already load balance movements,
      // which is a strictly wider power than stating an opening figure.
      '/admin/leave-config/bf-import': 'leaveConfig',
    };
    for (const child of NODE.children) {
      expect(exists(routeFile(child.href)), `${child.href} has no route file`).toBe(true);
      // A row whose route is unregistered is invisible or refused by our own access check.
      expect(REGISTERED_ROUTES.has(child.href), `${child.href} is not a registered route`).toBe(true);
      const owner = SCREENS.find((s) => s.routes.includes(child.href));
      expect(owner, `${child.href} is on no screen`).toBeTruthy();
      expect(owner!.screenKey, `${child.href} changed permission column`).toBe(OWNING_SCREEN[child.href]);
    }
    // Non-vacuity: the map above must describe exactly the children that exist, so a new row cannot be
    // added without deciding (and writing down) which permission column answers for it.
    expect(Object.keys(OWNING_SCREEN).sort()).toEqual(NODE.children.map((c) => c.href).sort());
  });

  /**
   * 5ca446db (r269) — the sixth row, and the four things about it that a later round could quietly undo.
   */
  it('the Employee Leave Inquiry row opens the existing Employee Balances screen and moves nothing', () => {
    expect(INQUIRY_ROW, 'the sixth row is gone').toBeTruthy();
    // THE ROUTE IS UNMOVED. Saved links, the export links already in circulation and the rail's own hrefs
    // all depend on this address; the row is a new DOOR, not a new address.
    expect(INQUIRY_ROW.href).toBe('/leave/employee-balances');
    expect(exists('app/leave/employee-balances/page.tsx')).toBe(true);
    // It stays lit on the rail's other admin tab, so stepping between them does not darken the menu.
    expect(INQUIRY_ROW.ownedSubpaths).toEqual(['/leave/employee-records']);
    // Highlighting is not a gate: adding one here would be a permission invented in the nav layer.
    expect(INQUIRY_ROW.adminOnly, 'ownedSubpaths must not have become a gate').toBeUndefined();
    expect(INQUIRY_ROW.managerUp, 'ownedSubpaths must not have become a gate').toBeUndefined();
    // It is NOT a Leave Config screen: no page under the module directory, and no map group (its own case
    // below and test/leave-config-map.test.ts pin the map half).
    expect(exists('app/admin/leave-config/employee-balances/page.tsx')).toBe(false);
    expect(LEAVE_CONFIG_MAP.flatMap((g) => g.items.map((i) => i.href))).not.toContain(INQUIRY_ROW.href);
    expect(LEAVE_CONFIG_MAP.map((g) => g.navKey)).not.toContain('employeeLeaveInquiry');
  });

  /**
   * r279 (3fbf7a02) — the second row, and the four things about it a later round could quietly undo.
   */
  it('the Leave Balance Health row sits directly under Entitlements and owns its own group, not a tab of one', () => {
    expect(BALANCE_HEALTH_ROW, 'the Balance Health row is gone').toBeTruthy();
    expect(BALANCE_HEALTH_ROW.href).toBe('/admin/leave-config/balance-health');
    // THE POSITION IS THE ANSWER, so it is pinned as the PAIR rather than as an index: it answers the
    // question you ask about entitlements, and it is the tab it left that sits above it.
    expect(NODE.children.map((c) => c.labelKey).slice(0, 2)).toEqual(['leaveEntitlements', 'leaveBalanceHealth']);
    // A real page, guarded, with no tabs of its own to own.
    expect(exists('app/admin/leave-config/balance-health/page.tsx')).toBe(true);
    expect(BALANCE_HEALTH_ROW.ownedSubpaths ?? []).toEqual([]);
    // Highlighting is not a gate: the Administration group is gated wholesale and the page calls
    // requireAdmin() for itself. A flag here would be a permission invented in the nav layer.
    expect(BALANCE_HEALTH_ROW.adminOnly).toBeUndefined();
    expect(BALANCE_HEALTH_ROW.managerUp).toBeUndefined();
    // A SIBLING, NOT A THIRD TAB: its own map group, of ONE item — so the tab row renders nothing, the
    // Entitlements group still has exactly its two tabs, and Entitlements does not own this path (owning
    // it would light the row above while the reader is on this one).
    const group = LEAVE_CONFIG_MAP.find((g) => g.navKey === 'leaveBalanceHealth')!;
    expect(group, 'every Leave Config row is a group; this one must be too').toBeTruthy();
    expect(group.items.map((i) => i.href)).toEqual([BALANCE_HEALTH_ROW.href]);
    expect(LEAVE_CONFIG_MAP.find((g) => g.navKey === 'leaveEntitlements')!.items).toHaveLength(2);
    expect(NODE.children.find((c) => c.labelKey === 'leaveEntitlements')!.ownedSubpaths).not.toContain(
      BALANCE_HEALTH_ROW.href,
    );
  });

  /**
   * r281 (09386e29) — the Run earned accrual row, and the four things about it a later round could undo.
   */
  it('the Run Earned Accrual row sits directly after Generate Entitlement and owns its own group, not a tab of one', () => {
    expect(EARNED_ACCRUAL_ROW, 'the Run earned accrual row is gone').toBeTruthy();
    expect(EARNED_ACCRUAL_ROW.href).toBe('/admin/leave-config/earned-accrual');
    // THE POSITION IS THE ANSWER, so it is pinned as the PAIR rather than as an index: the screen it was
    // filed inside is the one directly above it, and the two must read as neighbours rather than as one
    // containing the other.
    const labels = NODE.children.map((c) => c.labelKey);
    expect(labels.slice(labels.indexOf('leaveGenerate'), labels.indexOf('leaveGenerate') + 2)).toEqual([
      'leaveGenerate',
      'leaveEarnedAccrual',
    ]);
    // A real page, guarded, with no tabs of its own to own.
    expect(exists('app/admin/leave-config/earned-accrual/page.tsx')).toBe(true);
    expect(EARNED_ACCRUAL_ROW.ownedSubpaths ?? []).toEqual([]);
    // Highlighting is not a gate: the Administration group is gated wholesale and the page calls
    // requireAdmin() for itself. A flag here would be a permission invented in the nav layer.
    expect(EARNED_ACCRUAL_ROW.adminOnly).toBeUndefined();
    expect(EARNED_ACCRUAL_ROW.managerUp).toBeUndefined();
    // A SIBLING, NOT A SECOND TAB: its own map group, of ONE item — so the tab row renders nothing, the
    // Generate group still owns exactly its one screen, and Generate does not own this path (owning it
    // would light the row above while the reader is on this one, which is the very confusion this splits).
    const group = LEAVE_CONFIG_MAP.find((g) => g.navKey === 'leaveEarnedAccrual')!;
    expect(group, 'every Leave Config row is a group; this one must be too').toBeTruthy();
    expect(group.items.map((i) => i.href)).toEqual([EARNED_ACCRUAL_ROW.href]);
    expect(LEAVE_CONFIG_MAP.find((g) => g.navKey === 'leaveGenerate')!.items).toHaveLength(1);
    expect(NODE.children.find((c) => c.labelKey === 'leaveGenerate')!.ownedSubpaths ?? []).not.toContain(
      EARNED_ACCRUAL_ROW.href,
    );
  });

  /**
   * df00b85f — the Summary entry is retired and Entitlements leads the menu.
   *
   * The listing it opened (code / name / description / paid / status, an Edit link INTO Entitlements, a
   * delete) is rendered in full by the Entitlements per-type panel, so the row was a second door onto one
   * screen's settings. Three things make the removal safe rather than merely tidy, and each is pinned:
   * the route still resolves so no saved link 404s; the stub carries NO page guard, which is what lets
   * `/admin/leave` leave lib/permissions.ts without test/function-access.test.ts reddening in either
   * direction; and the label key retires WITH the row instead of lingering as an untranslatable orphan.
   */
  it('10b59703 — a row OWNS the tabs of its group, so it stays lit on them, and owns nothing else', () => {
    // The two screens that hang off no row of their own (Entitlement tables, Import leave data) are tabs
    // of Entitlements and Leave Adjustments. `ownedSubpaths` is highlighting only (packs/registry.ts),
    // and the two lists — the nav's and the map's — must not drift: a tab the row does not own goes dark
    // on arrival, and a path the row owns that is not its tab lights the wrong row.
    //
    // 7f69bd71 — ONE owned path that is not a tab, and it is named: the Reset records SUB-SCREEN
    // (`/admin/leave-config/records`), reached from the foot of Adjust balances and holding the two
    // read-only records that used to be tabs. Leave Adjustments owns it so the row stays lit on it — and
    // on the two `records/*` redirect stubs on the way through, which `isNavRowActive` prefix-matches.
    // Entitlements owns NO records path any more: the Configuration record lights Leave Adjustments now.
    //
    // 5ca446db (r269) — the loop runs over LEAVE_CONFIG_MAP, so the sixth row (Employee Leave Inquiry) is
    // skipped by construction: it has no map group, deliberately, because its destination is not a Leave
    // Config screen. It is NOT left unpinned — `MAPLESS_ROWS` names it and its owned path here, so the row
    // is still held to an exact set and a future map group for it would fail the "every row is a group"
    // half in test/r266-leave-config-rows.test.ts.
    //
    // r279 (3fbf7a02) — MAPLESS_ROWS DID NOT GROW. Leave Balance Health is a Leave Config page, so it
    // took a map group of its own (of one item, drawing no tab row) and is covered by the loop above
    // instead: its group has no tabs and its row owns no sub-screen, so the loop asserts an empty
    // `ownedSubpaths` for it — which is the right answer and is derived, not written down here.
    const SUB_SCREENS: Record<string, string[]> = { leaveAdjustments: [LEAVE_CONFIG_RECORDS_HREF] };
    const MAPLESS_ROWS: Record<string, string[]> = { employeeLeaveInquiry: ['/leave/employee-records'] };
    for (const group of LEAVE_CONFIG_MAP) {
      const row = NODE.children.find((c) => c.labelKey === group.navKey)!;
      expect(row, `${group.navKey} has no fly-out row`).toBeTruthy();
      const tabs = group.items.slice(1).map((i) => i.href);
      expect(row.ownedSubpaths ?? [], `${group.navKey} ownedSubpaths must be exactly its other tabs (plus its named sub-screen)`).toEqual([
        ...tabs,
        ...(SUB_SCREENS[group.navKey] ?? []),
      ]);
    }
    const mapped = new Set(LEAVE_CONFIG_MAP.map((g) => g.navKey as string));
    for (const row of NODE.children.filter((c) => !mapped.has(c.labelKey))) {
      expect(MAPLESS_ROWS[row.labelKey], `${row.labelKey} is on no map group and is unpinned here`).toBeTruthy();
      expect(row.ownedSubpaths ?? [], `${row.labelKey} ownedSubpaths`).toEqual(MAPLESS_ROWS[row.labelKey]);
    }
    expect(Object.keys(MAPLESS_ROWS)).toEqual(NODE.children.filter((c) => !mapped.has(c.labelKey)).map((c) => c.labelKey));
    expect(NODE.children.find((c) => c.labelKey === 'leaveEntitlements')!.ownedSubpaths).not.toContain('/admin/leave-config/records/entitlement');
    // Non-vacuity: two rows own two tabs each and the Leave Inquiry row owns the rail's other admin tab
    // (2 → 3 at r269), and the sidebar consults them all (components/sidebar.tsx).
    // 3fb1a611 (r299) — 3 → 4: Leave Credit owns its Rules tab.
    expect(NODE.children.filter((c) => (c.ownedSubpaths ?? []).length > 0)).toHaveLength(4);
    const sidebar = read('components/sidebar.tsx');
    expect(sidebar).toContain('const childPaths = (c: { href: string; ownedSubpaths?: string[] }) => [c.href, ...(c.ownedSubpaths ?? [])];');
    expect(sidebar).toContain('isParentActive(pathname, children.flatMap(childPaths))');
    expect(sidebar).toContain('.filter((c) => isRowActive(c))');
  });

  it('the Summary row is gone and the leave TYPE screen is first', () => {
    expect(NODE.children.map((c) => c.href)).not.toContain('/admin/leave');
    expect(NODE.children[0].href).toBe('/admin/leave-config/types');
    expect(read('packs/leave/index.ts')).not.toContain("labelKey: 'leaveSummary'");
  });

  it('/admin/leave survives as an UNGUARDED redirect stub — bookmarks land, the grid stays honest', () => {
    const stub = read('app/admin/leave/page.tsx');
    expect(stub, 'the route file must still exist').toContain('redirect(');
    // a6fe37fc Round 5 — repointed at the leave TYPE screen's new address IN THE SAME COMMIT that made
    // `/admin/leave/entitlements` a stub of its own. A stub whose destination is another stub still
    // delivers the bookmark, but through a hop that need not happen and one edit away from a loop.
    expect(stub).toContain('/admin/leave-config/types');
    // A stub is not a guarded page. If it ever calls one of these, test/function-access.test.ts's
    // reverse-completeness check fails — because the route is (correctly) no longer registered.
    expect(stub).not.toMatch(/requireAdmin|scopedAdmin|scopedSession|requirePayrollAccess/);
    const permissions = read('lib/permissions.ts');
    expect(permissions).not.toContain("'/admin/leave',");
    // The screen column survives, re-pointed at the page a reader can actually open.
    expect(permissions).toContain("href: '/admin/leave-config/types'");
  });

  it('/admin/leave/entitlements survives as an UNGUARDED redirect stub to the new leave TYPE screen', () => {
    // a6fe37fc Round 5 — the most-bookmarked address in the area, so this stub matters more than the
    // others and is asserted the same way.
    const stub = read('app/admin/leave/entitlements/page.tsx');
    expect(stub).toContain('redirect(');
    expect(stub).toContain('/admin/leave-config/types');
    expect(stub).not.toMatch(/requireAdmin|scopedAdmin|scopedSession|requirePayrollAccess/);
    expect(read('lib/permissions.ts')).not.toContain("'/admin/leave/entitlements',");
    // The 3,367-line panel it mounted is GONE, not moved: the four steps and six sub-steps IA §1.2 names
    // as the subject of the complaint are five tabs on the new screen.
    expect(exists('components/leave-type-panel.tsx'), 'the old panel outlived its page').toBe(false);
  });

  /**
   * f1b994e3 — the Audit row is retired into the ONE central Audit Trail (/admin/audit), which gained an
   * Area filter plus every filter the leave page had. The three things that make that removal safe rather
   * than merely tidy are each pinned here: the route still resolves so no saved link 404s and it lands
   * with Leave already chosen; the stub carries NO page guard, which is what lets `/admin/leave/audit`
   * leave lib/permissions.ts without test/function-access.test.ts reddening in either direction; and the
   * label key retires WITH the row instead of lingering as an orphan.
   */
  it('/admin/leave/replacement survives as an UNGUARDED redirect stub to Leave Credit’s Rules tab', () => {
    // a6fe37fc Round 5. Same contract as the two stubs above: the bookmark lands, the stub carries no
    // page guard, and the route left lib/permissions.ts in the same commit.
    // 3fb1a611 (r299) — UPDATED, NOT LOOSENED: the replacement-leave policy left Company rules for Leave Config ›
    // Leave Credit's Rules tab, so the stub now lands there in one hop (a stub aimed at a page that no longer
    // holds the setting would deliver the bookmark to nothing).
    const stub = read('app/admin/leave/replacement/page.tsx');
    expect(stub).toContain('redirect(');
    expect(stub).toContain("redirect(`/admin/leave-config/leave-credit/rules${qs ? `?${qs}` : ''}`)");
    expect(stub).not.toContain("redirect(`/admin/leave-config/company-rules");
    expect(/requireAdmin|scopedAdmin|scopedSession/.test(stub)).toBe(false);
    expect(read('lib/permissions.ts')).not.toContain("'/admin/leave/replacement',");
    // `nav.leaveCompanyRules` is the row's own key, in all six catalogues, with real translations.
    for (const loc of LOCALES) {
      const nav = JSON.parse(read(`messages/${loc}.json`)).nav as Record<string, string>;
      expect(nav.leaveCompanyRules, `${loc}: the Company rules row needs its own label`).toBeTruthy();
    }
  });

  it('/admin/leave/payroll survives as an UNGUARDED redirect stub, and nav.leavePayroll is pruned', () => {
    // a6fe37fc Round 5, the last of the ten. Same contract as every other stub: the bookmark lands, the
    // stub carries no page guard, the route left lib/permissions.ts in the same commit, and the label key
    // retires WITH the row rather than lingering as an untranslatable orphan.
    const stub = read('app/admin/leave/payroll/page.tsx');
    expect(stub).toContain('redirect(');
    expect(stub).toContain('/admin/leave-config/company-rules');
    expect(stub).not.toMatch(/requireAdmin|scopedAdmin|scopedSession|requirePayrollAccess/);
    expect(read('lib/permissions.ts')).not.toContain("'/admin/leave/payroll',");
    for (const loc of LOCALES) {
      const nav = JSON.parse(read(`messages/${loc}.json`)).nav as Record<string, string>;
      expect(nav.leavePayroll, `${loc}: nav.leavePayroll should be retired with the row`).toBeUndefined();
    }
  });

  it('the Audit row is gone, Company rules closes the ORIGINAL config rows, and the rows added since sit where they were asked for', () => {
    expect(NODE.children.map((c) => c.href)).not.toContain('/admin/leave/audit');
    // a6fe37fc Round 5 — the row that ABSORBED Replacement leave closes the five CONFIGURE rows. The
    // position the reporter's team reads is unchanged; only what sits in it moved.
    //
    // 5ca446db (r269) — UPDATED, NOT LOOSENED. "Company rules is last" was the assertion; it is now "last
    // of the five configuration rows", because the reporter asked for the inquiry row to sit at the BOTTOM,
    // after Company rules ("Add a sixth row to the Leave Config menu, at the bottom, after Company rules").
    // Both halves are pinned so neither the fifth position nor the sixth can drift.
    // r281 (a73d1e14) — UPDATED, NOT LOOSENED, and the two promises are separated rather than blurred.
    // "Company rules closes the config rows" and "the inquiry row is last" were both spellings of
    // POSITIONS, and this round adds a row BELOW the inquiry row because that is where the reporter drew
    // it (Special Setting, holding Half Day Deduction). What each round actually promised is a NEIGHBOUR
    // relationship, so each is pinned as a neighbour pair: Company rules immediately before the inquiry
    // row, and the inquiry row immediately before the row r281 added. A row inserted anywhere between
    // them still fails, and a row appended below Special Setting must name itself here — the same
    // discipline the ADDED_SINCE list above applies.
    expect(NODE.children.map((c) => c.labelKey).slice(-3)).toEqual([
      'leaveCompanyRules',
      'employeeLeaveInquiry',
      'leaveSpecialSetting',
    ]);
    expect(NODE.children.at(-1)!.href).toBe('/admin/leave-config/special-setting');
    // Company rules is still the last of the rows the a6fe37fc cutover left, which is what that round
    // promised: the only config row below it is the one r281 named above.
    const CONFIG_ROWS = NODE.children.filter((c) => c.href.startsWith('/admin/leave-config/'));
    expect(CONFIG_ROWS.at(-2)!.href).toBe('/admin/leave-config/company-rules');
    expect(read('packs/leave/index.ts')).not.toContain("labelKey: 'leaveAudit'");
  });

  it('/admin/leave/audit survives as an UNGUARDED redirect stub to the central Audit Trail', () => {
    const stub = read('app/admin/leave/audit/page.tsx');
    expect(stub, 'the route file must still exist').toContain('redirect(');
    // The destination is the one audit page, with the Leave area already chosen — a bookmark opens the
    // same view it always did, not an unfiltered firehose.
    expect(stub).toContain('/admin/audit');
    expect(stub).toContain("usp.set('module', 'leave')");
    expect(stub).not.toMatch(/requireAdmin|scopedAdmin|scopedSession|requirePayrollAccess/);
    // A stub is not a guarded page, so the route MUST have left the permission grid in the same change.
    const permissions = read('lib/permissions.ts');
    expect(permissions).not.toContain("'/admin/leave/audit',");
    // The export route retires the same way, so an old download link still returns a file.
    const exportStub = read('app/admin/leave/audit/export/route.ts');
    expect(exportStub).toContain('redirect(');
    expect(exportStub).toContain('/admin/audit/export');
    expect(exportStub).toContain("out.set('module', 'leave')");
  });

  it('nav.leaveAudit is pruned in all six catalogues — no orphan label', () => {
    // Grepped first, the r137 way: `nav.leaveAudit` had exactly ONE reader, the row deleted above, and
    // no computed `nav.${x}` form can reach it now that no descriptor names it.
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`));
      expect(dict.nav.leaveAudit, `${loc}: nav.leaveAudit must be pruned`).toBeUndefined();
    }
  });

  /**
   * This assertion ABSORBS test/leave-summary-tab-rename.test.ts, which df00b85f deleted. That file
   * guarded the "Leave Types" → "Summary" rename of this row's label in six locales; the row is gone, so
   * the rename has no subject, and the only thing left worth pinning about that key is that it went away
   * cleanly. It lives here because this file owns the menu.
   */
  it("nav.leaveSummary is pruned in all six catalogues, and people.detail.leaveSummary is NOT", () => {
    // r137 deleted three shared labels by prefix and broke a surviving consumer. The key removed here was
    // grepped first: `nav.leaveSummary` had exactly ONE reader, the row above. The identically-named key
    // under people.detail is a DIFFERENT label (the personnel profile's leave summary card) and must live.
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`));
      expect(dict.nav.leaveSummary, `${loc}: nav.leaveSummary must be pruned`).toBeUndefined();
      expect(dict.people.detail.leaveSummary, `${loc}: people.detail.leaveSummary must survive`).toBeTruthy();
    }
  });

  it('the tab strip is gone and nothing still renders it — one way in, not two', () => {
    expect(exists('components/leave-tabs.tsx'), 'components/leave-tabs.tsx must be deleted').toBe(false);
    // Any surviving import would be a build error, but a surviving RENDER in a comment or a stale
    // string would mislead the next author, so scan the leave admin surface for the symbol at all.
    const dir = path.join(ROOT, 'app', 'admin', 'leave');
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(d, e.name);
        return e.isDirectory() ? walk(full) : /\.tsx?$/.test(e.name) ? [full] : [];
      });
    for (const file of walk(dir)) {
      expect(fs.readFileSync(file, 'utf8'), `${path.relative(ROOT, file)} still names LeaveTabs`).not.toContain('LeaveTabs');
    }
  });

  it('the sidebar mounts it as a collapsible node, in its unchanged Admin-group position', () => {
    const sidebar = stripComments(read('components/sidebar.tsx'));
    expect(sidebar).toContain('LEAVE_CONFIG_NODE');
    expect(sidebar, 'the old flat row must be gone, not merely unused').not.toContain('LEAVE_CONFIG_ROW');
    // a324a4b3 rev3 put Attendance literally between Leave config and Claims config on the reporter's
    // instruction. Assert the order survives the conversion rather than trusting it did.
    const order = ['SYSTEM_SETTINGS_NODE', 'LEAVE_CONFIG_NODE', 'ATTENDANCE_NODE', 'CLAIMS_CONFIG_ROW', 'PAYROLL_NODE'];
    const positions = order.map((k) => sidebar.lastIndexOf(k));
    expect(positions.every((p) => p > 0), 'every admin-group anchor must still be mounted').toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('every child label resolves in all six catalogs, and admin.leaveTabs is retired', () => {
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`));
      for (const child of NODE.children) {
        const label = dict.nav?.[child.labelKey];
        expect(typeof label, `${loc}: nav.${child.labelKey}`).toBe('string');
        expect(String(label).trim().length, `${loc}: nav.${child.labelKey} is empty`).toBeGreaterThan(0);
      }
      // The labels MOVED; a leftover admin.leaveTabs would be a second copy free to drift.
      expect(dict.admin?.leaveTabs, `${loc}: admin.leaveTabs must be gone, not duplicated`).toBeUndefined();
    }
  });

  it('the menu does NOT hijack nav.leaveApproval, which labels a different screen', () => {
    // nav.leaveApproval is read by lib/permissions.ts for the separate `leaveApproval` SCREEN. Pointing
    // this menu child at it renames that screen silently — the exact bug the render check caught here.
    const permissions = read('lib/permissions.ts');
    expect(permissions).toContain("labelKey: 'nav.leaveApproval'");
    for (const loc of LOCALES) {
      const nav = JSON.parse(read(`messages/${loc}.json`)).nav;
      expect(nav.leaveApproval, `${loc}: the screen label must survive`).toBeTruthy();
      expect(nav.leaveApprovalWorkflow, `${loc}: the menu label must be its own key`).toBeTruthy();
      expect(nav.leaveApproval, `${loc}: the two must stay distinct`).not.toBe(nav.leaveApprovalWorkflow);
    }
  });

  it('the leave pack keeps its self-service row, which is not part of this move', () => {
    // /leave is the employee's own My Absence home. Folding it into the admin node would put a
    // self-service page behind the Administration group's adminOnly gate.
    const main = leavePack.navNodes!.filter((l) => l.group === 'main');
    expect(main).toHaveLength(1);
    expect(main[0].defaultHref).toBe('/leave');
    expect(main[0].children.map((l) => l.href)).toEqual(['/leave', '/leave/history']);
    expect(main[0].children.every((l) => l.exactHref)).toBe(true);
    expect(leavePack.navLinks!.some((l) => l.group === 'admin'), 'the flat admin row is replaced by the node').toBe(false);
  });
});
