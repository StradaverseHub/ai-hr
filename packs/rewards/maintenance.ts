/** Review lifecycle and access administration. These projections never load the pay roster. */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import { appUser, assignment, businessUnit, company, employment, person, position, rewardCycle, rewardMember, rewardUnit } from '../../db/schema';
import { todayInKualaLumpur } from '../../lib/hr-date';
import { withRewardsTenant } from '../../core/module-gate';
import { rewardRoles, type RewardRole } from './model';
import { activeRewardLogin, rewardRequiredRoles, rewardRoleLabels, rewardUnitCoverage } from './coverage';
export type RewardMaintenanceCode = 'scope' | 'changed' | 'locked' | 'account' | 'lastGr' | 'lastRequired' | 'membership' | 'preview' | 'confirmation' | 'used' | 'missing' | 'checker' | 'reason' | 'proxy' | 'dates';
const errorMessages: Record<RewardMaintenanceCode, string> = { checker: 'Another independent Rewards administrator must decide this request.', reason: 'Give a reason of at least 10 characters.', proxy: 'Choose an existing holder of this role to cover, with an end date.', dates: 'Choose a valid access date range.', scope: 'Company administrator access is required.', changed: 'This review changed in another session. Reload before saving.', locked: 'Return the unit to draft before changing its approved inputs.', account: 'Choose an active existing login account in this tenant.', lastGr: 'Keep at least one active Group Rewards reviewer assigned.', lastRequired: 'Keep at least one active person in every required approval role; replace them in one edit.', membership: 'The selected membership changed. Reload before saving.', preview: 'Access or account eligibility changed. Preview it again before saving.', confirmation: 'Confirm the exact review before deleting.', used: 'This review is in use and its history must be retained.', missing: 'Reward unit not found or access has been removed.' };
export class RewardMaintenanceError extends Error {
    constructor(readonly code: RewardMaintenanceCode, readonly role?: RewardRole) { super(code === 'lastRequired' && role ? `Keep at least one active ${rewardRoleLabels[role]} assigned; replace them in one edit.` : errorMessages[code]); this.name = 'RewardMaintenanceError'; }
}
const uuid = z.uuid();
const memberSchema = z.object({ userId: uuid, role: z.enum(rewardRoles), validFrom:z.iso.date().optional(),validTo:z.iso.date().nullable().optional(),coversUserId:uuid.nullable().optional(),restoreReason:z.string().trim().min(10).max(2000).optional(),restoreFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
 .refine(m=>!m.validTo||!m.validFrom||m.validTo>=m.validFrom,'Choose a valid access date range.')
 .refine(m=>!m.coversUserId||(m.coversUserId!==m.userId&&!!m.validTo),'A proxy needs another holder and an end date.');
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
const buName = sql<string> `coalesce(nullif(trim(${businessUnit.label}),''),${businessUnit.code})`;
// Same rule as app.login_blocked_on: an employment counts until its earliest end date, unless suspended.
const activeEmployment = (today: string) => and(isNull(employment.blacklistedAt), sql `(least(${employment.resignationDate},${employment.lastWorkingDate},${employment.terminatedOn}) is null or ${today}::date <= least(${employment.resignationDate},${employment.lastWorkingDate},${employment.terminatedOn}))`);
/** 68c84963 — identification facts from the earliest-hired active employment and its assignment current on
 *  `today` (Kuala Lumpur HR date). Employment/assignment RLS applies as for any People read; never pay. */
async function workforceFacts(tx: Tx, personIds: string[], today: string) {
    const facts = new Map<string, { employeeCode: string | null; jobTitle: string | null; companyName: string | null; businessUnitName: string | null }>();
    if (!personIds.length)
        return facts;
    const rows = await tx.select({ personId: employment.personId, employeeCode: employment.employeeCode, jobTitle: position.title, companyName: company.legalName, businessUnitName: buName }).from(employment).innerJoin(company, eq(company.id, employment.companyId)).leftJoin(assignment, and(eq(assignment.employmentId, employment.id), isNull(assignment.supersededAt), lte(assignment.validFrom, today), or(isNull(assignment.validTo), gte(assignment.validTo, today)))).leftJoin(position, eq(position.id, assignment.positionId)).leftJoin(businessUnit, eq(businessUnit.id, assignment.businessUnitId)).where(and(inArray(employment.personId, [...new Set(personIds)]), activeEmployment(today))).orderBy(asc(employment.personId), asc(employment.hiredOn), asc(employment.id), desc(assignment.validFrom));
    for (const { personId, ...row } of rows)
        if (!facts.has(personId))
            facts.set(personId, row);
    return facts;
}
const noFacts = { employeeCode: null, jobTitle: null, companyName: null, businessUnitName: null };
const pairKey = (m: {
    userId: string;
    role: string;
}) => `${m.userId}:${m.role}`;
type AccessRow = {
    id: string;
    userId: string;
    role: RewardRole;
    validFrom?:string;validTo?:string|null;coversUserId?:string|null;
};
async function accessState(tx: Tx, unitId: string, revision: number, lock: boolean) {
    const unit = await adminUnit(tx, unitId, revision, lock);
    const current: AccessRow[] = await tx.select({ id: rewardMember.id, userId: rewardMember.userId, role: rewardMember.role,validFrom:rewardMember.validFrom,validTo:rewardMember.validTo,coversUserId:rewardMember.coversUserId }).from(rewardMember).where(eq(rewardMember.unitId, unit.id)).orderBy(asc(rewardMember.userId), asc(rewardMember.role));
    return { unit, current };
}
/** One change against a unit's membership as it stands (a batch passes its accumulating state). */
async function applyAccess(tx: Tx, ctx: SessionContext, unit: typeof rewardUnit.$inferSelect, current: AccessRow[], input: RewardAccessChange) {
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
        if(input.after.coversUserId&&!current.some(m=>m.userId===input.after!.coversUserId&&m.role===input.after!.role))throw new RewardMaintenanceError('proxy');
        if(input.after.restoreReason&&!input.after.restoreFingerprint){
          if(!input.before||pairKey(input.before)!==pairKey(input.after))throw new RewardMaintenanceError('membership');
          const [gr]=await tx.execute<{ok:boolean}>(sql`select 'gr' in (select app.reward_roles(${unit.id}::uuid)) as ok`);
          if(!gr?.ok)throw new RewardMaintenanceError('scope');
        }
        if (next.some(m => pairKey(m) === pairKey(input.after!)))
            throw new RewardMaintenanceError('membership');
        next.push({ id: '', ...input.after });
    }
    // cd72f915: Group Rewards must always stay covered (as before); any other required seat may not lose its
    // last active holder. Coverage is judged on the next state, so a replacement in one edit passes.
    const required = rewardRequiredRoles(unit);
    const today=todayInKualaLumpur(),active:string[]=[];
    const eligibilityKey=(m:AccessRow)=>JSON.stringify({userId:m.userId,role:m.role,validFrom:m.validFrom??today,validTo:m.validTo??null,coversUserId:m.coversUserId??null});
    for(const member of [...current,...next]){
      if((member.validFrom&&member.validFrom>today)||(member.validTo&&member.validTo<today))continue;
      const [eligible]=await tx.execute<{ok:boolean}>(sql`select app.reward_access_candidate_eligible(${unit.id}::uuid,${member.userId}::uuid,${member.role}) as ok`);
      const restored=input.after?.restoreReason&&pairKey(input.after)===pairKey(member);
      if(eligible?.ok||restored)active.push(eligibilityKey(member));
    }
    const covered = (rows: AccessRow[], role: RewardRole) => rows.some(m => m.role === role && active.includes(eligibilityKey(m)));
    if (!covered(next, 'gr'))
        throw new RewardMaintenanceError('lastGr');
    const lost = required.find(role => covered(current, role) && !covered(next, role));
    if (lost)
        throw new RewardMaintenanceError('lastRequired', lost);
    return { next, active };
}
async function prepareAccess(tx: Tx, ctx: SessionContext, input: RewardAccessChange, lock = false) {
    // Access/eligibility writers share this barrier. Join before review locks and authority reads,
    // so an in-flight employment suspension or scope revocation cannot pass stale eligibility.
    if (lock)
        await tx.execute(sql `select app.access_workforce_write_lock()`);
    const { unit, current } = await accessState(tx, input.unitId, input.revision, lock);
    const { next, active } = await applyAccess(tx, ctx, unit, current, input);
    const digest = createHash('sha256').update(JSON.stringify({ actor: ctx.userId, tenant: ctx.tenantId, input, current, active })).digest('hex');
    return { unit, current, next, digest };
}
export async function previewRewardAccessChange(ctx: SessionContext, raw: unknown) { const input = rewardAccessChangeSchema.parse(raw); return withRewardsTenant(ctx, async (tx) => { const p = await prepareAccess(tx, ctx, input); return { ...input, digest: p.digest }; }); }
async function storeAccessRequest(tx:Tx,changes:RewardAccessChange[]){
 const [row]=await tx.execute<{id:string}>(sql`select app.reward_access_request_create(${JSON.stringify(changes)}::jsonb) as id`);
 return {requestId:row.id,pending:true as const};
}
/** A saved change is a pending request. Membership is changed only by the independent checker. */
export async function saveRewardAccessChange(ctx: SessionContext, raw: unknown, digest: string) {
 const input=rewardAccessChangeSchema.parse(raw);z.string().regex(/^[a-f0-9]{64}$/).parse(digest);
 return withRewardsTenant(ctx,async tx=>{const p=await prepareAccess(tx,ctx,input,true);if(p.digest!==digest)throw new RewardMaintenanceError('preview');return storeAccessRequest(tx,[input]);});
}
/** Legacy forms propose through the same request owner; they cannot bypass the second person. */
export async function changeRewardMember(ctx:SessionContext,unitId:string,revision:number,userId:string,role:RewardRole,remove=false){
 const input=rewardAccessChangeSchema.parse({unitId,revision,before:remove?{userId,role}:null,after:remove?null:{userId,role}});
 return withRewardsTenant(ctx,async tx=>{await prepareAccess(tx,ctx,input,true);return storeAccessRequest(tx,[input]);});
}
/** f38e5d8e — many exact per-review changes saved as one all-or-nothing unit. A batch is a self-contained value
 *  (changes + preview digest), so a later request/approval layer can hold and enact one batch as one request. */
export const rewardAccessBatchSchema = z.object({ changes: z.array(rewardAccessChangeSchema).min(1).max(500) }).strict();
export type RewardAccessBatch = z.infer<typeof rewardAccessBatchSchema>;
async function prepareAccessBatch(tx: Tx, ctx: SessionContext, batch: RewardAccessBatch, lock = false) {
    // One barrier for the whole batch, then each review locked once in id order: no lock-order inversion
    // against another batch or a single-change writer.
    if (lock)
        await tx.execute(sql `select app.access_workforce_write_lock()`);
    const revisions = new Map<string, number>();
    for (const c of batch.changes) {
        if ((revisions.get(c.unitId) ?? c.revision) !== c.revision)
            throw new RewardMaintenanceError('changed');
        revisions.set(c.unitId, c.revision);
    }
    const states = new Map<string, Awaited<ReturnType<typeof accessState>> & { rows: AccessRow[] }>();
    for (const unitId of [...revisions.keys()].sort()) {
        const state = await accessState(tx, unitId, revisions.get(unitId)!, lock);
        states.set(unitId, { ...state, rows: state.current });
    }
    // Pure additions first, so a removal later in the batch is judged with its replacement already in place.
    const ordered = [...batch.changes.filter(c => !c.before), ...batch.changes.filter(c => c.before)];
    const applied: RewardAccessChange[] = [], alreadyPresent: RewardAccessChange[] = [], active: string[][] = [];
    for (const change of ordered) {
        const state = states.get(change.unitId)!;
        // Repeating a grant that is already in place is reported, not refused, so a cycle-wide grant can be rerun.
        if (!change.before && change.after && state.rows.some(m => pairKey(m) === pairKey(change.after!))) {
            alreadyPresent.push(change);
            continue;
        }
        const result = await applyAccess(tx, ctx, state.unit, state.rows, change);
        state.rows = result.next;
        applied.push(change);
        active.push(result.active);
    }
    const digest = createHash('sha256').update(JSON.stringify({ actor: ctx.userId, tenant: ctx.tenantId, batch: batch.changes, current: [...states.values()].map(x => x.current), active })).digest('hex');
    return { states, applied, alreadyPresent, digest };
}
export async function previewRewardAccessBatch(ctx: SessionContext, raw: unknown) {
    const batch = rewardAccessBatchSchema.parse(raw);
    return withRewardsTenant(ctx, async (tx) => { const p = await prepareAccessBatch(tx, ctx, batch); return { changes: p.applied, alreadyPresent: p.alreadyPresent, digest: p.digest }; });
}
export async function saveRewardAccessBatch(ctx: SessionContext, raw: unknown, digest: string) {
 const batch=rewardAccessBatchSchema.parse(raw);z.string().regex(/^[a-f0-9]{64}$/).parse(digest);
 return withRewardsTenant(ctx,async tx=>{
  const p=await prepareAccessBatch(tx,ctx,batch,true);if(p.digest!==digest)throw new RewardMaintenanceError('preview');
  const stored=p.applied.length?await storeAccessRequest(tx,p.applied):{requestId:null,pending:false as const};
  return {...stored,batchId:stored.requestId,reviews:new Set(p.applied.map(c=>c.unitId)).size,applied:p.applied.length,alreadyPresent:p.alreadyPresent.length};
 });
}
export type RewardAccessRequest={id:string;changes:RewardAccessChange[];requestedBy:string;requestedName:string|null;requestedAt:string;status:'pending'|'approved'|'rejected'|'lapsed';canDecide:boolean;decidedAt:string|null;reason:string|null};
export async function rewardAccessRequests(ctx:SessionContext):Promise<RewardAccessRequest[]>{
 return withRewardsTenant(ctx,async tx=>{
  await tx.execute(sql`select app.reward_access_lapse_requests()`);
  const rows=await tx.execute<{id:string;changes:RewardAccessChange[];requested_by:string;requested_name:string|null;requested_at:string;status:RewardAccessRequest['status'];decided_at:string|null;reason:string|null}>(sql`select q.id,q.changes,q.requested_by,p.full_name as requested_name,q.requested_at::text,q.status,q.decided_at::text,q.reason from reward_access_request q left join app_user u on u.id=q.requested_by and u.tenant_id=q.tenant_id left join person p on p.id=u.person_id and p.tenant_id=q.tenant_id and app.access_workforce_person(p.id,'workforce.view') order by q.requested_at desc,q.id limit 500`);
  return rows.map(q=>({id:q.id,changes:q.changes,requestedBy:q.requested_by,requestedName:q.requested_name,requestedAt:q.requested_at,status:q.status,decidedAt:q.decided_at,reason:q.reason,canDecide:q.status==='pending'&&q.requested_by!==ctx.userId&&!q.changes.some(c=>c.before?.userId===ctx.userId||c.after?.userId===ctx.userId)}));
 });
}
export async function decideRewardAccessRequest(ctx:SessionContext,requestId:string,approve:boolean,reason=''){
 uuid.parse(requestId);z.boolean().parse(approve);reason=z.string().trim().max(2000).parse(reason);if(!approve&&reason.trim().length<10)throw new RewardMaintenanceError('reason');
 return withRewardsTenant(ctx,async tx=>{
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  const [q]=await tx.execute<{changes:RewardAccessChange[];requested_by:string;status:string}>(sql`select changes,requested_by,status from reward_access_request where id=${requestId}::uuid`);
  if(!q)throw new RewardMaintenanceError('scope');
  if(q.status!=='pending')throw new RewardMaintenanceError('changed');
  if(q.requested_by===ctx.userId||q.changes.some(c=>c.before?.userId===ctx.userId||c.after?.userId===ctx.userId))throw new RewardMaintenanceError('checker');
  const [live]=await tx.execute<{stale:boolean}>(sql`select app.reward_access_request_stale(${requestId}::uuid) as stale`);
  if(approve&&!live.stale)await prepareAccessBatch(tx,ctx,rewardAccessBatchSchema.parse({changes:q.changes}),true);
  const [result]=await tx.execute<{status:'approved'|'rejected'|'lapsed'}>(sql`select app.reward_access_request_decide(${requestId}::uuid,${approve},${reason}) as status`);
  return result;
 });
}
/** BU CEO seat suggestion: business_unit.head_employment_id → employment.person_id → that person's own active login.
 *  Never matched by email; an ambiguous person (several logins) gets no suggestion. Suggestions are never applied. */
async function buHeadSuggestions(tx: Tx, ctx: SessionContext, unitIds: string[]) {
    if (!unitIds.length)
        return [];
    const rows = await tx.select({ unitId: rewardUnit.id, userId: appUser.id }).from(rewardUnit).innerJoin(businessUnit, eq(businessUnit.id, rewardUnit.businessUnitId)).innerJoin(employment, eq(employment.id, businessUnit.headEmploymentId)).innerJoin(appUser, and(eq(appUser.personId, employment.personId), eq(appUser.tenantId, ctx.tenantId), activeRewardLogin())).innerJoin(person, and(eq(person.id, appUser.personId), visibleCandidate)).where(inArray(rewardUnit.id, unitIds)).orderBy(asc(rewardUnit.id), asc(appUser.id));
    return unitIds.flatMap(unitId => { const mine = rows.filter(r => r.unitId === unitId); return mine.length === 1 ? [mine[0]] : []; });
}
const copySchema = z.object({ fromCycleId: uuid, toCycleId: uuid, companyIds: z.array(uuid).min(1).max(500) }).strict().refine(v => v.fromCycleId !== v.toCycleId);
export type RewardAccessCopyProposal = { change: RewardAccessChange; suggested: boolean };
/** f38e5d8e — copy access from an earlier annual cycle onto the matching (company, business unit) Draft reviews of
 *  another. Proposes only; the reviewed selection is saved through saveRewardAccessBatch. */
export async function previewRewardAccessCopy(ctx: SessionContext, raw: unknown) {
    const input = copySchema.parse(raw);
    return withRewardsTenant(ctx, async (tx) => {
        const units = await tx.select({ id: rewardUnit.id, companyId: rewardUnit.companyId, businessUnitId: rewardUnit.businessUnitId, cycleId: rewardUnit.cycleId, status: rewardUnit.status, revision: rewardUnit.revision }).from(rewardUnit).where(and(inArray(rewardUnit.cycleId, [input.fromCycleId, input.toCycleId]), inArray(rewardUnit.companyId, input.companyIds), eq(rewardUnit.kind, 'annual'), isNull(rewardUnit.deletedAt), sql `app.reward_admin(${rewardUnit.companyId})`)).orderBy(asc(rewardUnit.id));
        const key = (u: { companyId: string; businessUnitId: string }) => `${u.companyId}:${u.businessUnitId}`;
        const sources = new Map<string, typeof units[number]>();
        for (const u of units)
            if (u.cycleId === input.fromCycleId && !sources.has(key(u)))
                sources.set(key(u), u);
        const targets = units.filter(u => u.cycleId === input.toCycleId && u.status === 'draft');
        const pairs = targets.flatMap(target => { const source = sources.get(key(target)); return source ? [{ target, source }] : []; });
        const members = pairs.length || targets.length ? await tx.select({ unitId: rewardMember.unitId, userId: rewardMember.userId, role: rewardMember.role, name: person.fullName, email: person.primaryEmail, visible: sql<boolean> `${person.id} is not null`, active: sql<boolean> `${appUser.archivedAt} is null and not app.login_blocked(${appUser.id})` }).from(rewardMember).innerJoin(appUser, and(eq(appUser.id, rewardMember.userId), eq(appUser.tenantId, rewardMember.tenantId))).leftJoin(person, and(eq(person.id, appUser.personId), visibleCandidate)).where(inArray(rewardMember.unitId, [...pairs.map(x => x.source.id), ...targets.map(x => x.id)])).orderBy(asc(rewardMember.unitId), asc(rewardMember.role), asc(person.fullName), asc(appUser.id)) : [];
        const proposals: RewardAccessCopyProposal[] = [], alreadyPresent: RewardAccessChange[] = [], skipped: { unitId: string; role: RewardRole; name: string | null; email: string | null }[] = [];
        for (const { target, source } of pairs)
            for (const m of members.filter(x => x.unitId === source.id)) {
                const change: RewardAccessChange = { unitId: target.id, revision: target.revision, before: null, after: { userId: m.userId, role: m.role } };
                if (!m.active || !m.visible)
                    skipped.push({ unitId: target.id, role: m.role, name: m.name, email: m.email });
                else if (members.some(x => x.unitId === target.id && x.userId === m.userId && x.role === m.role))
                    alreadyPresent.push(change);
                else
                    proposals.push({ change, suggested: false });
            }
        for (const s of await buHeadSuggestions(tx, ctx, targets.map(x => x.id))) {
            const target = targets.find(x => x.id === s.unitId)!;
            const seated = members.some(x => x.unitId === target.id && x.role === 'bu' && x.active) || proposals.some(x => x.change.unitId === target.id && x.change.after?.role === 'bu');
            if (!seated)
                proposals.push({ change: { unitId: target.id, revision: target.revision, before: null, after: { userId: s.userId, role: 'bu' } }, suggested: true });
        }
        return { proposals, alreadyPresent, skipped, unmatched: targets.filter(t => !sources.has(key(t))).map(t => t.id) };
    });
}
export async function rewardAccessAdministration(ctx: SessionContext, companyIds: string[]) {
    const ids = z.array(uuid).max(500).parse(companyIds);
    return withRewardsTenant(ctx, async (tx) => {
        if (!ids.length)
            return { reviews: [], members: [], users: [], candidates: [], suggestions: [] };
        const reviews = await tx.select({ id: rewardUnit.id, companyId: company.id, company: company.legalName, businessUnitId: businessUnit.id, unit: sql<string> `coalesce(nullif(trim(${businessUnit.label}),''),${businessUnit.code})`, cycleId: rewardCycle.id, cycle: rewardCycle.name, year: rewardCycle.year, kind: rewardUnit.kind, status: rewardUnit.status, revision: rewardUnit.revision }).from(rewardUnit).innerJoin(company, eq(company.id, rewardUnit.companyId)).innerJoin(businessUnit, eq(businessUnit.id, rewardUnit.businessUnitId)).innerJoin(rewardCycle, eq(rewardCycle.id, rewardUnit.cycleId)).where(and(inArray(rewardUnit.companyId, ids), isNull(rewardUnit.deletedAt), sql `app.reward_admin(${rewardUnit.companyId})`)).orderBy(desc(rewardCycle.year), asc(rewardCycle.name), asc(company.legalName), asc(businessUnit.code), asc(rewardUnit.id));
        if (!reviews.length)
            return { reviews: [], members: [], users: [], candidates: [], suggestions: [] };
        await tx.execute(sql`select app.reward_access_observe(NULL::uuid)`);
        const coverage = new Map((await rewardUnitCoverage(tx, reviews.map(r => r.id))).map(c => [c.unitId, c]));
        const today = todayInKualaLumpur();
        const memberRows = await tx.select({ id: rewardMember.id, unitId: rewardMember.unitId, userId: rewardMember.userId, role: rewardMember.role,lastChangedAt:sql<string>`coalesce((select max(d.occurred_at)::text from domain_event d where d.tenant_id=${rewardMember.tenantId} and d.aggregate_id=${rewardMember.unitId} and d.event_type='reward-unit.access-changed' and (d.payload->'before'->>'userId'=${rewardMember.userId}::text or d.payload->'after'->>'userId'=${rewardMember.userId}::text)),${rewardMember.createdAt}::text)`,validFrom:rewardMember.validFrom,validTo:rewardMember.validTo,coversUserId:rewardMember.coversUserId,suspension:sql<{reason:string;on:string}|null>`app.reward_member_suspension(${rewardMember.id})`, name: person.fullName, email: person.primaryEmail, personId: person.id, disabled: sql<boolean> `not app.reward_member_eligible(${rewardMember.id})` }).from(rewardMember).innerJoin(appUser, and(eq(appUser.id, rewardMember.userId), eq(appUser.tenantId, rewardMember.tenantId))).leftJoin(person, and(eq(person.id, appUser.personId), visibleCandidate)).where(inArray(rewardMember.unitId, reviews.map(r => r.id))).orderBy(asc(person.fullName), asc(appUser.id), asc(rewardMember.unitId), asc(rewardMember.role));
        const userRows = await tx.select({ id: appUser.id, name: person.fullName, email: person.primaryEmail, personId: person.id }).from(appUser).innerJoin(person, and(eq(person.id, appUser.personId), visibleCandidate)).where(and(eq(appUser.tenantId, ctx.tenantId), isNull(appUser.archivedAt), sql `not app.login_blocked(${appUser.id})`)).orderBy(asc(person.fullName), asc(appUser.id));
        // Active employees of these companies with no login yet: shown, never grantable (prepareAccess refuses).
        const candidateRows = await tx.selectDistinctOn([person.id], { personId: person.id, name: person.fullName, email: person.primaryEmail }).from(employment).innerJoin(person, and(eq(person.id, employment.personId), visibleCandidate)).where(and(inArray(employment.companyId, ids), activeEmployment(today), sql `not exists(select 1 from app_user u where u.person_id=${person.id})`)).orderBy(asc(person.id)).limit(2000);
        const facts = await workforceFacts(tx, [...memberRows, ...userRows, ...candidateRows].flatMap(r => r.personId ? [r.personId] : []), today);
        const withFacts = <T extends { personId: string | null }>({ personId, ...row }: T) => ({ ...row, ...(personId && facts.get(personId) || noFacts) });
        const members = memberRows.map(withFacts), users = userRows.map(withFacts);
        const candidates = candidateRows.map(withFacts).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
        const suggestions = await buHeadSuggestions(tx, ctx, reviews.filter(r => r.status === 'draft').map(r => r.id));
        return { reviews: reviews.map(r => ({ ...r, coverage: coverage.get(r.id)! })), members, users, candidates, suggestions };
    });
}
export type RewardAccessAdministration = Awaited<ReturnType<typeof rewardAccessAdministration>>;
/** Count only active current Rewards administrators for companies the caller administers. */
export function rewardAccessSingleAdminCompanies(ctx:SessionContext,companyIds:string[]){
 const ids=z.array(uuid).max(500).parse(companyIds);
 return withRewardsTenant(ctx,async tx=>{
  if(!ids.length)return [];
  const rows=await tx.select({name:company.legalName}).from(company).where(and(inArray(company.id,ids),sql`app.reward_admin(${company.id})`,sql`app.reward_access_admin_count(${company.id})<2`));
  return rows.map(row=>row.name);
 });
}

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
