import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, or, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { appUser, assignment, businessUnit, company, compensation, employment, jobGrade, payrollBatch, payrollInput, performanceReview, reviewCycle, person, rewardCycle, rewardDecision, rewardEntry, rewardMember, rewardUnit } from '../../db/schema';
import { assertModuleGate, withRewardsTenant } from '../../core/module-gate';
import { setCompensation } from '../../core/comp';
import { setEmploymentGrade } from '../../core/org';
import { setPayrollInput } from '../payroll/service';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { calculateRewards } from './engine';
import { calculateOffcycle, offcycleRoute, offcycleTransition, type Funding } from './offcycle';
import { canEditStage, defaultPolicy, emptyFacts, emptyRecommendation, factsSchema, isoDateSchema, policySchema, recommendationSchema, rewardRoles, transition, visibleEntry, type RewardEntry, type RewardFacts, type RewardPolicy, type RewardRole, type RewardSource } from './model';

export { calculateRewards } from './engine';
export { defaultPolicy } from './model';
export class RewardError extends Error { constructor(message: string) { super(message); this.name = 'RewardError'; } }
const idSchema = z.uuid();
const moneyToCents = (v: string) => Math.round(Number(v) * 100);
const digest = (unit: typeof rewardUnit.$inferSelect, entries: RewardEntry[]) => createHash('sha256').update(JSON.stringify({ policy: unit.policy, kind: unit.kind, parentUnitId: unit.parentUnitId, offcycle: unit.offcycle, entries: [...entries].sort((a, b) => a.id.localeCompare(b.id)).map(e => ({ id: e.id, source: e.source, facts: e.facts, recommendation: e.recommendation })) })).digest('hex');

async function rolesFor(tx: Tx, unitId: string): Promise<RewardRole[]> {
  const result = await tx.execute<{ role: RewardRole }>(sql`select app.reward_roles(${unitId}::uuid) as role`);
  return result.map(r => r.role);
}
async function funding(tx: Tx, unitId: string, lock = false): Promise<Funding & { duplicate: boolean }> {
  const [r] = await tx.execute<{ value: Funding & { duplicate: boolean } }>(sql`select app.reward_funding(${unitId}::uuid, ${lock}) as value`);
  return r.value;
}
async function calculateUnit(tx: Tx, unit: typeof rewardUnit.$inferSelect, entries: RewardEntry[]) {
  if (unit.kind === 'annual') return calculateRewards(entries, unit.policy);
  const available = await funding(tx, unit.id);
  const result = calculateOffcycle(entries, unit.policy, unit.kind, unit.offcycle!, available);
  if (available.duplicate) result.flags.push({ severity: 'block', code: 'OC-12', message: 'An employee already has an open off-cycle request against this annual review.' });
  return result;
}
async function requireAdmin(tx: Tx, companyId: string) {
  const [r] = await tx.execute<{ ok: boolean }>(sql`select app.reward_admin(${companyId}::uuid) as ok`);
  if (!r?.ok) throw new RewardError('Company administrator access is required.');
}
async function load(tx: Tx, unitId: string, lock = false) {
  idSchema.parse(unitId);
  const query = tx.select().from(rewardUnit).where(eq(rewardUnit.id, unitId));
  const [unit] = await (lock ? query.for('update') : query);
  if (!unit) throw new RewardError('Reward unit not found or access has been removed.');
  const roles = await rolesFor(tx, unitId);
  if (!roles.length) throw new RewardError('Ask an administrator to assign your Reward Desk role for this unit.');
  const entries = await tx.select().from(rewardEntry).where(eq(rewardEntry.unitId, unitId)).orderBy(asc(rewardEntry.id));
  return { unit, roles, entries };
}
function assertRevision(unit: typeof rewardUnit.$inferSelect, revision: number) {
  if (!Number.isInteger(revision) || unit.revision !== revision) throw new RewardError('This review changed in another session. Reload before saving.');
}
function assertUnlocked(unit: typeof rewardUnit.$inferSelect) {
  if (unit.status !== 'draft') throw new RewardError('Return the unit to draft before changing its approved inputs.');
}
async function stamp(tx: Tx, ctx: SessionContext, unitId: string, event: string, payload: Record<string, unknown> = {}) {
  await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'reward-unit', aggregateId: unitId, eventType: `reward-unit.${event}`, actor: actorOf(ctx), payload });
}
async function touch(tx: Tx, unitId: string) {
  await tx.update(rewardUnit).set({ revision: sql`${rewardUnit.revision}+1`, approvedDigest: null, updatedAt: new Date() }).where(eq(rewardUnit.id, unitId));
}

