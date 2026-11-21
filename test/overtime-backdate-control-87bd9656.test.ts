/**
 * 87bd9656 — Overtime Backdate Control, enforced by the ONE attendance submission owner for every entry path:
 * the employee's own web request, Request On Behalf by HR, the mobile app, the AI assistant's reviewed path and
 * HR's unclocked-work attestation on the day screen. HR has no exemption.
 *
 * Rule under test: with a limit of N days in the Schedule Group revision in force on the submission date, an
 * overtime application dated earlier than today − N is refused, naming the earliest date still allowed; today and
 * later dates pass. Every date is derived from the HR date owner (todayInKualaLumpur), never a literal.
 *
 * The Overtime Setting writer only accepts future start dates. To have a revision IN FORCE TODAY, each case saves
 * through the genuine writer and then performs a declared fixture restoration of that revision's start date (the
 * same pattern as test/attendance-policy-storage-fixture.ts): the guard trigger is disabled only inside that one
 * transaction and is verified enabled afterwards. This proves submission behaviour, not a backdating API.
 * All people, companies and figures are fictional.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { assignDefaultShift, createShift } from '../core/roster';
import { requestOwnOvertimePlanV2 } from '../core/mobile-attendance';
import { todayInKualaLumpur } from '../lib/hr-date';
import { OvertimeBackdateNotAllowedError, overtimeBackdateEarliestDate, overtimeBackdateRefused } from '../lib/overtime-backdate';
import { defaultScheduleOvertimeSetting, type ScheduleOvertimeSetting } from '../lib/schedule-overtime-setting';
import { attendanceCorrectionPreparedDigest, ensureStandardRule, prepareAttendanceCorrectionRequestTx, requestAttendanceCorrection, requestAttendanceCorrectionTx,
  saveScheduleGroupOvertimeSetting, scheduleGroupOvertimeSetting } from '../packs/attendance/service';
import { seedAttendanceSubmissionBase } from './helpers/attendance-submission-fixture';
import { createAttendancePolicyStorageFixtures } from './attendance-policy-storage-fixture';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, setModule, type Base } from './harness';

const state = vi.hoisted(() => ({ session: null as unknown, admin: null as unknown, scopeIds: [] as string[] }));
vi.mock('../lib/session', async (original) => ({ ...(await original<typeof import('../lib/session')>()), getSession: async () => state.session }));
vi.mock('../lib/scope', () => ({ scopedAdmin: async () => ({ s: state.admin, scopeIds: state.scopeIds }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({ redirect: (path: string): never => { throw new Error(`NEXT_REDIRECT:${path}`); }, notFound: vi.fn(() => undefined) }));
// The real English catalogue; onError throws so a missing key or a broken placeholder fails instead of echoing a key.
vi.mock('next-intl/server', async () => {
  const { createTranslator: make } = await import('next-intl');
  const { readFileSync: read } = await import('node:fs');
  const { fileURLToPath: path } = await import('node:url');
  const messages = JSON.parse(read(path(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getLocale: async () => 'en',
    getTranslations: async (ns: string | { namespace?: string }) => make({ locale: 'en', messages, namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never, onError: (e) => { throw e; } }),
  };
});
const { myRequestOvertime } = await import('../app/me/actions');
const { submitUnclockedAttendanceWorkAction } = await import('../app/attendance/individual/[date]/actions');

const catalogue = (locale: 'en' | 'ms') => JSON.parse(readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'));
const refusalText = (locale: 'en' | 'ms', days: number, date: string) =>
  createTranslator({ locale, messages: catalogue(locale), namespace: 'scheduleOvertimeSetting' as never })('backdateRefused' as never, { days, date } as never) as string;

let b: Base, ctx: SessionContext;
const day = (offset: number) => new Date(Date.parse(todayInKualaLumpur() + 'T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);
const REASON = 'Fictional overtime backdate control fixture';
const LIMIT = 3;

beforeAll(migrateTestDb); afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); b = await seedAttendanceSubmissionBase(); await setModule(b.tenantId, 'attendance', 'active'); ctx = adminCtx(b);
  state.admin = ctx; state.scopeIds = [b.companyId]; state.session = null;
});

/** A fictional employee on the standard Schedule Group, every day a 09:00–18:00 workday, with a login. */
async function employee(ruleId: string) {
  const hired = await hireEmployee(ctx, { person: { fullName: 'Fictional backdate worker', primaryEmail: randomUUID() + '@fixture.invalid' }, companyId: b.companyId,
    departmentId: b.deptA, employmentType: 'full_time', hiredOn: day(-60) });
  const shift = await createShift(ctx, { code: 'BD_' + randomUUID().slice(0, 6), name: 'Fictional 09:00–18:00', startTime: '09:00', endTime: '18:00', breakMinutes: 0,
    weeklyPattern: [1, 2, 3, 4, 5, 6, 7], ruleId });
  await assignDefaultShift(ctx, { employmentId: hired.employmentId, shiftId: shift.id });
  const userId = await createAppUser(b.tenantId, hired.personId, 'employee');
  const web: SessionContext = { ...adminCtx(b), userId, personId: hired.personId, roles: ['employee'], grants: undefined };
  const mobile: SessionContext = { tenantId: b.tenantId, userId, personId: hired.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: b.companyId }], entitlements: harnessSnapshot(b.tenantId) };
  return { ...hired, web, mobile };
}
/** A fictional HR administrator of the company, with a person and a login (Request On Behalf needs both). */
async function hrAdministrator() {
  const hired = await hireEmployee(ctx, { person: { fullName: 'Fictional company HR', primaryEmail: randomUUID() + '@fixture.invalid' }, companyId: b.companyId,
    departmentId: b.deptB, employmentType: 'full_time', hiredOn: day(-60) });
  const userId = await createAppUser(b.tenantId, hired.personId, 'hr_admin');
  await owner.db.update(s.roleAssignment).set({ companyId: b.companyId }).where(eq(s.roleAssignment.appUserId, userId));
  return { ...hired, userId, ctx: { ...adminCtx(b), userId, personId: hired.personId, roles: ['hr_admin'], grants: [{ role: 'hr_admin', companyId: b.companyId }] } as SessionContext };
}
/** Saves a Manual Overtime Setting for the company through the genuine writer, starting tomorrow. */
async function saveSetting(ruleId: string, over: Partial<ScheduleOvertimeSetting>) {
  const view = await scheduleGroupOvertimeSetting(ctx, { ruleId });
  const saved = await saveScheduleGroupOvertimeSetting(ctx, { ruleId, scope: { kind: 'companies', companyIds: [b.companyId] }, effectiveFrom: day(1),
    setting: { ...defaultScheduleOvertimeSetting(null), approval: 'manual', ...over }, expectedToken: view.token, reason: REASON });
  expect(saved.revisions).toHaveLength(1);
  return saved.revisions[0].id;
}
/** Declared fixture restoration only: move one genuinely scheduled revision's start into the past. */
async function restoreStart(revisionId: string, effectiveFrom: string, policyPatch?: Record<string, unknown>) {
  await owner.db.transaction(async tx => {
    await tx.execute(sql`ALTER TABLE attendance_group_policy_revision DISABLE TRIGGER attendance_group_policy_revision_guard`);
    const [row] = await tx.select().from(s.attendanceGroupPolicyRevision).where(eq(s.attendanceGroupPolicyRevision.id, revisionId));
    const policy = policyPatch ? { ...row.policy, overtime: { ...row.policy.overtime, ...policyPatch } } : row.policy;
    const updated = await tx.update(s.attendanceGroupPolicyRevision).set({ effectiveFrom, policy: policy as typeof row.policy }).where(eq(s.attendanceGroupPolicyRevision.id, revisionId)).returning();
    expect(updated).toHaveLength(1);
    await tx.execute(sql`ALTER TABLE attendance_group_policy_revision ENABLE TRIGGER attendance_group_policy_revision_guard`);
  });
  const guards = await owner.db.execute(sql`select tgenabled from pg_trigger where tgrelid='attendance_group_policy_revision'::regclass
    and tgname='attendance_group_policy_revision_guard'`);
  expect(Array.from(guards).map(row => row.tgenabled)).toEqual(['O']);
}
/** The standard group, one employee, and a limit of LIMIT days in force today (revision start `start`). */
async function limited(start = day(-10)) {
  const ruleId = (await ensureStandardRule(ctx)).id;
  const worker = await employee(ruleId);
  const revisionId = await saveSetting(ruleId, { backdateControl: true, backdateDays: LIMIT });
  const [stored] = await owner.db.select().from(s.attendanceGroupPolicyRevision).where(eq(s.attendanceGroupPolicyRevision.id, revisionId));
  expect(stored.policy.overtime.backdateLimitDays).toBe(LIMIT);
  await restoreStart(revisionId, start);
  return { ruleId, worker, revisionId };
}
const overtime = (employmentId: string, date: string) => ({ employmentId, date, plannedStartTime: '18:00', plannedEndTime: '19:00', requestedOtMinutes: 60,
  reason: REASON, requestKind: 'self_overtime' as const });
