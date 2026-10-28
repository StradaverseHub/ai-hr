/**
 * WP-C (APR-022) — the HOD department view against real RLS as ai_hr_app.
 *
 * Every read is the persona's app-role session (the service, or app.onehr_department_view through that
 * session). HOD assignments are written by the group-wide HR administrator through the WP-B2 service.
 * `owner` only builds what the app cannot express in one step: the org tree, administrative reporting lines,
 * KPI lines and stored overalls on the reviews, and data the 0663 triggers refuse (a self assignment, a
 * cross-group assignment) so the projection's own predicates are what keeps them out. Dates come from
 * todayInKualaLumpur().
 *
 * Org: Holding ← Acme (seedBase unit) and Sister (unit); Other group ← Other unit. One group-wide OneHR cycle.
 * Lines: Mia → Head; Ian → Mia; Sam (Sister) → Head; Xin → Head (but Xin's HOD is Hoda); Oz (Other unit) → Head;
 * Rae (Operations) → Hoda, outside Head's line and department.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee } from '../core/org';
import * as perf from '../packs/performance/service';
import { defaultPolicy, kpiSchema, scorecard, type KPI } from '../packs/performance/onehr/model';
import { departmentSpread } from '../packs/performance/onehr/department-view-model';
import { addDaysIso } from '../packs/performance/onehr/leader-seat-model';
import framework from '../packs/performance/onehr/framework.json';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

// Only the year is read at load (a run across New Year is out of scope); every HR day is read where it is used.
const year = Number(todayInKualaLumpur().slice(0, 4));
/** A date the service stamped between two reads of the HR day: one of them, so a run across midnight still passes. */
const hrDayBetween = (before: string, after: string) => expect.stringMatching(new RegExp(`^(${before}|${after})$`));
type Hired = { employmentId: string; personId: string };
const COLUMNS = ['employment_id', 'parent_employment_id', 'full_name', 'department_name', 'job_title', 'direct', 'finalized', 'overall_band', 'overall_score', 'mechanism'];

let b: Base, a: SessionContext, sister: string, other: string, cycle: string;
let head: Hired, headSecond: Hired, hoda: Hired, mia: Hired, ian: Hired, sam: Hired, xin: Hired, oz: Hired, plain: Hired, rae: Hired;
let H: SessionContext, HODA: SessionContext, PLAIN: SessionContext;