/** The only roster read crossing the service boundary. Never return internal entries or EC aggregates. */
export async function getRewardUnit(ctx: SessionContext, unitId: string) {
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId);
    const calculated = await calculateUnit(tx, unit, entries);
    const visible = calculated.rows.filter(e => visibleEntry(e, roles, ctx.personId));
    const visibleIds = new Set(visible.map(e => e.id));
    const flags = calculated.flags.filter(f => !f.entryId || visibleIds.has(f.entryId));
    const hiddenBlocks = calculated.flags.filter(f => f.entryId && !visibleIds.has(f.entryId) && f.severity === 'block').length;
    if (hiddenBlocks) flags.push({ severity: 'block', code: 'ACCESS-01', message: 'A restricted record needs review by its authorised reviewer.' });
    const [cycle] = await tx.select().from(rewardCycle).where(eq(rewardCycle.id, unit.cycleId));
    const [bu] = await tx.select({ name: businessUnit.name }).from(businessUnit).where(eq(businessUnit.id, unit.businessUnitId));
    const members = await tx.select({ id: rewardMember.id, role: rewardMember.role, userId: rewardMember.userId }).from(rewardMember).where(eq(rewardMember.unitId, unitId)).orderBy(asc(rewardMember.role), asc(rewardMember.userId));
    const decisions = await tx.select({ id: rewardDecision.id, action: rewardDecision.action, fromStage: rewardDecision.fromStage, toStage: rewardDecision.toStage, actorId: rewardDecision.actorId, reason: rewardDecision.reason, createdAt: rewardDecision.createdAt, revision: rewardDecision.revision }).from(rewardDecision).where(eq(rewardDecision.unitId, unitId)).orderBy(desc(rewardDecision.createdAt), desc(rewardDecision.id));
    // EC totals are derived ONLY from the rows the viewer may see (including the own-person exclusion).
    const ecRows = visible.filter(e => e.plan === 'ec');
    return { unit, cycle, route: unit.kind === 'annual' ? ['bu', 'bg', 'gr', 'ctro', 'ec'] as RewardRole[] : offcycleRoute(unit.kind, unit.offcycle!, entries), name: bu?.name ?? 'Business unit', roles, members, decisions,
      rows: visible, flags, hiddenCount: entries.length - visible.length,
      budgets: { standard: calculated.budgets.standard, h: calculated.budgets.h },
      ec: roles.some(r => ['gr', 'ctro', 'ec'].includes(r)) ? { count: ecRows.length, referenceCents: Math.round(ecRows.reduce((v, e) => v + e.source.basicCents, 0) * .07), incrementCents: ecRows.reduce((v, e) => v + e.newBasicCents - e.source.basicCents, 0), bonusCents: ecRows.reduce((v, e) => v + e.bonusCents + e.lumpCents, 0) } : null,
      suggestedLumpCents: calculated.suggestedLumpCents, lumpUnitCents: calculated.lumpUnitCents,
      suggestedMultiplierBp: calculated.suggestedMultiplierBp, lumpWorking: calculated.lumpWorking,
      canEdit: canEditStage(unit.status, roles) || unit.kind !== 'annual' && unit.status === 'draft' && roles.includes('bg'), canConfigure: roles.includes('gr') && unit.status === 'draft' && unit.kind === 'annual',
    };
  });
}

export async function listRewardUnits(ctx: SessionContext, companyIds: string[]) {
  return withRewardsTenant(ctx, async tx => {
    if (!companyIds.length) return [];
    return tx.select({ id: rewardUnit.id, cycleId: rewardCycle.id, cycle: rewardCycle.name, kind: rewardUnit.kind, year: rewardCycle.year, company: company.legalName, unit: businessUnit.name, status: rewardUnit.status, revision: rewardUnit.revision })
      .from(rewardUnit).innerJoin(rewardCycle, eq(rewardCycle.id, rewardUnit.cycleId)).innerJoin(company, eq(company.id, rewardUnit.companyId)).innerJoin(businessUnit, eq(businessUnit.id, rewardUnit.businessUnitId))
      .where(inArray(rewardUnit.companyId, companyIds)).orderBy(desc(rewardCycle.year), asc(rewardCycle.name), asc(businessUnit.name));
  });
}

export async function rewardSetupChoices(ctx: SessionContext, companyIds: string[]) {
  return withRewardsTenant(ctx, async tx => {
    const companies = companyIds.length ? await tx.select({ id: company.id, name: company.legalName }).from(company).where(and(inArray(company.id, companyIds), sql`app.reward_admin(${company.id})`)).orderBy(asc(company.legalName)) : [];
    if (!companies.length) return { companies: [], units: [], users: [], cycles: [] };
    const units = await tx.select({ id: businessUnit.id, companyId: businessUnit.companyId, name: businessUnit.name, global: businessUnit.isGlobal }).from(businessUnit).where(and(isNull(businessUnit.archivedAt), or(inArray(businessUnit.companyId, companies.map(c => c.id)), eq(businessUnit.isGlobal, true)))).orderBy(asc(businessUnit.name));
    const users = await tx.select({ id: appUser.id, name: person.fullName, email: person.primaryEmail }).from(appUser).leftJoin(person, eq(person.id, appUser.personId)).where(and(isNull(appUser.archivedAt), sql`not app.login_blocked(${appUser.id})`)).orderBy(asc(person.fullName), asc(appUser.id));
    const cycles = await tx.select({ id: rewardCycle.id, name: rewardCycle.name, year: rewardCycle.year }).from(rewardCycle).orderBy(desc(rewardCycle.year), asc(rewardCycle.name));
    return { companies, units, users, cycles };
  });
}

