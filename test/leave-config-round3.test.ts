/**
 * a6fe37fc ROUND 3 — the rest of the new Leave Configuration module, seven pages under
 * `/admin/leave-config`, every one of them built ALONGSIDE the screen it will replace and replacing
 * nothing yet (docs/design/a6fe37fc-migration-order.md → Round 3).
 *
 * ⚠️ WHAT THIS FILE IS FOR, IN ONE LINE: a rebuild's failure mode is silently dropping a function, and
 * every single thing that could drop one here passes `tsc`, `next build`, a 200 and the rest of the
 * suite. So this is a static source guard — the repo convention for this feature area (the same shape as
 * test/leave-config-types-tabs.test.ts, which Round 2 wrote for the same reason).
 *
 * THE FOUR PROPERTIES IT PINS:
 *
 *   1. **Every function of the six unchanged screens is carried, and the ANTI-DROP TABLE IS KEYED TO IA
 *      §3 — which was wrong again.** r258 found §3.1 two functions short (F47/F48) and wrote the lesson
 *      down: *a table-keyed guard is only as complete as its table.* This round re-read the six OLD pages
 *      against §3.2 rather than trusting it, and found the same defect twice more — the eligibility
 *      EXPLAIN panel on Entitlement tables (r212 `8ebf77ae`) and the generation-run LOG with its per-run
 *      CSV on Generate entitlement (`93249794`). Neither was in the table; both are whole Cards. They are
 *      now F49 and F50 in §3.2 and they are pinned below by name.
 *
 *   2. **A flow that is not changing is MOUNTED, never re-implemented** (IA §2.3 — one component, several
 *      mount points). A second copy of the adjustment flow or the importer is the exact defect this item
 *      exists to remove, and it is the cheapest mistake to make in a round whose brief is "add pages".
 *
 *   3. **Company rules — the one genuinely new screen — cannot silently write a default over a stored
 *      setting.** Its four editors post ABSOLUTE-SET forms: `setToilPolicy` reads
 *      `fd.get('expiryDays') ?? 90`, `fd.get('enabled') === 'on'`, and so on. There is no tri-state marker
 *      to omit and therefore no marker to protect them — a field dropped from one of these forms does not
 *      fail to save, it saves the DEFAULT over whatever the company had. Round 2 learned that one level
 *      down and this file starts there: for each action, every field its branch READS, checked against the
 *      FORM THAT CARRIES IT, and every entry checked back against app/admin/actions.ts so the table cannot
 *      go stale under the assertion.
 *
 *   4. **The permission column and the page land together, and the MENU does not move.** A guarded
 *      page.tsx absent from `lib/permissions.ts` is a route nobody can grant or revoke
 *      (test/function-access.test.ts fails both ways); a new route ON the map before Round 5 would put two
 *      entries for one job in front of the administrator.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAVE_CONFIG_MAP, LEAVE_CONFIG_RECORD_LABEL_ID, leaveConfigScreenHref } from '../components/leave-config-map';
// 7f69bd71 — `LEAVE_CONFIG_RECORDS_HREF` is asserted by NAME in the adjustments page source below, not
// imported: the case pins that the page resolves the address through the map's constant.
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The seven pages this round adds: key → { file, route, the map id it renders as `current` }. */
const SCREENS_BUILT = {
  companyRules: {
    file: 'app/admin/leave-config/company-rules/page.tsx',
    route: '/admin/leave-config/company-rules',
    mapId: 'companyRules',
  },
  entitlementTables: {
    file: 'app/admin/leave-config/entitlement-tables/page.tsx',
    route: '/admin/leave-config/entitlement-tables',
    mapId: 'entitlementTables',
  },
  generate: {
    file: 'app/admin/leave-config/generate/page.tsx',
    route: '/admin/leave-config/generate',
    mapId: 'generateEntitlement',
  },
  adjustments: {
    file: 'app/admin/leave-config/adjustments/page.tsx',
    route: '/admin/leave-config/adjustments',
    mapId: 'adjustments',
  },
  import: {
    file: 'app/admin/leave-config/import/page.tsx',
    route: '/admin/leave-config/import',
    mapId: 'importLeaveData',
  },
  // 7f69bd71 — the two records are SUB-TABS of the Reset records sub-screen now, each a server component
  // mounted by ONE guarded page (`RECORDS_PAGE`). `file` is the component that carries the function
  // (F45 / F46), `route` is the sub-screen's; the component has no map mount and no guard of its own —
  // the page it is mounted on has both jobs, and the cases below read it there.
  recordsEntitlement: {
    file: 'components/leave/reset-record-configuration.tsx',
    route: '/admin/leave-config/records',
    mapId: 'entitlementArchive',
  },
  recordsBalances: {
    file: 'components/leave/reset-record-balances.tsx',
    route: '/admin/leave-config/records',
    mapId: 'ledgerArchive',
  },
  // r281 (a73d1e14) — SPECIAL SETTING, the eighth. Not a Round 3 screen, but the half-day card this file
  // guards moved onto it, and the assertions follow the EDITOR rather than the address (the same rule the
  // cutover table below already applies). Registering it here also holds it to this file's own
  // per-screen rules: a declared route, a map mount with its own id, and no server action of its own.
  specialSetting: {
    file: 'app/admin/leave-config/special-setting/page.tsx',
    route: '/admin/leave-config/special-setting',
    mapId: 'specialSetting',
  },
  // r281 (cdd7500b) — THE LEAVE TYPE SCREEN, the ninth, and for the same reason as the eighth: the shared
  // leave groups this file guards moved onto it (at PAGE level, above the per-type workspace — see the
  // comment at the mount for why that distinction is the whole item), so the assertions follow the editor.
  leaveTypesScreen: {
    file: 'app/admin/leave-config/types/page.tsx',
    route: '/admin/leave-config/types',
    mapId: 'leaveTypes',
  },
} as const;

type ScreenKey = keyof typeof SCREENS_BUILT;
const KEYS = Object.keys(SCREENS_BUILT) as ScreenKey[];
const src = Object.fromEntries(KEYS.map((k) => [k, read(SCREENS_BUILT[k].file)])) as Record<ScreenKey, string>;
/** 7f69bd71 — the sub-screen page that guards and mounts the two record components. */
const RECORDS_PAGE = 'app/admin/leave-config/records/page.tsx';
const RECORD_KEYS = ['recordsEntitlement', 'recordsBalances'] as const;
const isRecord = (k: ScreenKey): k is (typeof RECORD_KEYS)[number] => (RECORD_KEYS as readonly string[]).includes(k);

