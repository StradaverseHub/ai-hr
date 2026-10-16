import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { homeDates, homeGreetingInput, homePolicyInput, homeSharingInput, homeWfhInput } from '../lib/home-model';
import { homeCalendarWindow } from '../lib/home-calendar-model';
const id = '11111111-1111-4111-8111-111111111111';
describe('personal Home calendar and closed inputs', () => {
    it('preserves Monday/Sunday boundaries and leap-year dates without local timezone drift', () => {
        expect(homeCalendarWindow('2028-02-29', 'month', 1)).toEqual({ from: '2028-01-31', to: '2028-03-12' });
        expect(homeCalendarWindow('2028-02-29', 'week', 0)).toEqual({ from: '2028-02-27', to: '2028-03-04' });
        expect(homeDates('2028-02-28', '2028-03-01')).toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
        expect(() => homeDates('2027-02-29', '2027-03-01')).toThrow();
        expect(() => homeDates('2028-01-01', '2028-12-31')).toThrow();
    });
    it('accepts only explicit settings and exact recipient selections, never caller authority', () => {
        expect(homeSharingInput.safeParse({ employmentId: id, expectedRevision: 0, availability: false, birthday: false, anniversary: false, weekStartsOn: 1 }).success).toBe(true);
        expect(homeSharingInput.safeParse({ employmentId: id, expectedRevision: 0, availability: true, birthday: true, anniversary: true, weekStartsOn: 1, admin: true }).success).toBe(false);
        expect(homeGreetingInput.safeParse({ employmentId: id, recipientEmploymentId: id, requestId: id, kind: 'birthday', date: '2028-02-29', message: 'Hello', recipientEmail: 'other@invalid' }).success).toBe(false);
        expect(homeWfhInput.safeParse({ employmentId: id, requestId: id, policyId: id, from: '2028-02-29', to: '2028-03-01', status: 'approved' }).success).toBe(false);
        expect(homePolicyInput.safeParse({ companyId: id, expectedRevision: 0, wfhEnabled: true, wfhApprovalRequired: false, availabilityEnabled: false, birthdaysEnabled: false, anniversariesEnabled: false, scopeIds: [id] }).success).toBe(false);
    });
    it('keeps the complete Home/notice/settings vocabulary in all six locales', () => {
        const locales = ['en', 'ms', 'zh', 'ta', 'th', 'vi'];
        const keys = (value: unknown, prefix = ''): string[] => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, child]) => keys(child, prefix + '.' + key)) : [prefix];
        const en = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'));
        for (const locale of locales) {
            const actual = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
            for (const namespace of ['home', 'homeNotice', 'homeSettings'])
                expect(keys(actual[namespace]).sort()).toEqual(keys(en[namespace]).sort());
        }
    });
});
