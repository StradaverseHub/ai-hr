/**
 * fe9c73bc — the staged, archive-first entitlement-configuration reset, run for real against seeded rows.
 *
 * Unlike the r180 script (which a test never executes, because it is gated on a production tenant id), this
 * tool takes its tenant on the command line and is therefore EXECUTED here, stage by stage, on a fixture
 * that carries one of every kind of row the approved plan names:
 *   · three entitlement tables (two in force, one ended) across two leave types, and two eligibility rules;
 *   · for two employees: three accruals (one dated at hire), THREE adjustments — one system-written
 *     (sys:profile_recalc:<id>, no batch), one with a human reason, one with a batch id — one debit
 *     attached to a real APPROVED leave request, one in_lieu_accrual;
 *   · three recalc-audit rows — one whose ledger_id points at an accrual, one pointing at the
 *     system-written adjustment, one with ledger_id NULL.
 *
 * `--include-system-adjustments` is OPT-IN (see the script header): without it the accruals stage is
 * byte-for-byte what it was before the flag existed, and the "default keeps all three" test pins that;
 * with it only the system-written adjustment joins the scope, its audit row goes with it, and the balance
 * moves by exactly that row's days.
 *
 * The plan's verdict per record kind is the assertion: configuration and generated entitlement CLEARED,
 * taken leave and manual adjustments KEPT, a written record in the archive tables FIRST, and the archive
 * VERIFIED inside the transaction (a short copy rolls the whole stage back).
 *
 * THE LAYER CHECK. entitlement_reset_archive.layer carried a CHECK from migration 0397 admitting only 'scheme'
 * and 'policy'; migration 0460 widens it to admit 'template' and 'rule', and the test database is migrated
 * fresh so it carries 0460. The script still PREFLIGHTS that CHECK and refuses while it is narrow — the
 * fail-closed guard for any environment 0460 has not reached — and one test below pins that by narrowing the
 * constraint back to 0397's definition inside the test and restoring exactly what it found.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { leaveBalances } from '../core/read';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { addDaysIso, leaveTypeConfigHealth } from '../lib/leave-config-health';
import { todayInKualaLumpur } from '../lib/hr-date';
import { entitlementResetArchiveCsv, listEntitlementResetArchive } from '../core/entitlement-archive';
import {
  formatReport,
  layerCheckAdmits,
  renderServiceBands,
  runEntitlementReset,
  surveyTenants,
  type Stage,
} from '../scripts/reset-entitlement-configuration';
import { EVERYONE_TEXT } from '../scripts/entitlement-criteria-words';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const URL_ = process.env.TEST_MIGRATION_DATABASE_URL!;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let b: Base;

/** The CHECK as the database currently defines it — read, never assumed, so the refusal test restores it exactly. */
const CHECK_SQL = sql`select pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = 'entitlement_reset_archive'::regclass and conname = 'entitlement_reset_archive_layer_check'`;
const dropCheck = () =>
  owner.db.execute(sql`ALTER TABLE entitlement_reset_archive DROP CONSTRAINT IF EXISTS entitlement_reset_archive_layer_check`);
const addCheck = (def: string) =>
  owner.db.execute(sql.raw(`ALTER TABLE entitlement_reset_archive ADD CONSTRAINT entitlement_reset_archive_layer_check ${def}`));
/** Migration 0397's definition, verbatim — what every environment without 0460 still has. */
const NARROW_DEF_0397 = "CHECK (layer IN ('scheme', 'policy'))";

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

// ── THE FIXTURE ──────────────────────────────────────────────────────────────────────────────────────
type Fx = {
  today: string;
  sickTypeId: string;
  gradeId: string;
  emp1: string; // ANNUAL: two accruals (one at hire) + one debit on an approved request
  emp2: string; // SICK: one accrual, three adjustments (system / human / batched), one in_lieu_accrual
  accrual1Id: string;
  /** The sys:profile_recalc adjustment — the ONLY adjustment --include-system-adjustments may clear. */
  sysAdjId: string;
  sysAdjReason: string;
  tplA: { lineageId: string; name: string };
  tplB: { lineageId: string; name: string };
  batchId: string;
  requestId: string;
};