/**
 * a6fe37fc ROUND 5 (cutover) — THE ONE TABLE THIS FILE NOW TURNS ON, AND THE REASON IT IS A TABLE.
 *
 * Round 3 built seven screens ALONGSIDE the ones they replace and this file pinned that nothing moved.
 * Round 5 is the opposite act and it is deliberately **one commit per screen, ten times** (migration
 * order → Round 5): the map entry, the inbound links, the permission route, the private title key and
 * the emptying of the old page all land together for ONE screen, and the replay runs either side of it.
 *
 * So the round-3 assertions are not deleted — they are re-pointed at a switch. `cutOver: false` still
 * asserts exactly what Round 3 asserted (old screen live, on the menu, registered, new screen carrying
 * the preview note); `cutOver: true` asserts the cutover actually happened for that screen and happened
 * WHOLE — the old page is a redirect stub aimed at `to`, its route has left lib/permissions.ts, the map
 * names the new address, and the preview note is gone because the screen is no longer a preview.
 *
 * Flipping one line is the whole diff of a cutover commit here, which is what makes a half-done cutover
 * (menu moved, route still registered) fail rather than pass quietly.
 */
const CUTOVER: Record<string, { to: string; cutOver: boolean }> = {
  leaveTypes: { to: '/admin/leave-config/types', cutOver: true },
  templates: { to: '/admin/leave-config/entitlement-tables', cutOver: true },
  payroll: { to: '/admin/leave-config/company-rules', cutOver: true },
  replacement: { to: '/admin/leave-config/company-rules', cutOver: true },
  generate: { to: '/admin/leave-config/generate', cutOver: true },
  adjustments: { to: '/admin/leave-config/adjustments', cutOver: true },
  import: { to: '/admin/leave-config/import', cutOver: true },
  // 7f69bd71 — repointed ONE HOP: the two records moved again, to the sub-tabs of the Reset records
  // sub-screen, and these older stubs aim straight at it (`record` first, then the forwarded query)
  // rather than at the stubs `records/entitlement` and `records/balances` became.
  archive: { to: '/admin/leave-config/records', cutOver: true },
  ledgerArchive: { to: '/admin/leave-config/records', cutOver: true },
};
/** 7f69bd71 — the sub-tab each older record stub names, and the reason the sub-screen is off the menu. */
const RECORD_OF: Record<string, 'configuration' | 'balances'> = { archive: 'configuration', ledgerArchive: 'balances' };
const OFF_MENU_SUB_SCREEN = '/admin/leave-config/records';

/** The old address each of those screens answers on, so a stub can be checked against its own route. */
const OLD_ROUTE: Record<string, string> = {
  leaveTypes: '/admin/leave/entitlements',
  templates: '/admin/leave/entitlements/templates',
  payroll: '/admin/leave/payroll',
  replacement: '/admin/leave/replacement',
  generate: '/admin/leave/generate',
  adjustments: '/admin/leave/adjustments',
  import: '/admin/leave/import',
  archive: '/admin/leave/entitlements/archive',
  ledgerArchive: '/admin/leave/entitlements/ledger-archive',
};

/** The old screens. Read, never written. */
const OLD = {
  leaveTypes: read('app/admin/leave/entitlements/page.tsx'),
  templates: read('app/admin/leave/entitlements/templates/page.tsx'),
  payroll: read('app/admin/leave/payroll/page.tsx'),
  replacement: read('app/admin/leave/replacement/page.tsx'),
  generate: read('app/admin/leave/generate/page.tsx'),
  adjustments: read('app/admin/leave/adjustments/page.tsx'),
  import: read('app/admin/leave/import/page.tsx'),
  archive: read('app/admin/leave/entitlements/archive/page.tsx'),
  ledgerArchive: read('app/admin/leave/entitlements/ledger-archive/page.tsx'),
};

