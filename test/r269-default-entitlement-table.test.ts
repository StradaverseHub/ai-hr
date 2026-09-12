/**
 * r269 · 76ffdcf2 — THE DEFAULT ENTITLEMENT TABLE, and the sentences that wrongly made a benefit scheme
 * a precondition for entitlement.
 *
 * ── WHAT THE REPORTER WAS REACTING TO ────────────────────────────────────────────────────────────────
 * The sentence they quoted was OURS, shipped by r266's rename (`3a14035e`): "No benefit scheme covers
 * this employee yet, so no entitlement table reaches them and no days have been granted." That asserts a
 * chain of cause and effect the engine never followed — 34 employees on production held 2026 Annual Leave
 * days while their profile said exactly that. What IS true is narrower: a leave type with two or more
 * tables and no MATCHING scheme resolves to nothing, because the resolver refuses to guess which of
 * several tables a person should get (r193 fault 3).
 *
 * So this item is two halves and both are pinned here:
 *   §A  THE BEHAVIOUR — a leave type may name a DEFAULT entitlement table, and an employee no scheme
 *       covers receives it instead of nothing. Against the real engine, in a real database.
 *   §B  THE SAFETY PROPERTIES that must survive it, each of which a future round could erase by
 *       "simplifying" the fallback: a matching scheme always wins; the sole-table answer still wins; a
 *       STOPPED default applies to nobody; a default belonging to another leave type is refused; and with
 *       NO default the answer is still nothing, so the system never invents days (`noEntitlementOpinion`).
 *   §C  THE WORDS — the causal claims are gone in all six locales, and the screens render the new states.
 *
 * ── NON-VACUITY ──────────────────────────────────────────────────────────────────────────────────────
 * Delete the `defaultTemplateByType` fallback branch from `winnerFor` (core/entitlement-template.ts) and
 * §A's "an employee no benefit scheme covers receives the leave type's default table" fails on
 * `expect(won?.templateName).toBe(DEFAULT_TABLE)` — received null.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  buildTemplateEntitlementResolver,
  createEligibilityRule,
  createEntitlementTemplate,
  eligibilityNoticeFrom,
  explainEntitlementEligibilityFor,
  retireEntitlementTemplate,
  setLeaveTypeDefaultTemplate,
} from '../core/entitlement-template';
import { entitlementCoverageFor } from '../core/leave';
import { benefitSchemeView } from '../core/entitlement-scheme-view';
import { leaveTypeConfigHealth } from '../lib/leave-config-health';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Dict = Record<string, unknown>;
const getPath = (obj: unknown, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

/** A date far enough after HIRED that the 5+ band applies, and never derived from a hardcoded future. */
const HIRED = '2018-01-01';
const AS_OF = '2026-06-30';
const SCHEME_TABLE = 'Grade Permanent 16 - 19';
const DEFAULT_TABLE = 'Company standard';

const BANDS = [
  { fromYears: 0, toYears: 2, days: 20 },
  { fromYears: 2, toYears: 5, days: 22 },
  { fromYears: 5, toYears: null, days: 24 },
];
/** Deliberately different figures, so "which table answered" is readable off the DAYS alone. */
const DEFAULT_BANDS = [
  { fromYears: 0, toYears: 2, days: 8 },
  { fromYears: 2, toYears: null, days: 14 },
];

let b: Base;

async function newLeaveType(tenantId: string, name: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId, code: `DEF_${randomUUID().slice(0, 6).toUpperCase()}`, name, paid: true })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function hire(name: string): Promise<string> {
  const { employmentId } = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: HIRED,
  } as never);
  return employmentId;
}