async function snapshotEmployees(tx: Tx, ctx: SessionContext, unit: typeof rewardUnit.$inferSelect) {
  await requireAdmin(tx, unit.companyId);
  const at = unit.snapshotDate;
  const records = await tx.select({ employmentId: employment.id, personId: employment.personId, companyId: employment.companyId, employeeCode: employment.employeeCode, name: person.fullName, grade: jobGrade.code, gradeId: employment.gradeId, hiredOn: employment.hiredOn, confirmedOn: employment.confirmationDate, tenderDate: employment.tenderResignationDate, resignedOn: employment.resignationDate, assignmentId: assignment.id })
    .from(employment).innerJoin(person, eq(person.id, employment.personId)).innerJoin(assignment, eq(assignment.employmentId, employment.id)).leftJoin(jobGrade, eq(jobGrade.id, employment.gradeId))
    .where(and(eq(employment.companyId, unit.companyId), eq(assignment.businessUnitId, unit.businessUnitId), lte(employment.hiredOn, at), or(isNull(employment.terminatedOn), gt(employment.terminatedOn, at)), lte(assignment.validFrom, at), or(isNull(assignment.validTo), gt(assignment.validTo, at)), isNull(assignment.supersededAt)))
    .orderBy(asc(employment.employeeCode), asc(employment.id));
  const seen = new Set<string>();
  for (const e of records) {
    if (seen.has(e.employmentId)) throw new RewardError('An employee has overlapping assignments. Correct Personnel before importing.');
    seen.add(e.employmentId);
    const [comp] = await tx.select().from(compensation).where(and(eq(compensation.employmentId, e.employmentId), lte(compensation.validFrom, at), or(isNull(compensation.validTo), gt(compensation.validTo, at)), isNull(compensation.supersededAt))).orderBy(desc(compensation.validFrom)).limit(1);
    const [review] = await tx.select({ id: performanceReview.id, rating: performanceReview.overallRating }).from(performanceReview).innerJoin(reviewCycle, eq(reviewCycle.id, performanceReview.cycleId)).where(and(eq(performanceReview.employmentId, e.employmentId), lte(reviewCycle.periodStart, `${unit.policy.year}-12-31`), sql`${reviewCycle.periodEnd} >= ${`${unit.policy.year}-01-01`}`, sql`${performanceReview.closedAt} is not null`)).orderBy(desc(performanceReview.closedAt), desc(performanceReview.id)).limit(1);
    const source: RewardSource = {
      employmentId: e.employmentId, personId: e.personId, compensationId: comp?.id ?? null,
      employeeCode: e.employeeCode ?? e.employmentId, name: e.name, grade: (e.grade ?? '').replace(/^JG\s*/i, ''), gradeId: e.gradeId,
      basicCents: comp ? moneyToCents(comp.basicSalary) : 0, currency: comp?.currency ?? 'MYR', payMode: comp?.payMode ?? 'monthly',
      hiredOn: e.hiredOn, confirmedOn: e.confirmedOn, notice: !!((e.tenderDate && e.tenderDate <= at) || (e.resignedOn && e.resignedOn <= at)),
      lastPayChange: comp && comp.validFrom > e.hiredOn ? comp.validFrom : null,
      confirmationPayChange: !!(comp && e.confirmedOn && comp.validFrom === e.confirmedOn && comp.validFrom > e.hiredOn),
      performanceReviewId: review?.id ?? null, performanceRating: review?.rating ?? null,
    };
    const [existing] = await tx.select({ id: rewardEntry.id, source: rewardEntry.source, facts: rewardEntry.facts }).from(rewardEntry).where(and(eq(rewardEntry.unitId, unit.id), eq(rewardEntry.employmentId, e.employmentId)));
    if (existing) {
      // Refresh is explicit and invalidates data verification and all earlier approvals.
      await tx.update(rewardEntry).set({ source, facts: { ...existing.facts, reviewed: false }, updatedAt: new Date() }).where(eq(rewardEntry.id, existing.id));
    } else await tx.insert(rewardEntry).values({ tenantId: ctx.tenantId, unitId: unit.id, employmentId: e.employmentId, source, facts: emptyFacts(), recommendation: emptyRecommendation() });
  }
  return seen;
}

