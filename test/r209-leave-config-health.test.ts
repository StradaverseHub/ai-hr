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
 *      six actions call it, after the write and before the redirect.
 *   D. THE SHARED POOL, for SIX types at once. `balance_source_type_id` already works for one borrower
 *      (test/leave-balance-source-upl.test.ts). The approved plan asks it to carry six, and asks that the
 *      employee read ONE figure with the contributing types named — which `leaveBalances` did not do at all.
 *
 * NOTHING HERE WRITES CONFIGURATION ON THE REPORTER'S BEHALF. Every case builds its own fixture; the
 * deliverable is that the missing configuration is visible and the resolution explainable.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { leaveBalances } from '../core/read';
import {
  createEligibilityRule,
  createEntitlementTemplate,
  leaveTypeIdForRuleLineage,
  leaveTypeIdForTemplateLineage,
  updateEntitlementTemplate,
} from '../core/entitlement-template';
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
  accrualUnconfigured: false,
  archived: false,
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
    expect(block).toContain('<LeaveConfigHealthNotice health={scopedHealth} />');
    expect(block).toContain('<LeaveConfigHealthCard rows={allHealth} />');
    // ⚠️ THE "no rule points here" MARKER IS PER LEAVE TYPE, not one boolean for the whole table. The
    // unfiltered mount lists every type's tables together, so a single flag would either warn on a healthy
    // single-table type or stay silent on a broken multi-table one — and it is the same set the card above
    // it derives from, so the two cannot disagree about which zero is a fault.
    expect(block).toContain('!soleTableTypeIds.has(x.leaveTypeId)');
    expect(block).toContain("t('ruleNonePointsHere')");
    // …and the expiry badges on the rules table, judged on the lineage's CURRENT version only.
    expect(block).toContain("t('ruleExpiredBadge')");
    expect(block).toContain("t('ruleExpiringBadge')");
    expect(block).toContain('ruleHeadIds.has(x.id)');
    const page = read('app/admin/leave/entitlements/page.tsx');
    expect(page).toContain('leaveConfigHealthAll(');
    expect(page).toContain('<LeaveConfigHealthCard rows={configHealth} />');
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

    // 4. …and the recompute the six actions now fire is what closes the gap.
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
  it('all six entitlement writers recompute — after the service call, before the redirect', () => {
    const src = read('app/admin/leave/entitlements/templates/actions.ts');
    const writers = [
      ['createEntitlementTemplateAction', 'createEntitlementTemplate('],
      ['updateEntitlementTemplateAction', 'updateEntitlementTemplate('],
      ['retireEntitlementTemplateAction', 'retireEntitlementTemplate('],
      ['createEligibilityRuleAction', 'createEligibilityRule('],
      ['updateEligibilityRuleAction', 'updateEligibilityRule('],
      ['retireEligibilityRuleAction', 'retireEligibilityRule('],
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
