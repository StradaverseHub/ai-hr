/**
 * WP-B2 (APR-022) — the leader seat registry against real RLS as ai_hr_app.
 *
 * Every write is the persona's app-role session through the service (or a direct statement through the
 * persona's session where the database rule itself is under test); `owner` only reads back, sets locks and
 * builds the org tree. Dates come from todayInKualaLumpur().
 *
 * Org: Holding (business group node) ← Acme (unit, seedBase); Other group ← Other unit. One OneHR cycle per
 * unit. Sessions anchored by hand here carry no explicit reviewers unless a case says so: the live seat is
 * the only grant under test.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee } from '../core/org';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { addDaysIso } from '../packs/performance/onehr/leader-seat-model';
import { closeAll, createAppUser, entitledCtx, eventTypesFor, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

// Only the year is read at load (a run across New Year is out of scope); every HR day is read where it is used.
const year = Number(todayInKualaLumpur().slice(0, 4));
/** A date the service stamped between two reads of the HR day: one of them, so a run across midnight still passes. */
const hrDayBetween = (before: string, after: string) => expect.stringMatching(new RegExp(`^(${before}|${after})$`));
type Hired = { employmentId: string; personId: string };
type Kind = 'hod' | 'bu_ceo' | 'bg_ceo' | 'group_chief';
const tierOf = { hod: 'hod', bu_ceo: 'bu', bg_ceo: 'bg', group_chief: 'group' } as const;
const NAMES = ['buCeo', 'successor', 'bgCeo', 'hodOne', 'hodTwo', 'chief', 'member', 'explicit', 'partner', 'bgAdmin', 'unitAdmin', 's1', 's2', 's3'] as const;
type Name = (typeof NAMES)[number];

let b: Base, a: SessionContext, holding: string, other: string, otherNode: string, cycleA: string, cycleX: string;
const P = {} as Record<Name | 'xSubject' | 'xReviewer', Hired>;
const U = {} as Record<Name, SessionContext>;

const hire = (name: string, companyId: string, departmentId: string) =>
  hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@leader-seats.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
