/** Client-safe Home vocabulary. No browser-submitted fact or selection conveys authority. */
import { z } from 'zod';
import { isCalendarDate } from './calendar-date';
export const homeDate = z.string().refine(isCalendarDate);
export const HOME_CARDS = ['greeting', 'brief', 'day', 'calendar', 'tasks', 'leave', 'notices', 'around', 'moments'] as const;
export const homeCard = z.enum(HOME_CARDS);
export const homePolicyInput = z.object({ companyId: z.string().uuid(), expectedRevision: z.number().int().min(0), wfhEnabled: z.boolean(), wfhApprovalRequired: z.boolean(), availabilityEnabled: z.boolean(), birthdaysEnabled: z.boolean(), anniversariesEnabled: z.boolean() }).strict();
export const homeSharingInput = z.object({ employmentId: z.string().uuid(), expectedRevision: z.number().int().min(0), availability: z.boolean(), birthday: z.boolean(), anniversary: z.boolean(), weekStartsOn: z.union([z.literal(0), z.literal(1)]) }).strict();
export const homeWfhInput = z.object({ employmentId: z.string().uuid(), requestId: z.string().uuid(), policyId: z.string().uuid(), from: homeDate, to: homeDate }).strict();
export const homeWfhDecision = z.object({ id: z.string().uuid(), expectedRevision: z.number().int().min(0), decision: z.enum(['approved', 'rejected', 'cancelled']) }).strict();
export const homeGreetingInput = z.object({ employmentId: z.string().uuid(), recipientEmploymentId: z.string().uuid(), requestId: z.string().uuid(), kind: z.enum(['birthday', 'anniversary']), date: homeDate, message: z.string().trim().min(1).max(500) }).strict();
export class HomeError extends Error {
    constructor(readonly code: 'unavailable' | 'invalid' | 'stale' | 'disabled' | 'overlap' | 'forbidden') { super('Home request unavailable.'); this.name = 'HomeError'; }
}
export function homeDates(from: string, to: string, max = 62) {
    if (!isCalendarDate(from) || !isCalendarDate(to) || from > to)
        throw new HomeError('invalid');
    const dates: string[] = [];
    let day = from;
    while (day <= to) {
        if (dates.length >= max)
            throw new HomeError('invalid');
        dates.push(day);
        const instant = new Date(day + 'T12:00:00Z');
        instant.setUTCDate(instant.getUTCDate() + 1);
        day = instant.toISOString().slice(0, 10);
    }
    return dates;
}
export type HomeCalendarEntry = {
    id: string;
    date: string;
    kind: 'leave' | 'wfh' | 'holiday' | 'payday' | 'teamLeave' | 'teamWfh';
    status: 'pending' | 'approved' | 'unknown';
    label: string | null;
    employmentId: string | null;
    partial?: boolean;
};
export type HomeMoment = {
    employmentId: string;
    name: string;
    date: string;
    kind: 'birthday' | 'anniversary';
};
export const homeCalendarQuery = z.object({ employmentId: z.string().uuid(), from: homeDate, to: homeDate }).strict();