const actionsSrc = read('app/admin/actions.ts');

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 4. The permission column, and the menu that does not move yet
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R3 · the seven routes are registered, and the menu stays where it is', () => {
  it.each(KEYS)('%s is a declared route, so it can be granted and revoked like any screen', (k) => {
    expect(
      REGISTERED_ROUTES.has(SCREENS_BUILT[k].route),
      `${SCREENS_BUILT[k].route} is a guarded page with no screen column — test/function-access.test.ts's ` +
        `reverse-completeness case fails on exactly this, and the route becomes one nobody can grant or revoke`,
    ).toBe(true);
  });

  it('all seven hang off the EXISTING leaveConfig screen key — a key rename would drop every stored grant', () => {
    // lib/permissions.ts records that a screen key "may key stored role configs". Renaming `leaveConfig`
    // would silently drop every tenant's existing grant for the whole area, which is why the migration
    // order says only `href` and `routes` ever move — and Round 5 moves them, one screen per commit.
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    expect(leaveConfig.guard).toBe('requireAdmin');
    expect(leaveConfig.screenKey).toBe('leaveConfig');
    for (const k of KEYS) expect(leaveConfig.routes).toContain(SCREENS_BUILT[k].route);
    // The canonical href follows the leave TYPE screen, and moves in that screen's own commit.
    expect(leaveConfig.href).toBe(CUTOVER.leaveTypes.cutOver ? '/admin/leave-config/types' : '/admin/leave/entitlements');
  });

  it('a cut-over screen has LEFT the route registry, in the same commit that emptied its page', () => {
    // The direction test/function-access.test.ts bites on here is "no stale routes": a registered route
    // whose page no longer calls a guard. A stub is not a screen the access grid can describe, so the
    // route and the page move together or neither does — the /admin/leave (df00b85f) precedent.
    for (const [name, { cutOver }] of Object.entries(CUTOVER)) {
      const route = OLD_ROUTE[name];
      if (cutOver) {
        expect(
          REGISTERED_ROUTES.has(route),
          `${route} is a redirect stub now and must have left lib/permissions.ts in the SAME commit`,
        ).toBe(false);
      } else {
        expect(REGISTERED_ROUTES.has(route), `${route} is still a full screen and must stay registered`).toBe(
          true,
        );
      }
    }
  });

  it.each(KEYS)('%s calls the page guard the registry describes', (k) => {
    // function-access.test.ts finds a page by grepping for the guard call; a page that reaches the
    // registry without one fails the no-stale-routes direction instead.
    // 7f69bd71 — a record COMPONENT carries no guard: the sub-screen page that mounts it does, once.
    expect(isRecord(k) ? read(RECORDS_PAGE) : src[k]).toContain('requireAdmin()');
    if (isRecord(k)) expect(src[k]).not.toContain('requireAdmin()');
  });

  it('the menu names the cut-over screens at their NEW address and the rest at their old one', () => {
    // ROUND 3 asserted "none of the seven is on the map — the menu moves at the Round 5 cutover, not
    // now". Round 5 IS that cutover, and it moves ONE entry per commit, so the assertion becomes a
    // read of the CUTOVER table rather than a blanket absence. Both directions still fail loudly: a
    // menu entry that moved before its page was emptied, and a page emptied while the menu still points
    // at the stub (two hops to reach a screen, and the map lying about where it is).
    // 7f69bd71 — ONE destination is deliberately OFF the menu: the Reset records sub-screen, reached
    // from the foot of Adjust balances. A menu entry for it would put the records back where the
    // reporter said they did not belong; the link is what makes it reachable, so the link is asserted.
    const hrefs = LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => i.href);
    expect(hrefs).not.toContain(OFF_MENU_SUB_SCREEN);
    expect(src.adjustments).toContain('<Link href={LEAVE_CONFIG_RECORDS_HREF}');
    for (const [name, { to, cutOver }] of Object.entries(CUTOVER)) {
      if (cutOver) {
        if (to !== OFF_MENU_SUB_SCREEN) expect(hrefs, `${name} is cut over, so the menu must name ${to}`).toContain(to);
        expect(hrefs, `${name} is cut over, so ${OLD_ROUTE[name]} must be off the menu`).not.toContain(
          OLD_ROUTE[name],
        );
      } else {
        expect(hrefs, `${name} is not cut over yet, so the menu still names ${OLD_ROUTE[name]}`).toContain(
          OLD_ROUTE[name],
        );
      }
    }
  });

  it('Company rules joined the map as ONE line, and the ids it absorbed left it', () => {
    // ROUND 3: "Company rules is a screen id with NO map entry, which is what makes Round 5 a one-line
    // change." This IS that change, so the case is inverted rather than dropped — and the inversion is
    // what proves the early id was worth carrying: an addition, not a rename of a screen the customer had
    // already learned. The heading still comes from the same key the menu entry uses.
    const ids = LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => i.id as string);
    expect(ids).toContain('companyRules');
    // 10b59703 (r266) — the heading comes from the submenu ROW's key now (`leaveConfigPageHeader`),
    // not the map item's; the two absorbed ids below still render as SECTION headings through the item
    // key. Updated rather than loosened: the property is still "one string, one source".
    expect(src.companyRules).toContain("leaveConfigPageHeader('companyRules')");
    // `replacementLeave` and `payrollImpact` are the ids with no map entry now: their screens were
    // ABSORBED into this one, and two entries reaching one screen is what this component exists to stop.
    // The ids themselves survive — Company rules renders them as its section headings.
    if (CUTOVER.replacement.cutOver) expect(ids).not.toContain('replacementLeave');
    if (CUTOVER.payroll.cutOver) expect(ids).not.toContain('payrollImpact');
    expect(src.companyRules).toContain("leaveConfigScreenTitle('replacementLeave')");
    // …and `payrollImpact`, the OTHER id whose screen this one absorbed. Both outlived their map entries
    // so the administrator finds the words they knew each setting by.
    expect(src.companyRules).toContain("leaveConfigScreenTitle('payrollImpact')");
  });

  it.each(KEYS)('%s renders the area map, so a new screen can reach its siblings', (k) => {
    // Without it a leave-config screen can reach no other leave-config screen at all — a worse map than
    // the old screens have, which is the r258 finding on Round 2's first draft.
    // 7f69bd71 — the two records are sub-tabs of a SUB-SCREEN, not tabs of a row: no map mount on the
    // component and none on the page that mounts it. The page reaches the module through its back link
    // to Leave Adjustments instead, and the record id survives only as the sub-tab's label.
    if (isRecord(k)) {
      const page = read(RECORDS_PAGE);
      expect(src[k]).not.toContain('<LeaveConfigMap');
      expect(page).not.toContain('<LeaveConfigMap');
      expect(page).toContain("back={{ href: leaveConfigScreenHref('adjustments'), label: tNav('leaveAdjustments') }}");
      // The id labels its sub-tab: the page reads the label through the map's record → id table.
      expect(page).toContain('LEAVE_CONFIG_RECORD_LABEL_ID[id]');
      expect(Object.values(LEAVE_CONFIG_RECORD_LABEL_ID)).toContain(SCREENS_BUILT[k].mapId);
      return;
    }
    expect(src[k]).toContain(`<LeaveConfigMap current="${SCREENS_BUILT[k].mapId}" />`);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Mounted, never re-implemented
// ────────────────────────────────────────────────────────────────────────────────────────────────────

/** IA §3 function → the new page that must carry it, and the mount that proves it is not a copy. */
const MOUNTS: [string, ScreenKey, string][] = [
  ['F33 entitlement tables, unfiltered', 'entitlementTables', '<EntitlementTablesBlock data={data}'],
  ['F49 employee eligibility explain panel (r212)', 'entitlementTables', '<EligibilityExplainPanel s={s} data={data}'],
  ['F41 the five-step generate wizard', 'generate', '<GenerateForm'],
  ['F42 the four-step adjustment flow', 'adjustments', '<AdjustmentForm'],
  ['F44 the ledger importer', 'import', '<LeaveLedgerImport />'],
  // r281 (a73d1e14) — the half-day card is on the Special Setting row now; the mount follows the editor.
  ['F4/F26 the half-day company picker', 'specialSetting', '<HalfDayCompanyPicker'],
  // r281 (cdd7500b) — the shared groups are on the leave TYPE screen now, at page level; mount follows.
  ['F3 the shared leave group manager', 'leaveTypesScreen', '<LeaveSharedGroupConfig'],
  ['F38 the replacement eligibility picker', 'companyRules', '<ReplacementEligibilityPicker'],
];

/**
 * r281 — WHERE EACH OF THE FOUR COMPANY/TENANT SETTINGS IS EDITED TODAY, one screen each.
 *
 * Round 3 gathered all four onto Company rules and this file asserted them there. The reporter has since
 * asked for some of them to move again — the half-day card to a "Special Setting" row of its own — so the
 * table says which file carries which editor, and the property this file has always guarded (exactly ONE
 * screen answers for each setting) is asserted against the current answer rather than against an address
 * that has stopped being true.
 */
const POSTED_FROM: Record<string, string> = {
  setLeaveHalfDayFullDeductionCompaniesAction: 'app/admin/leave-config/special-setting/page.tsx',
  setLeaveEncashmentPolicyAction: 'app/admin/leave-config/company-rules/page.tsx',
  setToilPolicyAction: 'app/admin/leave-config/company-rules/page.tsx',
  createLeaveSharedGroupAction: 'app/admin/leave-config/types/page.tsx',
  updateLeaveSharedGroupAction: 'app/admin/leave-config/types/page.tsx',
  deleteLeaveSharedGroupAction: 'app/admin/leave-config/types/page.tsx',
};

describe('a6fe37fc R3 · a flow that is not changing is MOUNTED, not re-implemented (IA §2.3)', () => {
  it.each(MOUNTS)('%s is mounted on the new page', (_fn, key, mount) => {
    expect(src[key]).toContain(mount);
  });

  it('the shared criteria BUILDER is called, so Generate and Adjustments cannot offer different axes', () => {
    // 93249794 extracted `buildOrgCriteriaSections` precisely so two screens asking the identical
    // question could not drift. A page that built its own section list would be that drift.
    for (const k of ['generate', 'adjustments'] as const) {
      expect(src[k]).toContain('buildOrgCriteriaSections(');
      expect(src[k]).not.toContain('ORG_CRITERIA_FIELDS');
    }
  });

  it('the entitlement-tables page mounts the block UNFILTERED — no leaveTypeId, or it is the tab', () => {
    // The all-types view is the only thing this screen does that a leave type's own tab 3 cannot.
    expect(src.entitlementTables).not.toContain('leaveTypeId={');
  });

  it('no new server action, and no page declares one', () => {
    // Round 2's rule 2, still in force: every save goes through an action that already exists, with its
    // signature unchanged, which is what keeps the OLD screen working while both are live.
    for (const k of KEYS) {
      expect(src[k].includes("'use server'"), `${SCREENS_BUILT[k].file} must not declare server actions`).toBe(
        false,
      );
    }
    // r281 — the four settings are no longer all on one screen (the reporter asked for three of them to
    // move), so each action is checked against the FILE that carries its editor today. The property is
    // unchanged and is Round 2's rule 2: the action already exists, its signature is untouched, and the
    // page that posts it declares none of its own.
    for (const [action, file] of Object.entries(POSTED_FROM)) {
      expect(actionsSrc).toContain(`export async function ${action}(`);
      expect(read(file), `${action} is not posted from ${file}`).toContain(action);
    }
  });

  it('none of the seven imports the panel Round 5 deletes', () => {
    // An IMPORT, not a mention: the doc comments name that file deliberately, and a source scan does not
    // strip comments (the pack-drift ratchet's documented false positive, generalised).
    const imports = (s: string) => [...s.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const k of KEYS) {
      expect(imports(src[k]).filter((p) => p.includes('leave-type-panel'))).toEqual([]);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 1. Anti-drop — keyed to IA §3, including the two rows the table did not have
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R3 · nothing the six unchanged screens do was dropped in the move', () => {
  it('F43 the recent adjustment batches, and reversing one as a UNIT', () => {
    expect(src.adjustments).toContain('reverseLeaveAdjustmentAction');
    expect(src.adjustments).toContain('name="batchId"');
    // TARGETED and WRITTEN shown separately: they differ whenever a frozen encashment snapshot was
    // skipped, and a silent difference is what makes a bulk write untrustworthy.
    expect(src.adjustments).toContain('written: batch.writtenCount');
    expect(src.adjustments).toContain('targeted: batch.targetedCount');
    // …and it still asks first: reversal writes compensating rows and a second attempt is refused.
    expect(src.adjustments).toContain('<ConfirmSubmit');
  });

  it('F50 the generation-run log and its per-run CSV — the row IA §3.2 never had', () => {
    // 93249794's request: "Allow HR to download the processing log". F41 named only the wizard, so a
    // table-keyed guard could not have seen this whole Card go. Now it can.
    expect(src.generate).toContain('listLeaveGenerationRuns(');
    expect(src.generate).toContain("t('generateRunsTitle')");
    // The five stored counts, not recomputed: recomputing would answer a question about last March with
    // this morning's configuration.
    for (const field of ['employeesSelected', 'employeesPassed', 'employeesFailed', 'granted', 'forfeits']) {
      expect(src.generate).toContain(`run.${field}`);
    }
    // A plain link, not a POST a refresh can repeat — and still pointed at the OLD /export handler,
    // which moves with the screen in Round 5 (IA §3.2). Pointing at one that does not exist yet would
    // ship a download button that 404s.
    expect(src.generate).toContain('href={`/admin/leave/generate/export?run=${run.id}`}');
  });

  it('F49 the eligibility explain panel keeps its four addressable GET parameters', () => {
    // r212 made every answer a link on purpose. Dropping a parameter does not break the panel visibly —
    // it silently stops carrying the employee, the type or the date through.
    for (const p of ['explainQ', 'explainEmployment', 'explainLeaveType', 'explainAsOf']) {
      expect(src.entitlementTables).toContain(`${p}?: string`);
    }
    // The whole `sp` is handed on, so a parameter added to the panel later needs no change here.
    expect(src.entitlementTables).toContain('params={sp}');
  });

  it('F45 / F46 the two records keep their capture picker and their CSV', () => {
    for (const k of ['recordsEntitlement', 'recordsBalances'] as const) {
      expect(src[k]).toContain('name="capture"');
      expect(src[k]).toContain("t('downloadCsv')");
      // An unknown ?capture is ignored rather than rendering an empty table for a tag that does not exist.
      // 7f69bd71 — the capture arrives as a prop from the sub-screen page, which reads `sp.capture`.
      expect(src[k]).toContain('captures.find((c) => c.captureTag === capture)?.captureTag');
      expect(read(RECORDS_PAGE)).toContain('capture={sp.capture}');
    }
    // The export handlers stay at their old addresses this round — they move with the screens in Round 5.
    expect(src.recordsEntitlement).toContain('/admin/leave/entitlements/archive/export');
    expect(src.recordsBalances).toContain('/admin/leave/entitlements/ledger-archive/export');
    // F46's two counts: the point of the record is that the number of rows taken away is CHECKABLE.
    expect(src.recordsBalances).toContain("t('counts', { ledger: ledgerCount, audit: auditCount })");
  });

  it('the balance record still offers NO re-capture button, and that absence is the feature', () => {
    // The capture runs once, inside the correction script's transaction, before the rows are deleted. A
    // re-capture offered here could only run AFTER they are gone and would write an empty snapshot over
    // the only copy. A "helpful" button added later is the regression this case exists to catch.
    expect(src.recordsBalances).not.toContain('<form action=');
    expect(src.recordsEntitlement).not.toContain('<form action=');
  });

  it('the encashment tour anchor came across with the setting it is on', () => {
    // lib/module-tours.json can repoint one route string at the cutover only if the anchor is already
    // where the setting went.
    expect(OLD.payroll).toContain('data-tour="leave-encashment"');
    expect(src.companyRules).toContain('data-tour="leave-encashment"');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// 3. Company rules — the absolute-set forms, one level down
// ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A field one action reads: how it appears in the form, and how the action reads it. */
type PostedField = { label: string; inForm: RegExp; inAction: RegExp };

/** `name="x"`, read as `fd.get('x')` / `formData.getAll('x')`. */
const posted = (name: string): PostedField => ({
  label: `name="${name}"`,
  inForm: new RegExp(`name="${name}"`),
  inAction: new RegExp(`\\.get(?:All)?\\('${name}'\\)`),
});

/** The eight replacement-eligibility pickers: ONE descriptor drives the form AND the action's loop. */
const ELIGIBILITY_PICKERS: PostedField = {
  label: 'the REPLACEMENT_ELIGIBILITY_CRITERIA pickers (name={c.key})',
  inForm: /name=\{c\.key\}/,
  inAction: /getAll\(c\.key\)/,
};

/**
 * Server action → the form on Company rules that posts it → every field its body READS.
 *
 * ⚠️ THESE ARE ABSOLUTE-SET FORMS, NOT TRI-STATE ONES, AND THAT IS WHY THIS TABLE EXISTS. `setToilPolicy`
 * reads `fd.get('expiryDays') ?? 90` and `fd.get('enabled') === 'on'`; `setEncashmentPolicy` reads both
 * switches by presence. There is no marker whose absence skips the branch — the branch ALWAYS runs. So a
 * field that is renamed, dropped, or drifts into a neighbouring form does not fail to save: it saves the
 * default (90 days, false, '') over whatever the company had, silently, on the next Save anyone presses.
 */
const ACTION_FIELDS: Record<string, { mountedIn?: string[]; fields: PostedField[] }> = {
  setLeaveHalfDayFullDeductionCompaniesAction: {
    // The one posted field is rendered by the picker, not by the page — `ChipMultiSelect` emits one
    // hidden input per selected value under the name the wrapper passes it.
    mountedIn: ['components/leave/half-day-company-picker.tsx'],
    fields: [posted('companyIds')],
  },
  setLeaveEncashmentPolicyAction: {
    fields: [posted('companyId'), posted('enabled'), posted('autoFreeze')],
  },
  setToilPolicyAction: {
    mountedIn: ['components/replacement-eligibility-picker.tsx'],
    fields: [
      posted('companyId'),
      posted('enabled'),
      posted('accrualBasis'),
      posted('onExpiry'),
      // BOTH counts and the unit, every time: switching the unit and switching back must not lose the
      // other count (migration 0380's two-column note).
      posted('expiryUnit'),
      posted('expiryDays'),
      posted('expiryMonths'),
      posted('replacementLeaveFrom'),
      posted('allowFirstScheduleEligible'),
      posted('autoAccrueOnApproval'),
      posted('carryForwardAtYearEnd'),
      posted('employeeRequestEnabled'),
      ELIGIBILITY_PICKERS,
    ],
  },
};

/**
 * Every `<form>` on the screen that CARRIES the action, with the source of the components it mounts
 * folded in.
 *
 * r281 — it used to read `src.companyRules` unconditionally, because Round 3 gathered all four editors
 * there. Three of them have since been asked to move, so the screen is looked up in POSTED_FROM rather
 * than assumed: the property ("every field the action READS is posted by the form that posts it") is
 * about a form and an action, never about an address.
 */
function scopeFor(action: string, mountedIn: string[] = []): string | null {
  const body = read(POSTED_FROM[action])
    .split('<form')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('</form>')))
    .find((b) => b.includes(`action={${action}}`));
  if (body == null) return null;
  return [body, ...mountedIn.map(read)].join('\n');
}

describe('a6fe37fc R3 · Company rules — every form still posts every field its action READS', () => {
  it.each(Object.entries(ACTION_FIELDS))('the %s form posts every field its body reads', (action, spec) => {
    const scope = scopeFor(action, spec.mountedIn);
    expect(scope, `no form on Company rules posts ${action}`).not.toBeNull();
    for (const field of spec.fields) {
      expect(
        field.inForm.test(scope!),
        `the ${action} form no longer posts ${field.label}, and the action still READS it — this form is ` +
          `absolute-set, so every save through it would write the DEFAULT over whatever is stored`,
      ).toBe(true);
    }
  });

  it('every field in the table is one app/admin/actions.ts actually reads', () => {
    // Kept honest in both directions: a stale row here makes the case above assert a field nothing
    // consumes, which is a guard that has quietly stopped guarding.
    for (const [action, spec] of Object.entries(ACTION_FIELDS)) {
      for (const field of spec.fields) {
        expect(
          field.inAction.test(actionsSrc),
          `${action} · ${field.label} is not read by app/admin/actions.ts — the table has gone stale`,
        ).toBe(true);
      }
    }
  });

  it('the shared-group manager carries its own five fields, so mounting it carries the whole editor', () => {
    // F3's fields live inside the client component both screens mount, which is exactly the property
    // that makes "one component, two mount points" safe. `maxDaysPerApplication` is NOT tri-state: the
    // update action reads it every time, so a form that dropped the input would clear the cap on save.
    const group = read('components/leave-shared-group-config.tsx');
    for (const field of ['name', 'totalLimitDays', 'maxDaysPerApplication', 'essPlacement', 'leaveTypeIds']) {
      expect(group).toContain(`name="${field}"`);
      expect(actionsSrc).toMatch(new RegExp(`\\.get(?:All)?\\('${field}'\\)`));
    }
  });

  it('r281 — each of the four settings has exactly ONE editor, and the screen it is on is named', () => {
    // ROUND 3's version read "the four settings are gathered from FOUR different surfaces — that is what
    // the screen is for", and asserted all four on Company rules. That premise has been overtaken by the
    // reporter: they asked for the half-day card to sit under a "Special Setting" heading of its own, and
    // gathering-for-its-own-sake was never the property worth guarding. THE PROPERTY IS: one setting, one
    // editor, and it is findable — so each is asserted on the file that carries it, and asserted ABSENT
    // from every other Leave Config page, which is the half that catches a move leaving a copy behind.
    const OWNER: Record<string, string> = {
      // F4/F26, from every leave type → Company rules → Special Setting (r281, a73d1e14)
      setLeaveHalfDayFullDeductionCompaniesAction: 'app/admin/leave-config/special-setting/page.tsx',
      // F40, from Payroll impact. Stays on Company rules.
      setLeaveEncashmentPolicyAction: 'app/admin/leave-config/company-rules/page.tsx',
      // F3, from Leave types → Company rules → back to Leave types at PAGE level (r281, cdd7500b). The
      // reporter asked for it under leave types; the reason it left that screen was that it sat INSIDE
      // the per-type workspace, so the mount POINT — not the screen — is what changed on the way back.
      'listLeaveSharedGroups(': 'app/admin/leave-config/types/page.tsx',
      // F38, from Replacement leave. Stays on Company rules.
      setToilPolicyAction: 'app/admin/leave-config/company-rules/page.tsx',
    };
    const modulePages = readdirSync(resolve(here, '..', 'app/admin/leave-config'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `app/admin/leave-config/${e.name}/page.tsx`)
      .filter((f) => existsSync(resolve(here, '..', f)));
    for (const [needle, owner] of Object.entries(OWNER)) {
      expect(read(owner), `${needle} is not on ${owner}`).toContain(needle);
      for (const other of modulePages) {
        if (other === owner) continue;
        expect(read(other).includes(needle), `${needle} is on ${other} as well as ${owner}`).toBe(false);
      }
    }
  });

  it('the replacement section keeps its company filter, and keeps it OUT of the global scope cookie', () => {
    // 20e759a0: nine companies stacked is 180 controls. And `getScopeIds` is GLOBAL — narrowing this page
    // by writing the company_scope cookie would silently re-scope Roster, Payroll and everything else.
    expect(src.companyRules).toContain('resolveCompanyFilter(company, visibleIds)');
    expect(src.companyRules).toContain('<CompanyFilterSelect');
    expect(src.companyRules).toContain("const PAGE = '/admin/leave-config/company-rules'");
    // The eligibility criterion still offers the FULL in-scope list: "who may SUBMIT" is a different
    // question from "which company am I configuring", and narrowing it would drop companies on save.
    expect(src.companyRules).toContain('companyIds: visible.map((c) => ({ id: c.id, name: c.name }))');
  });

  it('the picker template crosses the boundary RAW, or next-intl throws at render', () => {
    // `tr('pickerSelectedCount')` throws FORMATTING_ERROR — the ICU variable is supplied on the client as
    // the selection changes. Caught by render-verify, not by tsc, the build or the suite.
    expect(src.companyRules).toContain("tr.raw('pickerSelectedCount')");
  });

  it('F4/F26 the half-day picker offers the adminOnly WRITE scope, never the page-wide company list', () => {
    // ⚠️ SECURITY-ADJACENT, AND UNTIL r259 PINNED BY NOTHING AT ALL. The verify pass proved the gap at
    // runtime rather than asserting it: swapping `listCompanies(s, { adminOnly: true })` for
    // `listCompanies(s)` on this page passed this file, leave-config-map, leave-pack-drift,
    // server-client-boundary and function-access — 87/87 green — because every one of them checks what
    // the page RENDERS, never which company set it renders it from.
    //
    // The company UPDATE policy is admin-for-company (`app.is_admin_for`, migration 0016's WITH CHECK),
    // so `listCompanies(s)` — what the rest of this page reads, for the filter and for the "who may
    // SUBMIT" criterion — is WIDER than the set the write can reach. Feeding the picker that wider list
    // would let a company-scoped hr_admin tick or untick a company whose row
    // core.setLeaveHalfDayFullDeductionCompanies then silently refuses: the screen and the database
    // disagreeing, with no error and nothing on screen to see. It is also the OLD screen's scope
    // character for character — test/leave-condition-substeps.test.ts pins the same call on
    // /admin/leave/entitlements, and a different scope here would be a different control.
    //
    // Asserted STRUCTURALLY — which name the adminOnly read is bound to, and which list the picker is
    // handed — rather than by a bare `toContain('adminOnly')`: keeping the call while handing the picker
    // `visible` is the same defect with the reassuring string still in the file.
    //
    // r281 (a73d1e14) — RE-POINTED AT THE SCREEN THAT CARRIES THE PICKER, exactly as the Round 3 note
    // above instructed the next mover to do ("re-point this case at wherever `halfDayCompanies` is now
    // bound, never drop it"). The card is the whole of the Special Setting page now, so the read is a
    // single await rather than one slot of a batch; what is asserted is unchanged — which call the name
    // is bound to, and which list the picker is handed.
    const picker = read(POSTED_FROM.setLeaveHalfDayFullDeductionCompaniesAction);
    const binding = /const halfDayCompanies = await (listCompanies\([^;]*?\));/.exec(picker);
    expect(
      binding,
      '`halfDayCompanies` is no longer bound by a single read on the screen that carries the picker — ' +
        're-point this case at wherever it is now bound, never drop it',
    ).not.toBeNull();
    expect(
      binding![1],
      "the half-day picker's company list is no longer the adminOnly scope — a company-scoped hr_admin " +
        'would be offered companies whose row the write can never reach, and the untick would vanish on save',
    ).toBe('listCompanies(s, { adminOnly: true })');

    // …and that narrower list is what the PICKER is handed. Scoped to the form, so a wider list read
    // elsewhere on the page for a different question cannot satisfy it.
    const form = scopeFor('setLeaveHalfDayFullDeductionCompaniesAction');
    expect(form, 'no form posts setLeaveHalfDayFullDeductionCompaniesAction').not.toBeNull();
    expect(form!).toContain('companies={halfDayCompanies.map((c) => ({ value: c.id, label: c.name }))}');
    for (const wider of ['companies', 'visible', 'shown']) {
      expect(
        new RegExp(`companies=\\{${wider}\\b`).test(form!),
        `the half-day picker is fed \`${wider}\`, which is wider than the set the write can reach`,
      ).toBe(false);
    }
    // The ticked state is derived from the SAME narrow list: derived from a wider one, the card would
    // show ticks for companies the picker does not even offer.
    expect(picker).toContain(
      'const halfDayEnabledCompanyIds = halfDayCompanies.filter((c) => c.leaveHalfDayFullDeduction).map((c) => c.id);',
    );
  });

  it('the three save banners on Company rules are LIVE, and the banking-risk one reaches its reader', () => {
    // ⚠️ ROUND 3 SHIPPED THIS CASE AS A DISCLOSURE — "these three banners are DORMANT until Round 5" —
    // and told the cutover commit, in writing, that it would FAIL here and must re-point rather than
    // delete. This is that re-point.
    //
    // `setToilPolicyAction` returns through the `LEAVE_REPLACEMENT` module constant, and Round 5 pointed
    // that constant at `/admin/leave-config/company-rules` in the same commit that emptied the old
    // Replacement leave screen. So `?error=` / `?saved=` / `?warning=` now arrive HERE, and the markup
    // that was unreachable is the live UI.
    //
    // `warning=` is the Phase-B #14 premium-equivalent BANKING-RISK warning. It was produced on every
    // qualifying save for months and silently dropped, because the screen it landed on never read the
    // param. Building the absorbing screen to read all three a round EARLY is what stopped that
    // happening a second time at exactly this cutover; this case is what stops it happening a third.
    expect(src.companyRules).toContain('const { error, warning, saved, company } = await searchParams;');
    expect(src.companyRules).toContain('<ErrorBanner message={error} />');
    expect(src.companyRules).toContain("tr('savedBanner')");
    expect(src.companyRules).toContain('{warning}');
    // The constant, and the helper that builds the return URL from it. Both halves are asserted because
    // either one alone could be repointed while the other still named the old screen.
    expect(
      actionsSrc,
      'LEAVE_REPLACEMENT must name Company rules — otherwise the banking-risk warning lands on a stub ' +
        'and reaches the administrator only after a bounce, or not at all if the stub ever stops ' +
        'forwarding the query string',
    ).toContain("const LEAVE_REPLACEMENT = '/admin/leave-config/company-rules';");
    expect(/const back = \(params: string\) =>\s+`\$\{LEAVE_REPLACEMENT\}/.test(actionsSrc)).toBe(true);
    // The old screen is a stub now — it reads no params at all, which is why the constant HAD to move.
    expect(OLD.replacement).not.toContain('const { error, warning, saved, company } = await searchParams;');
    expect(OLD.replacement).toContain('redirect(');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// The preview module has ONE navigation direction, and it is OUT
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R3 · every cross-screen link in the preview module points where the MAP points', () => {
  // r259 finding 3: the module navigated two ways at once. `LeaveConfigMap` on all seven new pages links
  // to the OLD addresses (the menu moves at the cutover, one commit per screen), while four of those same
  // pages' back-links pointed back INTO `/admin/leave-config/`. Each half is defensible alone; together
  // they put two answers to "where is the leave type screen" on one page, and Round 5 would have had to
  // move one set and leave the other — the inverse of the cutover instinct.
  //
  // DIRECTION CHOSEN: **out**, at the address that is live today, resolved through the map itself so the
  // two cannot drift. It is the direction that survives the cutover untouched — Round 5 empties each old
  // page into a redirect stub aimed at the new module, so a link resolved through the map reaches the NEW
  // screen the moment the old one goes, and the cutover moves `LEAVE_CONFIG_MAP` alone.
  const MODULE = 'app/admin/leave-config';

  /** Every page/component file in the module, walked — so a page added later cannot skip this. */
  function walk(rel: string, out: string[] = []): string[] {
    for (const e of readdirSync(resolve(here, '..', rel), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  const FILES = walk(MODULE);

  it('the module has more than one page, or this walk is asserting nothing', () => {
    expect(FILES.length).toBeGreaterThan(7);
  });

  it.each(FILES)('%s links at no OTHER screen inside the preview module', (rel) => {
    // `href="…"`, `href={'…'}` and `back={{ href: '…' }}` all in one: the literal destinations only —
    // a link resolved through `leaveConfigScreenHref` has no literal to find, which is the point.
    const own = rel.replace(/^app/, '').replace(/\/page\.tsx$/, '');
    const literals = [...read(rel).matchAll(/href[=:]\s*\{?\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    const inward = literals.filter((h) => h.startsWith('/admin/leave-config') && h !== own);
    expect(
      inward,
      `${rel} hard-links into the preview module while the map on the same page links out — resolve it ` +
        `through leaveConfigScreenHref() so the back-link and the menu cannot give two answers`,
    ).toEqual([]);
  });

  it('10b59703 — the four former back-links are GONE: those screens are tabs of a row now, not pages under Leave types', () => {
    // r259 gave each of these four a back-link to the leave type screen, resolved through the map. r266
    // made them TABS (Entitlements: Entitlement tables · Configuration record; Leave Adjustments: Balance
    // record · Import), so a back-link would be a second navigation direction beside the tab row — the
    // exact two-answers defect this describe exists to stop. Inverted rather than deleted: each page
    // must read its header through the row helper and carry no back-link, literal or resolved.
    for (const k of ['entitlementTables', 'import'] as const) {
      expect(src[k], `${SCREENS_BUILT[k].file} still links back to the leave type screen`).not.toContain(
        "leaveConfigScreenHref('leaveTypes')",
      );
      expect(src[k], `${SCREENS_BUILT[k].file} still renders a PageHeader back-link`).not.toContain('back={{');
      expect(src[k], `${SCREENS_BUILT[k].file} does not read its header through the row helper`).toContain(
        'leaveConfigPageHeader(',
      );
    }
    // 7f69bd71 — the two records LEFT this loop: they are sub-tabs of the Reset records sub-screen, which
    // is a page under the Leave Adjustments row and therefore DOES carry a back link — to Leave
    // Adjustments, never to the leave type screen — and reads its own heading, not the row helper's.
    for (const k of RECORD_KEYS) {
      expect(src[k]).not.toContain("leaveConfigScreenHref('leaveTypes')");
      expect(src[k]).not.toContain('back={{');
      expect(src[k]).not.toContain('leaveConfigPageHeader(');
    }
    const recordsPage = read(RECORDS_PAGE);
    expect(recordsPage).toContain("back={{ href: leaveConfigScreenHref('adjustments'), label: tNav('leaveAdjustments') }}");
    expect(recordsPage).not.toContain("leaveConfigScreenHref('leaveTypes')");
    expect(recordsPage).not.toContain('leaveConfigPageHeader(');
    // And the direction that resolves to: whatever the MAP says today, which is the point of resolving
    // through it — the cutover moves the map entry and every back-link follows in the same commit.
    const fromMap = LEAVE_CONFIG_MAP.flatMap((g) => g.items).find((i) => i.id === 'leaveTypes')!.href;
    expect(leaveConfigScreenHref('leaveTypes')).toBe(fromMap);
    expect(leaveConfigScreenHref('leaveTypes')).toBe(
      CUTOVER.leaveTypes.cutOver ? '/admin/leave-config/types' : '/admin/leave/entitlements',
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// Nothing is removed this round
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R5 · a function is live on exactly ONE screen, and the cutover moved it whole', () => {
  /**
   * ROUND 3's version of this table read "%s is still live on the old screen": nothing was removed, and
   * a setting editable in two places for two rounds was the deliberate price of "something works at
   * every point". Round 5 CLOSES that window, one screen per commit, and the table is re-pointed rather
   * than deleted — because the property worth guarding is not "the old page still has it", it is
   * **the function did not evaporate in the move**. Before its screen's commit the needle must be on the
   * old page; after it, on the new one. Either way exactly one screen answers for it.
   */
  /**
   * r281 — the needles whose destination is no longer the one their CUTOVER entry names.
   *
   * The cutover table answers "which commit moved this", which is still the right key for "did it leave
   * the old screen too early". It stopped being the right answer for "where is it now" the moment the
   * reporter asked for a second move, so the two questions get two tables rather than one that quietly
   * means both.
   */
  const DESTINATION: Record<string, string> = {
    'the half-day card': 'app/admin/leave-config/special-setting/page.tsx',
    'shared leave groups': 'app/admin/leave-config/types/page.tsx',
  };

  const NEW_FILE: Record<string, string> = {
    // Half-day and shared groups leave the leave TYPE page for Company rules, so `leaveTypes` names the
    // file those needles must ARRIVE in, which is Company rules — not the new leave type screen.
    leaveTypes: 'app/admin/leave-config/company-rules/page.tsx',
    templates: 'app/admin/leave-config/entitlement-tables/page.tsx',
    payroll: 'app/admin/leave-config/company-rules/page.tsx',
    replacement: 'app/admin/leave-config/company-rules/page.tsx',
    generate: 'app/admin/leave-config/generate/page.tsx',
    adjustments: 'app/admin/leave-config/adjustments/page.tsx',
    import: 'app/admin/leave-config/import/page.tsx',
    // 7f69bd71 — the two records live in the components the Reset records sub-screen mounts.
    archive: 'components/leave/reset-record-configuration.tsx',
    ledgerArchive: 'components/leave/reset-record-balances.tsx',
  };

  it.each([
    ['the half-day card', 'leaveTypes', 'setLeaveHalfDayFullDeductionCompaniesAction', 'leaveTypes'],
    ['shared leave groups', 'leaveTypes', '<LeaveSharedGroupConfig', 'leaveTypes'],
    ['leave encashment', 'payroll', 'setLeaveEncashmentPolicyAction', 'payroll'],
    ['the replacement policy', 'replacement', 'setToilPolicyAction', 'replacement'],
    ['the entitlement tables', 'templates', '<EntitlementTablesBlock', 'templates'],
    ['the explain panel', 'templates', '<EligibilityExplainPanel', 'templates'],
    ['the generate wizard', 'generate', '<GenerateForm', 'generate'],
    ['the adjustment flow', 'adjustments', '<AdjustmentForm', 'adjustments'],
    ['the importer', 'import', '<LeaveLedgerImport', 'import'],
    ['the entitlement record', 'archive', 'listEntitlementResetArchive', 'archive'],
    ['the balance record', 'ledgerArchive', 'listLeaveLedgerResetArchive', 'ledgerArchive'],
  ] as [string, keyof typeof OLD, string, string][])(
    '%s is live on exactly one screen (%s)',
    (_what, file, needle, absorbedBy) => {
      // `absorbedBy` is the CUTOVER entry whose commit actually moves the needle, which is not always
      // the screen the needle is FOUND on. The half-day card and shared leave groups sit on the old leave
      // TYPE screen and land on Company rules, so they move when the leave type page is emptied — with
      // `leaveTypes`, not with the Company rules screen's own absorbed entries.
      if (CUTOVER[absorbedBy].cutOver) {
        const arrivedAt = DESTINATION[_what] ?? NEW_FILE[absorbedBy];
        expect(read(arrivedAt), `${_what} did not arrive at ${arrivedAt}`).toContain(needle);
      } else {
        expect(OLD[file], `${_what} left the old screen before its cutover commit`).toContain(needle);
      }
    },
  );

  it('an old page is a redirect stub aimed at its replacement, or it is still a full screen', () => {
    // ⚠️ NO STUB IS EVER DELETED (migration order → Round 6): the reporter's bookmarks are the entire
    // reason the ten of them exist, and "no address ever 404s" is rule 4 of the whole sequence.
    for (const [name, s] of Object.entries(OLD)) {
      const { to, cutOver } = CUTOVER[name];
      if (cutOver) {
        expect(s, `${name} is cut over but its page is not a redirect stub`).toContain('redirect(');
        expect(s, `${name}'s stub does not aim at ${to}`).toContain(to);
        // 7f69bd71 — a record stub names its sub-tab FIRST, so `?capture=` rides along behind it and the
        // link lands on the right record; and it aims at the sub-screen, never at the newer stub.
        if (RECORD_OF[name]) {
          expect(s, `${name}'s stub does not name its sub-tab`).toContain(`new URLSearchParams({ record: '${RECORD_OF[name]}' })`);
          expect(s, `${name}'s stub chains through another stub`).not.toMatch(/redirect\(`\/admin\/leave-config\/records\/(entitlement|balances)/);
        }
        // A stub carries no page guard, which is what lets its route leave lib/permissions.ts.
        expect(/requireAdmin|scopedAdmin|scopedSession/.test(s), `${name}'s stub still calls a guard`).toBe(
          false,
        );
        // The query string is forwarded, so an in-flight ?toast= / ?error= still surfaces at the
        // destination — the df00b85f / f1b994e3 stub contract, not a new one. For Company rules this is
        // load-bearing rather than tidy: `?warning=` is the premium-equivalent BANKING-RISK warning.
        //
        // ⚠️ ASSERTED AS THE LOOP, NOT AS THE TOKEN. The first version of this case checked for the
        // string `URLSearchParams`, and a deliberate break — deleting the forwarding loop while leaving
        // `const usp = new URLSearchParams();` behind — PASSED it. A guard that a real regression walks
        // through is not a guard. Both halves are checked now: the params are read, and the redirect is
        // built from them.
        expect(s, `${name}'s stub does not READ the incoming params`).toMatch(
          /for \(const \[k, v\] of Object\.entries\(sp\)\)/,
        );
        expect(s, `${name}'s stub does not carry them onto the destination`).toMatch(
          /usp\.set\(k, v\)/,
        );
        expect(s, `${name}'s stub does not append the query string to the redirect`).toMatch(
          /\$\{qs \? `\?\$\{qs\}` : ''\}/,
        );
      } else {
        expect(s.includes('redirect('), `${name} was emptied before its own cutover commit`).toBe(false);
        expect(s.length, `${name} was emptied`).toBeGreaterThan(500);
      }
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// i18n — the r127 lesson
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R3 · every new label ships in all six locales with real translations', () => {
  // r127 shipped a screen rendering entirely through MISSING_MESSAGE behind a green 200: it passes tsc,
  // the suite and next build. These pages call several namespaces each, so i18n-coverage's static-key
  // case skips them entirely and this is the pinning site.
  const NEW_KEYS: [string, string][] = [
    ['admin.leaveConfigMap', 'item.companyRules'],
    // `admin.leaveConfigPreview.note` STOOD HERE and is DELIBERATELY GONE (a6fe37fc Round 5): its last
    // mount came off Company rules at the cutover and the component was deleted with it, so the key is
    // pruned in all six catalogues rather than left as an orphan a copy-paste could revive.
    ['admin.leaveConfigCompanyRules', 'pageDescription'],
    ['admin.leaveConfigCompanyRules', 'intro'],
    // `introTwoEditors` STOOD HERE and is DELIBERATELY GONE (a6fe37fc Round 5). It told the
    // administrator each of the four settings was still editable on the screen it came from — true for
    // exactly the three commits the cutover took to absorb them, and false the moment the last one
    // landed. It came off the page with its key in all six catalogues: an obsolete reassurance teaches
    // the reader the screen is provisional.
  ];

  const at = (bundle: unknown, dotted: string): unknown =>
    dotted
      .split('.')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bundle);

  it.each(LOCALES)('%s carries every new key with real text', async (loc) => {
    const messages = (await import(`../messages/${loc}.json`)).default as Record<string, unknown>;
    for (const [ns, key] of NEW_KEYS) {
      const value = at(messages, `${ns}.${key}`);
      expect(typeof value, `${loc} · ${ns}.${key}`).toBe('string');
      expect((value as string).trim().length, `${loc} · ${ns}.${key} is blank`).toBeGreaterThan(0);
    }
  });

  it('the five non-English locales are TRANSLATED, not English copied through', async () => {
    const en = (await import('../messages/en.json')).default as Record<string, unknown>;
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const messages = (await import(`../messages/${loc}.json`)).default as Record<string, unknown>;
      for (const [ns, key] of NEW_KEYS) {
        expect(at(messages, `${ns}.${key}`), `${loc} · ${ns}.${key} is the English string`).not.toBe(
          at(en, `${ns}.${key}`),
        );
      }
    }
  });

  it('NOTHING in the module still calls itself a preview, and the note component is gone', () => {
    // ROUND 3: "the preview note is rendered by every screen that can SAVE, and by none that cannot" —
    // because every leave action redirected to a module constant naming the OLD address, so a save made
    // on a new screen navigated away from it. Round 5 removed the note screen by screen, in the same
    // commit that repointed that screen's constant, and Company rules was the last mount: a screen the
    // menu points at telling the administrator it is a preview is worse than no note at all.
    //
    // The component itself was DELETED with its last mount rather than left importable — an unused
    // "this is a preview" banner is one copy-paste away from reappearing on a live screen.
    for (const k of KEYS) {
      expect(src[k], `${k} still renders the preview note`).not.toContain('<LeaveConfigPreviewNote');
    }
    expect(
      existsSync(resolve(here, '..', 'app/admin/leave-config/preview-note.tsx')),
      'preview-note.tsx outlived its last mount',
    ).toBe(false);
  });
});
