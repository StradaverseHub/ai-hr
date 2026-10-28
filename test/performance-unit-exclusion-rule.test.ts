/**
 * D-P1-22 X1 (ADR-0150): the cycle exclusion rule's storage and authority, against real RLS as ai_hr_app.
 * Fixture: test/performance-unit-exclusion-fixture.ts (group-wide cycle; company A departments X, Y, Xc; company B Z).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createDepartment } from '../core/admin';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { adminCtx, closeAll, eventTypesFor, owner, seedBase } from './harness';
import { bringBack, buildFixture, cycleRevision, exclude, refusal, rulesOf, year, type Fixture } from './performance-unit-exclusion-fixture';

let f: Fixture;
beforeEach(async () => { f = await buildFixture(); });
afterAll(closeAll);

const rawInsert = (ctx: SessionContext, values: Partial<typeof schema.assessmentUnitExclusion.$inferInsert>) =>
  withTenant(ctx, (tx) => tx.insert(schema.assessmentUnitExclusion).values({ tenantId: f.b.tenantId, cycleId: f.cycleId, companyId: f.b.companyId, createdBy: ctx.userId!, ...values }).returning({ id: schema.assessmentUnitExclusion.id }));
const readAs = (ctx: SessionContext) =>
  withTenant(ctx, (tx) => tx.select({ id: schema.assessmentUnitExclusion.id, companyId: schema.assessmentUnitExclusion.companyId }).from(schema.assessmentUnitExclusion).orderBy(asc(schema.assessmentUnitExclusion.id)));

describe('the rule and its scope', () => {
  it('saves a whole-company rule and a department rule (tenant-wide HR administrator)', async () => {
    const dept = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const whole = await exclude(f.a, f.cycleId, f.companyB, null);
    const rows = await rulesOf(f.cycleId);
    expect(rows.map((r) => ({ id: r.id, companyId: r.companyId, departmentId: r.departmentId, endedAt: r.endedAt, createdBy: r.createdBy }))).toEqual([
      { id: dept.saved.ruleId, companyId: f.b.companyId, departmentId: f.dept.X, endedAt: null, createdBy: f.a.userId },
      { id: whole.saved.ruleId, companyId: f.companyB, departmentId: null, endedAt: null, createdBy: f.a.userId },
    ]);
    expect((await perf.listUnitExclusionRules(f.a, f.cycleId)).rules.map((r) => [r.id, r.active])).toEqual([[dept.saved.ruleId, true], [whole.saved.ruleId, true]]);
  });

  it('refuses a department that belongs to another company', async () => {
    expect(await refusal(perf.previewUnitExclusion(f.a, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.Z }))).toMatch(/The department belongs to another company/);
    expect(await refusal(rawInsert(f.a, { departmentId: f.dept.Z }))).toMatch(/The department belongs to another company/);
    expect(await rulesOf(f.cycleId)).toEqual([]);
  });

  it('refuses a company outside the cycle\'s scope', async () => {
    const { cycleId: unitCycle } = await perf.createCycle(f.a, { name: 'Company A only', companyId: f.b.companyId, periodStart: `${year - 1}-01-01`, periodEnd: `${year - 1}-12-31` });
    await perf.configureOnehrCycle(f.a, unitCycle, null, defaultPolicy(framework));
    await perf.openCycle(f.a, { cycleId: unitCycle });
    expect(await refusal(perf.previewUnitExclusion(f.a, unitCycle, { companyId: f.companyB, departmentId: f.dept.Z }))).toMatch(/The company is outside this cycle/);
    expect(await refusal(rawInsert(f.a, { cycleId: unitCycle, companyId: f.companyB, departmentId: f.dept.Z }))).toMatch(/The company is outside this cycle/);
    // Non-vacuous: company A inside that cycle is accepted.
    expect((await perf.previewUnitExclusion(f.a, unitCycle, { companyId: f.b.companyId, departmentId: f.dept.X })).digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses another tenant\'s cycle, company or department, and another tenant reads no rule', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const other = await seedBase();
    const otherAdmin = adminCtx(other);
    expect(await withTenant(otherAdmin, (tx) => tx.execute<{ v: unknown }>(sql`select app.assessment_unit_exclusion_facts(${f.cycleId}::uuid,${f.b.companyId}::uuid,null::uuid) as v`)).then((r) => r[0].v)).toBeNull();
    expect(await refusal(withTenant(otherAdmin, (tx) => tx.insert(schema.assessmentUnitExclusion).values({ tenantId: f.b.tenantId, cycleId: f.cycleId, companyId: f.b.companyId, createdBy: otherAdmin.userId! }))))
      .toMatch(/Invalid unit exclusion rule|row-level security/);
    expect(await refusal(withTenant(otherAdmin, (tx) => tx.insert(schema.assessmentUnitExclusion).values({ tenantId: other.tenantId, cycleId: f.cycleId, companyId: other.companyId, createdBy: otherAdmin.userId! }))))
      .toMatch(/performance and talent review cycle/);
    expect(await readAs(otherAdmin)).toEqual([]);
    expect(await readAs({ ...f.a, tenantId: other.tenantId })).toEqual([]);
  });

  it('a company-scoped HR administrator reads only its companies\' rules and writes none', async () => {
    const a1 = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const b1 = await exclude(f.a, f.cycleId, f.companyB, null);
    const hrB = await f.scoped(null, 'hr_admin', f.companyB);
    expect(await readAs(hrB)).toEqual([{ id: b1.saved.ruleId, companyId: f.companyB }]);
    expect((await perf.listUnitExclusionRules(hrB, f.cycleId)).rules.map((r) => r.id)).toEqual([b1.saved.ruleId]);
    expect(await refusal(rawInsert(hrB, { companyId: f.companyB, departmentId: f.dept.Z }))).toMatch(/row-level security/);
    expect(await refusal(perf.endUnitExclusion(hrB, b1.saved.ruleId, { revision: await cycleRevision(f.cycleId) }))).toMatch(/group-wide HR administrator/);
    expect(a1.saved.ruleId).not.toBe(b1.saved.ruleId);
  });

  it('a performance partner reads the rules of its companies and writes none (D4, ADR-0142)', async () => {
    const a1 = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    await exclude(f.a, f.cycleId, f.companyB, null);
    const partner = await f.scoped(null, 'performance_partner', f.b.companyId);
    expect(await readAs(partner)).toEqual([{ id: a1.saved.ruleId, companyId: f.b.companyId }]);
    expect(await refusal(rawInsert(partner, { departmentId: f.dept.Y }))).toMatch(/row-level security/);
    const preview = await perf.previewUnitExclusion(f.a, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.Y });
    expect(await refusal(perf.saveUnitExclusion(partner, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.Y, digest: preview.digest, revision: preview.revision }))).toMatch(/group-wide HR administrator/);
  });

  it('an employee or a line manager reads no rule', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(await readAs(f.U.S)).toEqual([]);
    expect(await readAs(f.U.M1)).toEqual([]);
    expect((await perf.listUnitExclusionRules(f.U.M1, f.cycleId)).rules).toEqual([]);
    expect(await refusal(perf.previewUnitExclusion(f.U.M1, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.X }))).toMatch(/Performance administrator access/);
  });

  it('an update may only end an active rule, once; an ended rule is immutable', async () => {
    const { saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const change = (set: Partial<typeof schema.assessmentUnitExclusion.$inferInsert>) =>
      withTenant(f.a, (tx) => tx.update(schema.assessmentUnitExclusion).set(set).where(eq(schema.assessmentUnitExclusion.id, saved.ruleId)));
    expect(await refusal(change({ departmentId: f.dept.Y }))).toMatch(/can only be ended/);
    expect(await refusal(change({ endedAt: new Date(), endedBy: f.U.M1.userId!, endReason: 'brought_back' }))).toMatch(/ended once, by its actor/);
    await bringBack(f.a, f.cycleId, saved.ruleId);
    const [row] = await rulesOf(f.cycleId);
    expect({ endedBy: row.endedBy, endReason: row.endReason, ended: row.endedAt != null }).toEqual({ endedBy: f.a.userId, endReason: 'brought_back', ended: true });
    expect(await refusal(bringBack(f.a, f.cycleId, saved.ruleId))).toMatch(/already takes part again/);
    expect(await refusal(change({ endReason: 'subsumed' }))).toMatch(/An ended unit exclusion rule is immutable/);
  });

  it('grants neither DELETE nor TRUNCATE; the pin is read-only to the application', async () => {
    const [p] = await owner.db.execute<Record<string, boolean>>(sql`select
      has_table_privilege('ai_hr_app','performance_assessment_unit_exclusion','DELETE') as rule_delete,
      has_table_privilege('ai_hr_app','performance_assessment_unit_exclusion','TRUNCATE') as rule_truncate,
      has_table_privilege('ai_hr_app','performance_assessment_unit_exclusion','INSERT') as rule_insert,
      has_table_privilege('ai_hr_app','performance_assessment_unit_exclusion_pin','INSERT') as pin_insert,
      has_table_privilege('ai_hr_app','performance_assessment_unit_exclusion_pin','DELETE') as pin_delete,
      has_table_privilege('ai_hr_app','performance_assessment_unit_exclusion_pin','SELECT') as pin_select`);
    expect(p).toEqual({ rule_delete: false, rule_truncate: false, rule_insert: true, pin_insert: false, pin_delete: false, pin_select: true });
    const rls = await owner.db.execute<{ relname: string; enabled: boolean; forced: boolean }>(sql`
      select relname, relrowsecurity as enabled, relforcerowsecurity as forced from pg_class
      where relname in ('performance_assessment_unit_exclusion','performance_assessment_unit_exclusion_pin') order by relname`);
    expect([...rls]).toEqual([
      { relname: 'performance_assessment_unit_exclusion', enabled: true, forced: true },
      { relname: 'performance_assessment_unit_exclusion_pin', enabled: true, forced: true },
    ]);
    const { saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(await refusal(withTenant(f.a, (tx) => tx.delete(schema.assessmentUnitExclusion).where(eq(schema.assessmentUnitExclusion.id, saved.ruleId))))).toMatch(/permission denied/);
    expect(await rulesOf(f.cycleId)).toHaveLength(1);
  });

  it('refuses writes in a draft or closed cycle (D11)', async () => {
    const { cycleId: draft } = await perf.createCycle(f.a, { name: 'Draft cycle', companyId: null, periodStart: `${year + 1}-01-01`, periodEnd: `${year + 1}-12-31` });
    await perf.configureOnehrCycle(f.a, draft, null, defaultPolicy(framework));
    expect(await refusal(rawInsert(f.a, { cycleId: draft, departmentId: f.dept.X }))).toMatch(/only while the cycle is open or in calibration/);
    expect(await refusal(perf.previewUnitExclusion(f.a, draft, { companyId: f.b.companyId, departmentId: f.dept.X }))).toMatch(/only while the cycle is open or in calibration/);
    const { saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    await perf.closeCycle(f.a, { cycleId: f.cycleId });
    expect(await refusal(bringBack(f.a, f.cycleId, saved.ruleId))).toMatch(/only while the cycle is open or in calibration/);
    expect(await refusal(rawInsert(f.a, { departmentId: f.dept.Y }))).toMatch(/only while the cycle is open or in calibration/);
    expect(await refusal(withTenant(f.a, (tx) => tx.update(schema.assessmentUnitExclusion).set({ endedAt: new Date(), endedBy: f.a.userId!, endReason: 'brought_back' }).where(eq(schema.assessmentUnitExclusion.id, saved.ruleId)))))
      .toMatch(/only while the cycle is open or in calibration/);
  });

  it('a whole-company save ends that company\'s department rules as subsumed, with both events', async () => {
    const dept = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const whole = await exclude(f.a, f.cycleId, f.b.companyId, null);
    expect(whole.preview.subsumedRuleIds).toEqual([dept.saved.ruleId]);
    expect(whole.saved.subsumed).toBe(1);
    const rows = await rulesOf(f.cycleId);
    expect(rows.map((r) => [r.id, r.endReason])).toEqual([[dept.saved.ruleId, 'subsumed'], [whole.saved.ruleId, null]]);
    const events = await eventTypesFor(f.b.tenantId, f.cycleId);
    expect(events.filter((e) => e === 'review-cycle.unit-exclusion-set')).toHaveLength(2);
    expect(events.filter((e) => e === 'review-cycle.unit-exclusion-ended')).toHaveLength(1);
    const [ended] = await owner.db.select({ payload: schema.domainEvent.payload }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, f.cycleId), eq(schema.domainEvent.eventType, 'review-cycle.unit-exclusion-ended')));
    expect(ended.payload).toMatchObject({ ruleId: dept.saved.ruleId, why: 'subsumed', subsumedBy: whole.saved.ruleId });
  });

  it('keeps one active rule per cycle, company and department; an ended rule may be saved again', async () => {
    const first = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(await refusal(rawInsert(f.a, { departmentId: f.dept.X }))).toMatch(/performance_assessment_unit_exclusion_active_uq|duplicate key/);
    const again = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(again.preview.alreadyActiveRuleId).toBe(first.saved.ruleId);
    expect(again.saved).toMatchObject({ ruleId: first.saved.ruleId, alreadyActive: true, archived: 0, moved: 0 });
    expect((await eventTypesFor(f.b.tenantId, f.cycleId)).filter((e) => e === 'review-cycle.unit-exclusion-set')).toHaveLength(1);
    await bringBack(f.a, f.cycleId, first.saved.ruleId);
    const third = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(third.saved.alreadyActive).toBe(false);
    expect(third.saved.ruleId).not.toBe(first.saved.ruleId);
    expect((await rulesOf(f.cycleId)).map((r) => r.endedAt == null)).toEqual([false, true]);
  });

  it('refuses a scope with nobody in it today', async () => {
    const empty = await createDepartment(f.a, { companyId: f.b.companyId, name: 'Nobody here' });
    expect(await refusal(perf.previewUnitExclusion(f.a, f.cycleId, { companyId: f.b.companyId, departmentId: empty.id }))).toMatch(/Nobody works in this unit today/);
  });
});