async function seedFixture(): Promise<Fx> {
  const ctx = adminCtx(b);
  const today = todayInKualaLumpur();
  const hiredOn = addDaysIso(today, -365);
  const [sick] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code: 'SICK', name: 'Medical Leave', paid: true })
    .returning({ id: schema.leaveType.id });
  const [grade] = await owner.db
    .insert(schema.jobGrade)
    .values({ tenantId: b.tenantId, code: 'G1', name: 'Grade 1' })
    .returning({ id: schema.jobGrade.id });

  // Two tables in force (one per type), one ENDED version on ANNUAL inserted straight in.
  const inForceFrom = addDaysIso(today, -100);
  const tplA = await createEntitlementTemplate(ctx, {
    leaveTypeId: b.annualLeaveTypeId,
    name: 'Annual — Executive',
    serviceBands: [
      { fromYears: 0, toYears: 2, days: 14, carryForwardDays: 5, maxBalanceDays: 20 },
      { fromYears: 2, toYears: null, days: 18 },
    ],
    validFrom: inForceFrom,
  });
  const tplB = await createEntitlementTemplate(ctx, {
    leaveTypeId: sick.id,
    name: 'Medical — All',
    serviceBands: [{ fromYears: 0, toYears: null, days: 14 }],
    validFrom: inForceFrom,
  });
  await owner.db.insert(schema.entitlementTemplate).values({
    tenantId: b.tenantId,
    lineageId: randomUUID(),
    leaveTypeId: b.annualLeaveTypeId,
    name: 'Annual — old',
    serviceBands: [{ fromYears: 0, toYears: null, days: 10 }],
    validFrom: addDaysIso(today, -400),
    validTo: addDaysIso(today, -200),
  });
  await createEligibilityRule(ctx, { name: 'Everyone', templateLineageId: tplA.lineageId, criteria: {}, validFrom: inForceFrom });
  await createEligibilityRule(ctx, {
    name: 'Grade 1 at Acme',
    templateLineageId: tplB.lineageId,
    criteria: { gradeIds: [grade.id], companyIds: [b.companyId] },
    validFrom: inForceFrom,
  });

  const hire = (fullName: string, email: string) =>
    hireEmployee(ctx, {
      person: { fullName, primaryEmail: email },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn,
      gradeId: null,
      grantLeaveTypes: [],
    });
  const e1 = await hire('Mei Ling', 'meiling.fe9c73bc@t.local');
  const e2 = await hire('Ahmad', 'ahmad.fe9c73bc@t.local');

  const [req] = await owner.db
    .insert(schema.leaveRequest)
    .values({
      tenantId: b.tenantId,
      employmentId: e1.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: addDaysIso(today, -10),
      endDate: addDaysIso(today, -10),
      days: '1.00',
      status: 'approved',
    })
    .returning({ id: schema.leaveRequest.id });
  const [batch] = await owner.db
    .insert(schema.leaveAdjustmentBatch)
    .values({
      tenantId: b.tenantId,
      actorUserId: b.adminUserId,
      days: '2.00',
      effectiveOn: addDaysIso(today, -20),
      reason: 'Bonus days',
      targetMode: 'individual',
      targetedCount: 1,
      writtenCount: 1,
    })
    .returning({ id: schema.leaveAdjustmentBatch.id });

  const row = (
    employmentId: string,
    leaveTypeId: string,
    entryType: 'accrual' | 'debit' | 'adjustment' | 'in_lieu_accrual',
    days: string,
    effectiveOn: string,
    extra: Partial<typeof schema.leaveLedger.$inferInsert> = {},
  ) =>
    owner.db
      .insert(schema.leaveLedger)
      .values({ tenantId: b.tenantId, employmentId, leaveTypeId, entryType, days, effectiveOn, ...extra })
      .returning({ id: schema.leaveLedger.id });
  const [accrual1] = await row(e1.employmentId, b.annualLeaveTypeId, 'accrual', '14.00', hiredOn);
  await row(e1.employmentId, b.annualLeaveTypeId, 'accrual', '14.00', addDaysIso(today, -30));
  await row(e1.employmentId, b.annualLeaveTypeId, 'debit', '-1.00', addDaysIso(today, -10), { sourceRequestId: req.id });
  await row(e2.employmentId, sick.id, 'accrual', '10.00', addDaysIso(today, -30));
  await row(e2.employmentId, sick.id, 'adjustment', '2.00', addDaysIso(today, -20), { adjustmentBatchId: batch.id, reason: 'Bonus days' });
  await row(e2.employmentId, sick.id, 'adjustment', '3.00', addDaysIso(today, -15), { reason: 'CNY 2026' });
  const sysAdjReason = `sys:profile_recalc:${e2.employmentId}`;
  const [sysAdj] = await row(e2.employmentId, sick.id, 'adjustment', '-4.00', addDaysIso(today, -12), { reason: sysAdjReason });
  await row(e2.employmentId, sick.id, 'in_lieu_accrual', '1.00', addDaysIso(today, -5));

  await owner.db.insert(schema.leaveEntitlementRecalcAudit).values([
    {
      tenantId: b.tenantId,
      employmentId: e1.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      previousEntitlement: '0.00',
      newEntitlement: '14.00',
      delta: '14.00',
      reason: 'employment_changed',
      effectiveOn: hiredOn,
      ledgerId: accrual1.id,
    },
    {
      tenantId: b.tenantId,
      employmentId: e2.employmentId,
      leaveTypeId: sick.id,
      previousEntitlement: '10.00',
      newEntitlement: '6.00',
      delta: '-4.00',
      reason: 'employment_changed',
      effectiveOn: addDaysIso(today, -12),
      ledgerId: sysAdj.id,
    },
    {
      tenantId: b.tenantId,
      employmentId: e2.employmentId,
      leaveTypeId: sick.id,
      previousEntitlement: '10.00',
      newEntitlement: '10.00',
      delta: '0.00',
      reason: 'grade_changed',
      effectiveOn: addDaysIso(today, -30),
      ledgerId: null,
    },
  ]);

  return {
    today,
    sickTypeId: sick.id,
    gradeId: grade.id,
    emp1: e1.employmentId,
    emp2: e2.employmentId,
    accrual1Id: accrual1.id,
    sysAdjId: sysAdj.id,
    sysAdjReason,
    tplA: { lineageId: tplA.lineageId, name: 'Annual — Executive' },
    tplB: { lineageId: tplB.lineageId, name: 'Medical — All' },
    batchId: batch.id,
    requestId: req.id,
  };
}

// ── COUNTING HELPERS — every assertion is a count read straight off the table. ────────────────────────
const n = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
const cnt = {
  templates: () => n(owner.db.select({ n: sql<number>`count(*)::int` }).from(schema.entitlementTemplate).where(eq(schema.entitlementTemplate.tenantId, b.tenantId))),
  rules: () => n(owner.db.select({ n: sql<number>`count(*)::int` }).from(schema.entitlementEligibilityRule).where(eq(schema.entitlementEligibilityRule.tenantId, b.tenantId))),
  ledger: (entryType?: string) =>
    n(
      owner.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.leaveLedger)
        .where(
          entryType
            ? and(eq(schema.leaveLedger.tenantId, b.tenantId), sql`${schema.leaveLedger.entryType} = ${entryType}`)
            : eq(schema.leaveLedger.tenantId, b.tenantId),
        ),
    ),
  audit: () => n(owner.db.select({ n: sql<number>`count(*)::int` }).from(schema.leaveEntitlementRecalcAudit).where(eq(schema.leaveEntitlementRecalcAudit.tenantId, b.tenantId))),
  entArchive: (layer?: string) =>
    n(
      owner.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.entitlementResetArchive)
        .where(
          layer
            ? and(eq(schema.entitlementResetArchive.tenantId, b.tenantId), eq(schema.entitlementResetArchive.layer, layer))
            : eq(schema.entitlementResetArchive.tenantId, b.tenantId),
        ),
    ),
  ledArchive: (layer?: string) =>
    n(
      owner.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.leaveLedgerResetArchive)
        .where(
          layer
            ? and(eq(schema.leaveLedgerResetArchive.tenantId, b.tenantId), eq(schema.leaveLedgerResetArchive.layer, layer))
            : eq(schema.leaveLedgerResetArchive.tenantId, b.tenantId),
        ),
    ),
};