const rowsFor = (employmentId: string) => owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.employmentId, employmentId));
async function redirectOf(fn: () => Promise<unknown>) {
  try { await fn(); return ''; } catch (e) { const msg = (e as Error).message; if (!msg.startsWith('NEXT_REDIRECT:')) throw e; return msg.slice('NEXT_REDIRECT:'.length); }
}
const errorOf = (url: string) => { const m = /[?&]error=([^&]*)/.exec(url); return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null; };
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
const otForm = (date: string, extra: Record<string, string> = {}) => form({ date, plannedStart: '18:00', plannedEnd: '19:00', reason: REASON, ...extra });

describe('the date rule (the request example: 3 days, submitted 16-Nov-2026)', () => {
  it('allows 13 to 16-Nov-2026 and refuses 12-Nov-2026 or earlier', () => {
    expect(overtimeBackdateEarliestDate('2026-11-16', 3)).toBe('2026-11-13');
    expect(['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'].map(date => overtimeBackdateRefused(date, '2026-11-16', 3)))
      .toEqual([true, false, false, false, false, false]);
    expect(overtimeBackdateEarliestDate('2026-03-01', 1), 'counts calendar days across a month end').toBe('2026-02-28');
    expect(() => overtimeBackdateEarliestDate('2026-11-16', 0)).toThrow();
  });
});