export async function createRewardUnit(ctx: SessionContext, raw: { name: string; year: number; companyId: string; businessUnitId: string; cycleId?: string; snapshotDate: string }) {
  const p = z.object({ name: z.string().trim().min(1).max(160), year: z.number().int().min(2000).max(2200), companyId: idSchema, businessUnitId: idSchema, cycleId: idSchema.optional(), snapshotDate: isoDateSchema }).parse(raw);
  if (p.snapshotDate > todayInKualaLumpur()) throw new RewardError('The snapshot date cannot be in the future.');
  return withRewardsTenant(ctx, async tx => {
    await requireAdmin(tx, p.companyId);
    let cycleId = p.cycleId;
    if (cycleId) { const [cycle] = await tx.select().from(rewardCycle).where(eq(rewardCycle.id, cycleId)); if (!cycle || cycle.year !== p.year) throw new RewardError('Select a cycle in the same reward year.'); }
    else { const [cycle] = await tx.insert(rewardCycle).values({ tenantId: ctx.tenantId, name: p.name, year: p.year, createdBy: ctx.userId! }).returning(); cycleId = cycle.id; }
    const [unit] = await tx.insert(rewardUnit).values({ tenantId: ctx.tenantId, createdBy: ctx.userId!, cycleId, companyId: p.companyId, businessUnitId: p.businessUnitId, policy: defaultPolicy(p.year), snapshotDate: p.snapshotDate }).returning();
    await tx.insert(rewardMember).values({ tenantId: ctx.tenantId, unitId: unit.id, userId: ctx.userId!, role: 'gr' });
    const employees = await snapshotEmployees(tx, ctx, unit);
    await stamp(tx, ctx, unit.id, 'created', { cycleId, employeeCount: employees.size });
    return unit.id;
  });
}

export async function saveRewardPolicy(ctx: SessionContext, unitId: string, revision: number, raw: unknown) {
  const policy = policySchema.parse(raw);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles } = await load(tx, unitId, true); assertRevision(unit, revision); assertUnlocked(unit);
    if (!roles.includes('gr')) throw new RewardError('Only Group Rewards may change policy.');
    if (unit.kind !== 'annual') throw new RewardError('Off-cycle reviews inherit their annual policy.');
    if (policy.year !== unit.policy.year) throw new RewardError('The reward year cannot change after the roster is created.');
    await tx.update(rewardUnit).set({ policy }).where(eq(rewardUnit.id, unitId)); await touch(tx, unitId);
    await stamp(tx, ctx, unitId, 'policy-updated', { revision: unit.revision + 1 });
  });
}

export async function setRewardMember(ctx: SessionContext, unitId: string, revision: number, userId: string, role: RewardRole, remove = false) {
  idSchema.parse(unitId); idSchema.parse(userId); z.enum(rewardRoles).parse(role);
  return withRewardsTenant(ctx, async tx => {
    const [unit] = await tx.select().from(rewardUnit).where(eq(rewardUnit.id, unitId)).for('update');
    if (!unit) throw new RewardError('Reward unit not found.');
    await requireAdmin(tx, unit.companyId); assertRevision(unit, revision); assertUnlocked(unit);
    const predicate = and(eq(rewardMember.unitId, unitId), eq(rewardMember.userId, userId), eq(rewardMember.role, role));
    if (remove && role === 'gr') {
      const group = await tx.select().from(rewardMember).where(and(eq(rewardMember.unitId, unitId), eq(rewardMember.role, 'gr')));
      if (group.filter(m => m.userId !== userId).length === 0) throw new RewardError('Keep at least one Group Rewards reviewer assigned.');
    }
    if (remove) await tx.delete(rewardMember).where(predicate);
    else if (!(await tx.select({ id: rewardMember.id }).from(rewardMember).where(predicate)).length) await tx.insert(rewardMember).values({ tenantId: ctx.tenantId, unitId, userId, role });
    // Role changes invalidate open forms just like recommendation changes.
    await touch(tx, unitId);
    await stamp(tx, ctx, unitId, remove ? 'member-removed' : 'member-assigned', { userId, role });
  });
}

