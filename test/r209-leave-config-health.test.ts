/**
 * r209 — THE CAUSES OF A 0.00 BALANCE, MADE VISIBLE, AND RECALCULATED ON SAVE.
 *
 * MEASURED ON PRODUCTION 2026-08-19, and every number below is that measurement:
 *   · exactly ONE `entitlement_eligibility_rule` on the whole tenant. It pointed at the PERMANENT Medical
 *     table and `valid_to = 2026-08-13`. From the 14th NO employee resolved to any entitlement template,
 *     on any leave type. Six Medical tables, five of which never had a rule at all.
 *   · `accrual_method` NULL on Examination / Graduation / Marriage / Study / Haji, with
 *     `leave_type.accrual_unconfigured` stamped 2026-08-04 — a column populated for two weeks and read by
 *     NO SURFACE. That is the defect: it was recorded, and it was invisible.
 *   · six Special Leave types configured `{days: 3, maxBalanceDays: 0}` — granted, then clamped to nothing.
 *
 * WHAT THESE CASES PIN, and why each needs its own kind of test:
 *
 *   A. `lib/leave-config-health.ts` — the pure verdict. Unit-testable, and it has to mirror ONE piece of
 *      resolver behaviour exactly (r193's sole-table gate) or its warnings are noise within a day.
 *   B. THE CONTRACT BETWEEN THE DERIVATION AND THE SCREENS. A perfect derivation nobody renders changes
 *      nothing, and `loadEntitlementTablesData` feeding it a shape where `accrualMethod` is always null
 *      would report every leave type as broken while every unit test still passed. AGENTS rule 17: when a
 *      defect lives in the contract between two files, pin it with source assertions across BOTH.
 *   C. RECALCULATE ON SAVE, against a real ledger. The trigger was DOCUMENTED and never wired —
 *      `reprojectEntitlementForLeaveTypeCohort`'s header in core/leave.ts has said since release three that
 *      it fires "when an entitlement TEMPLATE or an ELIGIBILITY RULE for the type is written", and no call
 *      site existed. The DB case proves the recompute is what moves the balance; the source case proves the
 *      eight actions call it, after the write and before the redirect (r210 added the two deletes).
 *   D. THE SHARED POOL, for SIX types at once. `balance_source_type_id` already works for one borrower
 *      (test/leave-balance-source-upl.test.ts). The approved plan asks it to carry six, and asks that the
 *      employee read ONE figure with the contributing types named — which `leaveBalances` did not do at all.
 *
 * NOTHING HERE WRITES CONFIGURATION ON THE REPORTER'S BEHALF. Every case builds its own fixture; the
 * deliverable is that the missing configuration is visible and the resolution explainable.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  openLeaveYear,
  reprojectEntitlementForLeaveTypeCohort,
  requestLeave,
  InsufficientLeaveBalanceOnSubmitError,
} from '../core/leave';
import { leaveBalances, leaveEntitlementBreakdown } from '../core/read';
import {
  createEligibilityRule,
  createEntitlementTemplate,
  leaveTypeIdForRuleLineage,
  leaveTypeIdForTemplateLineage,
  listEligibilityRules,
  listEntitlementTemplates,
  retireEntitlementTemplate,
  updateEntitlementTemplate,
} from '../core/entitlement-template';
// The HR grid + its export both render from this one helper, so a row that contradicts itself here
// contradicts itself in the downloaded file too.
import { employeeBalanceRows } from '../app/leave/employee-balances/rows';
import {
  addDaysIso,
  isBlockingFinding,
  leaveConfigHealthAll,
  leaveTypeConfigHealth,
  RULE_EXPIRY_WARNING_DAYS,
  type HealthLeaveType,
  type HealthRule,
  type HealthTemplate,
  type LeaveConfigFinding,
} from '../lib/leave-config-health';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
/** r279 — every page.tsx under one repo-relative directory, walked so a later mount cannot hide from
 *  the "exactly one address" assertion below by landing in a directory nobody listed. */
const pagesUnder = (dir: string): string[] =>
  readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? pagesUnder(`${dir}/${e.name}`) : e.name === 'page.tsx' ? [`${dir}/${e.name}`] : [],
  );
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const msgs = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as Record<string, never>;
const leaf = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

const TODAY = '2026-08-19';

// ── A. the pure verdict ─────────────────────────────────────────────────────────────────────────────

const type = (over: Partial<HealthLeaveType> = {}): HealthLeaveType => ({
  id: 'lt-med',
  name: 'Medical Leave',
  accrualMethod: 'grant_on_hire_prorated',
  // 76ffdcf2 — required on HealthLeaveType so a projection that drops it fails the compiler, not a page.
  defaultEntitlementTemplateLineageId: null,
  accrualUnconfigured: false,
  // 3fb1a611 (r299 fix pass) — required too, for the same reason; false = no Leave Credit on this tenant.
  daysFromLeaveCreditOnly: false,
  archived: false,
  // r299 (3de1453a) — required on HealthLeaveType; false ⇒ no stranded earned method on this fixture.
  earnedMethodNotAnnualLeave: false,
  ...over,
});

const template = (over: Partial<HealthTemplate> = {}): HealthTemplate => ({
  lineageId: 'tpl-permanent',
  leaveTypeId: 'lt-med',
  name: 'Medical — PERMANENT',
  validFrom: '2026-01-01',
  validTo: null,
  serviceBands: [{ days: 14, maxBalanceDays: 14 }],
  ...over,
});

const rule = (over: Partial<HealthRule> = {}): HealthRule => ({
  lineageId: 'rule-permanent',
  name: 'PERMANENT',
  templateLineageId: 'tpl-permanent',
  validFrom: '2026-01-01',
  validTo: null,
  criteria: {},
  ...over,
});

const health = (p: {
  leaveType?: HealthLeaveType;
  templates?: HealthTemplate[];
  rules?: HealthRule[];
  grades?: { id: string; name: string }[];
}) =>
  leaveTypeConfigHealth({
    leaveType: p.leaveType ?? type(),
    templates: p.templates ?? [template()],
    rules: p.rules ?? [rule()],
    grades: p.grades ?? [],
    today: TODAY,
  });