type Snapshot = Record<string, number>;
async function snapshot(): Promise<Snapshot> {
  return {
    templates: await cnt.templates(),
    rules: await cnt.rules(),
    ledger: await cnt.ledger(),
    accrual: await cnt.ledger('accrual'),
    adjustment: await cnt.ledger('adjustment'),
    debit: await cnt.ledger('debit'),
    in_lieu_accrual: await cnt.ledger('in_lieu_accrual'),
    audit: await cnt.audit(),
    entArchive: await cnt.entArchive(),
    ledArchive: await cnt.ledArchive(),
  };
}

const run = (stage: Stage, apply: boolean, extra: Partial<Parameters<typeof runEntitlementReset>[1]> = {}) =>
  runEntitlementReset(URL_, { tenantId: b.tenantId, stage, apply, tag: `fe9c73bc-test-${stage}`, ...extra });

describe('fe9c73bc — the fixture is what the plan counted', () => {
  it('carries one of every kind of row the plan names', async () => {
    await seedFixture();
    expect(await snapshot()).toEqual({
      templates: 3,
      rules: 2,
      ledger: 8,
      accrual: 3,
      adjustment: 3,
      debit: 1,
      in_lieu_accrual: 1,
      audit: 3,
      entArchive: 0,
      ledArchive: 0,
    });
  });

  it('the survey lists the tenant with its counts and writes nothing', async () => {
    await seedFixture();
    const rows = await surveyTenants(URL_);
    const mine = rows.find((r) => r.tenantId === b.tenantId)!;
    expect(mine).toMatchObject({ name: 'Acme Group', templates: 3, rules: 2, accrualRows: 3, ledgerRows: 8 });
    expect(await cnt.entArchive()).toBe(0);
    expect(await cnt.ledArchive()).toBe(0);
  });
});

describe('fe9c73bc — the dry run counts and writes nothing', () => {
  for (const stage of ['config', 'accruals'] as const) {
    it(`stage ${stage}: every source count unchanged, both archives empty, "Nothing was written"`, async () => {
      await seedFixture();
      const before = await snapshot();
      const r = await run(stage, false);
      expect(r.apply).toBe(false);
      expect(r.refusals).toEqual([]);
      expect(r.archived).toBeNull();
      expect(r.deleted).toBeNull();
      expect(await snapshot()).toEqual(before);
      const text = formatReport(r);
      expect(text).toContain('Nothing was written');
      expect(text).toContain('DRY RUN');
    });
  }

  it('the census says, per leave type, what the plan promised to say', async () => {
    const fx = await seedFixture();
    const r = await run('accruals', false);
    const annual = r.types.find((x) => x.leaveTypeId === b.annualLeaveTypeId)!;
    const sick = r.types.find((x) => x.leaveTypeId === fx.sickTypeId)!;
    expect(annual).toMatchObject({
      templatesInForce: 1,
      templatesEnded: 1,
      rulesInForce: 1,
      accrualRows: 2,
      accrualDays: 28,
      debitRows: 1,
      debitsOnApprovedRequests: 1,
      auditRowsInScope: 1,
    });
    expect(sick).toMatchObject({
      templatesInForce: 1,
      rulesInForce: 1,
      accrualRows: 1,
      adjustmentsWithBatch: 1,
      adjustmentsWithoutBatch: 2,
      debitRows: 0,
      auditRowsInScope: 0, // the sys-adjustment's audit row is NOT in scope without the flag
    });
    expect(sick.adjustmentReasons.map((a) => a.reason).sort()).toEqual(['Bonus days', 'CNY 2026', fx.sysAdjReason]);
    // THE SPLIT the flag decides on: system-written / human or no reason / with a batch id, rows AND days.
    expect(sick.adjustments).toEqual({
      system: { rows: 1, days: -4, reasons: [{ reason: fx.sysAdjReason, rows: 1, days: -4 }] },
      human: { rows: 1, days: 3 },
      batched: { rows: 1, days: 2 },
    });
    expect(sick.ledger.map((k) => k.entryType).sort()).toEqual(['accrual', 'adjustment', 'in_lieu_accrual']);
    expect(r.includeSystemAdjustments).toBe(false);
    expect(r.totals).toMatchObject({
      templates: 3,
      templatesInForce: 2,
      rules: 2,
      rulesInForce: 2,
      ledgerRows: 8,
      accrualRows: 3,
      adjustmentRows: 3,
      systemAdjustmentRows: 1,
      systemAdjustmentDays: -4,
      humanAdjustmentRows: 1,
      batchedAdjustmentRows: 1,
      scopeLedgerRows: 3,
      debitRows: 1,
      inLieuRows: 1,
      approvedRequests: 1,
      auditRowsInScope: 1,
    });
    // The dry-run footer says what the flag WOULD clear, by reason, and that everything else is kept.
    const text = formatReport(r);
    expect(text).toContain('include-system-adjustments=no');
    expect(text).toContain(`--include-system-adjustments WOULD also clear 1 system-written adjustment row(s) (-4.00 days): ${fx.sysAdjReason} 1 (-4.00)`);
    expect(text).toContain('system-written (sys:…) 1 rows -4.00 days / human or no reason 1 rows +3.00 days / with a batch id 1 rows +2.00 days');
    expect(text).toContain('Nothing was written');
    // The health verdict on the CURRENT configuration rides along — both types are configured today.
    expect(annual.healthNow?.templateCount).toBe(1);
    expect(sick.healthNow?.templateCount).toBe(1);
  });
});