export async function saveRewardEntry(ctx: SessionContext, unitId: string, revision: number, entryId: string, recommendation: unknown, facts?: unknown) {
  idSchema.parse(entryId); const rec = recommendationSchema.parse(recommendation);
  const validatedFacts = facts === undefined ? undefined : factsSchema.parse(facts);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId, true); assertRevision(unit, revision); assertUnlocked(unit);
    const entry = entries.find(e => e.id === entryId);
    if (!entry || !visibleEntry(entry, roles, ctx.personId)) throw new RewardError('This reward record is not available to you.');
    const canEC = entry.facts.confidentiality === 'ec' && roles.some(r => ['gr', 'ctro', 'ec'].includes(r));
    if (!canEditStage(unit.status, roles) && !(unit.kind !== 'annual' && roles.includes('bg')) && !canEC) throw new RewardError('You cannot edit this reward recommendation.');
    if (entry.facts.confidentiality !== 'ec' && rec.bonusCents != null) throw new RewardError('Use the bonus multiplier for a standard or JG H employee.');
    if (validatedFacts && !roles.includes('gr')) {
      const { erDecision: _er, pipDecision: _pip, caseReason: _reason, ...oldClassification } = entry.facts;
      const { erDecision: _newEr, pipDecision: _newPip, caseReason: _newReason, ...newClassification } = validatedFacts;
      if (!roles.includes('bu') || !isDeepStrictEqual(oldClassification, newClassification)) throw new RewardError('Only Group Rewards may verify employee inputs.');
    }
    await tx.update(rewardEntry).set({ recommendation: rec, ...(validatedFacts ? { facts: validatedFacts } : {}), updatedAt: new Date() }).where(eq(rewardEntry.id, entryId));
    await touch(tx, unitId); await stamp(tx, ctx, unitId, 'recommendation-updated', { entryId, revision: unit.revision + 1 });
  });
}

export async function importRewardFacts(ctx: SessionContext, unitId: string, revision: number, rows: { employmentId: string; facts: RewardFacts }[]) {
  const input = z.array(z.object({ employmentId: idSchema, facts: factsSchema })).min(1).max(10000).parse(rows);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId, true); assertRevision(unit, revision); assertUnlocked(unit);
    if (!roles.includes('gr')) throw new RewardError('Only Group Rewards may import ratings and classifications.');
    const seen = new Set<string>();
    for (const row of input) {
      const e = entries.find(e => e.employmentId === row.employmentId);
      if (!e || !visibleEntry(e, roles, ctx.personId) || seen.has(row.employmentId)) throw new RewardError('The import contains a duplicate or unavailable employee. Nothing was imported.');
      seen.add(row.employmentId);
      await tx.update(rewardEntry).set({ facts: row.facts, updatedAt: new Date() }).where(eq(rewardEntry.id, e.id));
    }
    await touch(tx, unitId); await stamp(tx, ctx, unitId, 'facts-imported', { count: input.length, revision: unit.revision + 1 });
  });
}

export async function refreshRewardSources(ctx: SessionContext, unitId: string, revision: number) {
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles, entries } = await load(tx, unitId, true); assertRevision(unit, revision); assertUnlocked(unit);
    if (!roles.includes('gr')) throw new RewardError('Only Group Rewards may refresh the roster.');
    if (unit.kind !== 'annual') throw new RewardError('Create a replacement off-cycle request if its salary snapshot is stale.');
    const seen = await snapshotEmployees(tx, ctx, unit);
    if (entries.some(e => !seen.has(e.employmentId))) throw new RewardError('The roster changed since this cycle was created. Create a replacement unit review to avoid silently dropping a recommendation.');
    await touch(tx, unitId); await stamp(tx, ctx, unitId, 'sources-refreshed', { revision: unit.revision + 1 });
  });
}

export async function setRewardUnitLump(ctx: SessionContext, unitId: string, revision: number, cents: number | null) {
  const value = z.number().int().min(0).max(100_000_000_000).nullable().parse(cents);
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles } = await load(tx, unitId, true); assertRevision(unit, revision); assertUnlocked(unit);
    if (!canEditStage(unit.status, roles)) throw new RewardError('You cannot change this unit recommendation.');
    await tx.update(rewardUnit).set({ policy: { ...unit.policy, lumpUnitCents: value } }).where(eq(rewardUnit.id, unitId));
    await touch(tx, unitId); await stamp(tx, ctx, unitId, 'lump-updated', { revision: unit.revision + 1 });
  });
}