describe('r209 · leaveTypeConfigHealth names the missing piece instead of leaving a 0.00 unexplained', () => {
  it('THE PRODUCTION SHAPE: six tables, one rule, expired 13 August ⇒ blocked, and it says why', () => {
    const templates = [
      template({ lineageId: 't1', name: 'Medical — PERMANENT' }),
      template({ lineageId: 't2', name: 'Medical — Contract Grade 19 and above' }),
      template({ lineageId: 't3', name: 'Medical — Contract Retiree' }),
    ];
    const h = health({
      templates,
      rules: [rule({ templateLineageId: 't1', validFrom: '2026-01-01', validTo: '2026-08-13' })],
    });
    // The two facts that were true on production and shown nowhere.
    expect(h.status).toBe('blocked');
    expect(h.findings).toContain('no_rule_in_force');
    expect(h.findings).toContain('rule_expired');
    expect(h.expiredRules).toEqual([{ name: 'PERMANENT', endedOn: '2026-08-13' }]);
    // Counts, so the screen can state them whether or not anything is wrong.
    expect(h.templateCount).toBe(3);
    expect(h.ruleCount).toBe(0);
    // And the tables nobody can reach are NAMED. "Some tables have no rule" is not actionable.
    expect(h.tablesWithoutRule).toEqual([
      'Medical — PERMANENT',
      'Medical — Contract Grade 19 and above',
      'Medical — Contract Retiree',
    ]);
  });

  it('the day BEFORE it expires the same configuration is merely a warning, and names the date', () => {
    const h = health({ rules: [rule({ validTo: addDaysIso(TODAY, 10) })] });
    expect(h.status).toBe('warning');
    expect(h.findings).toContain('rule_expiring');
    expect(h.findings).not.toContain('rule_expired');
    expect(h.expiringRules).toEqual([{ name: 'PERMANENT', endsOn: addDaysIso(TODAY, 10) }]);
    // THE POINT OF THE WINDOW: an end date beyond it is not yet news, or the card is amber forever.
    const far = health({ rules: [rule({ validTo: addDaysIso(TODAY, RULE_EXPIRY_WARNING_DAYS + 1) })] });
    expect(far.findings).not.toContain('rule_expiring');
    expect(far.status).toBe('ready');
  });

  it('judges a rule LINEAGE on its CURRENT version — an edit is not an expiry', () => {
    // An edit closes the running version and inserts a successor. Reading every version as its own rule
    // would report a perfectly healthy, twice-edited rule as expired twice.
    const h = health({
      rules: [
        rule({ validFrom: '2026-01-01', validTo: '2026-06-01' }),
        rule({ validFrom: '2026-06-01', validTo: null }),
      ],
    });
    expect(h.expiredRules).toEqual([]);
    expect(h.status).toBe('ready');
  });

  it('r193 fault 3, mirrored: ONE table and NO rule is the healthy shape, not a fault', () => {
    // `buildTemplateEntitlementResolver` applies a leave type's only table when no rule is in force —
    // Hospitalization Leave on the reporter's account is exactly this. Reporting it as broken would make
    // the whole card noise, and noise is how the real finding above gets skipped.
    const h = health({ rules: [] });
    expect(h.soleTableApplies).toBe(true);
    expect(h.status).toBe('ready');
    expect(h.findings).toEqual([]);
    expect(h.tablesWithoutRule).toEqual([]);
    // …and the safety half of that gate: SEVERAL tables and no rule genuinely resolves to nothing.
    const several = health({
      templates: [template({ lineageId: 't1' }), template({ lineageId: 't2', name: 'B' })],
      rules: [],
    });
    expect(several.soleTableApplies).toBe(false);
    expect(several.findings).toContain('no_rule_in_force');
  });

  it('a rule in force over a STOPPED table still blocks the sole-table fallback, exactly as the engine does', () => {
    /**
     * ⚠️ THE GATE IS MEASURED ON A WIDER SET OF RULES THAN "the rules that can match somebody", AND THE
     * FIRST CUT OF THIS FILE GOT IT WRONG — it reported READY over a leave type the engine granted to
     * nobody, and suppressed the surviving table's own "No eligibility rule points here" at the same time.
     *
     * `leaveTypeIdsWithEligibilityRulesAt` (core/entitlement-template.ts) joins rule → leave type through
     * EVERY version of the template lineage, in force or not, deliberately: a rule pointing at a stopped
     * table is still HR having stated an opinion, so the sole-table fallback stays out of its way and
     * NOBODY resolves. The shape is reached by ordinary use — stop a table without stopping the rule that
     * points at it, which is precisely what the retire confirmation's rule count warns about.
     */
    const h = health({
      templates: [
        template({ lineageId: 'old', name: 'Medical — OLD', validFrom: '2020-01-01', validTo: '2026-01-01' }),
        template({ lineageId: 'new', name: 'Medical — NEW', validFrom: '2026-01-01', validTo: null }),
      ],
      rules: [rule({ lineageId: 'r-old', templateLineageId: 'old', validFrom: '2020-01-01', validTo: null })],
    });
    expect(h.templateCount, 'one table in force — the stopped one is not').toBe(1);
    expect(h.soleTableApplies, 'a rule in force claims this type, so its single live table is NOT automatic').toBe(false);
    expect(h.status).toBe('blocked');
    expect(h.findings).toContain('no_rule_in_force');
    // …and because the fallback does not apply, the live table's own marker is not suppressed either.
    expect(h.tablesWithoutRule).toEqual(['Medical — NEW']);
  });

  it('no earning method blocks the type however complete the tables are (the accrual_unconfigured column)', () => {
    const h = health({ leaveType: type({ accrualMethod: null, accrualUnconfigured: true }) });
    expect(h.earningMethodSet).toBe(false);
    expect(h.status).toBe('blocked');
    expect(h.findings).toContain('no_earning_method');
    expect(isBlockingFinding('no_earning_method')).toBe(true);
  });

  it('no entitlement table at all is its own finding — Haji and Natural Disaster on the account', () => {
    const h = health({ templates: [], rules: [] });
    expect(h.status).toBe('blocked');
    expect(h.findings).toContain('no_entitlement_table');
    // …and NOT "no rule in force": there is nothing for a rule to point at, and telling HR to write one
    // sends them to the wrong screen.
    expect(h.findings).not.toContain('no_rule_in_force');
  });

  it('a table whose validity has not started, or has ended, is not in force and does not count', () => {
    const notYet = health({ templates: [template({ validFrom: '2026-09-01' })], rules: [] });
    expect(notYet.templateCount).toBe(0);
    expect(notYet.findings).toContain('no_entitlement_table');
    const ended = health({ templates: [template({ validTo: '2026-08-01' })], rules: [] });
    expect(ended.templateCount).toBe(0);
  });

  it('a Job Grade that belongs to no table is NAMED — the “Executive” case, left unmapped on purpose', () => {
    const grades = [
      { id: 'g-perm', name: 'GRADE 12 (PERMANENT)' },
      { id: 'g-exec', name: 'Executive' },
    ];
    const h = health({ rules: [rule({ criteria: { gradeIds: ['g-perm'] } })], grades });
    expect(h.findings).toContain('grades_without_table');
    expect(h.gradesWithoutTable).toEqual(['Executive']);
    expect(h.status).toBe('warning');
  });

  it('a rule that does NOT narrow by grade covers every grade — one such rule answers for the catalogue', () => {
    // core/org-criteria.ts's own semantics: an unrestricted axis is no restriction. A health check that
    // read an empty `gradeIds` as "covers nothing" would flag every grade on the commonest rule there is.
    const grades = [{ id: 'g-perm', name: 'GRADE 12 (PERMANENT)' }, { id: 'g-exec', name: 'Executive' }];
    expect(health({ rules: [rule({ criteria: {} })], grades }).gradesWithoutTable).toEqual([]);
    // Mixed: one rule narrows, another does not ⇒ still covered by the one that does not.
    expect(
      health({
        rules: [rule({ criteria: { gradeIds: ['g-perm'] } }), rule({ lineageId: 'r2', criteria: {} })],
        grades,
      }).gradesWithoutTable,
    ).toEqual([]);
  });

  it('a Maximum Balance of 0 over a band that grants days is WARNED, and its meaning is untouched', () => {
    // The six Special Leave types: `{days: 3, maxBalanceDays: 0}`. The scope fence is explicit — a cap of
    // zero is a real cap of zero (core/leave-compute.ts `bandMaxBalance`) and this only says so out loud.
    const h = health({ templates: [template({ serviceBands: [{ days: 3, maxBalanceDays: 0 }] })] });
    expect(h.findings).toContain('max_balance_zero');
    expect(h.zeroMaxBalanceTables).toEqual(['Medical — PERMANENT']);
    expect(h.status).toBe('warning');
    // A cap of 0 over a band that grants 0 says nothing new — the day table is the thing to fix.
    expect(health({ templates: [template({ serviceBands: [{ days: 0, maxBalanceDays: 0 }] })] }).findings).not.toContain(
      'max_balance_zero',
    );
    // A REAL cap is not a fault, and an absent one certainly is not.
    expect(health({ templates: [template({ serviceBands: [{ days: 3, maxBalanceDays: 14 }] })] }).findings).toEqual([]);
    expect(health({ templates: [template({ serviceBands: [{ days: 3 }] })] }).findings).toEqual([]);
  });

  it('a fully configured type is READY and says nothing — the card must not be permanently amber', () => {
    const h = health({});
    expect(h.status).toBe('ready');
    expect(h.findings).toEqual([]);
  });

  it('leaveConfigHealthAll: blocked first, archived types excluded, rules scoped to their own type', () => {
    const rows = leaveConfigHealthAll({
      leaveTypes: [
        type({ id: 'ready', name: 'Zeta Ready' }),
        type({ id: 'blocked', name: 'Alpha Blocked', accrualMethod: null, accrualUnconfigured: true }),
        type({ id: 'warn', name: 'Beta Warned' }),
        type({ id: 'gone', name: 'Archived', archived: true }),
      ],
      templates: [
        template({ lineageId: 'tr', leaveTypeId: 'ready' }),
        template({ lineageId: 'tb', leaveTypeId: 'blocked' }),
        template({ lineageId: 'tw', leaveTypeId: 'warn', serviceBands: [{ days: 3, maxBalanceDays: 0 }] }),
        template({ lineageId: 'tg', leaveTypeId: 'gone' }),
      ],
      rules: [
        rule({ lineageId: 'rr', templateLineageId: 'tr' }),
        rule({ lineageId: 'rb', templateLineageId: 'tb' }),
        rule({ lineageId: 'rw', templateLineageId: 'tw' }),
      ],
      grades: [],
      today: TODAY,
    });
    expect(rows.map((r) => r.leaveTypeName)).toEqual(['Alpha Blocked', 'Beta Warned', 'Zeta Ready']);
    expect(rows.map((r) => r.status)).toEqual(['blocked', 'warning', 'ready']);
    // Scoping is the load-bearing half: a rule belongs to a type only through the lineage it points at,
    // so a health check that handed every type every rule would report all of them healthy.
    expect(rows.find((r) => r.leaveTypeId === 'ready')!.ruleCount).toBe(1);
  });
});

