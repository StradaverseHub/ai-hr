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
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAVE_CONFIG_MAP, leaveConfigScreenHref } from '../components/leave-config-map';
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
  recordsEntitlement: {
    file: 'app/admin/leave-config/records/entitlement/page.tsx',
    route: '/admin/leave-config/records/entitlement',
    mapId: 'entitlementArchive',
  },
  recordsBalances: {
    file: 'app/admin/leave-config/records/balances/page.tsx',
    route: '/admin/leave-config/records/balances',
    mapId: 'ledgerArchive',
  },
} as const;

type ScreenKey = keyof typeof SCREENS_BUILT;
const KEYS = Object.keys(SCREENS_BUILT) as ScreenKey[];
const src = Object.fromEntries(KEYS.map((k) => [k, read(SCREENS_BUILT[k].file)])) as Record<ScreenKey, string>;

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
  leaveTypes: { to: '/admin/leave-config/types', cutOver: false },
  templates: { to: '/admin/leave-config/entitlement-tables', cutOver: false },
  payroll: { to: '/admin/leave-config/company-rules', cutOver: false },
  replacement: { to: '/admin/leave-config/company-rules', cutOver: false },
  generate: { to: '/admin/leave-config/generate', cutOver: false },
  adjustments: { to: '/admin/leave-config/adjustments', cutOver: false },
  import: { to: '/admin/leave-config/import', cutOver: true },
  archive: { to: '/admin/leave-config/records/entitlement', cutOver: false },
  ledgerArchive: { to: '/admin/leave-config/records/balances', cutOver: false },
};

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
    expect(src[k]).toContain('requireAdmin()');
  });

  it('the menu names the cut-over screens at their NEW address and the rest at their old one', () => {
    // ROUND 3 asserted "none of the seven is on the map — the menu moves at the Round 5 cutover, not
    // now". Round 5 IS that cutover, and it moves ONE entry per commit, so the assertion becomes a
    // read of the CUTOVER table rather than a blanket absence. Both directions still fail loudly: a
    // menu entry that moved before its page was emptied, and a page emptied while the menu still points
    // at the stub (two hops to reach a screen, and the map lying about where it is).
    const hrefs = LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => i.href);
    for (const [name, { to, cutOver }] of Object.entries(CUTOVER)) {
      if (cutOver) {
        expect(hrefs, `${name} is cut over, so the menu must name ${to}`).toContain(to);
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

  it('Company rules is a screen id with NO map entry, which is what makes Round 5 a one-line change', () => {
    // The id exists so the new page can render the map at all and take its heading from the same key the
    // menu entry will use. It is deliberately absent from the list until the cutover.
    const ids = LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => i.id as string);
    expect(ids).not.toContain('companyRules');
    expect(src.companyRules).toContain("leaveConfigScreenTitle('companyRules')");
  });

  it.each(KEYS)('%s renders the area map, so a new screen can reach its siblings', (k) => {
    // Without it a leave-config screen can reach no other leave-config screen at all — a worse map than
    // the old screens have, which is the r258 finding on Round 2's first draft.
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
  ['F4/F26 the half-day company picker', 'companyRules', '<HalfDayCompanyPicker'],
  ['F3 the shared leave group manager', 'companyRules', '<LeaveSharedGroupConfig'],
  ['F38 the replacement eligibility picker', 'companyRules', '<ReplacementEligibilityPicker'],
];

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
    for (const action of [
      'setLeaveHalfDayFullDeductionCompaniesAction',
      'setLeaveEncashmentPolicyAction',
      'setToilPolicyAction',
      'createLeaveSharedGroupAction',
      'updateLeaveSharedGroupAction',
      'deleteLeaveSharedGroupAction',
    ]) {
      expect(actionsSrc).toContain(`export async function ${action}(`);
      expect(src.companyRules).toContain(action);
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
      expect(src[k]).toContain('captures.find((c) => c.captureTag === sp.capture)?.captureTag');
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

/** Every `<form>` on Company rules, with the source of the components it mounts folded in. */
function scopeFor(action: string, mountedIn: string[] = []): string | null {
  const body = src.companyRules
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

  it('the four settings are gathered from FOUR different surfaces — that is what the screen is for', () => {
    // IA §2.0.3: Company rules is the only genuinely new destination, and this is the whole of its case.
    expect(src.companyRules).toContain('setLeaveHalfDayFullDeductionCompaniesAction'); // F4/F26, from every leave type
    expect(src.companyRules).toContain('setLeaveEncashmentPolicyAction'); //             F40,     from Payroll impact
    expect(src.companyRules).toContain('listLeaveSharedGroups('); //                     F3,      from Leave types
    expect(src.companyRules).toContain('setToilPolicyAction'); //                        F38,     from Replacement leave
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
    const batch = /const \[([^\]]+)\] = await Promise\.all\(\[([\s\S]*?)\n\s*\]\);/.exec(src.companyRules);
    expect(
      batch,
      'Company rules no longer batches its reads in one Promise.all — re-point this case at wherever ' +
        '`halfDayCompanies` is now bound, never drop it',
    ).not.toBeNull();
    const names = batch![1].split(',').map((x) => x.trim());
    const calls = batch![2]
      .split('\n')
      .map((l) => l.trim().replace(/,$/, ''))
      .filter(Boolean);
    const i = names.indexOf('halfDayCompanies');
    expect(i, '`halfDayCompanies` is no longer read on Company rules').toBeGreaterThan(-1);
    expect(
      calls[i],
      "the half-day picker's company list is no longer the adminOnly scope — a company-scoped hr_admin " +
        'would be offered companies whose row the write can never reach, and the untick would vanish on save',
    ).toBe('listCompanies(s, { adminOnly: true })');

    // …and that narrower list is what the PICKER is handed. Scoped to the form, so a wider list read
    // elsewhere on the page for a different question cannot satisfy it.
    const form = scopeFor('setLeaveHalfDayFullDeductionCompaniesAction');
    expect(form, 'no form on Company rules posts setLeaveHalfDayFullDeductionCompaniesAction').not.toBeNull();
    expect(form!).toContain('companies={halfDayCompanies.map((c) => ({ value: c.id, label: c.name }))}');
    for (const wider of ['companies', 'visible', 'shown']) {
      expect(
        new RegExp(`companies=\\{${wider}\\b`).test(form!),
        `the half-day picker is fed \`${wider}\`, which is wider than the set the write can reach`,
      ).toBe(false);
    }
    // The ticked state is derived from the SAME narrow list: derived from a wider one, the card would
    // show ticks for companies the picker does not even offer.
    expect(src.companyRules).toContain(
      'const halfDayEnabledCompanyIds = halfDayCompanies.filter((c) => c.leaveHalfDayFullDeduction).map((c) => c.id);',
    );
  });

  it('the three save banners on Company rules are DORMANT until Round 5, and this says so out loud', () => {
    // ⚠️ THIS CASE IS A DISCLOSURE, NOT A FEATURE CLAIM, and it is here so nobody reads dead markup as
    // live UI. The `?error=` / `?saved=` / `?warning=` params those banners read are produced by
    // `setToilPolicyAction`, which redirects to the `LEAVE_REPLACEMENT` module constant — the OLD screen
    // — so today all three land THERE, which does render them (app/admin/leave/replacement/page.tsx).
    // None of the three can appear on this page: r259's verify pass rendered it 55 times and no banner
    // path was ever taken. Nothing is lost meanwhile; the copy that is live is the old screen's.
    //
    // They are rendered here anyway, deliberately. `warning=` is the Phase-B #14 premium-equivalent
    // BANKING-RISK warning, which was produced on every qualifying save for months and silently dropped
    // because the screen it landed on did not read the param. Shipping the screen that absorbs
    // Replacement leave WITHOUT the banner would set that up to happen a second time, at the exact
    // moment Round 5 repoints the constant. A screen that cannot show a warning it is about to be sent
    // is the version of this worth refusing.
    //
    // ⚠️ WHEN ROUND 5 REPOINTS `LEAVE_REPLACEMENT` AT `/admin/leave-config/company-rules`, THIS CASE
    // FAILS — that is the whole point of asserting the old constant. It is the reminder that these three
    // banners have just become live UI, not a defect to route around: update the assertion in the
    // cutover commit (docs/design/a6fe37fc-migration-order.md → Round 5).
    expect(src.companyRules).toContain('const { error, warning, saved, company } = await searchParams;');
    expect(src.companyRules).toContain('<ErrorBanner message={error} />');
    expect(src.companyRules).toContain("tr('savedBanner')");
    expect(src.companyRules).toContain('{warning}');
    // The old screen still reads them, so the risk warning reaches an administrator TODAY.
    expect(OLD.replacement).toContain('const { error, warning, saved, company } = await searchParams;');
    // …and the action still returns there, which is what makes the copies above dormant. Both halves
    // carry the same instruction, because either one is what a Round 5 commit trips over first.
    const ROUND_5 =
      'the `warning=` / `saved=` / `error=` params now land on /admin/leave-config/company-rules, so the ' +
      'three banners asserted above have just become LIVE UI — including the premium-equivalent ' +
      'banking-risk warning. Re-point this case at the new target and re-read the new screen; do not delete it.';
    expect(
      actionsSrc.includes("const LEAVE_REPLACEMENT = '/admin/leave/replacement';"),
      `LEAVE_REPLACEMENT no longer names the old Replacement leave screen — if Round 5 has repointed it, ${ROUND_5}`,
    ).toBe(true);
    expect(
      /const back = \(params: string\) =>\s+`\$\{LEAVE_REPLACEMENT\}/.test(actionsSrc),
      `setToilPolicyAction no longer returns through LEAVE_REPLACEMENT — if Round 5 has repointed it, ${ROUND_5}`,
    ).toBe(true);
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

  it('the four back-links resolve through the map, so the cutover moves ONE list', () => {
    for (const k of ['entitlementTables', 'recordsEntitlement', 'recordsBalances', 'import'] as const) {
      expect(
        src[k],
        `${SCREENS_BUILT[k].file} lost its back-link to the leave type screen, or hard-coded it again`,
      ).toContain("leaveConfigScreenHref('leaveTypes')");
    }
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
  const NEW_FILE: Record<string, string> = {
    leaveTypes: 'app/admin/leave-config/types/page.tsx',
    templates: 'app/admin/leave-config/entitlement-tables/page.tsx',
    payroll: 'app/admin/leave-config/company-rules/page.tsx',
    replacement: 'app/admin/leave-config/company-rules/page.tsx',
    generate: 'app/admin/leave-config/generate/page.tsx',
    adjustments: 'app/admin/leave-config/adjustments/page.tsx',
    import: 'app/admin/leave-config/import/page.tsx',
    archive: 'app/admin/leave-config/records/entitlement/page.tsx',
    ledgerArchive: 'app/admin/leave-config/records/balances/page.tsx',
  };

  it.each([
    ['the half-day card', 'leaveTypes', 'setLeaveHalfDayFullDeductionCompaniesAction', 'payroll'],
    ['shared leave groups', 'leaveTypes', '<LeaveSharedGroupConfig', 'payroll'],
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
      // `absorbedBy` is the CUTOVER entry that owns the move: the half-day card and shared leave groups
      // sit on the old leave TYPE screen but land on Company rules, which the Replacement/Payroll
      // commits create — so their needle follows `payroll`, not `leaveTypes`.
      if (CUTOVER[absorbedBy].cutOver) {
        expect(read(NEW_FILE[absorbedBy]), `${_what} did not arrive at ${CUTOVER[absorbedBy].to}`).toContain(
          needle,
        );
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
        // A stub carries no page guard, which is what lets its route leave lib/permissions.ts.
        expect(/requireAdmin|scopedAdmin|scopedSession/.test(s), `${name}'s stub still calls a guard`).toBe(
          false,
        );
        // The query string is forwarded, so an in-flight ?toast= / ?error= still surfaces at the
        // destination — the df00b85f / f1b994e3 stub contract, not a new one.
        expect(s, `${name}'s stub drops the query string`).toContain('URLSearchParams');
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
    ['admin.leaveConfigPreview', 'note'],
    ['admin.leaveConfigCompanyRules', 'pageDescription'],
    ['admin.leaveConfigCompanyRules', 'intro'],
    ['admin.leaveConfigCompanyRules', 'introTwoEditors'],
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

  it('the preview note is rendered by every screen that is STILL a preview, and by none that is not', () => {
    // The note exists because a leave action redirects to a module constant that still names the OLD
    // address, so a save made on a not-yet-cut-over screen navigates away from it. At that screen's
    // cutover commit the constant is repointed AND the note comes off in the same change — a screen that
    // is the real one telling the administrator it is a preview is worse than no note at all.
    //
    // The two read-only records never carried it: they save nothing, so a note there would be furniture.
    const STILL_A_PREVIEW: [ScreenKey, string][] = [
      ['companyRules', 'replacement'],
      ['entitlementTables', 'templates'],
      ['generate', 'generate'],
      ['adjustments', 'adjustments'],
      ['import', 'import'],
    ];
    for (const [k, owner] of STILL_A_PREVIEW) {
      if (CUTOVER[owner].cutOver) {
        expect(src[k], `${k} is cut over — the preview note must come off in the same commit`).not.toContain(
          '<LeaveConfigPreviewNote',
        );
      } else {
        expect(src[k], `${k} still saves to the old address and must say so`).toContain(
          '<LeaveConfigPreviewNote />',
        );
      }
    }
    for (const k of ['recordsEntitlement', 'recordsBalances'] as const) {
      expect(src[k]).not.toContain('<LeaveConfigPreviewNote');
    }
  });
});
