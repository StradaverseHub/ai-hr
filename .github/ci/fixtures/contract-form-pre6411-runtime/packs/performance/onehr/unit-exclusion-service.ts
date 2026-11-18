/**
 * D-P1-22 (ADR-0150): units and departments not taking part in a cycle (the cycle exclusion rule).
 *
 * Service functions only (the administration screen, X5, waits for its design decision): list the rules, preview a
 * change, save it against the previewed digest and the cycle revision token, and bring a unit back.
 *
 * - Authority (D4): a tenant-wide HR administrator writes (app.assessment_unit_exclusion_writer); company-scoped
 *   administrators and performance partners read the rules and previews of their companies (RLS and the facts gate).
 * - One plan function (unitExclusionPlanTx) serves the preview and the save: the same database projection
 *   (app.assessment_unit_exclusion_facts, computed with the proposed scope before any write) and the same pure model.
 *   The save refuses a stale cycle revision or a different digest.
 * - Written once at save (D3): 360 rows archived through the keeping panel writer's body, untouched KPI lines moved
 *   through the moderator writer's body (moderatorSource 'matrix', no notices: D10). Frozen reviews are skipped and
 *   counted (D7). Everything else is derived from the rule by the database on every read.
 * - Bring back ends the rule. It restores no archived row and moves no KPI line back (business-exact).
 * - Events: review-cycle.unit-exclusion-set (rule, scope, counts, digest) and review-cycle.unit-exclusion-ended
 *   (rule, why: brought_back | subsumed). Rules are ended, never deleted (D12).
 */