// ── B. the contract between the derivation and the screens ──────────────────────────────────────────

const ALL_FINDINGS: LeaveConfigFinding[] = [
  'no_earning_method',
  'no_entitlement_table',
  'no_rule_in_force',
  'table_without_rule',
  'rule_expired',
  'rule_expiring',
  'grades_without_table',
  'max_balance_zero',
];

describe('r209 · the findings actually reach a screen, in every locale', () => {
  it('the renderer has a branch for EVERY finding, and every branch’s key exists in all six catalogues', () => {
    // The switch is exhaustive by tsc; the KEYS are not — a missing one paints MISSING_MESSAGE behind a
    // green 200 (AGENTS rule 6), which is why this reads the source rather than trusting the type.
    const src = read('components/leave/leave-config-health.tsx');
    for (const f of ALL_FINDINGS) expect(src, `branch for ${f}`).toContain(`case '${f}':`);
    const keys = [...src.matchAll(/t\('(health[A-Za-z]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(ALL_FINDINGS.length);
    for (const loc of LOCALES) {
      for (const k of new Set(keys)) {
        expect(leaf(msgs(loc), `admin.entitlementTemplates.${k}`), `${loc}.${k}`).toBeTruthy();
      }
    }
  });

  /**
   * The keys these two files resolve through a MAP or from a MULTI-NAMESPACE file, which is exactly the
   * class `test/i18n-coverage.test.ts` cannot see: check C reads literal `t('a.b')` calls and skips any
   * file with more than one namespace. A key missing here paints MISSING_MESSAGE in the browser behind a
   * green 200 that passes tsc, the suite and `next build` — AGENTS rule 6.
   */
  it('the map-resolved and multi-namespace captions exist in all six catalogues', () => {
    const card = read('components/leave/leave-config-health.tsx');
    const statusKeys = [...card.matchAll(/'(healthStatus[A-Za-z]+)'/g)].map((m) => m[1]);
    expect(new Set(statusKeys)).toEqual(new Set(['healthStatusBlocked', 'healthStatusWarning', 'healthStatusReady']));
    for (const loc of LOCALES) {
      for (const k of statusKeys) {
        expect(leaf(msgs(loc), `admin.entitlementTemplates.${k}`), `${loc}.${k}`).toBeTruthy();
      }
      // The two captions on the balance grids. `app/leave/employee-balances/page.tsx` reads three
      // namespaces and `leave-balance-table.tsx` reads two, so neither is checked by i18n-coverage.
      for (const k of ['leave.inquiry.resolvedEntitlementTable', 'leave.inquiry.sharedBalanceWith', 'me.leaveBalanceTable.sharedBalanceWith']) {
        expect(leaf(msgs(loc), k), `${loc}.${k}`).toBeTruthy();
      }
    }
    // …and the surfaces really do ask for them, or the keys above are six catalogues of dead strings.
    expect(read('app/leave/employee-balances/page.tsx')).toContain("tInq('resolvedEntitlementTable'");
    expect(read('app/leave/employee-balances/page.tsx')).toContain("tInq('sharedBalanceWith'");
    expect(read('components/leave/leave-balance-table.tsx')).toContain("tt('sharedBalanceWith'");
  });

  it('the two mounts render it: one type inside its own step, every type on the Entitlements page', () => {
    const block = read('app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
    /**
     * r270 (5527ce8f) — UPDATED, NOT DELETED. This pair of assertions pinned the exact literals of both
     * arms of a TWO-arm ternary. There are three states now, because the Entitlement tables tab drew a
     * second copy of a card `app/admin/leave-config/types/page.tsx` already renders at page level, and
     * asks for it to be suppressed. Both original literals are still asserted — the two arms did not
     * change, only what is tested before them — and the suppressed state is pinned beside them so the
     * flag cannot be quietly dropped back to today's two-arm shape.
     *
     * ⚠️ ORDER IS THE ASSERTION. The flag has to be read BEFORE the scoped/unscoped branch, or a caller
     * that said "do not draw this" falls through to the unscoped arm. The same ordering closes a live
     * edge case: a `leaveTypeId` matching no loaded row leaves `scopedHealth` null, so the SCOPED mount
     * used to render the unscoped card — an empty "No active leave types" over one type's tables.
     */
    expect(block).toContain('{!showConfigHealth ? null : scopedHealth ? (');
    expect(block).toContain('<LeaveConfigHealthNotice health={scopedHealth} />');
    expect(block).toContain('<LeaveConfigHealthCard rows={allHealth} />');
    expect(block).toContain('showConfigHealth = true');
    expect(block.indexOf('!showConfigHealth ? null')).toBeLessThan(block.indexOf('<LeaveConfigHealthNotice'));
    // …and exactly one mount suppresses it: the tab that has the duplicate, never the tab that owns it.
    expect(read('app/admin/leave-config/entitlement-tables/page.tsx')).toContain('showConfigHealth={false}');
    expect(read('app/admin/leave-config/types/page.tsx')).not.toContain('showConfigHealth={false}');
    // ⚠️ THE "no rule points here" MARKER IS PER LEAVE TYPE, not one boolean for the whole table. The
    // unfiltered mount lists every type's tables together, so a single flag would either warn on a healthy
    // single-table type or stay silent on a broken multi-table one — and it is the same set the card above
    // it derives from, so the two cannot disagree about which zero is a fault.
    // r271 (6d29e11c) — THE INVARIANT MOVED INTO THE DERIVATION, and is pinned where it now lives. When
    // the grid and the tables list merged, this decision stopped being a condition inside a table cell and
    // became one branch of `entitlementGridRows`, which asks it once per VERSION — still per leave type,
    // which is the whole point of this assertion. The marker's words are `gridNoGrade` now, which names
    // the consequence before the cause; `ruleNonePointsHere` retired with the column it lived in.
    expect(block).toContain('input.soleTableTypeIds.has(x.leaveTypeId)');
    expect(block, 'per leave type, never one boolean for the whole table').not.toMatch(
      /soleTableApplies\s*\?\s*\{ kind: 'everyone' \}/,
    );
    expect(block).toContain("t('gridNoGrade')");
    // …and the expiry badges on the rules table, judged on the lineage's CURRENT version only.
    expect(block).toContain("t('ruleExpiredBadge')");
    expect(block).toContain("t('ruleExpiringBadge')");
    expect(block).toContain('ruleHeadIds.has(x.id)');
    // r279 (3fbf7a02) — UPDATED, NOT DELETED, AND THE PROPERTY IS THE SAME ONE: the full listing is
    // rendered by THIS component from THIS derivation, and exactly once. What changed is its address.
    // `<LeaveConfigHealthCard rows={configHealth} />` on the Leave types tab was the assertion; the card
    // was named nowhere in the menu there, so the screen that explains a 0.00 balance could only be found
    // by already knowing it existed and scrolling. It is its own row and its own page now. The Leave
    // types tab keeps the DERIVATION (the rail's per-type "reaches nobody" badge reads it) and loses the
    // CARD — and both halves are asserted, so a half-done move that leaves two copies, or one that takes
    // the card away without giving it an address, fails here.
    const page = read('app/admin/leave-config/types/page.tsx');
    expect(page, 'the per-type badge still reads this derivation').toContain('leaveConfigHealthAll(');
    expect(page, 'the full listing moved to its own page; two copies drift').not.toContain('<LeaveConfigHealthCard');
    const moved = read('app/admin/leave-config/balance-health/page.tsx');
    expect(moved).toContain('leaveConfigHealthAll(');
    expect(moved).toContain('<LeaveConfigHealthCard rows={rows} />');
    // Exactly one page-level mount of the card in the whole module, so "it only changed address" holds.
    expect(
      pagesUnder('app/admin/leave-config').filter((p) => read(p).includes('<LeaveConfigHealthCard')),
      'the full listing must live at exactly one address',
    ).toEqual(['app/admin/leave-config/balance-health/page.tsx']);
  });

  /**
   * ⚠️ THE CONTRACT CASE, and the reason it is not a unit test of either side. `leaveTypeConfigHealth`
   * takes `accrualMethod` / `accrualUnconfigured` / the grade catalogue. If `loadEntitlementTablesData`
   * stopped supplying them, EVERY unit test above would still pass and EVERY leave type on the screen
   * would report "no earning method chosen" — a permanently red card that HR would learn to ignore, which
   * is the same outcome as the silence r209 replaced.
   */
  it('the loader supplies the three facts the derivation cannot compute for itself', () => {
    const block = read('app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
    expect(block).toContain('accrualMethod: x.accrualMethod ?? null');
    expect(block).toContain('accrualUnconfigured: x.accrualUnconfigured != null');
    expect(block).toContain('activeGrades: activeGrades.map((g) => ({ id: g.id, name: g.name }))');
    // …and the leave-type read really does project them, or the two lines above read `undefined` forever
    // and every type reports "no earning method chosen". `listLeaveTypes` gets them by spreading
    // `leaveTypeRuleColumns`, which is where the two columns are declared once for every engine.
    expect(read('core/read.ts')).toContain('...leaveTypeRuleColumns,');
    const cols = read('core/leave.ts');
    const map = cols.slice(cols.indexOf('export const leaveTypeRuleColumns = {'), cols.indexOf('} as const', cols.indexOf('export const leaveTypeRuleColumns = {')));
    expect(map).toContain('accrualMethod: leaveType.accrualMethod');
    expect(map).toContain('accrualUnconfigured: leaveType.accrualUnconfigured');
  });

  it('the derivation stays DB-free and framework-free, so both mounts share one definition', () => {
    const src = read('lib/leave-config-health.ts');
    expect(src).not.toContain('drizzle-orm');
    expect(src).not.toContain('@/db');
    expect(src).not.toContain("from 'react'");
  });
});

// ── C + D. against a real database ──────────────────────────────────────────────────────────────────

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

const uniq = (p: string) => `${p}_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;

async function leaveTypeRow(opts: { balanceSourceTypeId?: string; name?: string } = {}): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('R209'),
      name: opts.name ?? uniq('R209 Leave'),
      paid: true,
      counting: 'calendar_days',
      ...(opts.balanceSourceTypeId ? { balanceSourceTypeId: opts.balanceSourceTypeId } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'R209', primaryEmail: `r209_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });

async function hireWithCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hire();
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

/** The signed ledger total for one (employment, leave type) — the figure every balance surface shows. */
const ledgerTotal = async (employmentId: string, leaveTypeId: string): Promise<number> => {
  const rows = await owner.db
    .select({ days: schema.leaveLedger.days })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, leaveTypeId)));
  return Math.round(rows.reduce((n, r) => n + Number(r.days), 0) * 100) / 100;
};

