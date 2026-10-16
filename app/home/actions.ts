'use server';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getFreshSession } from '@/lib/session';
import { getLocale } from 'next-intl/server';
import { getScopeIds } from '@/lib/scope';
import { allowedCompanies } from '@/core/read';
import { withTenant } from '@/db/client';
import { resolveEntitlementsTx } from '@/core/entitlements';
import { homeCard, homeDate, HomeError } from '@/lib/home-model';
import * as read from '@/core/home-read';
import { saveHomePolicy, saveHomeSharing, requestHomeWorking, decideHomeWorking, sendHomeGreeting, homeOwnPreferences, homeAdminPolicies, homeWorkingRequests, homeWorkingRequest } from '@/core/home-policy';
import { homeInsightDismissal } from '@/db/schema';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { OwnEmploymentSelectionError } from '@/lib/own-employment-selection';
import { acknowledgeNotice } from '@/core/notice';
const query = z.object({ card: homeCard, employmentId: z.string().uuid(), from: homeDate.optional(), to: homeDate.optional() }).strict();
async function freshContext() { const original = await getFreshSession(); const ctx = { ...original, entitlements: await withTenant(original, tx => resolveEntitlementsTx(tx, original.tenantId)), entitlementsExempt: undefined, entitlementsError: undefined }; const companies = await allowedCompanies(ctx), scopeIds = await getScopeIds(companies.map(company => company.id)); return { ctx, scopeIds, locale: await getLocale() }; }
async function context(employmentId: string) { const p = { ...await freshContext(), employmentId }; await read.homeReadSubject(p); return p; }
function refusal(error: unknown) { return { ok: false as const, code: error instanceof HomeError ? error.code : error instanceof OwnEmploymentSelectionError ? 'unavailable' as const : error instanceof z.ZodError ? 'invalid' as const : 'unavailable' as const }; }
export async function loadHomeCardAction(raw: unknown) {
    try {
        const p = query.parse(raw), c = await context(p.employmentId);
        switch (p.card) {
            case 'greeting': return { ok: true as const, kind: p.card, data: await read.homeGreeting(c) };
            case 'brief': return { ok: true as const, kind: p.card, data: await read.homeBrief(c) };
            case 'day': return { ok: true as const, kind: p.card, data: await read.homeDay(c) };
            case 'calendar':
                if (!p.from || !p.to)
                    throw new HomeError('invalid');
                return { ok: true as const, kind: p.card, data: await read.homeCalendar(c, p.from, p.to) };
            case 'tasks': return { ok: true as const, kind: p.card, data: await read.homeTasks(c) };
            case 'leave': return { ok: true as const, kind: p.card, data: await read.homeTimeOff(c) };
            case 'notices': return { ok: true as const, kind: p.card, data: await read.homeNotices(c) };
            case 'around': return { ok: true as const, kind: p.card, data: await read.homeAround(c) };
            case 'moments': return { ok: true as const, kind: p.card, data: await read.homeLittleMoments(c) };
        }
    }
    catch (error) {
        return refusal(error);
    }
}
export async function loadHomeSettingsAction(employmentId?: string) { try {
    const c = await freshContext();
    if (employmentId)
        await read.homeReadSubject({ ...c, employmentId: z.string().uuid().parse(employmentId) });
    return { ok: true as const, preferences: employmentId ? await homeOwnPreferences(c.ctx, employmentId) : null, requests: employmentId ? await homeWorkingRequests(c.ctx, { employmentId }) : null, decisions: await homeWorkingRequests(c.ctx, { pendingDecisions: true, companyIds: c.scopeIds }), companies: await homeAdminPolicies(c.ctx, c.scopeIds) };
}
catch (error) {
    return refusal(error);
} }
export async function saveHomeSettingsAction(kind: 'policy' | 'sharing' | 'wfh' | 'decision' | 'greeting', raw: unknown) {
    try {
        const c = await freshContext();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new HomeError('invalid');
        const input = raw as Record<string, unknown>;
        if (kind === 'policy') {
            if (typeof input.companyId !== 'string' || !c.scopeIds.includes(input.companyId))
                throw new HomeError('forbidden');
        }
        else if (kind === 'decision') {
            const id = z.string().uuid().parse(input.id);
            if (!await homeWorkingRequest(c.ctx, id, c.scopeIds))
                throw new HomeError('unavailable');
        }
        else
            await read.homeReadSubject({ ...c, employmentId: z.string().uuid().parse(input.employmentId) });
        const result = kind === 'policy' ? await saveHomePolicy(c.ctx, raw) : kind === 'sharing' ? await saveHomeSharing(c.ctx, raw) : kind === 'wfh' ? await requestHomeWorking(c.ctx, raw) : kind === 'decision' ? await decideHomeWorking(c.ctx, raw) : kind === 'greeting' ? await sendHomeGreeting(c.ctx, raw) : null;
        if (!result)
            throw new HomeError('invalid');
        revalidatePath('/');
        revalidatePath('/home/settings');
        revalidatePath('/home/calendar');
        return { ok: true as const, result };
    }
    catch (error) {
        return refusal(error);
    }
}
export async function dismissHomeInsightAction(raw: unknown) { try {
    const p = z.object({ employmentId: z.string().uuid(), key: z.string().min(1).max(200), date: homeDate }).strict().parse(raw), ctx = await context(p.employmentId);
    const current = await read.homeBrief(ctx);
    if (p.date !== current.date || !current.insights.some(insight => insight.key === p.key))
        throw new HomeError('stale');
    await withTenant(ctx.ctx, tx => tx.insert(homeInsightDismissal).values({ tenantId: ctx.ctx.tenantId, appUserId: ctx.ctx.userId!, sourceKey: p.key, date: p.date }).onConflictDoNothing());
    return { ok: true as const };
}
catch (error) {
    return refusal(error);
} }
export async function acknowledgeHomeNoticeAction(raw: unknown) { try {
    const p = z.object({ employmentId: z.string().uuid(), noticeId: z.string().uuid(), expectedDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict().parse(raw);
    const c = await context(p.employmentId);
    await acknowledgeNotice(c.ctx, p);
    revalidatePath('/');
    return { ok: true as const };
}
catch (error) {
    return refusal(error);
} }