async function login(person: Hired): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, person.personId, 'manager');
  return { tenantId: b.tenantId, userId, personId: person.personId, roles: ['manager'], grants: [{ role: 'manager', companyId: null }], entitlements: a.entitlements };
}
async function scoped(person: Hired, role: 'hr_admin' | 'performance_partner', companyId: string): Promise<SessionContext> {
  const [u] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: person.personId }).returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId, role });
  return { tenantId: b.tenantId, userId: u.id, personId: person.personId, roles: [role], grants: [{ role, companyId }], entitlements: a.entitlements };
}
async function onehrCycle(name: string, companyId: string) {
  const { cycleId } = await perf.createCycle(a, { name, companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` });
  await perf.configureOnehrCycle(a, cycleId, null, defaultPolicy(framework));
  await perf.openCycle(a, { cycleId });
  return cycleId;
}
async function reviewOf(cycleId: string, e: Hired) {
  const [r] = await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, cycleId), eq(schema.performanceReview.employmentId, e.employmentId)));
  expect(r, 'the opened OneHR cycle has a review for the fixture person').toBeDefined();
  return r.id;
}
/** An anchored scope written by the HR administrator, as generation would write it, with an explicit cohort. */
async function anchored(cycleId: string, kind: Kind, anchor: { companyId?: string | null; employmentId?: string; groupId?: string }, name: string, people: Hired[], reviewers: string[] = []) {
  const reviewIds = await Promise.all(people.map((p) => reviewOf(cycleId, p)));
  return withTenant(a, async (tx) => {
    const [s] = await tx.insert(schema.onehrCalibration).values({
      tenantId: b.tenantId, cycleId, companyId: anchor.companyId ?? null, name, tier: tierOf[kind], reviewerUserIds: reviewers,
      anchorKind: kind, anchorEmploymentId: anchor.employmentId ?? null, calibrationGroupId: anchor.groupId ?? null,
    }).returning();
    for (let i = 0; i < people.length; i++) await tx.insert(schema.onehrCalibrationEntry).values({ tenantId: b.tenantId, sessionId: s.id, reviewId: reviewIds[i], employmentId: people[i].employmentId });
    return s.id;
  });
}
const access = (ctx: SessionContext, id: string) => withTenant(ctx, async (tx) => !!(await tx.execute<{ ok: boolean }>(sql`select app.onehr_calibration_access(${id}::uuid) as ok`))[0]?.ok);
const listed = async (ctx: SessionContext) => (await perf.listMyCalibrationSessions(ctx)).map((s) => s.id).sort();
const seatBu = (holder: Hired, ctx = a) => perf.appointLeaderSeat(ctx, { seatType: 'bu_ceo', companyId: b.companyId, holderEmploymentId: holder.employmentId });
async function assignHod(subjects: Hired[], hod: Hired | null) {
  const input = { subjectEmploymentIds: subjects.map((s) => s.employmentId), hodEmploymentId: hod?.employmentId ?? null };
  const preview = await perf.previewHodChange(a, input);
  return perf.applyHodChange(a, { ...input, fingerprint: preview.fingerprint, acknowledged: true });
}
const dbMessage = (message: string) => ({ cause: expect.objectContaining({ message }) });

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'performance', 'active');
  a = await entitledCtx(b);
  ({ id: holding } = await createCompany(a, { legalName: 'Holding Group Bhd' }));
  await owner.db.update(schema.company).set({ parentCompanyId: holding }).where(eq(schema.company.id, b.companyId));
  ({ id: otherNode } = await createCompany(a, { legalName: 'Other Group Bhd' }));
  ({ id: other } = await createCompany(a, { legalName: 'Other Unit Sdn Bhd' }));
  await owner.db.update(schema.company).set({ parentCompanyId: otherNode }).where(eq(schema.company.id, other));
  const deptX = await createDepartment(a, { companyId: other, name: 'Other unit dept' });
  for (const name of NAMES) P[name] = await hire(`Person ${name}`, b.companyId, name === 's3' ? b.deptB : b.deptA);
  P.xSubject = await hire('Other unit subject', other, deptX.id);
  P.xReviewer = await hire('Other unit reviewer', other, deptX.id);
  const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
  await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.tenantId, b.tenantId));
  cycleA = await onehrCycle('Acme annual', b.companyId);
  cycleX = await onehrCycle('Other annual', other);
  for (const name of NAMES) if (!['partner', 'bgAdmin', 'unitAdmin'].includes(name)) U[name] = await login(P[name]);
  U.partner = await scoped(P.partner, 'performance_partner', b.companyId);
  U.bgAdmin = await scoped(P.bgAdmin, 'hr_admin', holding);
  U.unitAdmin = await scoped(P.unitAdmin, 'hr_admin', b.companyId);
});
afterAll(closeAll);

describe('seat access follows the live seat', () => {
  it('an expired seat loses access the day after its last day; ending it today removes access at once', async () => {
    const today = todayInKualaLumpur();
    const [clock] = await owner.db.execute<{ d: string }>(sql`select ((now() at time zone 'Asia/Kuala_Lumpur')::date)::text as d`);
    expect(clock.d, 'the database day is the HR day (the case cannot pass vacuously near midnight)').toBe(today);
    const bu = await anchored(cycleA, 'bu_ceo', { companyId: b.companyId }, 'Acme unit', [P.s1, P.s2]);
    const bg = await anchored(cycleA, 'bg_ceo', { companyId: holding }, 'Holding group', [P.s1, P.s2]);
    expect(await access(U.buCeo, bu), 'no seat, no grant').toBe(false);
    const seat = await seatBu(P.buCeo);
    expect(await access(U.buCeo, bu)).toBe(true);
    await perf.endLeaderSeat(a, seat.id, { validTo: addDaysIso(today, 1) });
    expect(await access(U.buCeo, bu), 'valid_to is exclusive: today is still the last day').toBe(true);
    expect(await listed(U.buCeo)).toEqual([bu]);
    const bgSeat = await perf.appointLeaderSeat(a, { seatType: 'bg_ceo', companyId: holding, holderEmploymentId: P.bgCeo.employmentId });
    expect(await access(U.bgCeo, bg)).toBe(true);
    // No validTo: the seat ends on the service's own HR day, so a run across midnight cannot ask for yesterday.
    await perf.endLeaderSeat(a, bgSeat.id);
    expect(await access(U.bgCeo, bg)).toBe(false);
    expect(await listed(U.bgCeo)).toEqual([]);
    expect(await perf.hasCalibrationAssignment(U.bgCeo)).toBe(false);
  });

  it('a successor gains access with no rewrite of the scope, sees the saved calls and can write; the predecessor cannot', async () => {
    const bu = await anchored(cycleA, 'bu_ceo', { companyId: b.companyId }, 'Acme unit', [P.s1]);
    const rid = await reviewOf(cycleA, P.s1);
    const dayBefore = todayInKualaLumpur();
    await seatBu(P.buCeo);
    const first = await perf.getOnehrCalibration(U.buCeo, bu);
    expect(first.isReviewer).toBe(true);
    await perf.saveOnehrCalibration(U.buCeo, bu, first.session.revision, { reviewId: rid, axis: 'both', performance: 'AE', potential: 'High', performanceNote: 'Agreed in calibration.', potentialNote: 'Agreed in calibration.' });
    const snapshot = async () => JSON.stringify({
      session: await owner.db.select().from(schema.onehrCalibration).where(eq(schema.onehrCalibration.id, bu)),
      entries: await owner.db.select().from(schema.onehrCalibrationEntry).where(eq(schema.onehrCalibrationEntry.sessionId, bu)).orderBy(asc(schema.onehrCalibrationEntry.id)),
    });
    const before = await snapshot();
    await seatBu(P.successor);
    expect(await snapshot(), 'session row, reviewer_user_ids and entries are byte-identical').toBe(before);
    expect(await access(U.buCeo, bu)).toBe(false);
    await expect(perf.getOnehrCalibration(U.buCeo, bu)).rejects.toThrow(/access has been removed/);
    const seen = await perf.getOnehrCalibration(U.successor, bu);
    expect(seen.isReviewer).toBe(true);
    expect(seen.rows.map((r) => [r.entry.reviewId, r.entry.performance, r.entry.potential])).toEqual([[rid, 'AE', 'High']]);
    await perf.saveOnehrCalibration(U.successor, bu, seen.session.revision, { reviewId: rid, axis: 'both', performance: 'ME', potential: 'Mid', performanceNote: 'Successor review.', potentialNote: 'Successor review.' });
    const seats = (await perf.listLeaderSeats(a, { seatType: 'bu_ceo' })).map((s) => [s.holderEmploymentId, s.validFrom, s.validTo, s.endReason]);
    const dayAfter = todayInKualaLumpur(), day = hrDayBetween(dayBefore, dayAfter);
    expect(seats.sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([[P.buCeo.employmentId, day, day, 'replaced'], [P.successor.employmentId, day, null, null]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
  });

  it('a seat in one company opens nothing in another company or another business group', async () => {
    const buA = await anchored(cycleA, 'bu_ceo', { companyId: b.companyId }, 'Acme unit', [P.s1]);
    const buX = await anchored(cycleX, 'bu_ceo', { companyId: other }, 'Other unit', [P.xSubject]);
    const bgG = await anchored(cycleX, 'bg_ceo', { companyId: otherNode }, 'Other group', [P.xSubject]);
    await seatBu(P.buCeo);
    await perf.appointLeaderSeat(a, { seatType: 'bg_ceo', companyId: holding, holderEmploymentId: P.bgCeo.employmentId });
    expect(await listed(U.buCeo)).toEqual([buA]);
    expect(await access(U.buCeo, buX)).toBe(false);
    expect(await access(U.bgCeo, bgG)).toBe(false);
    expect(await listed(U.bgCeo)).toEqual([]);
    const work = await withTenant(U.buCeo, async (tx) => (await tx.execute<{ v: unknown }>(sql`select app.assessment_calibration_work(${buX}::uuid) as v`))[0].v);
    expect(work).toEqual([]);
  });

  it('keeps tenants apart: no holder, company or reader crosses a tenant', async () => {
    const b2 = await seedBase();
    await setModule(b2.tenantId, 'performance', 'active');
    const a2 = await entitledCtx(b2);
    const foreign = await hireEmployee(a2, { person: { fullName: 'Foreign person', primaryEmail: `${randomUUID()}@leader-seats.test` }, companyId: b2.companyId, departmentId: b2.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    await expect(perf.appointLeaderSeat(a, { seatType: 'bu_ceo', companyId: b.companyId, holderEmploymentId: foreign.employmentId })).rejects.toThrow('The seat holder must be an active employee');
    await expect(perf.appointLeaderSeat(a, { seatType: 'bu_ceo', companyId: b2.companyId, holderEmploymentId: P.buCeo.employmentId })).rejects.toThrow('Invalid leader seat company');
    await expect(perf.previewHodChange(a, { subjectEmploymentIds: [foreign.employmentId], hodEmploymentId: P.hodOne.employmentId })).rejects.toThrow('A picked person is not in your companies.');
    const seat = await seatBu(P.buCeo);
    expect((await perf.listLeaderSeats(a)).map((s) => s.id)).toEqual([seat.id]);
    expect(await perf.listLeaderSeats(a2)).toEqual([]);
    expect(await withTenant(a2, (tx) => tx.select().from(schema.leaderSeat))).toEqual([]);
  });

  it('never shows a holder their own row, in the list, the cohort, the decisions or the writer', async () => {
    const bu = await anchored(cycleA, 'bu_ceo', { companyId: b.companyId }, 'Acme unit', [P.s1, P.buCeo]);
    const own = await reviewOf(cycleA, P.buCeo), rid = await reviewOf(cycleA, P.s1);
    await seatBu(P.buCeo);
    expect(await perf.listMyCalibrationSessions(U.buCeo)).toEqual([expect.objectContaining({ id: bu, people: 1 })]);
    const v = await perf.getOnehrCalibration(U.buCeo, bu);
    expect(v.rows.map((r) => r.entry.reviewId)).toEqual([rid]);
    const visible = await withTenant(U.buCeo, (tx) => tx.select({ reviewId: schema.onehrCalibrationEntry.reviewId }).from(schema.onehrCalibrationEntry).where(eq(schema.onehrCalibrationEntry.sessionId, bu)));
    expect(visible.map((r) => r.reviewId)).toEqual([rid]);
    const decisions = await withTenant(U.buCeo, async (tx) => (await tx.execute<{ v: unknown }>(sql`select app.onehr_decisions(${own}::uuid) as v`))[0].v);
    expect(decisions).toEqual([]);
    await expect(perf.saveOnehrCalibration(U.buCeo, bu, v.session.revision, { reviewId: own, axis: 'both', performance: 'OU', potential: 'High', performanceNote: 'Self.', potentialNote: 'Self.' })).rejects.toThrow(/cannot be calibrated by you/);
  });

  it('keeps an ended seat readable as history while the former holder loses the scope', async () => {
    const bu = await anchored(cycleA, 'bu_ceo', { companyId: b.companyId }, 'Acme unit', [P.s1]);
    const dayBefore = todayInKualaLumpur();
    const seat = await seatBu(P.buCeo);
    await perf.endLeaderSeat(a, seat.id, { reason: 'Left the unit' });
    const dayAfter = todayInKualaLumpur(), day = hrDayBetween(dayBefore, dayAfter);
    const [history] = await perf.listLeaderSeats(a, { seatType: 'bu_ceo' });
    expect(history).toMatchObject({ id: seat.id, holderEmploymentId: P.buCeo.employmentId, holderName: 'Person buCeo', companyName: 'Acme Sdn Bhd', validFrom: day, validTo: day, endReason: 'Left the unit', live: false, source: 'admin' });
    expect(history.endedAt).toBeInstanceOf(Date);
    expect(await perf.listLeaderSeats(a, { seatType: 'bu_ceo', liveOnly: true })).toEqual([]);
    expect(await eventTypesFor(b.tenantId, seat.id)).toEqual(['performance.leader-seat.appointed', 'performance.leader-seat.ended']);
    expect(await access(U.buCeo, bu)).toBe(false);
    expect(await perf.listMyCalibrationSessions(U.buCeo)).toEqual([]);
    expect((await perf.listLeaderSeats(U.buCeo)).map((s) => s.id), 'a holder reads their own seat history').toEqual([seat.id]);
    await expect(withTenant(a, (tx) => tx.update(schema.leaderSeat).set({ endReason: 'Rewritten' }).where(eq(schema.leaderSeat.id, seat.id)))).rejects.toMatchObject(dbMessage('An ended record is immutable'));
  });
});

describe('the registry is written once, ended, never deleted', () => {
  const TABLES = ['performance_calibration_group', 'performance_calibration_group_member', 'performance_hod_assignment', 'performance_leader_seat', 'performance_onehr_calibration_entry_retired'];

  it('grants no DELETE or TRUNCATE to the app role, forces RLS, and refuses a delete', async () => {
    const grants = await owner.db.execute<{ table_name: string; privilege_type: string }>(sql`
      select table_name, privilege_type from information_schema.role_table_grants
      where grantee='ai_hr_app' and table_schema='public' and table_name = any(${sql.raw(`array['${TABLES.join("','")}']`)}) order by table_name, privilege_type`);
    const by: Record<string, string[]> = {};
    for (const g of grants) (by[g.table_name] ??= []).push(g.privilege_type);
    expect(by).toEqual({
      performance_calibration_group: ['INSERT', 'SELECT', 'UPDATE'], performance_calibration_group_member: ['INSERT', 'SELECT', 'UPDATE'],
      performance_hod_assignment: ['INSERT', 'SELECT', 'UPDATE'], performance_leader_seat: ['INSERT', 'SELECT', 'UPDATE'],
      performance_onehr_calibration_entry_retired: ['SELECT'],
    });
    const rls = await owner.db.execute<{ relname: string; enabled: boolean; forced: boolean }>(sql`
      select relname, relrowsecurity as enabled, relforcerowsecurity as forced from pg_class
      where relnamespace='public'::regnamespace and relname = any(${sql.raw(`array['${TABLES.join("','")}']`)}) order by relname`);
    expect(rls.map((r) => [r.relname, r.enabled, r.forced])).toEqual(TABLES.map((t) => [t, true, true]));
    const seat = await seatBu(P.buCeo);
    await expect(withTenant(a, (tx) => tx.delete(schema.leaderSeat).where(eq(schema.leaderSeat.id, seat.id)))).rejects.toThrow();
    expect(await owner.db.select({ id: schema.leaderSeat.id }).from(schema.leaderSeat)).toEqual([{ id: seat.id }]);
  });

  it('refuses backdating, for seats, ends and HOD changes, and allows a future start', async () => {
    const today = todayInKualaLumpur(), yesterday = addDaysIso(today, -1);
    await expect(perf.appointLeaderSeat(a, { seatType: 'bu_ceo', companyId: b.companyId, holderEmploymentId: P.buCeo.employmentId, validFrom: yesterday })).rejects.toThrow('A seat cannot start before today.');
    await expect(withTenant(a, (tx) => tx.insert(schema.leaderSeat).values({ tenantId: b.tenantId, seatType: 'bu_ceo', companyId: b.companyId, holderEmploymentId: P.buCeo.employmentId, validFrom: yesterday, source: 'admin', createdBy: b.adminUserId }))).rejects.toMatchObject(dbMessage('A leader seat cannot start before today'));
    await expect(perf.previewHodChange(a, { subjectEmploymentIds: [P.s1.employmentId], hodEmploymentId: P.hodOne.employmentId, validFrom: yesterday })).rejects.toThrow('A head of department change cannot start before today.');
    await expect(withTenant(a, (tx) => tx.insert(schema.hodAssignment).values({ tenantId: b.tenantId, subjectEmploymentId: P.s1.employmentId, hodEmploymentId: P.hodOne.employmentId, validFrom: yesterday, source: 'admin', createdBy: b.adminUserId }))).rejects.toMatchObject(dbMessage('A head of department assignment cannot start before today'));
    const seat = await seatBu(P.buCeo);
    await expect(perf.endLeaderSeat(a, seat.id, { validTo: yesterday })).rejects.toThrow('A seat cannot end before today.');
    await expect(withTenant(a, (tx) => tx.update(schema.leaderSeat).set({ validTo: yesterday, endedBy: b.adminUserId, endedAt: new Date() }).where(eq(schema.leaderSeat.id, seat.id)))).rejects.toMatchObject(dbMessage('A record ends today or later, and never later than it was due to end'));
    await expect(withTenant(a, (tx) => tx.update(schema.leaderSeat).set({ holderEmploymentId: P.successor.employmentId }).where(eq(schema.leaderSeat.id, seat.id)))).rejects.toMatchObject(dbMessage('A dated record can only be ended'));
    const future = await perf.appointLeaderSeat(a, { seatType: 'bu_ceo', companyId: other, holderEmploymentId: P.xReviewer.employmentId, validFrom: addDaysIso(today, 7) });
    expect((await perf.listLeaderSeats(a, { seatType: 'bu_ceo' })).find((s) => s.id === future.id)).toMatchObject({ validFrom: addDaysIso(today, 7), live: false });
  });

  it('lets a performance partner read seats but write none of the registry', async () => {
    const seat = await seatBu(P.buCeo);
    expect((await perf.listLeaderSeats(U.partner)).map((s) => [s.id, s.holderName])).toEqual([[seat.id, 'Person buCeo']]);
    await expect(perf.appointLeaderSeat(U.partner, { seatType: 'bu_ceo', companyId: b.companyId, holderEmploymentId: P.successor.employmentId })).rejects.toThrow(/Only a group-wide HR administrator or the HR administrator of the business group/);
    await expect(perf.endLeaderSeat(U.partner, seat.id)).rejects.toThrow('You cannot change this seat.');
    await expect(withTenant(U.partner, (tx) => tx.insert(schema.leaderSeat).values({ tenantId: b.tenantId, seatType: 'bu_ceo', companyId: b.companyId, holderEmploymentId: P.successor.employmentId, validFrom: todayInKualaLumpur(), source: 'admin', createdBy: U.partner.userId! }))).rejects.toThrow();
    await expect(perf.previewHodChange(U.partner, { subjectEmploymentIds: [P.s1.employmentId], hodEmploymentId: P.hodOne.employmentId })).rejects.toThrow(/group-wide HR administrator manages heads of department/);
    await expect(perf.createCalibrationGroup(U.partner, { name: 'Partner group' })).rejects.toThrow(/group-wide HR administrator/);
    expect(await owner.db.select({ id: schema.leaderSeat.id }).from(schema.leaderSeat)).toEqual([{ id: seat.id }]);
  });

  it('lets the business group administrator seat BU and BG CEOs inside the group, never a group chief; a unit administrator seats none', async () => {
    await expect(seatBu(P.buCeo, U.unitAdmin)).rejects.toThrow(/Only a group-wide HR administrator or the HR administrator of the business group/);
    await expect(perf.appointLeaderSeat(U.unitAdmin, { seatType: 'bg_ceo', companyId: holding, holderEmploymentId: P.bgCeo.employmentId })).rejects.toThrow(/Only a group-wide HR administrator or the HR administrator of the business group/);
    expect((await seatBu(P.buCeo, U.bgAdmin)).unchanged).toBe(false);
    expect((await perf.appointLeaderSeat(U.bgAdmin, { seatType: 'bg_ceo', companyId: holding, holderEmploymentId: P.bgCeo.employmentId })).unchanged).toBe(false);
    await expect(perf.appointLeaderSeat(U.bgAdmin, { seatType: 'bg_ceo', companyId: otherNode, holderEmploymentId: P.xReviewer.employmentId })).rejects.toThrow(/Only a group-wide HR administrator or the HR administrator of the business group/);
    const group = await perf.createCalibrationGroup(a, { name: 'Leadership group' });
    await expect(perf.appointLeaderSeat(U.bgAdmin, { seatType: 'group_chief', calibrationGroupId: group, holderEmploymentId: P.chief.employmentId })).rejects.toThrow('A group-wide HR administrator appoints group chiefs.');
    await expect(perf.createCalibrationGroup(U.bgAdmin, { name: 'Their group' })).rejects.toThrow(/group-wide HR administrator/);
    expect((await perf.listLeaderSeats(a)).map((s) => [s.seatType, s.holderEmploymentId]).sort()).toEqual([['bg_ceo', P.bgCeo.employmentId], ['bu_ceo', P.buCeo.employmentId]]);
  });

  it('keeps one business group per CEO: appointing a leader of another group leaves that group vacant', async () => {
    await perf.appointLeaderSeat(a, { seatType: 'bg_ceo', companyId: otherNode, holderEmploymentId: P.bgCeo.employmentId });
    await perf.appointLeaderSeat(a, { seatType: 'bg_ceo', companyId: holding, holderEmploymentId: P.bgCeo.employmentId });
    const live = await perf.listLeaderSeats(a, { seatType: 'bg_ceo', liveOnly: true });
    expect(live.map((s) => s.companyId)).toEqual([holding]);
    expect((await perf.listLeaderSeats(a, { seatType: 'bg_ceo' })).find((s) => s.companyId === otherNode)).toMatchObject({ endReason: 'moved', live: false });
  });
});

describe('heads of department', () => {
  async function hodScopes() {
    await assignHod([P.s1], P.hodOne);
    await assignHod([P.s2], P.hodTwo);
    const gen = await perf.generateCalibrationScopes(a, cycleA, { tiers: ['hod'] });
    expect(gen.created.map((c) => [c.anchorId, c.people]).sort()).toEqual([[P.hodOne.employmentId, 1], [P.hodTwo.employmentId, 1]].sort());
    return { one: gen.created.find((c) => c.anchorId === P.hodOne.employmentId)!.id, two: gen.created.find((c) => c.anchorId === P.hodTwo.employmentId)!.id };
  }

  it('excludes the HOD from their own people and refuses an HOD in another business group', async () => {
    const preview = await perf.previewHodChange(a, { subjectEmploymentIds: [P.s1.employmentId, P.hodOne.employmentId], hodEmploymentId: P.hodOne.employmentId });
    expect(preview).toMatchObject({ selfExcluded: 1, unchanged: 0, blockers: [], warnings: [{ code: 'import_overwrites', employmentIds: [P.s1.employmentId] }] });
    expect(preview.rows.map((r) => [r.subjectEmploymentId, r.subjectName, r.departmentName, r.currentHodEmploymentId, r.nextHodName])).toEqual([[P.s1.employmentId, 'Person s1', 'Finance', null, 'Person hodOne']]);
    await expect(perf.previewHodChange(a, { subjectEmploymentIds: [P.xSubject.employmentId], hodEmploymentId: P.hodOne.employmentId })).rejects.toThrow('A head of department can span business units but not business groups.');
    await expect(withTenant(a, (tx) => tx.insert(schema.hodAssignment).values({ tenantId: b.tenantId, subjectEmploymentId: P.xSubject.employmentId, hodEmploymentId: P.hodOne.employmentId, validFrom: todayInKualaLumpur(), source: 'admin', createdBy: b.adminUserId }))).rejects.toMatchObject(dbMessage('A head of department can span business units but not business groups'));
    await expect(withTenant(a, (tx) => tx.insert(schema.hodAssignment).values({ tenantId: b.tenantId, subjectEmploymentId: P.hodOne.employmentId, hodEmploymentId: P.hodOne.employmentId, validFrom: todayInKualaLumpur(), source: 'admin', createdBy: b.adminUserId }))).rejects.toThrow();
    // A department pick resolves today's assignees; a narrowed pick keeps only people with no HOD.
    await assignHod([P.s1], P.hodOne);
    const byDepartment = await perf.previewHodChange(a, { departmentIds: [b.deptB], hodEmploymentId: P.hodTwo.employmentId, only: 'unset' });
    expect(byDepartment.rows.map((r) => r.subjectEmploymentId)).toEqual([P.s3.employmentId]);
  });

  it('moves a person: the old entry is retired with its decision, the new HOD gets a fresh entry, the old HOD loses the person', async () => {
    const { one, two } = await hodScopes();
    const rid = await reviewOf(cycleA, P.s1), rid2 = await reviewOf(cycleA, P.s2);
    const v = await perf.getOnehrCalibration(U.hodOne, one);
    expect(v.isReviewer, 'the HOD anchor is a live reviewer without being named').toBe(true);
    await perf.saveOnehrCalibration(U.hodOne, one, v.session.revision, { reviewId: rid, axis: 'performance', performance: 'AE', potential: null, performanceNote: 'Strong year.', potentialNote: '' });
    const [entry] = await owner.db.select().from(schema.onehrCalibrationEntry).where(and(eq(schema.onehrCalibrationEntry.sessionId, one), eq(schema.onehrCalibrationEntry.reviewId, rid)));
    const move = { subjectEmploymentIds: [P.s1.employmentId], hodEmploymentId: P.hodTwo.employmentId };
    const preview = await perf.previewHodChange(a, move);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings).toEqual([
      { code: 'old_hod_decision_dropped', employmentIds: [P.s1.employmentId] },
      { code: 'former_hod_heads_nobody', employmentIds: [P.hodOne.employmentId] },
      { code: 'import_overwrites', employmentIds: [P.s1.employmentId] },
    ]);
    await expect(perf.applyHodChange(a, { ...move, fingerprint: preview.fingerprint })).rejects.toThrow(/read the warnings/);
    expect(await perf.applyHodChange(a, { ...move, fingerprint: preview.fingerprint, acknowledged: true })).toEqual({ changed: 1, retired: 1, added: 1, keptInPlace: 0 });
    const [retired] = await owner.db.select().from(schema.onehrCalibrationEntryRetired).where(eq(schema.onehrCalibrationEntryRetired.id, entry.id));
    expect(retired).toMatchObject({ sessionId: one, reviewId: rid, employmentId: P.s1.employmentId, performance: 'AE', performanceNote: 'Strong year.', retiredReason: 'hod_changed', retiredBy: b.adminUserId });
    expect(await owner.db.select().from(schema.onehrCalibrationEntry).where(eq(schema.onehrCalibrationEntry.id, entry.id))).toEqual([]);
    expect((await owner.db.select({ r: schema.onehrCalibrationEntry.reviewId }).from(schema.onehrCalibrationEntry).where(eq(schema.onehrCalibrationEntry.sessionId, two))).map((x) => x.r).sort()).toEqual([rid, rid2].sort());
    expect((await perf.listMyCalibrationSessions(U.hodOne)).find((s) => s.id === one)).toMatchObject({ people: 0 });
    const fresh = await perf.getOnehrCalibration(U.hodTwo, two);
    expect(fresh.rows.map((r) => r.entry.reviewId).sort()).toEqual([rid, rid2].sort());
    expect(fresh.rows.find((r) => r.entry.reviewId === rid)!.entry.performance).toBeNull();
    const decisions = await withTenant(a, async (tx) => (await tx.execute<{ v: { tier: string; performance: string | null }[] }>(sql`select app.onehr_decisions(${rid}::uuid) as v`))[0].v);
    expect(decisions.filter((d) => d.tier === 'hod').map((d) => d.performance)).toEqual([null]);
    expect((await perf.listHodAssignments(a, { subjectEmploymentId: P.s1.employmentId, liveOnly: false })).map((h) => [h.hodEmploymentId, h.live]).sort()).toEqual([[P.hodOne.employmentId, false], [P.hodTwo.employmentId, true]].sort());
    expect(await withTenant(a, (tx) => tx.select({ id: schema.onehrCalibrationEntryRetired.id }).from(schema.onehrCalibrationEntryRetired))).toEqual([{ id: entry.id }]);
    expect(await withTenant(U.hodOne, (tx) => tx.select({ id: schema.onehrCalibrationEntryRetired.id }).from(schema.onehrCalibrationEntryRetired)), 'retired history is for administrators').toEqual([]);
  });

  it('refuses a change that touches locked calibration work, applies it with a group-wide reason, and audits the override', async () => {
    const { one } = await hodScopes();
    const bu = await anchored(cycleA, 'bu_ceo', { companyId: b.companyId }, 'Acme unit', [P.s1]);
    await owner.db.update(schema.onehrCalibration).set({ performanceLockedAt: new Date() }).where(eq(schema.onehrCalibration.id, one));
    await owner.db.update(schema.onehrCalibrationEntry).set({ potentialLockedAt: new Date() }).where(eq(schema.onehrCalibrationEntry.sessionId, bu));
    const move = { subjectEmploymentIds: [P.s1.employmentId], hodEmploymentId: P.hodTwo.employmentId };
    const preview = await perf.previewHodChange(a, move);
    expect(preview.blockers).toEqual([{ code: 'old_hod_review_submitted', employmentIds: [P.s1.employmentId] }, { code: 'bu_review_locked', employmentIds: [P.s1.employmentId] }]);
    await expect(perf.applyHodChange(a, { ...move, fingerprint: preview.fingerprint, acknowledged: true })).rejects.toThrow(/Locked calibration work blocks this change/);
    const reason = 'Reorganisation approved by the board.';
    expect((await perf.applyHodChange(a, { ...move, fingerprint: preview.fingerprint, acknowledged: true, overrideReason: reason })).changed).toBe(1);
    const [row] = await owner.db.select().from(schema.hodAssignment).where(and(eq(schema.hodAssignment.subjectEmploymentId, P.s1.employmentId), isNull(schema.hodAssignment.endedAt)));
    expect(row).toMatchObject({ hodEmploymentId: P.hodTwo.employmentId, overrideReason: reason, source: 'admin' });
    const [audit] = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'performance.hod.override')));
    expect(audit.payload).toMatchObject({ reason, subjects: [P.s1.employmentId], blockers: preview.blockers });
  });

  it('refuses a stale preview and writes nothing', async () => {
    const { two } = await hodScopes();
    const move = { subjectEmploymentIds: [P.s1.employmentId], hodEmploymentId: P.hodTwo.employmentId };
    const preview = await perf.previewHodChange(a, move);
    await owner.db.update(schema.onehrCalibration).set({ potentialLockedAt: new Date() }).where(eq(schema.onehrCalibration.id, two));
    await expect(perf.applyHodChange(a, { ...move, fingerprint: preview.fingerprint, acknowledged: true, overrideReason: 'Approved.' })).rejects.toThrow(/previewed against different data/);
    expect((await perf.listHodAssignments(a, { subjectEmploymentId: P.s1.employmentId })).map((h) => h.hodEmploymentId)).toEqual([P.hodOne.employmentId]);
    await expect(perf.applyHodChange(a, { ...move, fingerprint: 'f'.repeat(64), acknowledged: true })).rejects.toThrow(/previewed against different data/);
  });

  it('removes an HOD with no successor, leaving the person with none', async () => {
    await assignHod([P.s1], P.hodOne);
    const preview = await perf.previewHodChange(a, { subjectEmploymentIds: [P.s1.employmentId], hodEmploymentId: null });
    expect(preview.rows).toEqual([expect.objectContaining({ subjectEmploymentId: P.s1.employmentId, currentHodEmploymentId: P.hodOne.employmentId, nextHodEmploymentId: null })]);
    await perf.applyHodChange(a, { subjectEmploymentIds: [P.s1.employmentId], hodEmploymentId: null, fingerprint: preview.fingerprint, acknowledged: true });
    expect(await perf.listHodAssignments(a, { subjectEmploymentId: P.s1.employmentId })).toEqual([]);
    expect(await eventTypesFor(b.tenantId, P.s1.employmentId)).toContain('performance.hod.ended');
  });
});

describe('generated scopes', () => {
  it('generates idempotently, leaves hand-built scopes unanchored, and keeps the explicit reviewer arm', async () => {
    const rid = await reviewOf(cycleA, P.s1);
    const hand = await perf.createOnehrCalibration(a, cycleA, { name: 'Hand-built unit', companyId: b.companyId, tier: 'bu', reviewerUserIds: [U.explicit.userId!], reviewIds: [rid], pbtAchievement: null, mode: 'after' });
    await seatBu(P.buCeo);
    const [{ n: total }] = await withTenant(a, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from performance_onehr_review r where r.cycle_id=${cycleA}::uuid and app.assessment_review_participates(r.review_id)`));
    expect(total).toBeGreaterThan(2);
    const first = await perf.generateCalibrationScopes(a, cycleA, { tiers: ['bu', 'bg'] });
    expect(first.created.map((c) => [c.tier, c.anchorId, c.people])).toEqual([['bu', b.companyId, total - 1], ['bg', holding, total]]);
    const unit = first.created[0]!.id;
    const [h] = await owner.db.select().from(schema.onehrCalibration).where(eq(schema.onehrCalibration.id, hand));
    expect([h.anchorKind, h.anchorEmploymentId, h.calibrationGroupId, h.reviewerUserIds]).toEqual([null, null, null, [U.explicit.userId]]);
    await expect(withTenant(a, (tx) => tx.update(schema.onehrCalibration).set({ anchorKind: 'bu_ceo' }).where(eq(schema.onehrCalibration.id, hand)))).rejects.toMatchObject(dbMessage('Calibration scope anchor is immutable'));
    expect(await access(U.buCeo, unit)).toBe(true);
    expect(await access(U.buCeo, hand), 'a seat never reaches a hand-built cohort').toBe(false);
    expect(await access(U.explicit, hand)).toBe(true);
    expect(await access(U.explicit, unit)).toBe(false);
    expect(await perf.hasCalibrationAssignment(U.explicit)).toBe(true);
    expect(await perf.generateCalibrationScopes(a, cycleA, { tiers: ['bu', 'bg'] })).toEqual({ created: [], extended: [], skipped: [] });
    expect((await owner.db.select({ id: schema.onehrCalibration.id }).from(schema.onehrCalibration).where(eq(schema.onehrCalibration.cycleId, cycleA))).length).toBe(3);
  });

  it('keeps department reviews live with HOD changes, adds people newly in a group on a repeat run, and builds the group from live membership', async () => {
    await assignHod([P.s1], P.hodOne);
    const first = await perf.generateCalibrationScopes(a, cycleA, { tiers: ['hod'] });
    expect(first.created).toEqual([expect.objectContaining({ tier: 'hod', anchorId: P.hodOne.employmentId, people: 1 })]);
    // The HOD writer keeps the open department review in step: a person newly under the HOD joins at once.
    expect(await assignHod([P.s3], P.hodOne)).toEqual({ changed: 1, retired: 0, added: 1, keptInPlace: 0 });
    expect(await perf.generateCalibrationScopes(a, cycleA, { tiers: ['hod'] })).toEqual({ created: [], extended: [], skipped: [] });
    const group = await perf.createCalibrationGroup(a, { name: 'Talent council' });
    await perf.addCalibrationGroupMembers(a, group, { employmentIds: [P.member.employmentId] });
    const g = await perf.generateCalibrationScopes(a, cycleA, { tiers: ['group'] });
    expect(g.created).toEqual([expect.objectContaining({ tier: 'group', anchorId: group, name: 'Talent council', people: 1 })]);
    const [row] = await owner.db.select().from(schema.onehrCalibration).where(eq(schema.onehrCalibration.id, g.created[0]!.id));
    expect(row).toMatchObject({ companyId: null, anchorKind: 'group_chief', calibrationGroupId: group, reviewerUserIds: [] });
    // Membership changes do not move sessions themselves; the idempotent repeat run adds the newcomer.
    await perf.addCalibrationGroupMembers(a, group, { employmentIds: [P.s2.employmentId] });
    expect(await perf.generateCalibrationScopes(a, cycleA, { tiers: ['group'] })).toEqual({ created: [], extended: [{ id: g.created[0]!.id, tier: 'group', anchorId: group, added: 1 }], skipped: [] });
    expect((await perf.listCalibrationGroupMembers(a, group)).map((m) => m.employmentId).sort()).toEqual([P.member.employmentId, P.s2.employmentId].sort());
  });
});