describe('fe9c73bc — stage config: configuration cleared, archived first, health reads unconfigured', () => {
  it('archives every template version and every rule, deletes them, touches no ledger row, appends ONE event', async () => {
    const fx = await seedFixture();
    const before = await snapshot();
    const r = await run('config', true);
    expect(r.refusals).toEqual([]);
    expect(r.archived).toEqual({ template: 3, rule: 2 });
    expect(r.deleted).toEqual({ template: 3, rule: 2 });

    const after = await snapshot();
    expect(after.templates).toBe(0);
    expect(after.rules).toBe(0);
    expect(after.entArchive).toBe(5);
    expect(await cnt.entArchive('template')).toBe(3);
    expect(await cnt.entArchive('rule')).toBe(2);
    // Ledger, audit and the ledger archive: byte-for-byte the same counts as before.
    for (const k of ['ledger', 'accrual', 'adjustment', 'debit', 'in_lieu_accrual', 'audit', 'ledArchive'] as const) {
      expect(after[k], k).toBe(before[k]);
    }

    // The product's own verdict, re-derived from a fresh read: NO configuration on either type.
    const tpls = await owner.db.select().from(schema.entitlementTemplate).where(eq(schema.entitlementTemplate.tenantId, b.tenantId));
    const rules = await owner.db
      .select()
      .from(schema.entitlementEligibilityRule)
      .where(eq(schema.entitlementEligibilityRule.tenantId, b.tenantId));
    for (const [id, name] of [
      [b.annualLeaveTypeId, 'Annual Leave'],
      [fx.sickTypeId, 'Medical Leave'],
    ] as const) {
      const h = leaveTypeConfigHealth({
        leaveType: { id, name, accrualMethod: 'annual', accrualUnconfigured: false, archived: false, defaultEntitlementTemplateLineageId: null },
        templates: tpls.map((x) => ({ ...x, serviceBands: x.serviceBands as { days: number }[] })),
        rules: rules.map((x) => ({ ...x, criteria: x.criteria as { gradeIds?: string[] } })),
        grades: [{ id: fx.gradeId, name: 'Grade 1' }],
        today: fx.today,
      });
      expect(h.templateCount).toBe(0);
      expect(h.findings).toContain('no_entitlement_table');
      expect(h.status).toBe('blocked');
    }
    // …and the same verdict the script read back INSIDE its transaction.
    expect(r.healthAfter?.map((h) => [h.name, h.templateCount, h.findings.includes('no_entitlement_table')])).toEqual(
      expect.arrayContaining([
        ['Annual Leave', 0, true],
        ['Medical Leave', 0, true],
      ]),
    );

    const events = await eventTypesFor(b.tenantId, b.tenantId);
    expect(events.filter((e) => e === 'entitlement-config.reset')).toHaveLength(1);
    const payload = await latestEventPayload(b.tenantId, b.tenantId, 'entitlement-config.reset');
    expect(payload).toMatchObject({
      item: 'fe9c73bc',
      stage: 'config',
      captureTag: 'fe9c73bc-test-config',
      archived: { template: 3, rule: 2 },
      deleted: { template: 3, rule: 2 },
    });
  });

  it('renders the archive in words: bands as 0398 wrote them, criteria as the rule screen says them', async () => {
    const fx = await seedFixture();
    await run('config', true);
    const rows = await listEntitlementResetArchive(adminCtx(b), { captureTag: 'fe9c73bc-test-config' });
    expect(rows.map((r) => r.layer)).toEqual(['template', 'template', 'template', 'rule', 'rule']);

    const exec = rows.find((r) => r.layer === 'template' && r.schemeName === 'Annual — Executive')!;
    expect(exec.entitlementText).toBe(
      '0-2 yrs: 14 days, max brought forward 5, max entitled + brought forward 20 | 2-no limit yrs: 18 days',
    );
    expect(exec.leaveTypeCode).toBe('ANNUAL');
    expect(exec.validToText).toBe('open');
    expect(exec.note).toMatch(new RegExp(`^lineage ${fx.tplA.lineageId} · version [0-9a-f-]{36} · in force$`));

    const old = rows.find((r) => r.layer === 'template' && r.schemeName === 'Annual — old')!;
    expect(old.entitlementText).toBe('0-no limit yrs: 10 days');
    expect(old.validToText).toBe(addDaysIso(fx.today, -200));
    expect(old.note).toMatch(/ · ended$/);

    const everyone = rows.find((r) => r.layer === 'rule' && r.schemeName === 'Everyone')!;
    expect(everyone.entitlementText).toBe(`${EVERYONE_TEXT} → Annual — Executive`);
    expect(everyone.leaveTypeCode).toBe('ANNUAL');
    expect(everyone.note).toMatch(new RegExp(`^rule lineage [0-9a-f-]{36} · template lineage ${fx.tplA.lineageId}$`));

    const narrowed = rows.find((r) => r.layer === 'rule' && r.schemeName === 'Grade 1 at Acme')!;
    expect(narrowed.entitlementText).toBe('Company: Acme Sdn Bhd · Job Grade: Grade 1 → Medical — All');
    expect(narrowed.leaveTypeCode).toBe('SICK');

    // The CSV names the new layers by their own words, not as a "Company / grade rule".
    const csv = await entitlementResetArchiveCsv(adminCtx(b), { captureTag: 'fe9c73bc-test-config' });
    expect(csv.content).toContain('Entitlement table');
    expect(csv.content).toContain('Eligibility rule');
    expect(csv.content).not.toContain('Company / grade rule');
  });

  it('the migrated database admits the two layers (0460), and the script agrees', async () => {
    const rows = (await owner.db.execute(CHECK_SQL)) as unknown as { def: string }[];
    expect(rows[0]?.def).toBe("CHECK ((layer = ANY (ARRAY['scheme'::text, 'policy'::text, 'template'::text, 'rule'::text])))");
    expect(await layerCheckAdmits(owner.db, ['template', 'rule'])).toBe(true);
  });

  it("REFUSES, writing nothing, where the layer CHECK is still 0397's (an environment 0460 has not reached)", async () => {
    await seedFixture();
    const found = ((await owner.db.execute(CHECK_SQL)) as unknown as { def: string }[])[0]?.def;
    expect(found).toBeTruthy();
    await dropCheck();
    await addCheck(NARROW_DEF_0397);
    try {
      expect(await layerCheckAdmits(owner.db, ['template', 'rule'])).toBe(false);
      const before = await snapshot();
      const r = await run('config', true);
      expect(r.refusals.some((x) => /entitlement_reset_archive_layer_check/.test(x) && /migration/.test(x))).toBe(true);
      expect(r.refusalCounts.layerCheckBlocked).toBe(1);
      expect(r.archived).toBeNull();
      expect(await snapshot()).toEqual(before);
      expect(formatReport(r)).toContain('REFUSED — nothing was written');
    } finally {
      await dropCheck();
      await addCheck(found!);
    }
  });

  it('refuses a capture tag that is already in use — a re-run is a new record, never an interleave', async () => {
    await seedFixture();
    await run('config', true);
    // Re-seed configuration and try the same tag again.
    await createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      name: 'Again',
      serviceBands: [{ fromYears: 0, toYears: null, days: 1 }],
      validFrom: addDaysIso(todayInKualaLumpur(), -1),
    });
    const r = await run('config', true);
    expect(r.refusals.some((x) => /already used/.test(x))).toBe(true);
    expect(await cnt.templates()).toBe(1);
    expect(await cnt.entArchive()).toBe(5);
  });
});