/** The ONE batched matcher the engines use — asked exactly as they ask it. No second resolver here. */
async function winner(employmentId: string, leaveTypeId: string, asOf = AS_OF) {
  return withTenant(adminCtx(b), async (tx) => {
    const r = await buildTemplateEntitlementResolver(tx, {
      employmentIds: [employmentId],
      leaveTypeIds: [leaveTypeId],
      asOf,
    });
    return { won: r.winnerFor(employmentId, leaveTypeId), band: r.bandFor(employmentId, leaveTypeId, 8) };
  });
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

// ── §A · THE BEHAVIOUR ────────────────────────────────────────────────────────────────────────────────
describe('§A · an employee no benefit scheme covers receives the leave type’s default table', () => {
  it('two tables and a scheme that excludes them: nothing today, the default table once one is named', async () => {
    const ctx = adminCtx(b);
    const typeId = await newLeaveType(b.tenantId, 'Annual Leave');
    const scheme = await createEntitlementTemplate(ctx, {
      leaveTypeId: typeId,
      name: SCHEME_TABLE,
      serviceBands: BANDS,
      validFrom: '2020-01-01',
    });
    const fallback = await createEntitlementTemplate(ctx, {
      leaveTypeId: typeId,
      name: DEFAULT_TABLE,
      serviceBands: DEFAULT_BANDS,
      validFrom: '2020-01-01',
    });
    // A scheme narrowed to a department this employee is NOT in — the production shape exactly: one
    // scheme over four job grades, 68 of 74 employees outside it.
    await createEligibilityRule(ctx, {
      name: 'Permanent 16 - 19',
      templateLineageId: scheme.lineageId,
      criteria: { departmentIds: [b.deptB] },
      validFrom: '2020-01-01',
    });
    const emp = await hire('Uncovered Employee');

    // BEFORE: two tables, a scheme in force that excludes them ⇒ no opinion. This is today's behaviour and
    // it is not a bug on its own — the engine refuses to guess between two tables nobody pointed at.
    expect((await winner(emp, typeId)).won).toBeNull();
    expect(await entitlementCoverageFor(ctx, { employmentId: emp, leaveTypeId: typeId, asOf: AS_OF })).toBe(
      'no_scheme',
    );

    await setLeaveTypeDefaultTemplate(ctx, { leaveTypeId: typeId, templateLineageId: fallback.lineageId });

    // AFTER: the default answers, by name, and the DAYS come from the default's own bands rather than the
    // scheme table's — which is how this assertion distinguishes "the default won" from "anything won".
    const { won, band } = await winner(emp, typeId);
    expect(won?.templateName).toBe(DEFAULT_TABLE);
    expect(won?.viaDefaultTemplate).toBe(true);
    expect(won?.viaSoleTemplate).toBe(false);
    expect(won?.ruleName).toBeNull();
    expect(band?.days).toBe(14);
    expect(await entitlementCoverageFor(ctx, { employmentId: emp, leaveTypeId: typeId, asOf: AS_OF })).toBe(
      'covered_by_default',
    );
  });

  it('clearing the default puts the employee back to NO OPINION — never to zero days', async () => {
    const ctx = adminCtx(b);
    const typeId = await newLeaveType(b.tenantId, 'Annual Leave');
    await createEntitlementTemplate(ctx, { leaveTypeId: typeId, name: 'A', serviceBands: BANDS, validFrom: '2020-01-01' });
    const fallback = await createEntitlementTemplate(ctx, {
      leaveTypeId: typeId,
      name: DEFAULT_TABLE,
      serviceBands: DEFAULT_BANDS,
      validFrom: '2020-01-01',
    });
    const emp = await hire('Cleared Default');

    await setLeaveTypeDefaultTemplate(ctx, { leaveTypeId: typeId, templateLineageId: fallback.lineageId });
    expect((await winner(emp, typeId)).won?.templateName).toBe(DEFAULT_TABLE);

    await setLeaveTypeDefaultTemplate(ctx, { leaveTypeId: typeId, templateLineageId: null });
    // NULL, not a zero-day band: `noEntitlementOpinion` reads this as "post nothing", which is what stops
    // a cleared default clawing days back off everybody it used to reach.
    expect((await winner(emp, typeId)).won).toBeNull();
    expect((await winner(emp, typeId)).band).toBeNull();
  });

  it('the explain panel names the default table as the winner, with no scheme name', async () => {
    const ctx = adminCtx(b);
    const typeId = await newLeaveType(b.tenantId, 'Annual Leave');
    await createEntitlementTemplate(ctx, { leaveTypeId: typeId, name: 'A', serviceBands: BANDS, validFrom: '2020-01-01' });
    const fallback = await createEntitlementTemplate(ctx, {
      leaveTypeId: typeId,
      name: DEFAULT_TABLE,
      serviceBands: DEFAULT_BANDS,
      validFrom: '2020-01-01',
    });
    const emp = await hire('Explained Default');
    await setLeaveTypeDefaultTemplate(ctx, { leaveTypeId: typeId, templateLineageId: fallback.lineageId });

    const explanation = await explainEntitlementEligibilityFor(ctx, {
      employmentId: emp,
      leaveTypeId: typeId,
      asOf: AS_OF,
    });
    expect(explanation.defaultTableApplies).toBe(true);
    expect(explanation.soleTableApplies).toBe(false);
    // The VERDICT is decided once, by the shared mapping both screens read — never re-derived per screen.
    const notice = eligibilityNoticeFrom(explanation);
    expect(notice.verdict).toBe('default_table');
    expect(notice.defaultTableApplies).toBe(true);
    expect(notice.winningTableName).toBe(DEFAULT_TABLE);
    expect(notice.winningRuleName).toBeNull();
  });
});

// ── §B · THE SAFETY PROPERTIES ────────────────────────────────────────────────────────────────────────
describe('§B · what the default must never do', () => {
  it('A MATCHING SCHEME ALWAYS WINS — a leave-type default can never reverse an exclusion HR wrote', async () => {
    const ctx = adminCtx(b);
    const typeId = await newLeaveType(b.tenantId, 'Annual Leave');
    const scheme = await createEntitlementTemplate(ctx, {
      leaveTypeId: typeId,
      name: SCHEME_TABLE,
      serviceBands: BANDS,
      validFrom: '2020-01-01',
    });
    const fallback = await createEntitlementTemplate(ctx, {
      leaveTypeId: typeId,
      name: DEFAULT_TABLE,
      serviceBands: DEFAULT_BANDS,
      validFrom: '2020-01-01',
    });
    // A scheme this employee DOES match, pointing at the other table.
    await createEligibilityRule(ctx, {
      name: 'Covers everyone here',
      templateLineageId: scheme.lineageId,
      criteria: { departmentIds: [b.deptA] },
      validFrom: '2020-01-01',
    });
    await setLeaveTypeDefaultTemplate(ctx, { leaveTypeId: typeId, templateLineageId: fallback.lineageId });
    const emp = await hire('Covered By Scheme');

    const { won, band } = await winner(emp, typeId);
    expect(won?.templateName).toBe(SCHEME_TABLE);
    expect(won?.ruleName).toBe('Covers everyone here');
    expect(won?.viaDefaultTemplate).toBe(false);
    expect(band?.days).toBe(24); // the SCHEME table's 5+ band, not the default's 14
  });

  it('the r193 sole-table answer still wins, and is still reported as the sole table', async () => {
    const ctx = adminCtx(b);
    const typeId = await newLeaveType(b.tenantId, 'Hospitalization Leave');
    const only = await createEntitlementTemplate(ctx, {
      leaveTypeId: typeId,
      name: 'Everyone',
      serviceBands: BANDS,
      validFrom: '2020-01-01',
    });
    await setLeaveTypeDefaultTemplate(ctx, { leaveTypeId: typeId, templateLineageId: only.lineageId });
    const emp = await hire('Sole Table');

    const { won } = await winner(emp, typeId);
    expect(won?.viaSoleTemplate).toBe(true);
    expect(won?.viaDefaultTemplate).toBe(false);
  });

  it('a STOPPED default applies to nobody — it never resolves against some other version', async () => {
    const ctx = adminCtx(b);
    const typeId = await newLeaveType(b.tenantId, 'Annual Leave');
    // THREE tables on purpose: stopping the default must leave TWO in force, or the r193 sole-table gate
    // would answer instead and this test would pass for the wrong reason.
    await createEntitlementTemplate(ctx, { leaveTypeId: typeId, name: 'A', serviceBands: BANDS, validFrom: '2020-01-01' });
    await createEntitlementTemplate(ctx, { leaveTypeId: typeId, name: 'B', serviceBands: BANDS, validFrom: '2020-01-01' });
    const fallback = await createEntitlementTemplate(ctx, {
      leaveTypeId: typeId,
      name: DEFAULT_TABLE,
      serviceBands: DEFAULT_BANDS,
      validFrom: '2020-01-01',
    });
    const emp = await hire('Stopped Default');
    await setLeaveTypeDefaultTemplate(ctx, { leaveTypeId: typeId, templateLineageId: fallback.lineageId });
    expect((await winner(emp, typeId)).won?.templateName).toBe(DEFAULT_TABLE);

    // Stopped from a date INSIDE the window being resolved: `inForce` is half-open, so a validTo equal to
    // `asOf` means not in force on `asOf`.
    await retireEntitlementTemplate(ctx, { lineageId: fallback.lineageId, validTo: AS_OF });
    expect((await winner(emp, typeId)).won).toBeNull();
  });

  it('a default pointing at ANOTHER leave type’s table is refused at write time', async () => {
    const ctx = adminCtx(b);
    const typeA = await newLeaveType(b.tenantId, 'Annual Leave');
    const typeB = await newLeaveType(b.tenantId, 'Medical Leave');
    const foreign = await createEntitlementTemplate(ctx, {
      leaveTypeId: typeB,
      name: 'Medical table',
      serviceBands: BANDS,
      validFrom: '2020-01-01',
    });
    await expect(
      setLeaveTypeDefaultTemplate(ctx, { leaveTypeId: typeA, templateLineageId: foreign.lineageId }),
    ).rejects.toThrow(/different leave type/i);
  });

  it('WITH NO DEFAULT NOTHING IS INVENTED — two tables, no scheme, no default ⇒ no opinion', async () => {
    const ctx = adminCtx(b);
    const typeId = await newLeaveType(b.tenantId, 'Annual Leave');
    await createEntitlementTemplate(ctx, { leaveTypeId: typeId, name: 'A', serviceBands: BANDS, validFrom: '2020-01-01' });
    await createEntitlementTemplate(ctx, { leaveTypeId: typeId, name: 'B', serviceBands: BANDS, validFrom: '2020-01-01' });
    const emp = await hire('No Default Anywhere');
    const { won, band } = await winner(emp, typeId);
    expect(won).toBeNull();
    expect(band).toBeNull();
  });
});

// ── §B2 · THE DERIVED PROFILE CARD AND THE HEALTH DERIVATION ─────────────────────────────────────────
describe('§B2 · the profile card and the config health read the engine’s own answer', () => {
  it('benefitSchemeView reports "covered by the default only", and names the table and the days', async () => {
    const ctx = adminCtx(b);
    const typeId = await newLeaveType(b.tenantId, 'Annual Leave');
    await createEntitlementTemplate(ctx, { leaveTypeId: typeId, name: 'A', serviceBands: BANDS, validFrom: '2020-01-01' });
    const fallback = await createEntitlementTemplate(ctx, {
      leaveTypeId: typeId,
      name: DEFAULT_TABLE,
      serviceBands: DEFAULT_BANDS,
      validFrom: '2020-01-01',
    });
    const emp = await hire('Card Default');
    await setLeaveTypeDefaultTemplate(ctx, { leaveTypeId: typeId, templateLineageId: fallback.lineageId });

    const view = await benefitSchemeView(ctx, emp, AS_OF);
    expect(view.coveredByDefaultOnly).toBe(true);
    // NOT the ambiguity state: no rules disagree, because no rule was consulted at all.
    expect(view.ambiguous).toBe(false);
    expect(view.schemeName).toBeNull();
    const row = view.perType.find((r) => r.leaveTypeId === typeId);
    expect(row?.viaDefaultTemplate).toBe(true);
    expect(row?.templateName).toBe(DEFAULT_TABLE);
    // "how many days that gives them" — the plan's promise, off the engine's own band resolver.
    expect(row?.daysAtService).toBe(14);
  });

  it('config health stops calling a leave type BLOCKED once a default table is in force', async () => {
    const type = {
      id: 'lt-1',
      name: 'Annual Leave',
      accrualMethod: 'full_upfront',
      accrualUnconfigured: false,
      archived: false,
    };
    const templates = [
      { lineageId: 'l-a', leaveTypeId: 'lt-1', name: 'A', validFrom: '2020-01-01', validTo: null, serviceBands: BANDS },
      { lineageId: 'l-d', leaveTypeId: 'lt-1', name: DEFAULT_TABLE, validFrom: '2020-01-01', validTo: null, serviceBands: DEFAULT_BANDS },
    ];
    const without = leaveTypeConfigHealth({ leaveType: type, templates, rules: [], grades: [], today: AS_OF });
    expect(without.findings).toContain('no_rule_in_force');
    expect(without.status).toBe('blocked');

    const withDefault = leaveTypeConfigHealth({
      leaveType: { ...type, defaultEntitlementTemplateLineageId: 'l-d' },
      templates,
      rules: [],
      grades: [{ id: 'g1', name: 'GRADE 16' }],
      today: AS_OF,
    });
    expect(withDefault.findings).not.toContain('no_rule_in_force');
    expect(withDefault.defaultTableApplies).toBe(true);
    expect(withDefault.defaultTableName).toBe(DEFAULT_TABLE);
    // The default table is reached by everyone no scheme covers, so it is not "a table nobody receives"…
    expect(withDefault.tablesWithoutRule).toEqual(['A']);
    // …and no job grade falls through it.
    expect(withDefault.gradesWithoutTable).toEqual([]);
  });

  it('a default whose only version has been STOPPED is not treated as in force by the health check', () => {
    const health = leaveTypeConfigHealth({
      leaveType: {
        id: 'lt-1',
        name: 'Annual Leave',
        accrualMethod: 'full_upfront',
        accrualUnconfigured: false,
        archived: false,
        defaultEntitlementTemplateLineageId: 'l-d',
      },
      // Two tables still in force after the default is stopped — otherwise the sole-table gate answers
      // and the finding would be absent for a reason that has nothing to do with the default.
      templates: [
        { lineageId: 'l-a', leaveTypeId: 'lt-1', name: 'A', validFrom: '2020-01-01', validTo: null, serviceBands: BANDS },
        { lineageId: 'l-b', leaveTypeId: 'lt-1', name: 'B', validFrom: '2020-01-01', validTo: null, serviceBands: BANDS },
        { lineageId: 'l-d', leaveTypeId: 'lt-1', name: DEFAULT_TABLE, validFrom: '2020-01-01', validTo: '2026-01-01', serviceBands: DEFAULT_BANDS },
      ],
      rules: [],
      grades: [],
      today: AS_OF,
    });
    expect(health.defaultTableApplies).toBe(false);
    expect(health.findings).toContain('no_rule_in_force');
  });
});

// ── §C · THE WORDS ───────────────────────────────────────────────────────────────────────────────────
describe('§C · the sentences that made a scheme a precondition are gone, in six locales', () => {
  /** The English sentences r266 shipped, verbatim from `3a14035e`. None may survive anywhere. */
  const RETIRED_CLAIMS = [
    'so no entitlement table reaches them and no days have been granted',
    'Nobody receives an entitlement table until a scheme covers them',
    'so nothing can point you at one of its entitlement tables',
    'Nobody can receive them.',
  ];

  it('no English string anywhere still claims a scheme is why an employee has no entitlement', () => {
    const hits: string[] = [];
    const walk = (o: unknown, p: string) => {
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o as Dict)) walk(v, `${p}.${k}`);
      else if (typeof o === 'string' && RETIRED_CLAIMS.some((c) => o.includes(c))) hits.push(p);
    };
    walk(en, 'en');
    expect(hits).toEqual([]);
  });

  it('the profile card, the balance tip and the apply refusal say what a scheme actually does', () => {
    // A scheme CHOOSES between tables. It does not decide entitlement — that is the reporter's own
    // correction, and it is the substance of the rewrite.
    expect(en.admin.personnel.benefitScheme.derivedNote).toContain(
      'a benefit scheme decides which entitlement table this employee receives',
    );
    expect(en.admin.personnel.benefitScheme.derivedNote).toContain('never grants or removes days by itself');
    expect(en.me.leaveBalanceTable.statusNoEligibilityMatchTip).toContain(
      'it is not what decides whether somebody is entitled',
    );
    expect(en.leave.errors.insufficientBalanceNoScheme).toContain('or to set a default entitlement table for it');
  });

  it('where an employee is covered by no scheme, the card says which table they fall back to', () => {
    const ps = en.admin.personnel.benefitScheme;
    expect(ps.notCovered).toBe('Not covered by a scheme');
    expect(ps.notCoveredHint).toContain('default entitlement table for each leave type');
    expect(ps.viaDefault).toContain('{table}');
    expect(ps.derivedNoteDefault).toContain('Entitlement is never withheld because a scheme is missing');
  });

  it('every key this item minted or rewrote exists in all six catalogues and is translated', () => {
    const KEYS = [
      'admin.entitlementTemplates.defaultTableTitle',
      'admin.entitlementTemplates.defaultTableIntro',
      'admin.entitlementTemplates.defaultTableNone',
      'admin.entitlementTemplates.defaultTableNoTables',
      'admin.entitlementTemplates.defaultTableSave',
      'admin.entitlementTemplates.defaultTableBadge',
      'admin.entitlementTemplates.createWithDefaultTableNote',
      'admin.entitlementTemplates.healthDefaultTable',
      'admin.entitlementTemplates.explainWinnerDefault',
      'admin.personnel.benefitScheme.notCovered',
      'admin.personnel.benefitScheme.notCoveredHint',
      'admin.personnel.benefitScheme.viaDefault',
      'admin.personnel.benefitScheme.derivedNoteDefault',
      'admin.personnel.benefitScheme.empty',
      'admin.personnel.benefitScheme.derivedNote',
      'admin.personnel.benefitScheme.derivedNoteEmpty',
      'me.leaveBalanceTable.statusNoEligibilityMatch',
      'me.leaveBalanceTable.statusNoEligibilityMatchTip',
      'leave.errors.insufficientBalanceNoScheme',
      'leave.errors.insufficientBalanceNoSchemeOther',
      'leave.breakdown.statusNoEligibilityMatchTitle',
      'leave.breakdown.statusNoEligibilityMatchBody',
      'leave.breakdown.eligibilityNoRules',
      'admin.entitlementTemplates.rulesNone',
      'admin.entitlementTemplates.healthNoRuleInForce',
      'admin.entitlementTemplates.healthConfiguredVsActual',
      'admin.entitlementTemplates.healthTableWithoutRule',
      'admin.entitlementTemplates.coexistNote',
      'admin.entitlementTemplates.createNoRuleWarning',
      'admin.entitlementTemplates.createEndsSoleTableWarning',
      'admin.leaveConfigTypes.entitlementStep.schemeExplainer',
    ];
    for (const key of KEYS) {
      const enValue = getPath(en, key);
      expect(typeof enValue, key).toBe('string');
      for (const [loc, cat] of Object.entries(CATALOGUES)) {
        const v = getPath(cat, key);
        expect(typeof v, `${loc} ${key}`).toBe('string');
        expect((v as string).length, `${loc} ${key}`).toBeGreaterThan(0);
        if (loc !== 'en') expect(v, `${loc} ${key} untranslated`).not.toBe(enValue);
      }
    }
  });

  it('the screens render the new states — the picker, the badge and the card’s third state', () => {
    const block = read('app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
    expect(block).toContain("t('defaultTableTitle')");
    expect(block).toContain('setLeaveTypeDefaultTemplateAction');
    expect(block).toContain('data-testid="default-entitlement-table-select"');
    expect(block).toContain("t('defaultTableBadge')");
    // The picker is the SCOPED mount's: a per-type control on the unfiltered screen would be 24 saves.
    expect(block).toContain('{scoped && scopedType ? (');

    const profile = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(profile).toContain("tScheme('notCovered')");
    expect(profile).toContain("tScheme('notCoveredHint')");
    expect(profile).toContain("tScheme('derivedNoteDefault')");
    expect(profile).toContain("tScheme('viaDefault', { table: r.templateName })");

    // The write reprojects AFTER the transaction has committed — the ordering `setLeaveTypeRules` obeys.
    const actions = read('app/admin/leave/entitlements/templates/actions.ts');
    const body = actions.slice(actions.indexOf('export async function setLeaveTypeDefaultTemplateAction'));
    const head = body.slice(0, body.indexOf('saved(formData'));
    expect(head.indexOf('await setLeaveTypeDefaultTemplate(')).toBeGreaterThan(-1);
    expect(head.indexOf('await recomputeAfterSave(')).toBeGreaterThan(head.indexOf('await setLeaveTypeDefaultTemplate('));
  });
});