describe('group chiefs', () => {
  it('refuses a member as chief, and any chief change once the group calls are locked in an open cycle', async () => {
    const group = await perf.createCalibrationGroup(a, { name: 'Talent council' });
    await perf.addCalibrationGroupMembers(a, group, { employmentIds: [P.member.employmentId, P.s3.employmentId] });
    await expect(perf.appointLeaderSeat(a, { seatType: 'group_chief', calibrationGroupId: group, holderEmploymentId: P.member.employmentId })).rejects.toThrow('A member of the group cannot be its chief');
    const seat = await perf.appointLeaderSeat(a, { seatType: 'group_chief', calibrationGroupId: group, holderEmploymentId: P.chief.employmentId });
    const [scope] = (await perf.generateCalibrationScopes(a, cycleA, { tiers: ['group'] })).created;
    expect(await access(U.chief, scope!.id)).toBe(true);
    expect(await listed(U.chief)).toEqual([scope!.id]);
    expect(await perf.listCalibrationGroups(a)).toEqual([expect.objectContaining({ id: group, name: 'Talent council', members: 2, chief: { seatId: seat.id, employmentId: P.chief.employmentId, name: 'Person chief' } })]);
    await owner.db.update(schema.onehrCalibrationEntry).set({ performanceLockedAt: new Date() }).where(and(eq(schema.onehrCalibrationEntry.sessionId, scope!.id), eq(schema.onehrCalibrationEntry.reviewId, await reviewOf(cycleA, P.member))));
    await expect(perf.appointLeaderSeat(a, { seatType: 'group_chief', calibrationGroupId: group, holderEmploymentId: P.successor.employmentId })).rejects.toThrow(/locked in an open cycle/);
    await expect(perf.endLeaderSeat(a, seat.id)).rejects.toThrow(/locked in an open cycle/);
    expect(await access(U.chief, scope!.id), 'the locked call stays with its chief').toBe(true);
  });
});