import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { actorOf, appendEvent } from '../../../db/events';
import { assessmentUnitExclusion, company, department, onehrCycle, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { policySchema } from './model';
import { archiveUnitExclusionPanelRowsTx, moveUnitExclusionKpiLinesTx } from './service';
import { parseUnitExclusionFacts, planUnitExclusion, type UnitExclusionPlan } from './unit-exclusion-model';

const uuid = z.uuid();
const scopeSchema = z.object({ companyId: uuid, departmentId: uuid.nullable().optional().transform((v) => v ?? null) });
const saveSchema = scopeSchema.extend({ digest: z.string().regex(/^[0-9a-f]{64}$/), revision: z.number().int() });
const endSchema = z.object({ revision: z.number().int() });
export type UnitExclusionScope = z.input<typeof scopeSchema>;

async function flag(tx: Tx, query: SQL): Promise<boolean> {
  const [row] = await tx.execute<{ ok: boolean | null }>(sql`select (${query}) as ok`);
  return !!row?.ok;
}
async function requireWriter(tx: Tx) {
  if (!(await flag(tx, sql`app.assessment_unit_exclusion_writer()`))) throw Error('A group-wide HR administrator decides which units take part in a cycle.');
}
async function cycleEvent(tx: Tx, ctx: SessionContext, cycleId: string, eventType: string, payload: Record<string, unknown>) {
  await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'review-cycle', aggregateId: cycleId, eventType, actor: actorOf(ctx), payload });
}
/** The cycle row and its OneHR configuration, locked: saves and bring-backs of one cycle run one at a time. */
async function lockCycle(tx: Tx, cycleId: string) {
  const [native] = await tx.select({ status: reviewCycle.status }).from(reviewCycle).where(eq(reviewCycle.id, cycleId)).for('no key update');
  const [config] = await tx.select({ revision: onehrCycle.revision }).from(onehrCycle).where(eq(onehrCycle.cycleId, cycleId)).for('update');
  if (!native || !config) throw Error('Performance review cycle not found.');
  if (!['open', 'calibration'].includes(native.status)) throw Error('Units can be left out or brought back only while the cycle is open or in calibration.');
  return config;
}
function grouped<T>(rows: readonly T[], key: (row: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const row of rows) map.set(key(row), [...(map.get(key(row)) ?? []), row]);
  return [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** THE plan function (preview and save): the facts projection with the proposed scope, then the pure model. */
export async function unitExclusionPlanTx(tx: Tx, cycleId: string, scope: { companyId: string; departmentId: string | null }): Promise<{ plan: UnitExclusionPlan; revision: number }> {
  const [row] = await tx.execute<{ facts: unknown }>(sql`select app.assessment_unit_exclusion_facts(${cycleId}::uuid,${scope.companyId}::uuid,${scope.departmentId}::uuid) as facts`);
  if (!row?.facts) throw Error('Performance administrator access to this cycle and company is required.');
  const facts = parseUnitExclusionFacts(row.facts);
  if (!facts.scope.companyExists) throw Error('Choose a company in this organisation.');
  if (!facts.scope.companyInCycle) throw Error('The company is outside this cycle.');
  if (!facts.scope.departmentInCompany) throw Error('The department belongs to another company.');
  if (!['open', 'calibration'].includes(facts.cycle.status)) throw Error('Units can be left out or brought back only while the cycle is open or in calibration.');
  if (facts.scope.headcount < 1) throw Error('Nobody works in this unit today. Choose a unit with people in it.');
  const [config] = await tx.select({ policy: onehrCycle.policy }).from(onehrCycle).where(eq(onehrCycle.cycleId, cycleId));
  if (!config) throw Error('Performance review cycle not found.');
  return { plan: planUnitExclusion(facts, { panelTarget: policySchema.parse(config.policy).panelTarget }), revision: facts.cycle.revision };
}

/** The cycle's rules the caller may read (their companies), active and ended, oldest first. */
export async function listUnitExclusionRules(ctx: SessionContext, cycleId: string) {
  uuid.parse(cycleId);
  return withPerformanceTenant(ctx, async (tx) => {
    const [cycle] = await tx.select({ id: reviewCycle.id, name: reviewCycle.name, status: reviewCycle.status, revision: onehrCycle.revision })
      .from(reviewCycle).innerJoin(onehrCycle, eq(onehrCycle.cycleId, reviewCycle.id)).where(eq(reviewCycle.id, cycleId));
    if (!cycle) throw Error('Performance review cycle not found.');
    const rules = await tx.select({
      id: assessmentUnitExclusion.id, companyId: assessmentUnitExclusion.companyId, companyName: company.legalName,
      departmentId: assessmentUnitExclusion.departmentId, departmentName: department.name,
      createdBy: assessmentUnitExclusion.createdBy, createdAt: assessmentUnitExclusion.createdAt,
      endedBy: assessmentUnitExclusion.endedBy, endedAt: assessmentUnitExclusion.endedAt, endReason: assessmentUnitExclusion.endReason,
    }).from(assessmentUnitExclusion)
      .leftJoin(company, eq(company.id, assessmentUnitExclusion.companyId))
      .leftJoin(department, eq(department.id, assessmentUnitExclusion.departmentId))
      .where(eq(assessmentUnitExclusion.cycleId, cycleId))
      .orderBy(asc(assessmentUnitExclusion.createdAt), asc(assessmentUnitExclusion.id));
    return { cycle, canWrite: await flag(tx, sql`app.assessment_unit_exclusion_writer()`), rules: rules.map((r) => ({ ...r, active: r.endedAt == null })) };
  });
}

/** What saving this scope would do, with its digest and the cycle revision token. Writes nothing. */
export async function previewUnitExclusion(ctx: SessionContext, cycleId: string, raw: UnitExclusionScope) {
  uuid.parse(cycleId);
  const scope = scopeSchema.parse(raw);
  return withPerformanceTenant(ctx, async (tx) => {
    const { plan, revision } = await unitExclusionPlanTx(tx, cycleId, scope);
    return { ...plan, revision };
  });
}

/**
 * Saves the previewed scope: the rule, the subsumed department rules ended, the written-once effects, one event.
 * An identical active rule makes this a no-op (nothing written again). Refuses a stale revision or digest.
 */
export async function saveUnitExclusion(ctx: SessionContext, cycleId: string, raw: z.input<typeof saveSchema>) {
  uuid.parse(cycleId);
  const input = saveSchema.parse(raw);
  return withPerformanceTenant(ctx, async (tx) => {
    if (!ctx.userId) throw Error('Sign in to change which units take part.');
    await requireWriter(tx);
    const config = await lockCycle(tx, cycleId);
    if (config.revision !== input.revision) throw Error('The cycle changed since the preview. Preview the change again.');
    const { plan } = await unitExclusionPlanTx(tx, cycleId, { companyId: input.companyId, departmentId: input.departmentId });
    if (plan.digest !== input.digest) throw Error('This change was previewed against different data. Preview it again.');
    if (plan.alreadyActiveRuleId) return { ruleId: plan.alreadyActiveRuleId, alreadyActive: true, archived: 0, moved: 0, skippedFrozen: 0, skippedActed: 0, subsumed: 0, counts: plan.counts, revision: config.revision };
    const touched = [...new Set([...plan.archive.map((a) => a.subjectEmploymentId), ...plan.moves.map((m) => m.subjectEmploymentId)])];
    if (touched.length && await flag(tx, sql`exists(select 1 from employment e where e.id=any(array[${sql.join(touched.map((id) => sql`${id}::uuid`), sql`,`)}]::uuid[]) and app.is_self_person(e.person_id))`)) {
      throw Error('Ask another administrator: this change would archive or move work on your own assessment.');
    }
    const [rule] = await tx.insert(assessmentUnitExclusion).values({ tenantId: ctx.tenantId, cycleId, companyId: input.companyId, departmentId: input.departmentId, createdBy: ctx.userId })
      .returning({ id: assessmentUnitExclusion.id });
    const subsumed = plan.subsumedRuleIds.length
      ? await tx.update(assessmentUnitExclusion).set({ endedBy: ctx.userId, endedAt: new Date(), endReason: 'subsumed' })
        .where(and(inArray(assessmentUnitExclusion.id, plan.subsumedRuleIds), isNull(assessmentUnitExclusion.endedAt)))
        .returning({ id: assessmentUnitExclusion.id, companyId: assessmentUnitExclusion.companyId, departmentId: assessmentUnitExclusion.departmentId })
      : [];
    for (const ended of [...subsumed].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      await cycleEvent(tx, ctx, cycleId, 'review-cycle.unit-exclusion-ended', { ruleId: ended.id, companyId: ended.companyId, departmentId: ended.departmentId, why: 'subsumed', subsumedBy: rule.id });
    }
    const reason = `Unit not taking part in this cycle (rule ${rule.id})`;
    let archived = 0, skippedFrozen = plan.counts.frozenSkipped, moved = 0, skippedActed = 0;
    for (const [reviewId, rows] of grouped(plan.archive, (a) => a.reviewId)) {
      const done = await archiveUnitExclusionPanelRowsTx(tx, ctx, reviewId, rows.map((r) => r.requestId), reason);
      archived += done.archived; skippedFrozen += done.skippedFrozen;
    }
    for (const [reviewId, lines] of grouped(plan.moves, (m) => m.reviewId)) {
      const done = await moveUnitExclusionKpiLinesTx(tx, ctx, reviewId, lines.map((l) => ({ kpiId: l.kpiId, to: l.to })), rule.id);
      moved += done.moved; skippedActed += done.skipped;
    }
    await tx.update(onehrCycle).set({ revision: config.revision + 1 }).where(eq(onehrCycle.cycleId, cycleId));
    await cycleEvent(tx, ctx, cycleId, 'review-cycle.unit-exclusion-set', {
      ruleId: rule.id, companyId: input.companyId, departmentId: input.departmentId, digest: plan.digest,
      counts: { ...plan.counts, archived, moved, skippedFrozen, skippedActed }, subsumed: subsumed.map((s) => s.id).sort(),
    });
    return { ruleId: rule.id, alreadyActive: false, archived, moved, skippedFrozen, skippedActed, subsumed: subsumed.length, counts: plan.counts, revision: config.revision + 1 };
  });
}

/** Bring back: ends the rule. Archived 360 rows and moved KPI lines stay as they are (business-exact). */
export async function endUnitExclusion(ctx: SessionContext, ruleId: string, raw: z.input<typeof endSchema>) {
  uuid.parse(ruleId);
  const input = endSchema.parse(raw);
  return withPerformanceTenant(ctx, async (tx) => {
    if (!ctx.userId) throw Error('Sign in to change which units take part.');
    await requireWriter(tx);
    const [found] = await tx.select({ cycleId: assessmentUnitExclusion.cycleId }).from(assessmentUnitExclusion).where(eq(assessmentUnitExclusion.id, ruleId));
    if (!found) throw Error('Unit exclusion rule not found.');
    const config = await lockCycle(tx, found.cycleId);
    const [rule] = await tx.select().from(assessmentUnitExclusion).where(eq(assessmentUnitExclusion.id, ruleId)).for('update');
    if (!rule) throw Error('Unit exclusion rule not found.');
    if (rule.endedAt) throw Error('This unit already takes part again.');
    if (config.revision !== input.revision) throw Error('The cycle changed. Reload before bringing the unit back.');
    await tx.update(assessmentUnitExclusion).set({ endedBy: ctx.userId, endedAt: new Date(), endReason: 'brought_back' }).where(eq(assessmentUnitExclusion.id, ruleId));
    await tx.update(onehrCycle).set({ revision: config.revision + 1 }).where(eq(onehrCycle.cycleId, rule.cycleId));
    await cycleEvent(tx, ctx, rule.cycleId, 'review-cycle.unit-exclusion-ended', { ruleId, companyId: rule.companyId, departmentId: rule.departmentId, why: 'brought_back' });
    return { ruleId, revision: config.revision + 1 };
  });
}