export async function decideRewardUnit(ctx: SessionContext, unitId: string, revision: number, action: 'submit' | 'approve' | 'return' | 'reject' | 'withdraw', reason: string, acknowledged = false) {
  z.enum(['submit', 'approve', 'return', 'reject', 'withdraw']).parse(action); reason = z.string().trim().max(4000).parse(reason);
  return withRewardsTenant(ctx, async tx => {
    idSchema.parse(unitId); await funding(tx, unitId, true);
    const { unit, roles, entries } = await load(tx, unitId, true); assertRevision(unit, revision);
    const route = unit.kind === 'annual' ? ['bu', 'bg', 'gr', 'ctro', 'ec'] as RewardRole[] : offcycleRoute(unit.kind, unit.offcycle!, entries);
    if (unit.kind === 'annual' && (action === 'reject' || action === 'withdraw')) throw new RewardError('Return an annual review to draft instead.');
    const next = unit.kind === 'annual' ? transition(unit.status, roles, action as 'submit' | 'approve' | 'return') : offcycleTransition(unit.status, roles, action, route);
    if (unit.kind !== 'annual' && action === 'approve' && entries.some(e => visibleEntry(e, roles, ctx.personId) && e.recommendation.promotionGrade) && !acknowledged) throw new RewardError('Acknowledge that you reviewed the current and proposed role summaries.');
    if (['return', 'reject', 'withdraw'].includes(action) && reason.length < 10) throw new RewardError('Explain why the unit is being returned (at least 10 characters).');
    const hash = digest(unit, entries), calculated = await calculateUnit(tx, unit, entries);
    if (action === 'submit' || action === 'approve') {
      if (!entries.length) throw new RewardError('A review needs at least one employee.');
      if (calculated.flags.some(f => f.severity === 'block')) throw new RewardError('Resolve all blocking checks, including restricted records, before proceeding.');
      if (calculated.flags.some(f => ['exception', 'warning'].includes(f.severity)) && reason.length < 10) throw new RewardError('Record why the exceptions and warnings are acceptable.');
      const members = await tx.select({ role: rewardMember.role }).from(rewardMember).innerJoin(appUser, eq(appUser.id, rewardMember.userId)).where(and(eq(rewardMember.unitId, unitId), isNull(appUser.archivedAt), sql`not app.login_blocked(${appUser.id})`));
      if ([...route, 'payroll'].some(role => !members.some(m => m.role === role))) throw new RewardError('Assign every approval role and the payroll handoff before submitting.');
      if (unit.status !== 'draft' && unit.approvedDigest !== hash) throw new RewardError('The inputs changed after submission. Return this review to draft.');
      // A person must not sign consecutive stages of the same revision, even if granted both roles.
      const [prior] = await tx.select().from(rewardDecision).where(and(eq(rewardDecision.unitId, unitId), eq(rewardDecision.revision, revision))).orderBy(desc(rewardDecision.createdAt), desc(rewardDecision.id)).limit(1);
      if (prior?.actorId === ctx.userId && action === 'approve') throw new RewardError('A different reviewer must sign the next approval stage.');
    }
    await tx.insert(rewardDecision).values({ tenantId: ctx.tenantId, unitId, actorId: ctx.userId!, revision, action, fromStage: unit.status, toStage: next, reason, digest: hash });
    await tx.update(rewardUnit).set({ status: next, approvedDigest: ['return', 'reject', 'withdraw'].includes(action) ? null : hash, ...(action === 'return' ? { revision: revision + 1 } : {}), ...(unit.kind !== 'annual' ? { reservedCents: { standard: calculated.budgets.standard.used[0], h: calculated.budgets.h.used[0] } } : {}), updatedAt: new Date() }).where(eq(rewardUnit.id, unitId));
    await stamp(tx, ctx, unitId, next === 'approved' ? 'approved' : 'routed', { from: unit.status, to: next, revision });
    return next;
  });
}

export async function rewardPayrollChoices(ctx: SessionContext, unitId: string) {
  return withRewardsTenant(ctx, async tx => {
    const { unit, roles } = await load(tx, unitId);
    if (!roles.includes('payroll')) return [];
    return tx.select({ id: payrollBatch.id, period: payrollBatch.payPeriod }).from(payrollBatch).where(and(eq(payrollBatch.companyId, unit.companyId), eq(payrollBatch.status, 'draft'))).orderBy(desc(payrollBatch.payPeriod), asc(payrollBatch.id));
  });
}