describe('Overtime Backdate Control — every entry path, limit of 3 days in force today', () => {
  it('self overtime on the web: today − 3 to today and planned dates pass; today − 4 is refused with the earliest date, in the employee\'s language', async () => {
    const { worker } = await limited();
    state.session = worker.web;
    const refused = await redirectOf(() => myRequestOvertime(otForm(day(-4))));
    expect(errorOf(refused)).toBe(refusalText('en', LIMIT, day(-3)));
    expect(errorOf(refused)).toContain(day(-3));
    for (const date of [day(-3), day(-2), day(-1), day(0), day(1)]) {
      const url = await redirectOf(() => myRequestOvertime(otForm(date)));
      expect(errorOf(url), `${date} must be accepted: ${url}`).toBeNull();
    }
    const rows = await rowsFor(worker.employmentId);
    expect(rows.map(row => row.attendanceDate).sort()).toEqual([day(-3), day(-2), day(-1), day(0), day(1)]);
    expect(rows.every(row => row.requestedOtMinutes === 60 && row.status === 'pending')).toBe(true);
  }, 120_000);

  it('Request On Behalf by HR follows the same limit: there is no administrator exemption', async () => {
    const { worker } = await limited();
    const hr = await hrAdministrator();
    state.session = hr.ctx;
    const refused = await redirectOf(() => myRequestOvertime(otForm(day(-4), { onBehalfOf: worker.employmentId })));
    expect(errorOf(refused)).toBe(refusalText('en', LIMIT, day(-3)));
    expect(await rowsFor(worker.employmentId)).toEqual([]);
    const accepted = await redirectOf(() => myRequestOvertime(otForm(day(-3), { onBehalfOf: worker.employmentId })));
    expect(errorOf(accepted), accepted).toBeNull();
    const [row] = await rowsFor(worker.employmentId);
    expect(row).toMatchObject({ attendanceDate: day(-3), submittedByUserId: hr.userId, requestedOtMinutes: 60 });
  }, 120_000);

  it('the mobile app: a refusal in the app\'s language (Malay) naming the earliest date; within the limit it is filed', async () => {
    const { worker } = await limited();
    const command = (date: string) => ({ requestId: randomUUID(), date, plannedStart: '18:00', plannedEnd: '19:00', reason: REASON });
    const refused = await requestOwnOvertimePlanV2(worker.mobile, worker.employmentId, command(day(-4)), 'ms');
    expect(refused).toEqual({ outcome: 'refused', code: 'invalid', message: refusalText('ms', LIMIT, day(-3)) });
    expect(refusalText('ms', LIMIT, day(-3))).not.toBe(refusalText('en', LIMIT, day(-3)));
    const english = await requestOwnOvertimePlanV2(worker.mobile, worker.employmentId, command(day(-5)));
    expect(english).toMatchObject({ outcome: 'refused', code: 'invalid', message: refusalText('en', LIMIT, day(-3)) });
    expect(await requestOwnOvertimePlanV2(worker.mobile, worker.employmentId, command(day(-3)), 'ms')).toMatchObject({ outcome: 'submitted', date: day(-3), minutes: 60 });
  }, 120_000);

  it('the AI assistant\'s reviewed path: preparation refuses a date past the limit; a reviewed date within it confirms', async () => {
    const { worker } = await limited();
    const subject = worker.web;
    await expect(withTenant(subject, tx => prepareAttendanceCorrectionRequestTx(tx, subject, overtime(worker.employmentId, day(-4)))))
      .rejects.toMatchObject({ name: 'OvertimeBackdateNotAllowedError', limitDays: LIMIT, earliestDate: day(-3) });
    const digest = await withTenant(subject, async tx => attendanceCorrectionPreparedDigest(subject, await prepareAttendanceCorrectionRequestTx(tx, subject, overtime(worker.employmentId, day(-3)))));
    const done = await withTenant(subject, tx => requestAttendanceCorrectionTx(tx, subject, overtime(worker.employmentId, day(-3)), { expectedDigest: digest }));
    expect(done.correctionId).toMatch(/^[0-9a-f-]{36}$/);
    // A digest reviewed for an allowed date cannot be replayed onto a refused one: the limit is re-checked first.
    await expect(withTenant(subject, tx => requestAttendanceCorrectionTx(tx, subject, overtime(worker.employmentId, day(-4)), { expectedDigest: digest })))
      .rejects.toBeInstanceOf(OvertimeBackdateNotAllowedError);
  }, 120_000);

  it('clock-only corrections (no overtime) are not affected', async () => {
    const { worker } = await limited();
    const { correctionId } = await requestAttendanceCorrection(worker.web, { employmentId: worker.employmentId, date: day(-8), checkIn: '09:00', checkOut: '18:00', reason: REASON });
    expect(correctionId).toMatch(/^[0-9a-f-]{36}$/);
  }, 120_000);
});