describe('r209 · recalculate on save, instead of remembering to press Generate Entitlement', () => {
  /**
   * ⚠️ THE NON-VACUITY IS BUILT INTO THIS CASE. Step 3 asserts the balance has NOT moved after the table
   * is edited — which is exactly what the whole product did before r209, on every save. Step 4 then shows
   * the recompute moving it. Remove the recompute and step 4 fails; remove step 3 and the case could pass
   * against an engine that recalculated for some unrelated reason.
   */
  it('editing an entitlement table changes nothing until the cohort recompute runs, and then it does', async () => {
    const typeId = await leaveTypeRow();
    const tpl = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'Medical — all staff',
      serviceBands: [{ fromYears: 0, toYears: null, days: 14, carryForwardDays: 0, maxBalanceDays: null }],
      validFrom: '2026-01-01',
    });
    const emp = await hire();
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await ledgerTotal(emp.employmentId, typeId)).toBe(14);

    await updateEntitlementTemplate(adminCtx(b), {
      lineageId: tpl.lineageId,
      name: 'Medical — all staff',
      serviceBands: [{ fromYears: 0, toYears: null, days: 20, carryForwardDays: 0, maxBalanceDays: null }],
      validFrom: '2026-01-02',
    });
    // 3. The save alone moves nothing. This IS the reporter's complaint, asserted rather than described.
    expect(await ledgerTotal(emp.employmentId, typeId)).toBe(14);

    // 4. …and the recompute the eight actions now fire is what closes the gap.
    const res = await reprojectEntitlementForLeaveTypeCohort(adminCtx(b), {
      leaveTypeId: typeId,
      trigger: 'entitlement_template_updated',
      asOf: '2026-08-19',
    });
    expect(res.affected).toBeGreaterThan(0);
    expect(await ledgerTotal(emp.employmentId, typeId)).toBe(20);
    // Recorded, as the plan requires — `leave_entitlement_recalc_audit` already existed and now has rows.
    const audit = await owner.db
      .select({ reason: schema.leaveEntitlementRecalcAudit.reason, delta: schema.leaveEntitlementRecalcAudit.delta })
      .from(schema.leaveEntitlementRecalcAudit)
      .where(eq(schema.leaveEntitlementRecalcAudit.employmentId, emp.employmentId));
    expect(audit.map((a) => a.reason)).toContain('entitlement_template_updated');
    expect(audit.map((a) => Number(a.delta))).toContain(6);
  });

  it('the lineage → leave type derivations the wiring depends on resolve, for tables AND for rules', async () => {
    // An eligibility rule carries NO leave type — it names a template lineage. Without these two the
    // recompute has nothing to key on and the wiring is a no-op that looks wired.
    {
      const typeId = await leaveTypeRow();
      const tpl = await createEntitlementTemplate(adminCtx(b), {
        leaveTypeId: typeId,
        name: 'T',
        serviceBands: [{ fromYears: 0, toYears: null, days: 5 }],
        validFrom: '2026-01-01',
      });
      const r = await createEligibilityRule(adminCtx(b), {
        name: 'Everyone',
        templateLineageId: tpl.lineageId,
        criteria: {},
        validFrom: '2026-01-01',
      });
      expect(await leaveTypeIdForTemplateLineage(adminCtx(b), tpl.lineageId)).toBe(typeId);
      expect(await leaveTypeIdForRuleLineage(adminCtx(b), r.lineageId)).toBe(typeId);
      expect(await leaveTypeIdForTemplateLineage(adminCtx(b), randomUUID())).toBeNull();
      expect(await leaveTypeIdForTemplateLineage(adminCtx(b), '')).toBeNull();
    }
  });

  /**
   * The other half of the contract. The DB case above proves the recompute WORKS; this proves the six
   * writers CALL it — and calls it in the only order that is correct.
   *
   * ORDERING IS LOAD-BEARING, not stylistic, and no runtime observation can distinguish "inside a
   * transaction that then committed" from "after it": each per-employee recalc opens its own transaction
   * and reads the COMMITTED configuration, so a call before the service await would reproject every
   * employee against the configuration the save just replaced. Same argument, and the same shape of
   * assertion, as `setLeaveTypeRulesAction`'s ordering case in test/leave-earning-method-simplified.ts.
   *
   * And it must sit BEFORE `saved(...)`: `redirect()` works by throwing, so anything after it never runs.
   */
  it('all eight entitlement writers recompute — after the service call, before the redirect', () => {
    const src = read('app/admin/leave/entitlements/templates/actions.ts');
    // r210 added the two deletes. They recompute for the same reason a retire does: the employees the
    // removed lineage reached resolve to NO OPINION afterwards, which the kernel posts as a delta of 0
    // rather than clawing days back — and it is the read that re-derives the health card.
    const writers = [
      ['createEntitlementTemplateAction', 'createEntitlementTemplate('],
      ['updateEntitlementTemplateAction', 'updateEntitlementTemplate('],
      ['retireEntitlementTemplateAction', 'retireEntitlementTemplate('],
      ['deleteEntitlementTemplateAction', 'deleteEntitlementTemplate('],
      ['createEligibilityRuleAction', 'createEligibilityRule('],
      ['updateEligibilityRuleAction', 'updateEligibilityRule('],
      ['retireEligibilityRuleAction', 'retireEligibilityRule('],
      ['deleteEligibilityRuleAction', 'deleteEligibilityRule('],
    ] as const;
    for (const [action, service] of writers) {
      const start = src.indexOf(`export async function ${action}(`);
      expect(start, action).toBeGreaterThan(-1);
      const body = src.slice(start, src.indexOf('\n}\n', start));
      const write = body.indexOf(`await ${service}`);
      const recompute = body.indexOf('recomputeAfterSave(');
      const redirect = body.indexOf('saved(formData');
      expect(write, `${action} calls its service`).toBeGreaterThan(-1);
      expect(recompute, `${action} recomputes`).toBeGreaterThan(-1);
      expect(recompute, `${action}: recompute AFTER the write`).toBeGreaterThan(write);
      expect(recompute, `${action}: recompute BEFORE the redirect`).toBeLessThan(redirect);
    }
    // Best effort: a recompute hiccup must never turn a successful save into an error banner.
    const helper = src.slice(src.indexOf('async function recomputeAfterSave'));
    expect(helper).toContain('try {');
    expect(helper).toContain('console.error');
  });
});