export async function postRewardUnit(ctx: SessionContext, unitId: string, revision: number, batchId?: string) {
  if (batchId) idSchema.parse(batchId);
  assertModuleGate(ctx, 'payroll');
  return withRewardsTenant(ctx, async tx => {
    idSchema.parse(unitId); await funding(tx, unitId, true);
    const { unit, roles, entries } = await load(tx, unitId, true); assertRevision(unit, revision);
    if (!roles.includes('payroll')) throw new RewardError('The assigned payroll role is required.');
    await requireAdmin(tx, unit.companyId); // The existing salary and grade writers are administrator-owned.
    if (unit.status === 'posted') return { alreadyPosted: true };
    if (unit.status !== 'approved' || unit.approvedDigest !== digest(unit, entries)) throw new RewardError('Only the unchanged, fully approved review can be posted.');
    const result = await calculateUnit(tx, unit, entries);
    if (result.flags.some(f => f.severity === 'block')) throw new RewardError('The approved review no longer passes validation.');
    const hasBonus = result.rows.some(e => e.bonusCents + e.lumpCents > 0);
    if (hasBonus && !batchId) throw new RewardError('Select a draft payroll batch for the bonus and lump-sum awards.');
    if (batchId) {
      const [batch] = await tx.select().from(payrollBatch).where(eq(payrollBatch.id, batchId)).for('update');
      if (!batch || batch.companyId !== unit.companyId || batch.status !== 'draft') throw new RewardError('The payroll batch must be a draft in this company.');
    }
    // Deterministic lock order makes simultaneous reward units on the same people serialize.
    for (const e of [...result.rows].sort((a, b) => a.source.employmentId.localeCompare(b.source.employmentId))) {
      const [emp] = await tx.select().from(employment).where(eq(employment.id, e.source.employmentId)).for('update');
      if (!emp || emp.companyId !== unit.companyId || emp.terminatedOn || emp.gradeId !== e.source.gradeId) throw new RewardError('An employee changed company, grade or employment status. Return and refresh the review.');
      const [cur] = await tx.select().from(compensation).where(and(eq(compensation.employmentId, emp.id), isNull(compensation.validTo), isNull(compensation.supersededAt))).for('update');
      if (!cur || cur.id !== e.source.compensationId || moneyToCents(cur.basicSalary) !== e.source.basicCents || cur.currency !== e.source.currency || cur.payMode !== e.source.payMode) throw new RewardError('Salary data changed after the snapshot. Return and refresh the review.');
      if (e.newBasicCents !== e.source.basicCents) {
        if (unit.policy.effectiveFrom <= cur.validFrom) throw new RewardError('The salary effective date must follow the current salary record.');
        const comp = await setCompensation(ctx, { employmentId: emp.id, basicSalary: e.newBasicCents / 100, effectiveFrom: unit.policy.effectiveFrom, remarks: `Approved Reward Desk review ${unitId}` }, tx);
        await tx.update(rewardEntry).set({ enactedCompensationId: comp.compensationId }).where(eq(rewardEntry.id, e.id));
      }
      if (e.recommendation.promotionGrade) {
        // Grade is currently an undated employment attribute: do not silently apply a future promotion today.
        if (unit.policy.effectiveFrom !== todayInKualaLumpur()) throw new RewardError('A promotion must be posted on its effective date because Job Grade is not effective-dated.');
        const grades = await tx.select().from(jobGrade).where(isNull(jobGrade.archivedAt));
        const grade = grades.find(g => g.code.replace(/^JG\s*/i, '') === e.recommendation.promotionGrade);
        if (!grade) throw new RewardError('The approved promotion grade does not exist in Job Grades.');
        await setEmploymentGrade(ctx, { employmentId: emp.id, gradeId: grade.id }, tx);
      }
      const award = e.bonusCents + e.lumpCents;
      if (award && batchId) {
        const [existing] = await tx.select().from(payrollInput).where(and(eq(payrollInput.batchId, batchId), eq(payrollInput.employmentId, emp.id))).for('update');
        await setPayrollInput(ctx, { batchId, employmentId: emp.id, overtimeAmount: Number(existing?.overtimeAmount ?? 0), bonusAmount: Number(existing?.bonusAmount ?? 0) + award / 100, tp1Deduction: Number(existing?.tp1Deduction ?? 0), zakat: Number(existing?.zakat ?? 0), otSource: 'preserve', tp1SourceMode: 'preserve' }, tx);
      }
    }
    await tx.update(rewardUnit).set({ status: 'posted', fundingCents: unit.kind === 'annual' ? { standard: result.budgets.standard.pools.reduce((n, amount, i) => n + Math.max(0, amount - result.budgets.standard.used[i]), 0), h: result.budgets.h.pools.reduce((n, amount, i) => n + Math.max(0, amount - result.budgets.h.used[i]), 0) } : unit.fundingCents, postedBatchId: batchId ?? null, postedAt: new Date(), updatedAt: new Date() }).where(eq(rewardUnit.id, unitId));
    await stamp(tx, ctx, unitId, 'posted', { batchId: batchId ?? null, revision });
    return { alreadyPosted: false };
  });
}