describe('which revision supplies the limit', () => {
  it('a revision in force today also covers dates before its own start (no loophole by choosing an older date)', async () => {
    const { worker } = await limited(day(-1));
    await expect(requestAttendanceCorrection(worker.web, overtime(worker.employmentId, day(-4))))
      .rejects.toMatchObject({ limitDays: LIMIT, earliestDate: day(-3) });
    expect((await requestAttendanceCorrection(worker.web, overtime(worker.employmentId, day(-3)))).correctionId).toBeTruthy();
  }, 120_000);

  it('with the control off there is no day limit, and the stored revision carries no backdate key', async () => {
    const ruleId = (await ensureStandardRule(ctx)).id, worker = await employee(ruleId);
    const revisionId = await saveSetting(ruleId, {});
    const [stored] = await owner.db.select().from(s.attendanceGroupPolicyRevision).where(eq(s.attendanceGroupPolicyRevision.id, revisionId));
    expect(Object.hasOwn(stored.policy.overtime, 'backdateLimitDays')).toBe(false);
    await restoreStart(revisionId, day(-30));
    expect((await requestAttendanceCorrection(worker.web, overtime(worker.employmentId, day(-20)))).correctionId).toBeTruthy();
  }, 120_000);

  it('a revision that starts tomorrow does not apply today; an old revision without the key still reads', async () => {
    const ruleId = (await ensureStandardRule(ctx)).id, worker = await employee(ruleId);
    const first = await saveSetting(ruleId, {});
    await restoreStart(first, day(-10));
    const second = await saveSetting(ruleId, { backdateControl: true, backdateDays: LIMIT });
    const history = await owner.db.select().from(s.attendanceGroupPolicyRevision).where(and(eq(s.attendanceGroupPolicyRevision.ruleId, ruleId), eq(s.attendanceGroupPolicyRevision.companyId, b.companyId)));
    expect(history.map(row => [row.id === first ? 'first' : row.id === second ? 'second' : 'other', row.effectiveFrom, row.policy.overtime.backdateLimitDays ?? null]).sort())
      .toEqual([['first', day(-10), null], ['second', day(1), LIMIT]]);
    expect((await scheduleGroupOvertimeSetting(ctx, { ruleId })).saved?.setting).toMatchObject({ backdateControl: true, backdateDays: LIMIT });
    expect((await requestAttendanceCorrection(worker.web, overtime(worker.employmentId, day(-5)))).correctionId).toBeTruthy();
  }, 120_000);

  it('a group that has never saved an Overtime Setting keeps its older set-up and no limit', async () => {
    const ruleId = (await ensureStandardRule(ctx)).id, worker = await employee(ruleId);
    expect(await owner.db.select().from(s.attendanceGroupPolicyRevision).where(eq(s.attendanceGroupPolicyRevision.ruleId, ruleId))).toEqual([]);
    expect((await requestAttendanceCorrection(worker.web, overtime(worker.employmentId, day(-20)))).correctionId).toBeTruthy();
  }, 120_000);
});