describe('fe9c73bc — stage accruals: generated entitlement cleared, taken leave and adjustments kept', () => {
  it('archives 3 accruals + 1 recalc-audit row, deletes exactly those, and the debit balance now reads negative', async () => {
    const fx = await seedFixture();
    const r = await run('accruals', true);
    expect(r.refusals).toEqual([]);
    expect(r.archived).toEqual({ ledger: 3, recalc_audit: 1 });
    expect(r.deleted).toEqual({ ledger: 3, recalc_audit: 1 });

    const after = await snapshot();
    expect(after).toMatchObject({
      templates: 3, // configuration untouched by this stage
      rules: 2,
      ledger: 5,
      accrual: 0,
      adjustment: 3, // KEPT — all three, the system-written one included: the flag was not set
      debit: 1, // KEPT — leave actually taken
      in_lieu_accrual: 1, // KEPT — never in scope
      audit: 2,
      ledArchive: 4,
    });
    expect(await cnt.ledArchive('ledger')).toBe(3);
    expect(await cnt.ledArchive('recalc_audit')).toBe(1);

    // The audit row that pointed at an accrual is gone; the NULL-linked one and the one pointing at the
    // (kept) system-written adjustment remain.
    const audits = await owner.db
      .select({ ledgerId: schema.leaveEntitlementRecalcAudit.ledgerId, reason: schema.leaveEntitlementRecalcAudit.reason })
      .from(schema.leaveEntitlementRecalcAudit)
      .where(eq(schema.leaveEntitlementRecalcAudit.tenantId, b.tenantId))
      .orderBy(schema.leaveEntitlementRecalcAudit.reason);
    expect(audits).toEqual([
      { ledgerId: fx.sysAdjId, reason: 'employment_changed' },
      { ledgerId: null, reason: 'grade_changed' },
    ]);

    // The archive rows are rendered as the r180 capture renders them.
    const arch = await owner.db
      .select()
      .from(schema.leaveLedgerResetArchive)
      .where(eq(schema.leaveLedgerResetArchive.captureTag, 'fe9c73bc-test-accruals'));
    const ledgerRows = arch.filter((x) => x.layer === 'ledger');
    expect(ledgerRows.map((x) => x.entryType)).toEqual(['accrual', 'accrual', 'accrual']);
    expect(ledgerRows.every((x) => x.sourceRequestText === 'not sourced from a leave request')).toBe(true);
    expect(ledgerRows.map((x) => x.daysText).sort()).toEqual(['10.00', '14.00', '14.00']);
    expect(ledgerRows.map((x) => x.employeeName).sort()).toEqual(['Ahmad', 'Mei Ling', 'Mei Ling']);
    const auditRow = arch.find((x) => x.layer === 'recalc_audit')!;
    expect(auditRow.entitlementText).toBe('previous 0.00 → new 14.00 (delta 14.00)');
    expect(auditRow.sourceRowId).toMatch(/^[0-9a-f-]{36}$/);

    // THE HONEST CONSEQUENCE the plan states: through the product's own balance read (the one the
    // dashboard's leave-balance card calls), Mei Ling's Annual Leave now reads -1.00.
    const balances = await leaveBalances(adminCtx(b), fx.emp1);
    const annual = balances.find((x) => x.leaveTypeId === b.annualLeaveTypeId)!;
    expect(annual.balance).toBe(-1);
    // …and Ahmad keeps what HR gave by hand, what he worked for AND the system clawback: 2 + 3 + 1 - 4.
    const ahmad = (await leaveBalances(adminCtx(b), fx.emp2)).find((x) => x.leaveTypeId === fx.sickTypeId)!;
    expect(ahmad.balance).toBe(2);

    const events = await eventTypesFor(b.tenantId, b.tenantId);
    expect(events.filter((e) => e === 'entitlement-accruals.reset')).toHaveLength(1);
    expect(await latestEventPayload(b.tenantId, b.tenantId, 'entitlement-accruals.reset')).toMatchObject({
      item: 'fe9c73bc',
      stage: 'accruals',
      captureTag: 'fe9c73bc-test-accruals',
      includeSystemAdjustments: false,
      scope: { accrualRows: 3, systemAdjustmentRows: 0 },
      archived: { ledger: 3, recalcAudit: 1 },
      deleted: { ledger: 3, recalcAudit: 1 },
      kept: { adjustment: 3, debit: 1, inLieuAccrual: 1 },
    });
  });

  it('the two stages compose: config then accruals leaves exactly the kept rows and both records', async () => {
    await seedFixture();
    await run('config', true);
    await run('accruals', true);
    expect(await snapshot()).toEqual({
      templates: 0,
      rules: 0,
      ledger: 5,
      accrual: 0,
      adjustment: 3,
      debit: 1,
      in_lieu_accrual: 1,
      audit: 2,
      entArchive: 5,
      ledArchive: 4,
    });
  });
});