describe('named-reviewer readers see live seats', () => {
  it('gives a live seat holder the sidebar row, a task and reminder routing; an ended seat gives none', async () => {
    const bu = await anchored(cycleA, 'bu_ceo', { companyId: b.companyId }, 'Acme unit', [P.s1, P.s2]);
    const seat = await seatBu(P.buCeo);
    expect(await perf.hasCalibrationAssignment(U.buCeo)).toBe(true);
    expect((await perf.pendingCalibrationTasks(U.buCeo)).map((t) => t.id)).toEqual([bu]);
    const routing = async (ctx: SessionContext) => {
      const graph = await withTenant(ctx, async (tx) => (await tx.execute<{ v: { sessions: { id: string; reviewerUserIds: string[] }[] } }>(sql`select app.assessment_pending_work(${cycleA}::uuid) as v`))[0].v);
      return graph.sessions.find((s) => s.id === bu)!.reviewerUserIds;
    };
    expect(await routing(a)).toEqual([U.buCeo.userId]);
    expect(await routing({ ...a, userId: undefined, personId: undefined }), 'the dispatcher routes the same reviewer').toEqual([U.buCeo.userId]);
    await perf.endLeaderSeat(a, seat.id);
    expect(await perf.hasCalibrationAssignment(U.buCeo)).toBe(false);
    expect(await perf.pendingCalibrationTasks(U.buCeo)).toEqual([]);
    expect(await routing(a)).toEqual([]);
  });

  it('asks the reviewer helper about another login only for the dispatcher or the session administrators', async () => {
    const bu = await anchored(cycleA, 'bu_ceo', { companyId: b.companyId }, 'Acme unit', [P.s1]);
    await seatBu(P.buCeo);
    const ask = (ctx: SessionContext, user: string) => withTenant(ctx, async (tx) => !!(await tx.execute<{ ok: boolean }>(sql`select app.onehr_calibration_reviewer(${bu}::uuid,${user}::uuid) as ok`))[0]?.ok);
    expect(await ask(U.buCeo, U.buCeo.userId!)).toBe(true);
    expect(await ask(a, U.buCeo.userId!)).toBe(true);
    expect(await ask(U.s1, U.buCeo.userId!), 'a plain employee cannot probe who calibrates').toBe(false);
  });
});