describe('HR unclocked-work attestation on the attendance day screen', () => {
  const { fixture } = createAttendancePolicyStorageFixtures({ get b() { return b; }, get ctx() { return ctx; }, day });
  it('follows the same limit, with HR\'s translated message; within the limit it is submitted for review', async () => {
    // The storage fixture's declared historical baseline: an enabled policy allowing unclocked overtime, in force from yesterday.
    const f = await fixture('manual', '12', 'actual', true, undefined, 0, false, { mode: 'none', step: null }, 120, 'earliest', false, undefined, true);
    await restoreStart(f.revisionId, day(-1), { backdateLimitDays: LIMIT });
    const attest = (date: string) => submitUnclockedAttendanceWorkAction(form({ employmentId: f.employmentId, date, reason: REASON, requestedOtMinutes: '30',
      completeWorkedDay: 'on', workStart: `${date}T09:00`, workEnd: `${date}T10:00` }));
    expect(await attest(day(-4))).toEqual({ ok: false, message: refusalText('en', LIMIT, day(-3)) });
    expect(await rowsFor(f.employmentId)).toEqual([]);
    const accepted = await attest(day(-1));
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true });
    const [row] = await rowsFor(f.employmentId);
    expect(row).toMatchObject({ attendanceDate: day(-1), requestedOtMinutes: 30, status: 'pending' });
  }, 180_000);
});