describe('r209 · the health card and the ENGINE agree about which zero is a fault', () => {
  /**
   * ⚠️ THE MIRROR, PINNED AGAINST THE THING IT MIRRORS, over one database and one configuration.
   *
   * The card's whole value is that it says "blocked" exactly when the engine grants nobody anything. Where
   * the two drift, the card is worse than no card: a GREEN "Ready" over a leave type producing 0.00 for
   * every employee is the silence r209 exists to end, restated in a nicer font. The drift that shipped was
   * `soleTableApplies` — measured on rules pointing at a LIVE table, where the resolver's own gate
   * (`leaveTypeIdsWithEligibilityRulesAt`) counts a rule in force pointing at ANY version of the lineage.
   *
   * The configuration below is reached by ordinary use, not by a contrived state: HR writes a new table for
   * 2026, stops the old one, and leaves the rule pointing at the old one — which is exactly the state the
   * stop-confirmation's "this table has N eligibility rules" exists to warn about.
   */
  it('a rule left pointing at a STOPPED table: the engine grants nobody, so the card must not say ready', async () => {
    const typeId = await leaveTypeRow({ name: 'Medical Leave' });
    const old = await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'Medical — OLD',
      serviceBands: [{ fromYears: 0, toYears: null, days: 14 }],
      validFrom: '2020-01-01',
    });
    await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: typeId,
      name: 'Medical — NEW',
      serviceBands: [{ fromYears: 0, toYears: null, days: 18 }],
      validFrom: '2026-01-01',
    });
    await createEligibilityRule(adminCtx(b), {
      name: 'ALL STAFF',
      templateLineageId: old.lineageId,
      criteria: {},
      validFrom: '2020-01-01',
    });
    await retireEntitlementTemplate(adminCtx(b), { lineageId: old.lineageId, validTo: '2026-01-01' });
    const { employmentId } = await hireWithCtx();

    // THE ENGINE. One table in force, one rule in force — and the rule names the table that was stopped,
    // so the resolver drops it, the sole-table fallback stays out of its way, and NOTHING resolves.
    const bd = await leaveEntitlementBreakdown(adminCtx(b), employmentId, typeId, TODAY);
    expect(bd!.entitlementTemplateName).toBeNull();
    expect(bd!.entitlementStatus).toBe('no_eligibility_match');

    // THE CARD, over the very same rows — which is the point: no fixture is shared, the DB is.
    const templates = await listEntitlementTemplates(adminCtx(b), { leaveTypeId: typeId });
    const lineages = new Set(templates.map((t) => t.lineageId));
    const rules = (await listEligibilityRules(adminCtx(b))).filter((r) => lineages.has(r.templateLineageId));
    const h = leaveTypeConfigHealth({
      // An earning method IS set, deliberately: it leaves the rule/table state as the only thing that can
      // colour this card, so the case cannot pass for the wrong reason.
      leaveType: {
        id: typeId,
        name: 'Medical Leave',
        accrualMethod: 'grant_on_hire_prorated',
        accrualUnconfigured: false,
        daysFromLeaveCreditOnly: false, // 3fb1a611 fix pass — required on HealthLeaveType
        archived: false,
        defaultEntitlementTemplateLineageId: null,
        earnedMethodNotAnnualLeave: false,
      },
      templates,
      rules,
      grades: [],
      today: TODAY,
    });
    expect(h.soleTableApplies, 'a rule in force claims this type — its one live table is NOT automatic').toBe(false);
    expect(h.status).toBe('blocked');
    expect(h.findings).toContain('no_rule_in_force');
    // …and the surviving table keeps its own amber marker, which `soleTableApplies` would have silenced.
    expect(h.tablesWithoutRule).toEqual(['Medical — NEW']);
  });
});

