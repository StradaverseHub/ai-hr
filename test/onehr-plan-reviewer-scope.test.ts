/**
 * TASK-030 (CF-26 / AC-10) — a Career Plan (performance_onehr_plan) is read and written by its subject, its
 * assigned reviewer (app.assessment_plan_reviewer: the review's line manager or a KPI approver/moderator) and
 * the OneHR administrator of the plan's cycle (app.onehr_admin + app.onehr_cycle_admin, which admits the
 * ADR-0142 performance partner in scope). Department-tree visibility (app.visible_employment_ids: skip-level
 * managers, heads of department) no longer reaches a plan's content. Migration 0640.
 *
 * Every read and write below runs as ai_hr_app with tenant context (withTenant), so RLS is what answers.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee, setReportingLine } from '../core/org';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { adminCtx, closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const year = Number(todayInKualaLumpur().slice(0, 4));
type Hired = { employmentId: string; personId: string };

/** The refusal's own text through drizzle's `cause` chain, so a refusal cannot pass on an unrelated error. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const parts: string[] = [];
    let cur: unknown = e;
    while (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the operation to be refused, but it succeeded');
}

describe('Career Plan reviewer scope (TASK-030, migration 0640)', () => {
  let b: Base, a: SessionContext;
  let subject: Hired, subject2: Hired, manager: Hired, skip: Hired, hod: Hired, hodReport: Hired, approver: Hired, partnerPerson: Hired, otherEmployee: Hired;
  let self: SessionContext, self2: SessionContext, mgr: SessionContext, skipCtx: SessionContext, hodCtx: SessionContext, approverCtx: SessionContext;
  let partner: SessionContext, partnerOther: SessionContext, hrOther: SessionContext;
  let coB: string, cycleId: string, reviewId: string, review2Id: string, sharedPlanId: string, draftPlanId: string;
  const planYear = year + 1; // year-end cycle: the plan belongs to the following year

  async function userCtx(personId: string, role: 'employee' | 'manager'): Promise<SessionContext> {
    return { ...a, userId: await createAppUser(b.tenantId, personId, role), personId, roles: [role], grants: undefined };
  }
  async function grantCtx(role: 'performance_partner' | 'hr_admin', companyId: string | null, personId: string | null): Promise<SessionContext> {
    const [u] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId }).returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId, role });
    return { tenantId: b.tenantId, userId: u.id, personId, roles: [role], grants: [{ role, companyId }], entitlements: a.entitlements };
  }
  const hire = (name: string, companyId: string, departmentId: string) =>
    hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@plan-scope.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
  const line = (sub: Hired, mgrE: Hired) =>
    setReportingLine(a, { subordinateEmploymentId: sub.employmentId, managerEmploymentId: mgrE.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
  const reviewOf = async (cycle: string, e: Hired) => {
    const [r] = await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, cycle), eq(schema.performanceReview.employmentId, e.employmentId)));
    expect(r, 'the cycle opened a review for the employee').toBeDefined();
    return r.id;
  };
  /** Plan rows (with content) the actor can read through RLS. */
  const plansAs = (ctx: SessionContext) =>
    withTenant(ctx, (tx) => tx.select({ id: schema.onehrPlan.id, status: schema.onehrPlan.status, career: schema.onehrPlan.career, goals: schema.onehrPlan.goals }).from(schema.onehrPlan).orderBy(asc(schema.onehrPlan.id)));
  const idsAs = async (ctx: SessionContext) => (await plansAs(ctx)).map((p) => p.id).sort();
  const career = (aspiration: string) => ({ aspiration, mobility: 'stay', mobilityNote: '', targetProfileId: null });
  const goal = (area: string) => ({ id: randomUUID(), area, dueOn: '', onJob: `Practise ${area}`, fromOthers: '', formalLearning: '', status: 'not_started' as const });
  /** A raw UPDATE of a non-guarded column: RLS alone decides (USING filters the row, WITH CHECK refuses). */
  const touch = (ctx: SessionContext, planId: string, conversation: string) =>
    withTenant(ctx, (tx) => tx.update(schema.onehrPlan).set({ conversation }).where(eq(schema.onehrPlan.id, planId)).returning({ id: schema.onehrPlan.id }));
  /** A raw INSERT of a plan for the subject in a plan year that has none, so only RLS can refuse it. A
   * 'shared' row, so the old visibility arm also admits it for RETURNING (a draft would be refused by the
   * SELECT policy on RETURNING alone, before and after 0640, which would make a refusal vacuous). */
  const insertFor = (ctx: SessionContext, e: Hired, review: string, offset: number, status: 'draft' | 'shared' = 'shared') =>
    withTenant(ctx, (tx) => tx.insert(schema.onehrPlan).values({ tenantId: b.tenantId, employmentId: e.employmentId, reviewId: review, planYear: planYear + offset, status, goals: [] }).returning({ id: schema.onehrPlan.id }));

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    await setModule(b.tenantId, 'performance', 'active');
    a = await entitledCtx(b);
    subject = await hire('Plan subject', b.companyId, b.deptA);
    subject2 = await hire('Draft subject', b.companyId, b.deptA);
    manager = await hire('Line manager', b.companyId, b.deptA);
    skip = await hire('Skip-level manager', b.companyId, b.deptB);
    hod = await hire('Department head', b.companyId, b.deptA);
    hodReport = await hire('Department head report', b.companyId, b.deptA);
    approver = await hire('KPI approver', b.companyId, b.deptB);
    partnerPerson = await hire('Performance partner', b.companyId, b.deptB);
    ({ id: coB } = await createCompany(a, { legalName: 'Other Plan Co' }));
    const deptB2 = await createDepartment(a, { companyId: coB, name: 'Other dept' });
    otherEmployee = await hire('Other company person', coB, deptB2.id);
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.tenantId, b.tenantId));
    for (const e of [subject, subject2]) await line(e, manager);
    await line(manager, skip);
    await line(hodReport, hod);

    self = await userCtx(subject.personId, 'employee');
    self2 = await userCtx(subject2.personId, 'employee');
    mgr = await userCtx(manager.personId, 'manager');
    skipCtx = await userCtx(skip.personId, 'manager');
    hodCtx = await userCtx(hod.personId, 'manager');
    approverCtx = await userCtx(approver.personId, 'employee');
    partner = await grantCtx('performance_partner', b.companyId, partnerPerson.personId);
    partnerOther = await grantCtx('performance_partner', coB, null);
    hrOther = await grantCtx('hr_admin', coB, null);

    ({ cycleId } = await perf.createCycle(a, { name: 'Plan scope cycle', companyId: b.companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }));
    await perf.configureOnehrCycle(a, cycleId, null, defaultPolicy(framework));
    await perf.openCycle(a, { cycleId });
    reviewId = await reviewOf(cycleId, subject);
    review2Id = await reviewOf(cycleId, subject2);

    // The subject's KPI line carries a matrix approver (a reviewer who is not the line manager).
    const kpiId = randomUUID();
    const rev = async (ctx: SessionContext) => (await perf.getOnehrReview(ctx, reviewId))!.revision;
    await perf.saveOnehrKpis(self, reviewId, await rev(self), [{ id: kpiId, title: 'Delivery', description: '', weightBp: 10000, unit: 'units', scoring: { mechanism: 'A', method: 'more', rates: [0, 50, 100, 150, 200] }, moderatorEmploymentId: manager.employmentId }]);
    await perf.assignAssessmentKpiModerator(a, reviewId, await rev(a), kpiId, approver.employmentId);

    await perf.saveOnehrPlan(self, reviewId, null, { career: career('Lead the regional team'), goals: [goal('Facilitation')] }, true);
    await perf.saveOnehrPlan(self2, review2Id, null, { career: career('Private draft aspiration'), goals: [goal('Negotiation')] });
    const plans = await owner.db.select().from(schema.onehrPlan).orderBy(asc(schema.onehrPlan.createdAt));
    sharedPlanId = plans.find((p) => p.employmentId === subject.employmentId)!.id;
    draftPlanId = plans.find((p) => p.employmentId === subject2.employmentId)!.id;
    expect(plans.find((p) => p.id === sharedPlanId)!.status).toBe('shared');
    expect(plans.find((p) => p.id === draftPlanId)!.status).toBe('draft');
  });
  afterAll(closeAll);

  it('fixture: the skip-level manager and the department head CAN see the subject (department tree), and are not plan reviewers', async () => {
    // Non-vacuity of the refusals below: both actors pass the old visibility arm for the subject.
    for (const ctx of [skipCtx, hodCtx]) {
      const [r] = await withTenant(ctx, (tx) => tx.execute<{ visible: boolean; reviewer: boolean }>(sql`
        select ${subject.employmentId}::uuid = any(app.visible_employment_ids()) as visible, app.assessment_plan_reviewer(${sharedPlanId}::uuid) as reviewer`));
      expect(r).toEqual({ visible: true, reviewer: false });
    }
    const [m] = await withTenant(mgr, (tx) => tx.execute<{ reviewer: boolean }>(sql`select app.assessment_plan_reviewer(${sharedPlanId}::uuid) as reviewer`));
    expect(m.reviewer).toBe(true);
    const [ap] = await withTenant(approverCtx, (tx) => tx.execute<{ visible: boolean; reviewer: boolean }>(sql`
      select ${subject.employmentId}::uuid = any(app.visible_employment_ids()) as visible, app.assessment_plan_reviewer(${sharedPlanId}::uuid) as reviewer`));
    expect(ap).toEqual({ visible: false, reviewer: true });
  });

  it('a department-tree non-reviewer reads nothing of a shared plan (TASK-030 acceptance)', async () => {
    expect(await plansAs(skipCtx), 'skip-level manager').toEqual([]);
    expect(await plansAs(hodCtx), 'head of department').toEqual([]);
  });

  it('a department-tree non-reviewer cannot update a shared plan', async () => {
    expect(await touch(skipCtx, sharedPlanId, 'Skip-level note'), 'skip-level update matches no row').toEqual([]);
    expect(await touch(hodCtx, sharedPlanId, 'HOD note'), 'HOD update matches no row').toEqual([]);
    const [row] = await owner.db.select({ conversation: schema.onehrPlan.conversation }).from(schema.onehrPlan).where(eq(schema.onehrPlan.id, sharedPlanId));
    expect(row.conversation).toBe('');
  });

  it('a department-tree non-reviewer cannot insert a plan for the subject', async () => {
    expect(await refusal(insertFor(skipCtx, subject, reviewId, 5))).toMatch(/row-level security/);
    expect(await refusal(insertFor(hodCtx, subject, reviewId, 6))).toMatch(/row-level security/);
  });

  it('the assigned reviewers (line manager, KPI approver) read the shared plan; the line manager can write it', async () => {
    const m = await plansAs(mgr);
    expect(m.map((p) => p.id)).toEqual([sharedPlanId]);
    expect((m[0].career as { aspiration: string }).aspiration).toBe('Lead the regional team');
    expect(await idsAs(approverCtx)).toEqual([sharedPlanId]);
    expect(await touch(mgr, sharedPlanId, 'Reviewer note')).toEqual([{ id: sharedPlanId }]);
  });

  it('the subject reads and writes their own plan; drafts stay with the subject and the administrator', async () => {
    expect(await idsAs(self)).toEqual([sharedPlanId]);
    expect(await idsAs(self2)).toEqual([draftPlanId]);
    expect(await touch(self2, draftPlanId, 'Own draft note')).toEqual([{ id: draftPlanId }]);
    // The reviewer of subject2 never reads subject2's draft.
    const [rv] = await withTenant(mgr, (tx) => tx.execute<{ reviewer: boolean }>(sql`select app.assessment_plan_reviewer(${draftPlanId}::uuid) as reviewer`));
    expect(rv.reviewer, 'non-vacuous: the manager IS the reviewer of the draft plan').toBe(true);
    expect(await idsAs(mgr)).not.toContain(draftPlanId);
    expect(await touch(mgr, draftPlanId, 'Reviewer on a draft')).toEqual([]);
    // The HR administrator reads both, drafts included.
    expect(await idsAs(a)).toEqual([sharedPlanId, draftPlanId].sort());
    // The subject may write a plan row of their own (the service decides which year; RLS only who).
    expect(await insertFor(self, subject, reviewId, 3, 'draft')).toHaveLength(1);
  });

  it('a performance partner in scope reads (and administers) plans; one for another company reads nothing', async () => {
    expect(await idsAs(partner)).toEqual([sharedPlanId, draftPlanId].sort());
    expect(await touch(partner, sharedPlanId, 'Partner note')).toEqual([{ id: sharedPlanId }]);
    expect(await idsAs(partnerOther)).toEqual([]);
    expect(await touch(partnerOther, sharedPlanId, 'Other partner')).toEqual([]);
    expect(await refusal(insertFor(partnerOther, subject, reviewId, 7))).toMatch(/row-level security/);    // The partner's administration screens now count shared plans exactly as HR's do.
    const idp = async (ctx: SessionContext) => (await perf.getAssessmentOverview(ctx, cycleId)).overview!.rows.map((r) => r.cells.idp);
    const hrIdp = await idp(a);
    expect(hrIdp.some((c) => c.done > 0), 'non-vacuous: HR counts the shared plan').toBe(true);
    expect(await idp(partner)).toEqual(hrIdp);
  });

  it('a performance partner reads no plan of a cycle it does not administer (group-wide cycle, company-scoped grant)', async () => {
    const { cycleId: groupCycle } = await perf.createCycle(a, { name: 'Group plan cycle', companyId: null, periodStart: `${year - 1}-01-01`, periodEnd: `${year - 1}-12-31` });
    await perf.configureOnehrCycle(a, groupCycle, null, defaultPolicy(framework));
    await perf.openCycle(a, { cycleId: groupCycle });
    const groupReview = await reviewOf(groupCycle, subject);
    await perf.saveOnehrPlan(self, groupReview, null, { career: career('Lead the regional team'), goals: [goal('Coaching')] }, true);
    const [groupPlan] = await owner.db.select().from(schema.onehrPlan).where(and(eq(schema.onehrPlan.employmentId, subject.employmentId), eq(schema.onehrPlan.planYear, year)));
    expect(groupPlan.reviewId).toBe(groupReview);
    // Non-vacuous: the tenant-wide HR administrator and the line manager (reviewer in both cycles) read it.
    expect(await idsAs(a)).toContain(groupPlan.id);
    expect(await idsAs(mgr)).toContain(groupPlan.id);
    const ids = await idsAs(partner);
    expect(ids).toContain(sharedPlanId);
    expect(ids).not.toContain(groupPlan.id);
  });

  it('cross-company and cross-tenant actors read nothing', async () => {
    expect(await idsAs(hrOther), 'HR administrator of another company').toEqual([]);
    expect(await refusal(insertFor(hrOther, subject, reviewId, 8))).toMatch(/row-level security/);
    const other = await seedBase();
    expect(await plansAs(adminCtx(other)), 'administrator of another tenant').toEqual([]);
    expect(await plansAs({ ...mgr, tenantId: other.tenantId }), 'the reviewer under another tenant context').toEqual([]);
    expect(otherEmployee.employmentId).toBeTruthy();
  });

  it('HR administrator: progress and overview IDP figures are unchanged by 0640', async () => {
    const progress = await perf.getAssessmentProgress(a, cycleId, { module: 'career' });
    const idpCells = Object.fromEntries(progress.rows.map((r) => [r.name, r.cells.career?.state ?? null]));
    const overview = (await perf.getAssessmentOverview(a, cycleId)).overview!;
    const overviewIdp = overview.rows.map(({ cells: { idp: { href: _href, ...cell } } }) => cell); // href carries the per-run cycle id
    // Values recorded on the pre-0640 schema (alpha 9541b1686) with this exact fixture; see the test's report.
    expect({ counts: progress.counts.career, idpCells, overviewIdp }).toMatchInlineSnapshot(`
      {
        "counts": {
          "active": 1,
          "done": 0,
          "pending": 7,
        },
        "idpCells": {
          "Department head": "pending",
          "Department head report": "pending",
          "Draft subject": "pending",
          "KPI approver": "pending",
          "Line manager": "pending",
          "Performance partner": "pending",
          "Plan subject": "active",
          "Skip-level manager": "pending",
        },
        "overviewIdp": [
          {
            "done": 1,
            "opens": null,
            "pct": 12,
            "state": "open",
            "total": 8,
          },
        ],
      }
    `);
  });

  it('removing the line manager from the cycle keeps them the plan reviewer, as in OneHR (per-person removal never moves review up)', async () => {
    // OneHR moves review one level up only when the manager's UNIT or DEPARTMENT is left out by the cycle's
    // exclusion rule (_cycle_review_managers, app.py:15495, reads unit_out only). Removing one person
    // (cycle_participants mode 'remove') touches only that person's own participation (app.py:7429, :7481), so
    // the removed manager still reviews and the skip-level manager gains nothing. AI-HR's only exclusion is per
    // person, so this is a match, not a divergence. AI-HR has no unit/department exclusion rule (ADR-0141, D-P1-22).
    const view = (await perf.getOnehrCycle(a, cycleId))!;
    const lm = view.participants.find((p) => p.employmentId === manager.employmentId)!;
    await perf.setAssessmentParticipation(a, cycleId, view.revision, manager.employmentId, lm.revision, 'remove');
    expect((await perf.getOnehrCycle(a, cycleId))!.participants.find((p) => p.employmentId === manager.employmentId)).toMatchObject({ takingPart: false });
    const reviewerAs = async (ctx: SessionContext) =>
      (await withTenant(ctx, (tx) => tx.execute<{ reviewer: boolean }>(sql`select app.assessment_plan_reviewer(${sharedPlanId}::uuid) as reviewer`)))[0].reviewer;
    expect(await reviewerAs(mgr), 'the left-out line manager stays the reviewer').toBe(true);
    expect(await reviewerAs(skipCtx), 'the skip-level manager does not become the reviewer (OneHR: same)').toBe(false);
    expect(await idsAs(mgr)).toEqual([sharedPlanId]);
    expect(await idsAs(skipCtx)).toEqual([]);
  });
});