describe('fe9c73bc — --include-system-adjustments is OPT-IN; without it the stage is byte-for-byte what it was', () => {
  it('default: all three adjustment kinds survive, the archive holds accruals only, the event says false', async () => {
    const fx = await seedFixture();
    const r = await run('accruals', true);
    expect(r.includeSystemAdjustments).toBe(false);
    expect(r.totals.scopeLedgerRows).toBe(3);
    expect(r.archived).toEqual({ ledger: 3, recalc_audit: 1 });
    const remaining = await owner.db
      .select({ id: schema.leaveLedger.id, reason: schema.leaveLedger.reason, batch: schema.leaveLedger.adjustmentBatchId })
      .from(schema.leaveLedger)
      .where(and(eq(schema.leaveLedger.tenantId, b.tenantId), eq(schema.leaveLedger.entryType, 'adjustment')))
      .orderBy(schema.leaveLedger.reason);
    expect(remaining.map((x) => x.reason)).toEqual(['Bonus days', 'CNY 2026', fx.sysAdjReason]);
    expect(remaining.find((x) => x.id === fx.sysAdjId)).toBeTruthy();
    const arch = await owner.db
      .select({ entryType: schema.leaveLedgerResetArchive.entryType, layer: schema.leaveLedgerResetArchive.layer })
      .from(schema.leaveLedgerResetArchive)
      .where(eq(schema.leaveLedgerResetArchive.captureTag, 'fe9c73bc-test-accruals'));
    expect(arch.filter((x) => x.layer === 'ledger').every((x) => x.entryType === 'accrual')).toBe(true);
    expect((await latestEventPayload(b.tenantId, b.tenantId, 'entitlement-accruals.reset'))?.includeSystemAdjustments).toBe(false);
  });

  it('with the flag: ONLY the sys: adjustment joins the scope — archived, deleted, its audit row gone, the balance moves by exactly its days', async () => {
    const fx = await seedFixture();
    const r = await run('accruals', true, { includeSystemAdjustments: true });
    expect(r.refusals).toEqual([]);
    expect(r.includeSystemAdjustments).toBe(true);
    expect(r.totals.scopeLedgerRows).toBe(4);
    expect(r.totals.auditRowsInScope).toBe(2);
    expect(r.archived).toEqual({ ledger: 4, recalc_audit: 2 });
    expect(r.deleted).toEqual({ ledger: 4, recalc_audit: 2 });

    expect(await snapshot()).toMatchObject({
      ledger: 4,
      accrual: 0,
      adjustment: 2, // the human-reason one and the batched one — ALWAYS kept
      debit: 1,
      in_lieu_accrual: 1,
      audit: 1, // only the NULL-linked row is left
      ledArchive: 6,
    });
    const remaining = await owner.db
      .select({ id: schema.leaveLedger.id, reason: schema.leaveLedger.reason })
      .from(schema.leaveLedger)
      .where(and(eq(schema.leaveLedger.tenantId, b.tenantId), eq(schema.leaveLedger.entryType, 'adjustment')))
      .orderBy(schema.leaveLedger.reason);
    expect(remaining.map((x) => x.reason)).toEqual(['Bonus days', 'CNY 2026']);
    expect(remaining.find((x) => x.id === fx.sysAdjId)).toBeUndefined();
    const audits = await owner.db
      .select({ ledgerId: schema.leaveEntitlementRecalcAudit.ledgerId, reason: schema.leaveEntitlementRecalcAudit.reason })
      .from(schema.leaveEntitlementRecalcAudit)
      .where(eq(schema.leaveEntitlementRecalcAudit.tenantId, b.tenantId));
    expect(audits).toEqual([{ ledgerId: null, reason: 'grade_changed' }]);

    // The archive carries the adjustment row as the r180 capture renders it, reason verbatim.
    const arch = await owner.db
      .select()
      .from(schema.leaveLedgerResetArchive)
      .where(eq(schema.leaveLedgerResetArchive.captureTag, 'fe9c73bc-test-accruals'));
    const ledgerRows = arch.filter((x) => x.layer === 'ledger');
    expect(ledgerRows.map((x) => x.entryType).sort()).toEqual(['accrual', 'accrual', 'accrual', 'adjustment']);
    const adjRow = ledgerRows.find((x) => x.entryType === 'adjustment')!;
    expect(adjRow.reason).toBe(fx.sysAdjReason);
    expect(adjRow.daysText).toBe('-4.00');
    expect(adjRow.sourceRowId).toBe(fx.sysAdjId);
    const auditRows = arch.filter((x) => x.layer === 'recalc_audit');
    expect(auditRows.map((x) => x.entitlementText).sort()).toEqual([
      'previous 0.00 → new 14.00 (delta 14.00)',
      'previous 10.00 → new 6.00 (delta -4.00)',
    ]);
    expect(auditRows.every((x) => /accrual or a system-written adjustment/.test(x.note ?? ''))).toBe(true);

    // The balance moves by EXACTLY the cleared row's days: 2 (default run) → 6, i.e. +4 for a -4.00 row.
    const ahmad = (await leaveBalances(adminCtx(b), fx.emp2)).find((x) => x.leaveTypeId === fx.sickTypeId)!;
    expect(ahmad.balance).toBe(6);
    const meiLing = (await leaveBalances(adminCtx(b), fx.emp1)).find((x) => x.leaveTypeId === b.annualLeaveTypeId)!;
    expect(meiLing.balance).toBe(-1);

    expect(await latestEventPayload(b.tenantId, b.tenantId, 'entitlement-accruals.reset')).toMatchObject({
      includeSystemAdjustments: true,
      scope: { accrualRows: 3, systemAdjustmentRows: 1 },
      archived: { ledger: 4, recalcAudit: 2 },
      deleted: { ledger: 4, recalcAudit: 2 },
      kept: { adjustment: 2, debit: 1, inLieuAccrual: 1 },
    });
    expect(formatReport(r)).toContain('1 system-written adjustment row(s) were cleared WITH the accruals');
  });

  it('dry run with the flag: the scope and footer say so, and still nothing is written', async () => {
    const fx = await seedFixture();
    const before = await snapshot();
    const r = await run('accruals', false, { includeSystemAdjustments: true });
    expect(r.includeSystemAdjustments).toBe(true);
    expect(r.totals.scopeLedgerRows).toBe(4);
    expect(r.totals.auditRowsInScope).toBe(2);
    expect(r.types.find((x) => x.leaveTypeId === fx.sickTypeId)?.auditRowsInScope).toBe(1);
    const text = formatReport(r);
    expect(text).toContain('include-system-adjustments=yes');
    expect(text).toContain('--include-system-adjustments IS SET: this stage ALSO clears 1 system-written adjustment row(s) (-4.00 days)');
    expect(text).toContain('IN SCOPE for this stage        : 4 row(s) = accruals + 1 system-written adjustment(s)');
    expect(text).toContain('Nothing was written');
    expect(await snapshot()).toEqual(before);
  });

  it('the flag is ignored on the config stage', async () => {
    await seedFixture();
    const r = await run('config', false, { includeSystemAdjustments: true });
    expect(r.includeSystemAdjustments).toBe(false);
  });
});