describe('r209 · the shared pool reads as ONE figure, and refuses when it is spent', () => {
  /**
   * SIX TYPES, ONE POOL. `balance_source_type_id` is proven for one borrower already
   * (test/leave-balance-source-upl.test.ts); the plan asks it to carry the six Special Leave types, and
   * asks that the employee see one figure with the contributors named. `leaveBalances` did neither — it
   * grouped the ledger by leave type, so every borrower showed its own permanently empty ledger.
   */
  it('every member of the pool shows the SAME balance, and names the others', async () => {
    const pool = await leaveTypeRow({ name: 'Special Leave' });
    const members = [];
    for (const n of ['Marriage Leave', 'Study Leave', 'Examination Leave']) {
      members.push(await leaveTypeRow({ name: n, balanceSourceTypeId: pool }));
    }
    const { employmentId } = await hireWithCtx();
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: pool,
      entryType: 'accrual',
      days: '10.00',
      effectiveOn: '2026-01-01',
    });

    const rows = await leaveBalances(adminCtx(b), employmentId, 'en', { includeHidden: true });
    const byId = new Map(rows.map((r) => [r.leaveTypeId, r]));
    // ⚠️ ASSERTED ON A BORROWER FIRST, ON PURPOSE. The POOL's own row read 10 before r209 as well, so a
    // loop that started there would pass its first two assertions against the old behaviour and fail
    // later, on the descriptor — which is a much weaker statement than "the borrower's figure was wrong".
    expect(byId.get(members[0])!.balance, 'the borrower shows the POOL, not its own empty ledger').toBe(10);
    expect(byId.get(members[0])!.available).toBe(10);
    for (const id of [...members, pool]) {
      const row = byId.get(id);
      expect(row, id).toBeTruthy();
      // ONE FIGURE. Before r209 the three borrowers each read 0.00 here while the pool read 10.
      expect(row!.balance, `balance of ${row!.leaveType}`).toBe(10);
      expect(row!.available, `available of ${row!.leaveType}`).toBe(10);
      expect(row!.sharedBalance).not.toBeNull();
      expect(row!.sharedBalance!.sourceLeaveTypeName).toBe('Special Leave');
      // …and the contributors are NAMED, so nobody has to guess whether the number is per type or shared.
      expect(new Set(row!.sharedBalance!.contributingLeaveTypes)).toEqual(
        new Set(['Special Leave', 'Marriage Leave', 'Study Leave', 'Examination Leave']),
      );
    }
    // A type outside the pool is untouched — this pass must be invisible to every ordinary leave type.
    const outsider = await leaveTypeRow({ name: 'Annual Leave' });
    const again = await leaveBalances(adminCtx(b), employmentId, 'en', { includeHidden: true });
    expect(again.find((r) => r.leaveTypeId === outsider)?.sharedBalance ?? null).toBeNull();
  });

  /**
   * ⚠️ THE OTHER HALF OF A POOLED ROW, WHICH THE FIRST CUT LEFT BEHIND AND THEREBY MADE WORSE.
   *
   * The pooling pass replaces a borrower's balance / accrued / taken with the SOURCE's. Every remaining
   * figure — YTD Entitled, Carried Forward, Adjustment, Forfeited — and the entitlement STATUS came from
   * the borrower's OWN breakdown, which describes a leave type that has no entitlement table and by design
   * never will. The row therefore read "YTD Entitled 0.00 · Balance 10.00" under a red notice whose tip
   * says "This leave type has no entitlement table set up… Create an entitlement table for it" — over days
   * the employee can in fact spend, and instructing HR to do the one thing that would BREAK the pool.
   * Before r209 that row was a silent 0.00; a wrong instruction is worse than the silence it replaced.
   */
  it('a BORROWER tells the POOL’s entitlement story — never “create a table” over days it can spend', async () => {
    const pool = await leaveTypeRow({ name: 'Annual Leave' });
    const borrower = await leaveTypeRow({ name: 'Emergency Leave', balanceSourceTypeId: pool });
    await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: pool,
      name: 'Annual — all staff',
      serviceBands: [{ fromYears: 0, toYears: null, days: 10, carryForwardDays: 0, maxBalanceDays: null }],
      validFrom: '2026-01-01',
    });
    const { employmentId } = await hireWithCtx();
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const rows = await employeeBalanceRows(adminCtx(b), employmentId, TODAY, 'en');
    const byId = new Map(rows.map((r) => [r.leaveTypeId, r]));
    const src = byId.get(pool)!;
    const bor = byId.get(borrower)!;

    // The pooled figure itself is unchanged — this case is about everything printed BESIDE it.
    expect(bor.balance, 'the borrower still shows the pool').toBe(10);
    // THE ASSERTION THE CASE TURNS ON: a leave type that borrows is not a leave type missing a table.
    expect(bor.entitlementStatus).not.toBe('no_entitlement_table');
    // The pool's story, whole, so the row cannot contradict itself in any column.
    expect(src.entitlementStatus).toBe('granted');
    expect(bor.entitlementStatus).toBe(src.entitlementStatus);
    expect(bor.ytdEntitled, 'YTD Entitled beside a balance of 10.00').toBe(10);
    expect(bor.ytdEntitled).toBe(src.ytdEntitled);
    expect(bor.entitlementTemplateName).toBe('Annual — all staff');
    // …and the caption that says WHOSE figure it is is still there, so one pool never reads as two.
    expect(bor.sharedBalance!.sourceLeaveTypeName).toBe('Annual Leave');
  });

  it('every grid that captions a pooled balance looks its story up through the pool, not the row', () => {
    // AGENTS rule 17 — the defect lives in the CONTRACT between the pooling pass (core/read.ts) and each
    // grid's breakdown lookup, so a unit test of either half passes throughout. The employee's own grid,
    // HR's grid + its export, and the Personnel profile all show the pooled figure; all three must resolve
    // the breakdown through `balanceStoryTypeId` or the contradiction comes back on the one that does not.
    for (const rel of [
      // r302 (6c9802c9): the employee's own balances are read per leave year in core/my-leave.ts, which is
      // where the pool lookup moved with them (the page no longer resolves any breakdown itself).
      'core/my-leave.ts',
      'app/leave/employee-balances/rows.ts',
      'app/admin/personnel/[employmentId]/page.tsx',
    ]) {
      expect(read(rel), rel).toContain('balanceStoryTypeId(');
    }
    // …and it stays DB-free, so the client grids can keep sharing one definition of "whose figure is this".
    expect(read('lib/shared-leave-balance.ts')).not.toMatch(/from '(\.\.\/)?(db|core)\//);
  });

  it('a pending application on ONE member reduces Available on ALL of them', async () => {
    // This is the engine's own rule (`balanceSpenderTypeIds`): a pending Marriage application reserves the
    // pool, so the pool's own Available must fall too — otherwise the screen offers days the submit guard
    // then refuses, which is the one disagreement that must not exist.
    const pool = await leaveTypeRow({ name: 'Special Leave' });
    const marriage = await leaveTypeRow({ name: 'Marriage Leave', balanceSourceTypeId: pool });
    const study = await leaveTypeRow({ name: 'Study Leave', balanceSourceTypeId: pool });
    const { ctx, employmentId } = await hireWithCtx();
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: pool,
      entryType: 'accrual',
      days: '10.00',
      effectiveOn: '2026-01-01',
    });

    await requestLeave(ctx, {
      employmentId,
      leaveTypeId: marriage,
      startDate: '2026-06-01',
      endDate: '2026-06-04',
      today: '2026-05-01',
    });

    const rows = await leaveBalances(adminCtx(b), employmentId, 'en', { includeHidden: true });
    const byId = new Map(rows.map((r) => [r.leaveTypeId, r]));
    for (const id of [pool, marriage, study]) {
      expect(byId.get(id)!.pending, id).toBe(4);
      expect(byId.get(id)!.available, id).toBe(6);
      expect(byId.get(id)!.balance, id).toBe(10);
    }
  });

  it('an application that exceeds the shared balance is REFUSED, across two different member types', async () => {
    // The refusal path the plan asks to verify before pointing six types at one pool. The days are spent
    // by one member and the next member is refused — the pool, not the type, is what runs out.
    const pool = await leaveTypeRow({ name: 'Special Leave' });
    const marriage = await leaveTypeRow({ name: 'Marriage Leave', balanceSourceTypeId: pool });
    const study = await leaveTypeRow({ name: 'Study Leave', balanceSourceTypeId: pool });
    const { ctx, employmentId } = await hireWithCtx();
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: pool,
      entryType: 'accrual',
      days: '10.00',
      effectiveOn: '2026-01-01',
    });

    // 8 of the 10 days, taken under Marriage Leave.
    await requestLeave(ctx, {
      employmentId,
      leaveTypeId: marriage,
      startDate: '2026-06-01',
      endDate: '2026-06-08',
      today: '2026-05-01',
    });
    // 2 remain, so 2 under STUDY leave is fine…
    await requestLeave(ctx, {
      employmentId,
      leaveTypeId: study,
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      today: '2026-05-01',
    });
    // …and the eleventh day is refused, under a THIRD type that has never been used.
    const examination = await leaveTypeRow({ name: 'Examination Leave', balanceSourceTypeId: pool });
    await expect(
      requestLeave(ctx, {
        employmentId,
        leaveTypeId: examination,
        startDate: '2026-08-03',
        endDate: '2026-08-03',
        today: '2026-05-01',
      }),
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
  });
});
