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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAVE_CONFIG_MAP } from '../components/leave-config-map';
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

/** The old screens, which this round must leave standing. Read, never written. */
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
    // order says only `href` and `routes` ever move.
    const leaveConfig = SCREENS.find((s) => s.screenKey === 'leaveConfig')!;
    expect(leaveConfig.guard).toBe('requireAdmin');
    for (const k of KEYS) expect(leaveConfig.routes).toContain(SCREENS_BUILT[k].route);
    // The href has NOT moved: the menu still points at the old leave type screen until Round 5.
    expect(leaveConfig.href).toBe('/admin/leave/entitlements');
  });

  it.each(KEYS)('%s calls the page guard the registry describes', (k) => {
    // function-access.test.ts finds a page by grepping for the guard call; a page that reaches the
    // registry without one fails the no-stale-routes direction instead.
    expect(src[k]).toContain('requireAdmin()');
  });

  it('none of the seven is on the leave config map — the menu moves at the Round 5 cutover, not now', () => {
    const hrefs = LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => i.href);
    for (const k of KEYS) expect(hrefs).not.toContain(SCREENS_BUILT[k].route);
    // …and every old screen is still the one the menu names.
    for (const old of [
      '/admin/leave/entitlements',
      '/admin/leave/entitlements/templates',
      '/admin/leave/replacement',
      '/admin/leave/payroll',
      '/admin/leave/generate',
      '/admin/leave/adjustments',
      '/admin/leave/import',
      '/admin/leave/entitlements/archive',
      '/admin/leave/entitlements/ledger-archive',
    ]) {
      expect(hrefs).toContain(old);
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
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// Nothing is removed this round
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('a6fe37fc R3 · this round adds and removes NOTHING — every old screen keeps its copy', () => {
  it.each([
    ['the half-day card', 'leaveTypes', 'setLeaveHalfDayFullDeductionCompaniesAction'],
    ['shared leave groups', 'leaveTypes', '<LeaveSharedGroupConfig'],
    ['leave encashment', 'payroll', 'setLeaveEncashmentPolicyAction'],
    ['the replacement policy', 'replacement', 'setToilPolicyAction'],
    ['the entitlement tables', 'templates', '<EntitlementTablesBlock'],
    ['the explain panel', 'templates', '<EligibilityExplainPanel'],
    ['the generate wizard', 'generate', '<GenerateForm'],
    ['the adjustment flow', 'adjustments', '<AdjustmentForm'],
    ['the importer', 'import', '<LeaveLedgerImport'],
    ['the entitlement record', 'archive', 'listEntitlementResetArchive'],
    ['the balance record', 'ledgerArchive', 'listLeaveLedgerResetArchive'],
  ] as [string, keyof typeof OLD, string][])(
    '%s is still live on the old screen (%s)',
    (_what, file, needle) => {
      // A setting editable in two places for two rounds is deliberate and is the price of "something
      // works at every point". Both write the same column through the same action; Round 5 closes it.
      expect(OLD[file]).toContain(needle);
    },
  );

  it('the old pages are untouched by this round — they are still full screens, not stubs', () => {
    for (const [name, s] of Object.entries(OLD)) {
      expect(s.includes('redirect('), `${name} was turned into a redirect stub — that is Round 5`).toBe(false);
      expect(s.length, `${name} was emptied`).toBeGreaterThan(500);
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

  it('the preview note is rendered by every screen that can SAVE, and by none that cannot', async () => {
    // The note exists because every leave action still redirects to the OLD address, so a save made on a
    // new screen navigates away from it. The two read-only records save nothing, so a note there would be
    // furniture — and furniture stops being read.
    for (const k of ['companyRules', 'entitlementTables', 'generate', 'adjustments', 'import'] as const) {
      expect(src[k]).toContain('<LeaveConfigPreviewNote />');
    }
    for (const k of ['recordsEntitlement', 'recordsBalances'] as const) {
      expect(src[k]).not.toContain('<LeaveConfigPreviewNote');
    }
    const note = read('app/admin/leave-config/preview-note.tsx');
    expect(note).toContain("getTranslations('admin.leaveConfigPreview')");
  });
});
