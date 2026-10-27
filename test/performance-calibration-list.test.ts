/**
 * WP-B1 (APR-020) — listMyCalibrationSessions / hasCalibrationAssignment against real RLS as ai_hr_app.
 *
 * The service re-implements no authority: what a viewer sees is what performance_onehr_calibration RLS and
 * app.onehr_calibration_access admit. These cases pin the persona boundaries the Calibration destination
 * promises — HOD only their HOD session, BU CEO only theirs, nobody else's company, final tier for cycle
 * administrators only, and a performance partner only in-scope cycles.
 *
 * Sessions are written directly as the HR administrator (the creation service's year-end / ratings
 * preconditions are not what is under test here); every READ is the persona's app-role session via the service.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee } from '../core/org';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const year = Number(todayInKualaLumpur().slice(0, 4));
type Hired = { employmentId: string; personId: string };

describe('Calibration destination: sessions the viewer may enter (real RLS)', () => {
  let b: Base, a: SessionContext, coB: string;
  let hod: SessionContext, bu: SessionContext, outsider: SessionContext, reviewerB: SessionContext, finalNamed: SessionContext, partner: SessionContext;
  let hodPerson: Hired, subjects: Hired[], subjectB: Hired;
  let cycleA: string, cycleB: string;
  let hodSession: string, buSession: string, finalSession: string, buSessionB: string;

  const hire = (name: string, companyId: string, departmentId: string) =>
    hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@calibration.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
  async function userCtx(personId: string, role: 'employee' | 'manager'): Promise<SessionContext> {
    const userId = await createAppUser(b.tenantId, personId, role);
    return { tenantId: b.tenantId, userId, personId, roles: [role], grants: [{ role, companyId: null }], entitlements: a.entitlements };
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
  async function session(cycleId: string, companyId: string | null, tier: 'hod' | 'bu' | 'bg' | 'group' | 'final', name: string, reviewers: string[], people: Hired[]) {
    // Written as the HR administrator through the app role: the calibration authority trigger
    // (app.assessment_final_authority) requires a cycle administrator as the current user.
    const reviewIds = await Promise.all(people.map((p) => reviewOf(cycleId, p)));
    return withTenant(a, async (tx) => {
      const [s] = await tx.insert(schema.onehrCalibration).values({ tenantId: b.tenantId, cycleId, companyId, name, tier, reviewerUserIds: reviewers }).returning();
      for (let i = 0; i < people.length; i++) await tx.insert(schema.onehrCalibrationEntry).values({ tenantId: b.tenantId, sessionId: s.id, reviewId: reviewIds[i], employmentId: people[i].employmentId });
      return s.id;
    });
  }
  const names = async (ctx: SessionContext) => (await perf.listMyCalibrationSessions(ctx)).map((s) => s.name).sort();

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    await setModule(b.tenantId, 'performance', 'active');
    a = await entitledCtx(b);
    hodPerson = await hire('Head of department', b.companyId, b.deptA);
    const buPerson = await hire('BU chief', b.companyId, b.deptA);
    const outsiderPerson = await hire('Plain employee', b.companyId, b.deptA);
    const finalPerson = await hire('Named on final only', b.companyId, b.deptA);
    const partnerPerson = await hire('Performance partner', b.companyId, b.deptB);
    subjects = [await hire('Subject one', b.companyId, b.deptA), await hire('Subject two', b.companyId, b.deptA)];
    ({ id: coB } = await createCompany(a, { legalName: 'Other Company Sdn Bhd' }));
    const deptB = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    subjectB = await hire('Company B subject', coB, deptB.id);
    const reviewerBPerson = await hire('Company B reviewer', coB, deptB.id);
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.tenantId, b.tenantId));
    cycleA = await onehrCycle('Company A annual', b.companyId);
    cycleB = await onehrCycle('Company B annual', coB);

    hod = await userCtx(hodPerson.personId, 'manager');
    bu = await userCtx(buPerson.personId, 'manager');
    outsider = await userCtx(outsiderPerson.personId, 'employee');
    finalNamed = await userCtx(finalPerson.personId, 'manager');
    reviewerB = await userCtx(reviewerBPerson.personId, 'manager');
    const [pu] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: partnerPerson.personId }).returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: pu.id, companyId: b.companyId, role: 'performance_partner' });
    partner = { tenantId: b.tenantId, userId: pu.id, personId: partnerPerson.personId, roles: ['performance_partner'], grants: [{ role: 'performance_partner', companyId: b.companyId }], entitlements: a.entitlements };

    // The HOD's own review sits in their department cohort: it must never count as one of "their" people.
    hodSession = await session(cycleA, b.companyId, 'hod', 'A department', [hod.userId!], [...subjects, hodPerson]);
    buSession = await session(cycleA, b.companyId, 'bu', 'A business unit', [bu.userId!], subjects);
    finalSession = await session(cycleA, b.companyId, 'final', 'A final override', [finalNamed.userId!, hod.userId!], subjects);
    buSessionB = await session(cycleB, coB, 'bu', 'B business unit', [reviewerB.userId!], [subjectB]);
  });
  afterAll(closeAll);

  it('a HOD reviewer sees only their HOD session, and never their own entry among its people', async () => {
    const rows = await perf.listMyCalibrationSessions(hod);
    expect(rows.map((r) => r.id)).toEqual([hodSession]);
    expect(rows[0]).toMatchObject({ tier: 'hod', cycleName: 'Company A annual', companyName: 'Acme Sdn Bhd', people: 2, toDo: 2, lock: 'open', window: 'open', href: `/performance/assessment/calibration/${hodSession}` });
    expect(await perf.hasCalibrationAssignment(hod)).toBe(true);
  });

  it('a BU CEO reviewer sees only the BU session', async () => {
    expect((await perf.listMyCalibrationSessions(bu)).map((r) => r.id)).toEqual([buSession]);
    expect(await perf.hasCalibrationAssignment(bu)).toBe(true);
  });

  it('an employee named on no session sees none and gets no sidebar row', async () => {
    expect(await perf.listMyCalibrationSessions(outsider)).toEqual([]);
    expect(await perf.hasCalibrationAssignment(outsider)).toBe(false);
  });

  it('a company-B reviewer sees nothing of company A', async () => {
    const rows = await perf.listMyCalibrationSessions(reviewerB);
    expect(rows.map((r) => r.id)).toEqual([buSessionB]);
    expect(rows.every((r) => r.cycleId === cycleB)).toBe(true);
  });

  it('the final tier is for cycle administrators only, whoever reviewer_user_ids names', async () => {
    expect(await perf.listMyCalibrationSessions(finalNamed)).toEqual([]);
    expect(await perf.hasCalibrationAssignment(finalNamed)).toBe(false);
    expect((await perf.listMyCalibrationSessions(hod)).map((r) => r.id)).not.toContain(finalSession);
    expect(await names(a)).toEqual(['A business unit', 'A department', 'A final override', 'B business unit']);
  });

  it('a company-scoped performance partner sees only in-scope cycles, final tier included', async () => {
    expect(await names(partner)).toEqual(['A business unit', 'A department', 'A final override']);
    // Not a named reviewer anywhere: the sidebar row comes from canAdministerOnehr, not this query.
    expect(await perf.hasCalibrationAssignment(partner)).toBe(false);
  });

  it('reports lock and window state from the session and cycle policy, and to-do drops when a part is locked', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString(), future = new Date(Date.now() + 86_400_000).toISOString();
    const [cfg] = await owner.db.select().from(schema.onehrCycle).where(eq(schema.onehrCycle.cycleId, cycleA));
    await owner.db.update(schema.onehrCycle).set({ policy: { ...(cfg.policy as object), windows: { pm_hod: { opensAt: null, closesAt: past }, pot_hod: { opensAt: null, closesAt: past }, pm_buceo: { opensAt: future, closesAt: null }, pot_buceo: { opensAt: future, closesAt: null } } } }).where(eq(schema.onehrCycle.cycleId, cycleA));
    await owner.db.update(schema.onehrCalibration).set({ performanceLockedAt: new Date(), potentialLockedAt: new Date() }).where(eq(schema.onehrCalibration.id, hodSession));
    const [h] = await perf.listMyCalibrationSessions(hod);
    expect(h).toMatchObject({ window: 'closed', lock: 'partial', toDo: 0, people: 2, closesOn: todayInKualaLumpur(new Date(past)) });
    const [u] = await perf.listMyCalibrationSessions(bu);
    expect(u).toMatchObject({ window: 'upcoming', opensOn: todayInKualaLumpur(new Date(future)) });
  });

  it('refuses when the tenant does not have the performance module', async () => {
    await setModule(b.tenantId, 'performance', 'disabled');
    const off = { ...hod, entitlements: (await entitledCtx(b)).entitlements };
    await expect(perf.listMyCalibrationSessions(off)).rejects.toThrow();
    expect(await perf.hasCalibrationAssignment(off)).toBe(false);
  });
});