describe('fe9c73bc — refusals fail closed: nothing archived, nothing deleted, counts printed', () => {
  it('an accrual carrying a source_request_id', async () => {
    const fx = await seedFixture();
    await owner.db
      .update(schema.leaveLedger)
      .set({ sourceRequestId: fx.requestId })
      .where(eq(schema.leaveLedger.id, fx.accrual1Id));
    const before = await snapshot();
    const r = await run('accruals', true);
    expect(r.refusalCounts.requestSourcedAccruals).toBe(1);
    expect(r.refusals.some((x) => /source_request_id/.test(x))).toBe(true);
    expect(r.archived).toBeNull();
    expect(r.deleted).toBeNull();
    expect(await snapshot()).toEqual(before);
    expect(formatReport(r)).toContain('REFUSED — nothing was written');
  });

  it('a leave_encashment_snapshot row for the tenant (ADR-0069), on BOTH stages', async () => {
    const fx = await seedFixture();
    const [p] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, fx.emp1));
    const [req] = await owner.db
      .insert(schema.resignationRequest)
      .values({ tenantId: b.tenantId, employmentId: fx.emp1, personId: p.personId, lastWorkingDay: addDaysIso(fx.today, 30), status: 'accepted' })
      .returning({ id: schema.resignationRequest.id });
    await owner.db.insert(schema.leaveEncashmentSnapshot).values({
      tenantId: b.tenantId,
      employmentId: fx.emp1,
      resignationRequestId: req.id,
      leaveTypeId: b.annualLeaveTypeId,
      balanceDays: '27.00',
      encashableDays: '27.00',
      calculatedAsOf: fx.today,
      status: 'frozen',
    });
    const before = await snapshot();
    for (const stage of ['config', 'accruals'] as const) {
      const r = await run(stage, true);
      expect(r.refusalCounts.encashmentSnapshots).toBe(1);
      expect(r.refusals.some((x) => /leave_encashment_snapshot/.test(x))).toBe(true);
      expect(r.archived).toBeNull();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('a toil_accrual referencing an accrual this stage would delete', async () => {
    const fx = await seedFixture();
    await owner.db.insert(schema.toilAccrual).values({
      tenantId: b.tenantId,
      employmentId: fx.emp1,
      workedDate: addDaysIso(fx.today, -40),
      otMinutes: 480,
      daysCredited: '1.00',
      accrualBasis: 'hours_worked',
      expiresOn: addDaysIso(fx.today, 300),
      ledgerEntryId: fx.accrual1Id,
    });
    const before = await snapshot();
    const r = await run('accruals', true);
    expect(r.refusalCounts.toilReferences).toBe(1);
    expect(r.refusals.some((x) => /toil_accrual/.test(x))).toBe(true);
    expect(r.archived).toBeNull();
    expect(await snapshot()).toEqual(before);
  });
});

describe('fe9c73bc — the archive VERIFY is a throw inside the transaction, not a log line', () => {
  it('config: one archive row short → ARCHIVE INCOMPLETE, nothing deleted, the short copy rolled back', async () => {
    await seedFixture();
    const before = await snapshot();
    await expect(
      run('config', true, {
        testHooks: {
          afterArchive: async (tx) => {
            await tx.execute(sql`delete from entitlement_reset_archive where id = (
              select id from entitlement_reset_archive where capture_tag = 'fe9c73bc-test-config' and layer = 'rule' limit 1)`);
          },
        },
      }),
    ).rejects.toThrow(/ARCHIVE INCOMPLETE: 1 rule row\(s\) captured .* but 2 exist\. Nothing deleted\./);
    expect(await snapshot()).toEqual(before);
    expect(await cnt.entArchive()).toBe(0);
    expect(await eventTypesFor(b.tenantId, b.tenantId)).not.toContain('entitlement-config.reset');
  });

  it('accruals: one archive row short → ARCHIVE INCOMPLETE, nothing deleted, the short copy rolled back', async () => {
    await seedFixture();
    const before = await snapshot();
    await expect(
      run('accruals', true, {
        testHooks: {
          afterArchive: async (tx) => {
            await tx.execute(sql`delete from leave_ledger_reset_archive where id = (
              select id from leave_ledger_reset_archive where capture_tag = 'fe9c73bc-test-accruals' and layer = 'ledger' limit 1)`);
          },
        },
      }),
    ).rejects.toThrow(/ARCHIVE INCOMPLETE: 2 ledger row\(s\) captured .* but 3 accrual row\(s\) exist\. Nothing deleted\./);
    expect(await snapshot()).toEqual(before);
    expect(await cnt.ledArchive()).toBe(0);
    expect(await eventTypesFor(b.tenantId, b.tenantId)).not.toContain('entitlement-accruals.reset');
  });
});

describe('fe9c73bc — the words', () => {
  it('renderServiceBands writes the band table as migration 0398 did', () => {
    expect(renderServiceBands([{ fromYears: 0, toYears: 2, days: 14, carryForwardDays: 5 }])).toBe(
      '0-2 yrs: 14 days, max brought forward 5',
    );
    expect(
      renderServiceBands([
        { fromYears: 0, toYears: null, days: 14, maxBalanceDays: 20, carryForwardExpiryDay: 31, carryForwardExpiryMonth: 3 },
      ]),
    ).toBe('0-no limit yrs: 14 days, max entitled + brought forward 20, carry expires 31/3');
    expect(renderServiceBands([])).toBe('no bands');
    expect(renderServiceBands({ not: 'an array' })).toMatch(/recorded as stored/);
  });
});

describe('fe9c73bc — the reader knows the two new layers (source shape)', () => {
  // 7f69bd71 — the reader is the Configuration record component the Reset records sub-screen mounts;
  // the page that used to hold it is a redirect stub.
  const page = fs.readFileSync(path.join(ROOT, 'components/leave/reset-record-configuration.tsx'), 'utf8');
  const reader = fs.readFileSync(path.join(ROOT, 'core/entitlement-archive.ts'), 'utf8');

  it('labels template and rule rows by their own keys, and the two old layers exactly as before', () => {
    expect(page).toContain("r.layer === 'template'");
    expect(page).toContain("t('layerTemplate')");
    expect(page).toContain("r.layer === 'rule'");
    expect(page).toContain("t('layerRule')");
    expect(page).toContain("r.layer === 'scheme'\n                        ? t('layerScheme')");
    expect(page).toContain("t('layerPolicy')");
    // "All grades" / "All companies" stay POLICY facts: a template or rule row must not claim them.
    expect(page).toContain("r.layer === 'policy'\n                        ? (r.gradeName ?? t('allGrades'))");
    expect(page).toContain("r.companyName ?? (r.layer === 'policy' ? t('allCompanies') : dash)");
  });

  it('the reader type and the CSV carry the union, so a fifth layer cannot silently print as a policy', () => {
    expect(reader).toContain("export type EntitlementArchiveLayer = 'scheme' | 'policy' | 'template' | 'rule';");
    expect(reader).toContain("template: 'Entitlement table'");
    expect(reader).toContain("rule: 'Eligibility rule'");
  });

  it('migration 0460 widens the CHECK to all four layers, and the journal carries it', () => {
    const mig = fs.readFileSync(path.join(ROOT, 'db/migrations/0460_entitlement_reset_archive_layers.sql'), 'utf8');
    expect(mig).toContain('DROP CONSTRAINT IF EXISTS entitlement_reset_archive_layer_check');
    expect(mig).toContain('ADD CONSTRAINT entitlement_reset_archive_layer_check');
    expect(mig).toMatch(/CHECK \(layer IN \('scheme', 'policy', 'template', 'rule'\)\)/);
    for (const layer of ['scheme', 'policy', 'template', 'rule']) expect(mig).toContain(`'${layer}'`);
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, 'db/migrations/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.tag === '0460_entitlement_reset_archive_layers');
    expect(entry).toMatchObject({ idx: 460, when: 1781862560000 });
  });

  it('the first column header names the new layers when the chosen capture holds them, and stays "Benefit scheme" otherwise', () => {
    expect(page).toContain("rows.some((r) => r.layer === 'template' || r.layer === 'rule')");
    expect(page).toContain("t('colTemplateOrRule')");
    expect(page).toContain("t('colScheme')");
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${loc}.json`), 'utf8'));
      expect(typeof m.admin.entitlementArchive.colTemplateOrRule, loc).toBe('string');
    }
  });

  it('all six locales carry layerTemplate and layerRule under admin.entitlementArchive', () => {
    for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi']) {
      const m = JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${loc}.json`), 'utf8'));
      expect(typeof m.admin.entitlementArchive.layerTemplate, loc).toBe('string');
      expect(typeof m.admin.entitlementArchive.layerRule, loc).toBe('string');
    }
  });
});