export async function createOffcycleReview(ctx: SessionContext, parentId: string, raw: { kind: 'adhoc' | 'midyear'; entryIds: string[]; effectiveFrom: string; exceptionReason: string }) {
  idSchema.parse(parentId);
  const p = z.object({ kind: z.enum(['adhoc', 'midyear']), entryIds: z.array(idSchema).min(1).max(10000), effectiveFrom: isoDateSchema, exceptionReason: z.string().trim().max(4000) }).parse(raw);
  if (p.kind === 'adhoc' && p.entryIds.length !== 1) throw new RewardError('Select exactly one employee for an ad-hoc request.');
  if (new Set(p.entryIds).size !== p.entryIds.length) throw new RewardError('Select each employee only once.');
  if (p.exceptionReason && (p.kind !== 'adhoc' || p.exceptionReason.length < 30)) throw new RewardError('A budget exception is available only for an ad-hoc request and needs a reason of at least 30 characters.');
  return withRewardsTenant(ctx, async tx => {
    const { unit: parent, roles, entries } = await load(tx, parentId);
    if (parent.kind !== 'annual' || parent.status !== 'posted') throw new RewardError('Use a posted annual review as the funding source.');
    if (!roles.some(r => ['bu', 'bg', 'gr'].includes(r))) throw new RewardError('BU, BG or Group Rewards access is required.');
    if (p.effectiveFrom <= parent.policy.effectiveFrom) throw new RewardError('The off-cycle effective date must follow the annual award.');
    const selected = p.entryIds.map(id => entries.find(e => e.id === id));
    if (selected.some(e => !e || !visibleEntry(e, roles, ctx.personId))) throw new RewardError('The request contains an unavailable employee.');
    const chosen = selected as typeof entries;
    const bgOrigin = !roles.includes('bu') && !roles.includes('gr') && roles.includes('bg');
    if (bgOrigin && (p.kind !== 'adhoc' || chosen.some(e => e.facts.confidentiality !== 'bg'))) throw new RewardError('BG may originate an ad-hoc request for a BG direct report.');
    const id = randomUUID();
    const [unit] = await tx.insert(rewardUnit).values({ id, tenantId: ctx.tenantId, createdBy: ctx.userId!, cycleId: parent.cycleId, companyId: parent.companyId, businessUnitId: parent.businessUnitId,
      kind: p.kind, parentUnitId: parent.id, offcycle: { exceptionReason: p.exceptionReason, bgOrigin },
      policy: { ...parent.policy, effectiveFrom: p.effectiveFrom }, snapshotDate: todayInKualaLumpur(),
    }).returning();
    const members = await tx.select({ userId: rewardMember.userId, role: rewardMember.role }).from(rewardMember).innerJoin(appUser, eq(appUser.id, rewardMember.userId)).where(and(eq(rewardMember.unitId, parentId), isNull(appUser.archivedAt), sql`not app.login_blocked(${appUser.id})`));
    for (const m of members) await tx.insert(rewardMember).values({ tenantId: ctx.tenantId, unitId: id, userId: m.userId, role: m.role });
    for (const e of chosen) {
      const [record] = await tx.execute<{ source: Partial<RewardSource> | null }>(sql`select app.reward_current_source(${parentId}::uuid, ${e.employmentId}::uuid) as source`);
      if (!record.source) throw new RewardError('An employee has left this company or has no current salary.');
      const source = { ...e.source, ...record.source };
      if (source.lastPayChange && p.effectiveFrom <= source.lastPayChange) throw new RewardError('The effective date must follow the current salary record.');
      await tx.insert(rewardEntry).values({ tenantId: ctx.tenantId, unitId: id, employmentId: e.employmentId, source, facts: e.facts, recommendation: emptyRecommendation() });
    }
    await stamp(tx, ctx, id, 'created', { parentId, kind: unit.kind, employeeCount: chosen.length });
    return id;
  });
}

export async function pendingRewardReviews(ctx: SessionContext, companyIds: string[]) {
  return withRewardsTenant(ctx, async tx => {
    if (!companyIds.length) return [];
    return tx.select({ id: rewardUnit.id, kind: rewardUnit.kind, status: rewardUnit.status, name: businessUnit.name, cycle: rewardCycle.name })
      .from(rewardUnit).innerJoin(rewardCycle, eq(rewardCycle.id, rewardUnit.cycleId)).innerJoin(businessUnit, eq(businessUnit.id, rewardUnit.businessUnitId))
      .where(and(inArray(rewardUnit.companyId, companyIds), sql`${rewardUnit.status} in ('bg','gr','ctro','ec')`, sql`${rewardUnit.status} in (select app.reward_roles(${rewardUnit.id}))`))
      .orderBy(asc(rewardUnit.createdAt), asc(rewardUnit.id));
  });
}

/** In-app notification fan-out for the shared dispatcher; payloads contain no employee pay. */
export async function rewardNotificationRecipients(tx: Tx, unitId: string, stage: unknown): Promise<string[]> {
  if (typeof stage !== 'string') return [];
  const role = stage === 'approved' ? 'payroll' : stage === 'draft' ? 'bu' : stage;
  if (!(rewardRoles as readonly string[]).includes(role)) return [];
  const rows = await tx.select({ employmentId: employment.id }).from(rewardMember)
    .innerJoin(appUser, eq(appUser.id, rewardMember.userId))
    .innerJoin(employment, eq(employment.personId, appUser.personId))
    .innerJoin(rewardUnit, eq(rewardUnit.id, rewardMember.unitId))
    .where(and(eq(rewardMember.unitId, unitId), eq(rewardUnit.status, stage as (typeof rewardUnit.$inferSelect)['status']), sql`${rewardMember.role} = case when ${rewardUnit.status}='draft' and ${rewardUnit.offcycle}->>'bgOrigin'='true' then 'bg' else ${role} end`, eq(rewardUnit.companyId, employment.companyId), isNull(appUser.archivedAt), isNull(employment.terminatedOn), sql`not app.login_blocked(${appUser.id})`));
  return [...new Set(rows.map(r => r.employmentId))];
}
