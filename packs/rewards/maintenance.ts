/** Review lifecycle and access administration. These projections never load the pay roster. */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { appUser, businessUnit, company, person, rewardCycle, rewardMember, rewardUnit } from '../../db/schema';
import { withRewardsTenant } from '../../core/module-gate';
import { rewardRoles, type RewardRole } from './model';
export type RewardMaintenanceCode = 'scope' | 'changed' | 'locked' | 'account' | 'lastGr' | 'membership' | 'preview' | 'confirmation' | 'used' | 'missing';
const errorMessages: Record<RewardMaintenanceCode, string> = { scope: 'Company administrator access is required.', changed: 'This review changed in another session. Reload before saving.', locked: 'Return the unit to draft before changing its approved inputs.', account: 'Choose an active existing login account in this tenant.', lastGr: 'Keep at least one active Group Rewards reviewer assigned.', membership: 'The selected membership changed. Reload before saving.', preview: 'Access or account eligibility changed. Preview it again before saving.', confirmation: 'Confirm the exact review before deleting.', used: 'This review is in use and its history must be retained.', missing: 'Reward unit not found or access has been removed.' };
export class RewardMaintenanceError extends Error {
    constructor(readonly code: RewardMaintenanceCode) { super(errorMessages[code]); this.name = 'RewardMaintenanceError'; }
}
const uuid = z.uuid();
const memberSchema = z.object({ userId: uuid, role: z.enum(rewardRoles) }).strict();
export const rewardAccessChangeSchema = z.object({ unitId: uuid, revision: z.number().int().positive(), before: memberSchema.nullable(), after: memberSchema.nullable() }).strict().refine(v => v.before || v.after);
export type RewardAccessChange = z.infer<typeof rewardAccessChangeSchema>;
async function admin(tx: Tx, companyId: string) {
    const [r] = await tx.execute<{
        ok: boolean;
    }>(sql `select app.reward_admin(${companyId}::uuid) as ok`);
    if (!r?.ok)
        throw new RewardMaintenanceError('scope');
}
async function adminUnit(tx: Tx, id: string, revision?: number, lock = false) {
    const q = tx.select().from(rewardUnit).where(and(eq(rewardUnit.id, uuid.parse(id)), isNull(rewardUnit.deletedAt)));
    const [unit] = await (lock ? q.for('update') : q);
    if (!unit)
        throw new RewardMaintenanceError('missing');
    await admin(tx, unit.companyId);
    if (revision !== undefined && unit.revision !== revision)
        throw new RewardMaintenanceError('changed');
    if (revision !== undefined && unit.status !== 'draft')
        throw new RewardMaintenanceError('locked');
    return unit;
}
// General person RLS has a legacy any-admin read arm. Candidate names and new grants instead
// use the canonical workforce read policy, which retains group-wide unassigned-person access.
const visibleCandidate = sql<boolean> `app.access_workforce_person(${person.id}, 'workforce.view')`;
const pairKey = (m: {
    userId: string;
    role: string;
}) => `${m.userId}:${m.role}`;
async function prepareAccess(tx: Tx, ctx: SessionContext, input: RewardAccessChange, lock = false) {
    // Access/eligibility writers share this barrier. Join before review locks and authority reads,
    // so an in-flight employment suspension or scope revocation cannot pass stale eligibility.
    if (lock)
        await tx.execute(sql `select app.access_workforce_write_lock()`);
    const unit = await adminUnit(tx, input.unitId, input.revision, lock);
    const current = await tx.select({ id: rewardMember.id, userId: rewardMember.userId, role: rewardMember.role }).from(rewardMember).where(eq(rewardMember.unitId, unit.id)).orderBy(asc(rewardMember.userId), asc(rewardMember.role));
    if (input.before && !current.some(m => pairKey(m) === pairKey(input.before!)))
        throw new RewardMaintenanceError('membership');
    const next = current.filter(m => !input.before || pairKey(m) !== pairKey(input.before));
    if (input.after) {
        // Do not add account/person tuple SHARE locks: legacy archival takes its tuple before
        // its access-barrier row trigger. The barrier above serializes supported account,
        // employment and permission writers without reversing that lock order.
        const [account] = await tx.select({ id: appUser.id }).from(appUser).innerJoin(person, and(eq(person.id, appUser.personId), visibleCandidate)).where(and(eq(appUser.id, input.after.userId), eq(appUser.tenantId, ctx.tenantId), isNull(appUser.archivedAt), sql `not app.login_blocked(${appUser.id})`));
        if (!account)
            throw new RewardMaintenanceError('account');
        if (next.some(m => pairKey(m) === pairKey(input.after!)))
            throw new RewardMaintenanceError('membership');
        next.push({ id: '', ...input.after });
    }
    const gr = next.filter(m => m.role === 'gr').map(m => m.userId);
    const activeGr = gr.length ? await tx.select({ id: appUser.id }).from(appUser).where(and(inArray(appUser.id, gr), eq(appUser.tenantId, ctx.tenantId), isNull(appUser.archivedAt), sql `not app.login_blocked(${appUser.id})`)) : [];
    if (!activeGr.length)
        throw new RewardMaintenanceError('lastGr');
    const digest = createHash('sha256').update(JSON.stringify({ actor: ctx.userId, tenant: ctx.tenantId, input, current, activeGr: activeGr.map(x => x.id).sort() })).digest('hex');
    return { unit, current, next, digest };
}
export async function previewRewardAccessChange(ctx: SessionContext, raw: unknown) { const input = rewardAccessChangeSchema.parse(raw); return withRewardsTenant(ctx, async (tx) => { const p = await prepareAccess(tx, ctx, input); return { ...input, digest: p.digest }; }); }
async function commitAccessTx(tx: Tx, ctx: SessionContext, input: RewardAccessChange, expectedDigest?: string) {
    const p = await prepareAccess(tx, ctx, input, true);
    if (expectedDigest !== undefined && p.digest !== expectedDigest)
        throw new RewardMaintenanceError('preview');
    // Add first: a legitimate replacement never creates an intermediate loss of GR coverage.
    if (input.after && (!input.before || pairKey(input.before) !== pairKey(input.after)))
        await tx.insert(rewardMember).values({ tenantId: ctx.tenantId, unitId: p.unit.id, ...input.after });
    if (input.before && (!input.after || pairKey(input.before) !== pairKey(input.after)))
        await tx.delete(rewardMember).where(and(eq(rewardMember.unitId, p.unit.id), eq(rewardMember.userId, input.before.userId), eq(rewardMember.role, input.before.role)));
    await tx.update(rewardUnit).set({ revision: p.unit.revision + 1, approvedDigest: null, updatedAt: new Date() }).where(eq(rewardUnit.id, p.unit.id));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'reward-unit', aggregateId: p.unit.id, eventType: 'reward-unit.access-changed', actor: actorOf(ctx), payload: { before: input.before, after: input.after, revision: p.unit.revision + 1 } });
}
export async function saveRewardAccessChange(ctx: SessionContext, raw: unknown, digest: string) { const input = rewardAccessChangeSchema.parse(raw); z.string().regex(/^[a-f0-9]{64}$/).parse(digest); return withRewardsTenant(ctx, tx => commitAccessTx(tx, ctx, input, digest)); }
/** Compatibility entry point: legacy configuration forms use the very same owner and locks. */
export async function changeRewardMember(ctx: SessionContext, unitId: string, revision: number, userId: string, role: RewardRole, remove = false) {
    const input = rewardAccessChangeSchema.parse({ unitId, revision, before: remove ? { userId, role } : null, after: remove ? null : { userId, role } });
    return withRewardsTenant(ctx, tx => commitAccessTx(tx, ctx, input));
}
export async function rewardAccessAdministration(ctx: SessionContext, companyIds: string[]) {
    const ids = z.array(uuid).max(500).parse(companyIds);
    return withRewardsTenant(ctx, async (tx) => {
        if (!ids.length)
            return { reviews: [], members: [], users: [] };
        const reviews = await tx.select({ id: rewardUnit.id, companyId: company.id, company: company.legalName, businessUnitId: businessUnit.id, unit: sql<string> `coalesce(nullif(trim(${businessUnit.label}),''),${businessUnit.code})`, cycleId: rewardCycle.id, cycle: rewardCycle.name, year: rewardCycle.year, kind: rewardUnit.kind, status: rewardUnit.status, revision: rewardUnit.revision }).from(rewardUnit).innerJoin(company, eq(company.id, rewardUnit.companyId)).innerJoin(businessUnit, eq(businessUnit.id, rewardUnit.businessUnitId)).innerJoin(rewardCycle, eq(rewardCycle.id, rewardUnit.cycleId)).where(and(inArray(rewardUnit.companyId, ids), isNull(rewardUnit.deletedAt), sql `app.reward_admin(${rewardUnit.companyId})`)).orderBy(desc(rewardCycle.year), asc(rewardCycle.name), asc(company.legalName), asc(businessUnit.code), asc(rewardUnit.id));
        if (!reviews.length)
            return { reviews: [], members: [], users: [] };
        const members = await tx.select({ id: rewardMember.id, unitId: rewardMember.unitId, userId: rewardMember.userId, role: rewardMember.role, name: person.fullName, email: person.primaryEmail, disabled: sql<boolean> `${appUser.archivedAt} is not null or app.login_blocked(${appUser.id})` }).from(rewardMember).innerJoin(appUser, and(eq(appUser.id, rewardMember.userId), eq(appUser.tenantId, rewardMember.tenantId))).leftJoin(person, and(eq(person.id, appUser.personId), visibleCandidate)).where(inArray(rewardMember.unitId, reviews.map(r => r.id))).orderBy(asc(person.fullName), asc(appUser.id), asc(rewardMember.unitId), asc(rewardMember.role));
        const users = await tx.select({ id: appUser.id, name: person.fullName, email: person.primaryEmail }).from(appUser).innerJoin(person, and(eq(person.id, appUser.personId), visibleCandidate)).where(and(eq(appUser.tenantId, ctx.tenantId), isNull(appUser.archivedAt), sql `not app.login_blocked(${appUser.id})`)).orderBy(asc(person.fullName), asc(appUser.id));
        return { reviews, members, users };
    });
}
export type RewardAccessAdministration = Awaited<ReturnType<typeof rewardAccessAdministration>>;
export type RewardDeletionReason = 'locked' | 'recommendations' | 'decisions' | 'children' | 'payroll' | 'external' | 'deleted';
export async function rewardDeletionEligibility(ctx: SessionContext, unitId: string) {
    return withRewardsTenant(ctx, async (tx) => {
        await adminUnit(tx, unitId);
        const [r] = await tx.execute<{
            reason: RewardDeletionReason | null;
        }>(sql `select app.reward_deletion_reason(${unitId}::uuid) as reason`);
        return r.reason;
    });
}
export async function deleteRewardReview(ctx: SessionContext, unitId: string, revision: number, confirmation: string) {
    uuid.parse(unitId);
    z.number().int().positive().parse(revision);
    if (confirmation !== unitId)
        throw new RewardMaintenanceError('confirmation');
    return withRewardsTenant(ctx, async (tx) => {
        const [unit] = await tx.select().from(rewardUnit).where(eq(rewardUnit.id, unitId)).for('update');
        if (!unit)
            throw new RewardMaintenanceError('missing');
        await admin(tx, unit.companyId);
        if (unit.deletedAt)
            return { alreadyDeleted: true };
        if (unit.revision !== revision)
            throw new RewardMaintenanceError('changed');
        const [r] = await tx.execute<{
            reason: RewardDeletionReason | null;
        }>(sql `select app.reward_deletion_reason(${unitId}::uuid) as reason`);
        if (r.reason)
            throw new RewardMaintenanceError('used');
        await tx.update(rewardUnit).set({ deletedAt: new Date(), deletedBy: ctx.userId!, revision: revision + 1, updatedAt: new Date() }).where(eq(rewardUnit.id, unitId));
        await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'reward-unit', aggregateId: unitId, eventType: 'reward-unit.deleted', actor: actorOf(ctx), payload: { cycleId: unit.cycleId, revision: revision + 1, retainedSnapshots: true } });
        return { alreadyDeleted: false };
    });
}
