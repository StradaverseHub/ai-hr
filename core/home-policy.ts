/** New Home-owned facts only. Existing clocking, leave, pay and notice authority stays with its owner. */
import {createHash} from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import * as s from '../db/schema';
import { appendEvent, actorOf } from '../db/events';
import { ownLiveEmploymentTx } from './own-employment-selection';
import { provenCompanyDatesTx } from './employment-company';
import { homeDates, homePolicyInput, homeSharingInput, homeWfhInput, homeWfhDecision, homeGreetingInput, HomeError, type HomeMoment } from '../lib/home-model';
import { todayInKualaLumpur } from '../lib/hr-date';
const event = (tx: Tx, ctx: SessionContext, type: string, id: string, payload: Record<string, unknown>) => appendEvent(tx, { tenantId: ctx.tenantId, actor: actorOf(ctx), aggregateType: 'home', aggregateId: id, eventType: type, payload });
const policyTx = async (tx: Tx, companyId: string) => { const [row] = await tx.select().from(s.homeCompanyPolicy).where(and(eq(s.homeCompanyPolicy.companyId, companyId), isNull(s.homeCompanyPolicy.supersededAt))).limit(1); return row ?? null; };
export async function homeOwnPreferences(ctx: SessionContext, employmentId: string) { return withTenant(ctx, async (tx) => { const own = await ownLiveEmploymentTx(tx, ctx, employmentId); const [sharing] = await tx.select().from(s.homeSharing).where(eq(s.homeSharing.employmentId, own.employmentId)).limit(1); return { policy: await policyTx(tx, own.companyProof.companyId!), sharing: sharing ?? { employmentId, revision: 0, availability: false, birthday: false, anniversary: false, weekStartsOn: 1 } }; }); }
export async function homeAdminPolicies(ctx: SessionContext, companyIds?: readonly string[]) { return withTenant(ctx, async (tx) => { const companies = await tx.select({ id: s.company.id, name: s.company.legalName }).from(s.company).where(and(sql `app.is_admin_for(${s.company.id})`, companyIds ? inArray(s.company.id, [...companyIds]) : undefined)).orderBy(s.company.legalName, s.company.id).limit(101); if (companies.length > 100)
    throw new HomeError('unavailable'); const policies = companies.length ? await tx.select().from(s.homeCompanyPolicy).where(and(inArray(s.homeCompanyPolicy.companyId, companies.map(c => c.id)), isNull(s.homeCompanyPolicy.supersededAt))) : []; return companies.map(company => ({ ...company, policy: policies.find(policy => policy.companyId === company.id) ?? null })); }); }