const hire = (name: string, companyId: string, departmentId: string, positionId?: string, personId?: string) =>
  hireEmployee(a, { person: personId ? { id: personId } : { fullName: name, primaryEmail: `${randomUUID()}@department-view.test` }, companyId, departmentId, positionId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
async function login(person: Hired): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, person.personId, 'manager');
  return { tenantId: b.tenantId, userId, personId: person.personId, roles: ['manager'], grants: [{ role: 'manager', companyId: null }], entitlements: a.entitlements };
}
const line = (sub: Hired, mgr: Hired) => owner.db.insert(schema.reportingLine).values({ tenantId: b.tenantId, subordinateEmploymentId: sub.employmentId, managerEmploymentId: mgr.employmentId, lineType: 'administrative', validFrom: '2020-01-01' });
async function assignHod(subjects: Hired[], hod: Hired | null, validFrom?: string) {
  const input = { subjectEmploymentIds: subjects.map((s) => s.employmentId), hodEmploymentId: hod?.employmentId ?? null, ...(validFrom ? { validFrom } : {}) };
  const preview = await perf.previewHodChange(a, input);
  return perf.applyHodChange(a, { ...input, fingerprint: preview.fingerprint, acknowledged: true });
}
/** Data the 0663 validation trigger refuses, written by the fixture owner with triggers off. */
const forceHod = (subject: Hired, hod: Hired) => owner.db.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL session_replication_role = replica`);
  await tx.insert(schema.hodAssignment).values({ tenantId: b.tenantId, subjectEmploymentId: subject.employmentId, hodEmploymentId: hod.employmentId, validFrom: todayInKualaLumpur(), source: 'admin', createdBy: b.adminUserId });
});
async function reviewOf(e: Hired) {
  const [r] = await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId, cycle), eq(schema.onehrReview.employmentId, e.employmentId)));
  expect(r, 'the opened OneHR cycle has a review for the fixture person').toBeDefined();
  return r;
}
/**
 * A complete KPI line, parsed by the real kpiSchema so every service reader that parses the review's kpis
 * (participation, moderation, workspace) accepts what the fixture writes. Every required field is given.
 */
const kpi = (title: string, approvedActual: number, locked: boolean): KPI => kpiSchema.parse({
  id: randomUUID(), title, description: '', weightBp: 5000, unit: 'score', moderatorEmploymentId: null,
  scoring: { mechanism: 'A', method: 'more', rates: [1, 2, 3, 4, 5] },
  setting: 'approved', settingRemark: '', actual: approvedActual, note: '', approvedActual, moderationRemark: '', locked,
});
/** KPI lines and the stored overall on a review, as the moderation writers leave them. */
async function setResult(e: Hired, lines: KPI[], stored: { band: string; score: number } | null) {
  // Derived lines ({ ...line, locked: true }) are re-parsed too: the fixture writes only what the service reads.
  const kpis = kpiSchema.array().parse(lines);
  const r = await reviewOf(e);
  await owner.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.update(schema.onehrReview).set({ kpis, managerPerformance: stored?.band ?? null, managerScore: stored ? String(stored.score) : null }).where(eq(schema.onehrReview.reviewId, r.reviewId));
  });
}
const view = (ctx: SessionContext, cycleId = cycle) => withTenant(ctx, (tx) => tx.execute<Record<string, unknown>>(sql`select * from app.onehr_department_view(${cycleId}::uuid)`));
const cycles = (ctx: SessionContext) => withTenant(ctx, (tx) => tx.execute<Record<string, unknown>>(sql`select * from app.onehr_department_cycles()`));
const names = async (ctx: SessionContext) => (await view(ctx)).map((r) => r.full_name).sort();

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'performance', 'active');
  a = await entitledCtx(b);
  const { id: holding } = await createCompany(a, { legalName: 'Holding Group Bhd' });
  await owner.db.update(schema.company).set({ parentCompanyId: holding }).where(eq(schema.company.id, b.companyId));
  ({ id: sister } = await createCompany(a, { legalName: 'Sister Unit Sdn Bhd' }));
  await owner.db.update(schema.company).set({ parentCompanyId: holding }).where(eq(schema.company.id, sister));
  const { id: otherNode } = await createCompany(a, { legalName: 'Other Group Bhd' });
  ({ id: other } = await createCompany(a, { legalName: 'Other Unit Sdn Bhd' }));
  await owner.db.update(schema.company).set({ parentCompanyId: otherNode }).where(eq(schema.company.id, other));
  const sisterDept = await createDepartment(a, { companyId: sister, name: 'Sister ops' });
  const otherDept = await createDepartment(a, { companyId: other, name: 'Other ops' });
  head = await hire('Head', b.companyId, b.deptA, b.positionId);
  hoda = await hire('Hoda', b.companyId, b.deptA, b.positionId);
  mia = await hire('Mia', b.companyId, b.deptA, b.positionId);
  ian = await hire('Ian', b.companyId, b.deptB);
  xin = await hire('Xin', b.companyId, b.deptA, b.positionId);
  plain = await hire('Plain', b.companyId, b.deptA);
  rae = await hire('Rae', b.companyId, b.deptB);
  sam = await hire('Sam', sister, sisterDept.id);
  oz = await hire('Oz', other, otherDept.id);
  headSecond = await hire('Head', sister, sisterDept.id, undefined, head.personId);
  const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
  await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.tenantId, b.tenantId));
  for (const [sub, mgr] of [[mia, head], [ian, mia], [sam, head], [xin, head], [oz, head], [rae, hoda]] as const) await line(sub, mgr);
  ({ cycleId: cycle } = await perf.createCycle(a, { name: 'Group annual', companyId: null, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }));
  await perf.configureOnehrCycle(a, cycle, null, defaultPolicy(framework));
  await perf.openCycle(a, { cycleId: cycle });
  for (const e of [head, headSecond, hoda, mia, ian, xin, plain, sam, oz, rae]) await setResult(e, [kpi('Delivery', 3, false), kpi('Quality', 4, false)], null);
  H = await login(head); HODA = await login(hoda); PLAIN = await login(plain);
});
afterAll(closeAll);

describe('population: the live per-person HOD assignment, and nothing else', () => {
  it('lists direct and indirect people, a person in a sister unit, and orders the forest; never the line-only colleague', async () => {
    await assignHod([mia, ian, sam], head);
    await assignHod([xin], hoda);
    expect(await names(H)).toEqual(['Ian', 'Mia', 'Sam']);
    const rows = await view(H);
    const row = (e: Hired) => rows.find((r) => r.employment_id === e.employmentId)!;
    expect([row(mia).direct, row(mia).parent_employment_id]).toEqual([true, null]);
    // Indirect: Ian's line manager is Mia, a member of the population, so Mia is his parent.
    expect([row(ian).direct, row(ian).parent_employment_id]).toEqual([false, mia.employmentId]);
    expect([row(sam).direct, row(sam).department_name, row(sam).job_title]).toEqual([true, 'Sister ops', null]);
    expect([row(mia).department_name, row(mia).job_title]).toEqual(['Finance', 'Executive']);
    // Xin reports to Head on the line, but Xin's HOD assignment names Hoda: the line never adds a person.
    expect(rows.some((r) => r.employment_id === xin.employmentId)).toBe(false);
    const service = await perf.getDepartmentView(H);
    expect(service?.rows.map((r) => [r.fullName, r.depth])).toEqual([['Mia', 0], ['Ian', 1], ['Sam', 0]]);
    expect(service?.cycle).toMatchObject({ id: cycle, name: 'Group annual', people: 3, finalized: 0 });
  });

  it('does not depend on what the HOD could otherwise see: an assigned person outside the line and department is listed; a removed participant is not', async () => {
    await assignHod([rae, mia], head);
    // Rae works in Operations (Head is in Finance), reports to Hoda, and sits in no calibration scope of Head's:
    // the caller-visibility arm of app.assessment_review_participates would drop her; eligibility alone keeps her.
    const visible = await withTenant(H, (tx) => tx.execute<{ ok: boolean }>(sql`select app.can_see_employment(${rae.employmentId}::uuid) as ok`));
    expect(visible[0]?.ok, 'non-vacuous: Head cannot otherwise see Rae').toBe(false);
    expect(await names(H)).toEqual(['Mia', 'Rae']);
    const row = (await view(H)).find((r) => r.employment_id === rae.employmentId)!;
    expect([row.direct, row.parent_employment_id, row.department_name]).toEqual([false, null, 'Operations']);
    // Removing Mia from the cycle's participants drops her; the assignment itself is untouched.
    const [part] = await owner.db.select().from(schema.assessmentParticipationSnapshot).where(and(eq(schema.assessmentParticipationSnapshot.cycleId, cycle), eq(schema.assessmentParticipationSnapshot.employmentId, mia.employmentId)));
    expect(part, 'the opened cycle snapshotted Mia as a participant').toBeDefined();
    const config = await perf.getOnehrCycle(a, cycle);
    await perf.setAssessmentParticipation(a, cycle, config!.revision, mia.employmentId, part.revision, 'remove');
    expect(await names(H)).toEqual(['Rae']);
    expect((await perf.listHodAssignments(a, { subjectEmploymentId: mia.employmentId, liveOnly: true })).map((h) => h.hodEmploymentId)).toEqual([head.employmentId]);
  });

  it('never returns a person in another business group, even with forced data and a line to the HOD', async () => {
    await expect(perf.previewHodChange(a, { subjectEmploymentIds: [oz.employmentId], hodEmploymentId: head.employmentId })).rejects.toThrow('A head of department can span business units but not business groups.');
    await forceHod(oz, head);
    const [forced] = await owner.db.select().from(schema.hodAssignment).where(eq(schema.hodAssignment.subjectEmploymentId, oz.employmentId));
    expect(forced?.hodEmploymentId, 'the forced row exists').toBe(head.employmentId);
    expect(await names(H)).toEqual([]);
  });

  it("never returns the HOD's own person, even when an assignment names them (forced past the trigger)", async () => {
    await forceHod(headSecond, head);
    await assignHod([mia], head);
    expect((await reviewOf(headSecond)).employmentId).toBe(headSecond.employmentId);
    expect(await names(H)).toEqual(['Mia']);
  });

  it('a non-HOD gets nothing: no rows, no cycles, no page, no link', async () => {
    await assignHod([mia, ian], head);
    expect(await view(PLAIN)).toEqual([]);
    expect(await cycles(PLAIN)).toEqual([]);
    expect(await perf.getDepartmentView(PLAIN)).toBeNull();
    expect(await perf.hasDepartmentView(PLAIN)).toBe(false);
    expect(await perf.hasDepartmentView(H)).toBe(true);
    // The HR administrator is not an HOD either: administration grants no department view.
    expect(await view(a)).toEqual([]);
  });

  it('an ended assignment drops the person the day after its last day; ending it today drops them at once', async () => {
    const today = todayInKualaLumpur();
    const [clock] = await owner.db.execute<{ d: string }>(sql`select ((now() at time zone 'Asia/Kuala_Lumpur')::date)::text as d`);
    expect(clock.d, 'the database day is the HR day (the case cannot pass vacuously near midnight)').toBe(today);
    await assignHod([mia, ian], head);
    await assignHod([mia], null, addDaysIso(today, 1));
    expect(await names(H), 'valid_to is exclusive: today is still Mia\'s last day').toEqual(['Ian', 'Mia']);
    await assignHod([ian], null);
    const dayAfter = todayInKualaLumpur();
    expect(await names(H), 'an assignment ending today ended yesterday').toEqual(['Mia']);
    const [ended] = await owner.db.select().from(schema.hodAssignment).where(eq(schema.hodAssignment.subjectEmploymentId, ian.employmentId));
    expect(ended).toMatchObject({ validTo: hrDayBetween(today, dayAfter), endedBy: b.adminUserId });
  });

  it('keeps tenants apart', async () => {
    await assignHod([mia], head);
    const b2 = await seedBase();
    await setModule(b2.tenantId, 'performance', 'active');
    const a2 = await entitledCtx(b2);
    const stranger = await hireEmployee(a2, { person: { fullName: 'Stranger', primaryEmail: `${randomUUID()}@department-view.test` }, companyId: b2.companyId, departmentId: b2.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    const strangerId = await createAppUser(b2.tenantId, stranger.personId, 'manager');
    const S: SessionContext = { tenantId: b2.tenantId, userId: strangerId, personId: stranger.personId, roles: ['manager'], grants: [{ role: 'manager', companyId: null }], entitlements: a2.entitlements };
    expect(await view(S, cycle)).toEqual([]);
    expect(await cycles(S)).toEqual([]);
    expect(await names(H)).toEqual(['Mia']);
  });
});

describe('projection shape and privileges', () => {
  it('returns exactly the declared columns, executable by the app role and not by PUBLIC', async () => {
    await assignHod([mia], head);
    const [row] = await view(H);
    expect(Object.keys(row).sort()).toEqual([...COLUMNS].sort());
    const [cycleRow] = await cycles(H);
    expect(Object.keys(cycleRow).sort()).toEqual(['cycle_id', 'cycle_name', 'finalized', 'people', 'period_end']);
    const [fn] = await owner.db.execute<{ result: string; definer: boolean; app: boolean; pub: boolean }>(sql`select pg_get_function_result('app.onehr_department_view(uuid)'::regprocedure) as result,
      p.prosecdef as definer, has_function_privilege('ai_hr_app','app.onehr_department_view(uuid)','EXECUTE') as app, has_function_privilege('public','app.onehr_department_view(uuid)','EXECUTE') as pub
      from pg_proc p where p.oid='app.onehr_department_view(uuid)'::regprocedure`);
    expect(fn).toEqual({
      result: 'TABLE(employment_id uuid, parent_employment_id uuid, full_name text, department_name text, job_title text, direct boolean, finalized boolean, overall_band text, overall_score numeric, mechanism text)',
      definer: true, app: true, pub: false,
    });
    const [cyc] = await owner.db.execute<{ app: boolean; pub: boolean }>(sql`select has_function_privilege('ai_hr_app','app.onehr_department_cycles()','EXECUTE') as app, has_function_privilege('public','app.onehr_department_cycles()','EXECUTE') as pub`);
    expect(cyc).toEqual({ app: true, pub: false });
    // The eligibility helper is internal: only the definer projection reaches it.
    const [helper] = await owner.db.execute<{ app: boolean; pub: boolean; definer: boolean }>(sql`select has_function_privilege('ai_hr_app','app.assessment_review_eligible(uuid)','EXECUTE') as app,
      has_function_privilege('public','app.assessment_review_eligible(uuid)','EXECUTE') as pub, p.prosecdef as definer from pg_proc p where p.oid='app.assessment_review_eligible(uuid)'::regprocedure`);
    expect(helper).toEqual({ app: false, pub: false, definer: true });
  });
});

describe('overall rating: the stored moderated overall, only once every KPI line is locked', () => {
  it('is Pending until the last line locks, then the value; a stored band with an open line, or locked lines with no stored band, stay Pending', async () => {
    await assignHod([mia, ian, sam], head);
    const policy = defaultPolicy(framework);
    const open = [kpi('Delivery', 3, true), kpi('Quality', 4, false)];
    // A stale stored band while a line is still open never shows.
    await setResult(mia, open, { band: 'AE', score: 3.9 });
    const one = (await view(H)).find((r) => r.employment_id === mia.employmentId)!;
    expect([one.finalized, one.overall_band, one.overall_score, one.mechanism]).toEqual([false, null, null, null]);
    const locked = open.map((k) => ({ ...k, locked: true }));
    const expected = scorecard(locked, policy, b.companyId, true);
    expect(expected, 'independent calculation: weighted (3 + 4) / 2 on the default A cutoffs').toEqual({ score: 3.5, band: 'ME' });
    // Every line locked but no stored overall (the classic per-line moderation path before confirmation): Pending.
    await setResult(mia, locked, null);
    expect((await view(H)).find((r) => r.employment_id === mia.employmentId)!.finalized).toBe(false);
    await setResult(mia, locked, { band: expected.band!, score: expected.score! });
    const done = (await view(H)).find((r) => r.employment_id === mia.employmentId)!;
    expect([done.finalized, done.overall_band, Number(done.overall_score), done.mechanism]).toEqual([true, 'ME', 3.5, 'A']);
  });

  it('counts the spread over finalized people only, and N of M over everyone listed', async () => {
    await assignHod([mia, ian, sam], head);
    const all = (a1: number, a2: number) => [kpi('Delivery', a1, true), kpi('Quality', a2, true)];
    await setResult(mia, all(3, 4), { band: 'ME', score: 3.5 });
    await setResult(sam, all(5, 5), { band: 'OU', score: 5 });
    const v = await perf.getDepartmentView(H);
    const spread = departmentSpread(v!.rows);
    expect([spread.finalized, spread.total]).toEqual([2, 3]);
    expect(spread.counts).toEqual({ UA: 0, BE: 0, ME: 1, AE: 0, OU: 1 });
    expect([spread.pct.ME, spread.pct.OU]).toEqual([50, 50]);
    expect(v!.cycle).toMatchObject({ people: 3, finalized: 2 });
    expect(v!.rows.find((r) => r.fullName === 'Sam')).toMatchObject({ finalized: true, overallBand: 'OU', overallScore: 5, mechanism: 'A' });
  });
});