describe('leader import', () => {
  it('maps parsed rows onto the same writers, refusing unknown identifiers and stale previews', async () => {
    const code = async (e: Hired, value: string) => { await owner.db.update(schema.employment).set({ employeeCode: value }).where(eq(schema.employment.id, e.employmentId)); };
    await code(P.s1, 'E-S1'); await code(P.hodOne, 'E-H1'); await code(P.buCeo, 'E-BU');
    await owner.db.update(schema.company).set({ companyLabel: 'ACME' }).where(eq(schema.company.id, b.companyId));
    const rows = { hodRows: [{ employeeCode: 'E-S1', hod: 'E-H1' }, { employeeCode: 'E-S2', hod: '' }, { employeeCode: 'E-NOPE', hod: 'E-H1' }], seatRows: [{ seatType: 'bu_ceo' as const, anchor: 'acme', holder: 'E-BU' }] };
    const preview = await perf.importLeaders(a, rows);
    expect(preview.applied).toBe(false);
    if (preview.applied) return;
    expect(preview.errors).toEqual([{ kind: 'hod', line: 3, message: 'Employee ID E-NOPE is unknown.' }]);
    await expect(perf.importLeaders(a, rows, { apply: true, fingerprint: preview.fingerprint, acknowledged: true })).rejects.toThrow(/Fix the rows with errors/);
    const clean = { hodRows: rows.hodRows.slice(0, 2), seatRows: rows.seatRows };
    const ok = await perf.importLeaders(a, clean);
    if (ok.applied) throw Error('preview expected');
    expect(ok.errors).toEqual([]);
    expect(ok.hod.map((h) => h.rows.map((r) => [r.subjectEmploymentId, r.nextHodEmploymentId]))).toEqual([[[P.s1.employmentId, P.hodOne.employmentId]]]);
    await expect(perf.importLeaders(a, clean, { apply: true, fingerprint: 'a'.repeat(64) })).rejects.toThrow(/previewed against different data/);
    expect(await perf.importLeaders(a, clean, { apply: true, fingerprint: ok.fingerprint, acknowledged: true })).toEqual({ applied: true, hod: { changed: 1, retired: 0, added: 0, keptInPlace: 0 }, seats: { appointed: 1, ended: 0, unchanged: 0 } });
    expect((await perf.listHodAssignments(a, { subjectEmploymentId: P.s1.employmentId })).map((h) => [h.hodEmploymentId, h.source])).toEqual([[P.hodOne.employmentId, 'import']]);
    expect((await perf.listLeaderSeats(a, { liveOnly: true })).map((s) => [s.seatType, s.companyId, s.holderEmploymentId, s.source])).toEqual([['bu_ceo', b.companyId, P.buCeo.employmentId, 'import']]);
  });
});