export async function saveHomePolicy(ctx: SessionContext, raw: unknown) {
    const p = homePolicyInput.parse(raw);
    return withTenant(ctx, async (tx) => {
        const [authority] = await tx.execute(sql `select app.is_admin_for(${p.companyId}::uuid) allowed`);
        if (!(authority as {
            allowed: boolean;
        })?.allowed)
            throw new HomeError('forbidden');
        await tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${'home-policy:' + ctx.tenantId + ':' + p.companyId},0))`);
        const old = await policyTx(tx, p.companyId);
        if ((old?.revision ?? 0) !== p.expectedRevision)
            throw new HomeError('stale');
        if (old)
            await tx.update(s.homeCompanyPolicy).set({ supersededAt: new Date() }).where(eq(s.homeCompanyPolicy.id, old.id));
        const { expectedRevision, ...input } = p;
        const [row] = await tx.insert(s.homeCompanyPolicy).values({ ...input, tenantId: ctx.tenantId, revision: expectedRevision + 1, createdBy: ctx.userId! }).returning();
        await event(tx, ctx, 'home.policy.changed', row!.id, { companyId: p.companyId, revision: row!.revision });
        return { id: row!.id, revision: row!.revision };
    });
}
export async function saveHomeSharing(ctx: SessionContext, raw: unknown) {
    const p = homeSharingInput.parse(raw);
    return withTenant(ctx, async (tx) => {
        const own = await ownLiveEmploymentTx(tx, ctx, p.employmentId);
        await tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${'home-sharing:' + ctx.tenantId + ':' + own.employmentId},0))`);
        const [old] = await tx.select().from(s.homeSharing).where(eq(s.homeSharing.employmentId, own.employmentId)).limit(1).for('update');
        if ((old?.revision ?? 0) !== p.expectedRevision)
            throw new HomeError('stale');
        const values = { availability: p.availability, birthday: p.birthday, anniversary: p.anniversary, weekStartsOn: p.weekStartsOn, revision: p.expectedRevision + 1, updatedBy: ctx.userId!, updatedAt: new Date() };
        if (old)
            await tx.update(s.homeSharing).set(values).where(eq(s.homeSharing.employmentId, own.employmentId));
        else
            await tx.insert(s.homeSharing).values({ ...values, tenantId: ctx.tenantId, employmentId: own.employmentId });
        await event(tx, ctx, 'home.sharing.changed', own.employmentId, { availability: p.availability, birthday: p.birthday, anniversary: p.anniversary, revision: values.revision });
        return { revision: values.revision };
    });
}
export async function requestHomeWorking(ctx: SessionContext, raw: unknown) {
    const p = homeWfhInput.parse(raw), dates = homeDates(p.from, p.to, 31);
    if (p.from < todayInKualaLumpur())
        throw new HomeError('invalid');
    return withTenant(ctx, async (tx) => {
        const own = await ownLiveEmploymentTx(tx, ctx, p.employmentId);
        await tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${'home-wfh:' + ctx.tenantId + ':' + own.employmentId},0))`);
        const [old] = await tx.select().from(s.homeWfhRequest).where(eq(s.homeWfhRequest.id, p.requestId)).limit(1);
        if (old) {
            if (old.employmentId !== p.employmentId || old.policyId !== p.policyId || old.from !== p.from || old.to !== p.to || old.requestedBy !== ctx.userId)
                throw new HomeError('stale');
            return { id: old.id, status: old.status, revision: old.revision };
        }
        const policy = await policyTx(tx, own.companyProof.companyId!);
        if (!policy?.wfhEnabled)
            throw new HomeError('disabled');
        if (policy.id !== p.policyId)
            throw new HomeError('stale');
        const proof = await provenCompanyDatesTx(tx, dates.map(date => ({ employmentId: own.employmentId, date })));
        if (dates.some(date => proof.get(own.employmentId + '|' + date)?.companyId !== policy.companyId))
            throw new HomeError('unavailable');
        const overlap = await tx.select({ id: s.homeWfhRequest.id }).from(s.homeWfhRequest).where(and(eq(s.homeWfhRequest.employmentId, own.employmentId), inArray(s.homeWfhRequest.status, ['pending', 'approved']), lte(s.homeWfhRequest.from, p.to), gte(s.homeWfhRequest.to, p.from))).limit(1);
        if (overlap.length)
            throw new HomeError('overlap');
        const [row] = await tx.insert(s.homeWfhRequest).values({ id: p.requestId, tenantId: ctx.tenantId, employmentId: own.employmentId, companyId: policy.companyId, policyId: policy.id, from: p.from, to: p.to, status: policy.wfhApprovalRequired ? 'pending' : 'approved', requestedBy: ctx.userId! }).returning();
        await event(tx, ctx, 'home.wfh.requested', row!.id, { employmentId: own.employmentId, companyId: policy.companyId, from: p.from, to: p.to, status: row!.status, policyId: policy.id });
        return { id: row!.id, status: row!.status, revision: row!.revision };
    });
}
export async function decideHomeWorking(ctx: SessionContext, raw: unknown) {
    const p = homeWfhDecision.parse(raw);
    return withTenant(ctx, async (tx) => {
        // Take the same employee request fence before the request row; all lifecycle writers use this order.
        const [visible] = await tx.select({ employmentId: s.homeWfhRequest.employmentId }).from(s.homeWfhRequest).where(eq(s.homeWfhRequest.id, p.id)).limit(1);
        if (!visible)
            throw new HomeError('unavailable');
        await tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${'home-wfh:' + ctx.tenantId + ':' + visible.employmentId},0))`);
        const [row] = await tx.select().from(s.homeWfhRequest).where(eq(s.homeWfhRequest.id, p.id)).limit(1).for('update');
        if (!row || row.revision !== p.expectedRevision)
            throw new HomeError('stale');
        if (p.decision === 'cancelled')
            await ownLiveEmploymentTx(tx, ctx, row.employmentId);
        else {
            const [allowed] = await tx.execute(sql `select app.home_can_decide(${row.employmentId}::uuid,${row.companyId}::uuid) allowed`);
            if (!(allowed as {
                allowed: boolean;
            })?.allowed)
                throw new HomeError('forbidden');
        }
        const [updated] = await tx.update(s.homeWfhRequest).set({ status: p.decision, revision: row.revision + 1, decidedBy: ctx.userId!, decidedAt: new Date() }).where(eq(s.homeWfhRequest.id, row.id)).returning();
        await event(tx, ctx, 'home.wfh.decided', row.id, { employmentId: row.employmentId, companyId: row.companyId, decision: p.decision, revision: updated!.revision });
        return { id: updated!.id, status: updated!.status, revision: updated!.revision };
    });
}
export async function homeWorkingRequests(ctx: SessionContext, p: {
    employmentId?: string;
    from?: string;
    to?: string;
    pendingDecisions?: boolean;
    companyIds?: readonly string[];
} = {}) {
    return withTenant(ctx, async (tx) => {
        if (p.employmentId)
            await ownLiveEmploymentTx(tx, ctx, p.employmentId);
        const rows = await tx.select({ request: s.homeWfhRequest, name: s.person.fullName, employeeCode: s.employment.employeeCode }).from(s.homeWfhRequest).innerJoin(s.employment, and(eq(s.employment.id, s.homeWfhRequest.employmentId), eq(s.employment.tenantId, s.homeWfhRequest.tenantId))).innerJoin(s.person, and(eq(s.person.id, s.employment.personId), eq(s.person.tenantId, s.employment.tenantId))).where(and(p.employmentId ? eq(s.homeWfhRequest.employmentId, p.employmentId) : undefined, p.companyIds ? inArray(s.homeWfhRequest.companyId, [...p.companyIds]) : undefined, p.from ? gte(s.homeWfhRequest.to, p.from) : undefined, p.to ? lte(s.homeWfhRequest.from, p.to) : undefined, p.pendingDecisions ? and(eq(s.homeWfhRequest.status, 'pending'), sql `app.home_can_decide(${s.homeWfhRequest.employmentId},${s.homeWfhRequest.companyId})`, sql `exists(select 1 from home_company_policy hp where hp.id=home_wfh_request.policy_id and hp.tenant_id=home_wfh_request.tenant_id and hp.superseded_at is null and hp.wfh_enabled)`) : undefined)).orderBy(desc(s.homeWfhRequest.createdAt), s.homeWfhRequest.id).limit(101);
        return { items: rows.slice(0, 100).map(row => ({ ...row.request, name: row.name, employeeCode: row.employeeCode })), truncated: rows.length > 100 };
    });
}
export async function homeMomentsTx(tx: Tx, ctx: SessionContext, employmentId: string, from: string, to: string): Promise<{
    items: HomeMoment[];
    truncated: boolean;
}> { await ownLiveEmploymentTx(tx, ctx, employmentId); homeDates(from, to, 8); const rows = await tx.execute(sql `select * from app.home_moments(${employmentId}::uuid,${from}::date,${to}::date)`); const items = rows as unknown as {
    employment_id: string;
    full_name: string;
    moment_date: string;
    kind: 'birthday' | 'anniversary';
}[]; return { items: items.slice(0, 100).map(row => ({ employmentId: row.employment_id, name: row.full_name, date: row.moment_date, kind: row.kind })), truncated: items.length > 100 }; }
export function homeMoments(ctx: SessionContext, employmentId: string, from: string, to: string) { return withTenant(ctx, tx => homeMomentsTx(tx, ctx, employmentId, from, to)); }
export function homeAvailability(ctx: SessionContext, employmentId: string) { return withTenant(ctx, async (tx) => { await ownLiveEmploymentTx(tx, ctx, employmentId); const rows = await tx.execute(sql `select * from app.home_availability(${employmentId}::uuid)`); const data = rows as unknown as {
    employment_id: string;
    full_name: string;
    status: 'office' | 'wfh' | 'leave' | 'unknown';
}[]; return { items: data.slice(0, 100).map(row => ({ employmentId: row.employment_id, name: row.full_name, status: row.status })), truncated: data.length > 100 }; }); }
export async function sendHomeGreeting(ctx: SessionContext, raw: unknown) {
    const p = homeGreetingInput.parse(raw);
    return withTenant(ctx, async (tx) => {
        await ownLiveEmploymentTx(tx, ctx, p.employmentId);
        await tx.execute(sql `select pg_advisory_xact_lock(hashtextextended(${'home-greeting:' + ctx.tenantId + ':' + p.requestId},0))`);
        const [old] = await tx.select().from(s.homeGreeting).where(eq(s.homeGreeting.id, p.requestId)).limit(1);
        if (old) {
            if (old.senderUserId !== ctx.userId || old.senderEmploymentId !== p.employmentId || old.recipientEmploymentId !== p.recipientEmploymentId || old.kind !== p.kind || old.date !== p.date || old.messageDigest !== createHash('sha256').update(p.message).digest('hex'))
                throw new HomeError('stale');
            return { id: old.id };
        }
        const permitted = await homeMomentsTx(tx, ctx, p.employmentId, p.date, p.date);
        if (!permitted.items.some(row => row.employmentId === p.recipientEmploymentId && row.kind === p.kind && row.date === p.date))
            throw new HomeError('unavailable');
        const [row] = await tx.insert(s.homeGreeting).values({ id: p.requestId, tenantId: ctx.tenantId, senderEmploymentId: p.employmentId, recipientEmploymentId: p.recipientEmploymentId, senderUserId: ctx.userId!, kind: p.kind, date: p.date, message: p.message }).returning({ id: s.homeGreeting.id });
        await event(tx, ctx, 'home.greeting.sent', row!.id, { senderEmploymentId: p.employmentId, recipientEmploymentId: p.recipientEmploymentId, kind: p.kind, date: p.date });
        return row!;
    });
}
export function homeTeamCalendar(ctx: SessionContext, employmentId: string, from: string, to: string) { homeDates(from, to); return withTenant(ctx, async (tx) => { await ownLiveEmploymentTx(tx, ctx, employmentId); const rows = await tx.execute(sql `select * from app.home_team_calendar(${employmentId}::uuid,${from}::date,${to}::date)`); const data = rows as unknown as {
    employment_id: string;
    full_name: string;
    entry_date: string;
    kind: 'teamLeave' | 'teamWfh';
    status: 'pending' | 'approved';
    source_id: string;
}[]; return { items: data.slice(0, 1000), truncated: data.length > 1000 }; }); }
export function homeWorkingRequest(ctx: SessionContext, id: string, companyIds: readonly string[]) { return withTenant(ctx, async (tx) => { const [row] = await tx.select().from(s.homeWfhRequest).where(and(eq(s.homeWfhRequest.id, id), inArray(s.homeWfhRequest.companyId, [...companyIds]))).limit(1); return row ?? null; }); }
export function homeReceivedGreetings(ctx: SessionContext, employmentId: string) { return withTenant(ctx, async (tx) => { await ownLiveEmploymentTx(tx, ctx, employmentId); const rows = await tx.execute(sql `select * from app.home_received_greetings(${employmentId}::uuid)`); const data = rows as unknown as {
    id: string;
    sender_name: string;
    message: string;
    moment_date: string;
    kind: 'birthday' | 'anniversary';
    created_at: Date | string;
}[]; return { items: data.slice(0, 50).map(row => ({ id: row.id, sender: row.sender_name, message: row.message, date: row.moment_date, kind: row.kind, createdAt: new Date(row.created_at).toISOString() })), truncated: data.length > 50 }; }); }
