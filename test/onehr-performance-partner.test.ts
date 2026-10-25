/**
 * ADR-0141 — the OneHR performance partner: performance administration WITHOUT compensation.
 *
 * Verification contract (ADR-0141 "Verification contract"), exercised against real RLS as the app role:
 *   positive    — a company-scoped partner administers a OneHR-native cycle in its company;
 *   negative    — no compensation, no generic cycle / merit / pending pay, no payroll / HR authority, no
 *                 person columns beyond self, no other company, no review_cycle or performance_review
 *                 write (the trigger refuses while the row lock still succeeds), no cycle create/open/close,
 *                 no conversion of a generic cycle, and a revoked grant stops at the next request;
 *   equivalence — HR administrators read the same labels through app.onehr_person_labels as from person.
 *
 * Fixture style follows test/onehr-service.test.ts (OneHR cycle) and test/partner-roles.test.ts (a grant
 * written as the owner, then a hand-built SessionContext carrying exactly that grant).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { assignRole, createCompany, createDepartment, revokeRole } from '../core/admin';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { canAdminOnehr, canManagePayroll, canManagePerfComp, isAdmin, isOnehrOnlyPerformanceAdmin } from '../lib/authz-model';
import { closeAll, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const year = Number(todayInKualaLumpur().slice(0, 4));
type Hired = { employmentId: string; personId: string };

/**
 * The refusal's own text, walking drizzle's `cause` chain (drizzle reports "Failed query: …" and keeps the
 * Postgres message on the cause). Asserting on it is what keeps a refusal test from passing on an unrelated
 * error — a NOT NULL violation would satisfy a bare `rejects.toThrow()`.
 */
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

describe('OneHR performance partner (ADR-0141)', () => {
  let b: Base, a: SessionContext;
  let subject: Hired, manager: Hired, peers: Hired[], partnerPerson: Hired, otherEmployee: Hired;
  let coB: string, onehrCycleId: string, genericCycleId: string, genericDraftId: string, otherCycleId: string, reviewId: string;
  let partner: SessionContext;

  async function partnerCtx(companyId: string | null, personId: string | null): Promise<SessionContext> {
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId })
      .returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'performance_partner' });
    return { tenantId: b.tenantId, userId: u.id, personId, roles: ['performance_partner'], grants: [{ role: 'performance_partner', companyId }], entitlements: a.entitlements };
  }
  const hire = (name: string, companyId: string, departmentId: string) =>
    hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@partner.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
  async function onehrCycle(name: string, companyId: string) {
    const { cycleId } = await perf.createCycle(a, { name, companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` });
    await perf.configureOnehrCycle(a, cycleId, null, defaultPolicy(framework));
    await perf.openCycle(a, { cycleId });
    return cycleId;
  }
  const revisionOf = async (id: string) => (await perf.getOnehrReview(a, id))!.revision;

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    await setModule(b.tenantId, 'performance', 'active');
    a = await entitledCtx(b);
    subject = await hire('Partner subject', b.companyId, b.deptA);
    manager = await hire('Partner manager', b.companyId, b.deptA);
    peers = [await hire('Partner peer 0', b.companyId, b.deptA), await hire('Partner peer 1', b.companyId, b.deptA)];
    partnerPerson = await hire('Partner herself', b.companyId, b.deptB);
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    for (const e of [subject, manager, ...peers]) await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.id, e.employmentId));
    for (const e of [subject, ...peers]) await setReportingLine(a, { subordinateEmploymentId: e.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
    await setCompensation(a, { employmentId: subject.employmentId, basicSalary: 7777, effectiveFrom: `${year - 2}-01-01` });

    ({ id: coB } = await createCompany(a, { legalName: 'Other Partner Co' }));
    const deptB = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    otherEmployee = await hire('Other company person', coB, deptB.id);

    onehrCycleId = await onehrCycle('Partner OneHR cycle', b.companyId);
    otherCycleId = await onehrCycle('Other company OneHR cycle', coB);
    ({ cycleId: genericCycleId } = await perf.createCycle(a, { name: 'Generic merit cycle', companyId: b.companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }));
    await perf.openCycle(a, { cycleId: genericCycleId });
    ({ cycleId: genericDraftId } = await perf.createCycle(a, { name: 'Generic draft cycle', companyId: b.companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }));

    const [r] = await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, onehrCycleId), eq(schema.performanceReview.employmentId, subject.employmentId)));
    expect(r, 'the OneHR cycle opened a review for the subject').toBeDefined();
    reviewId = r.id;
    partner = await partnerCtx(b.companyId, partnerPerson.personId);
  });
  afterAll(closeAll);

  // ───────────────────────────── TS gates (UX mirror) ─────────────────────────────
  it('is a OneHR administrator only: never admin, perf-comp, payroll, nor scoped to another company', () => {
    expect(canAdminOnehr(partner, b.companyId)).toBe(true);
    expect(canAdminOnehr(partner, coB)).toBe(false);
    expect(isOnehrOnlyPerformanceAdmin(partner)).toBe(true);
    expect(isAdmin(partner)).toBe(false);
    expect(canManagePerfComp(partner)).toBe(false);
    expect(canManagePayroll(partner)).toBe(false);
    // The union rule: an HR administrator who also holds the role is never narrowed.
    const both: SessionContext = { ...a, roles: ['hr_admin', 'performance_partner'], grants: [{ role: 'hr_admin', companyId: null }, { role: 'performance_partner', companyId: b.companyId }] };
    expect(isOnehrOnlyPerformanceAdmin(both)).toBe(false);
  });

  it('holds no HR, perf-comp or payroll authority in the database either', async () => {
    const q = (ctx: SessionContext) =>
      withTenant(ctx, (tx) => tx.execute<{ admin: boolean; perfcomp: boolean; payroll: boolean; onehr: boolean; partner: boolean }>(sql`
        select app.is_admin() as admin, app.can_admin_perfcomp_for(${b.companyId}::uuid) as perfcomp,
               app.can_admin_payroll_for(${b.companyId}::uuid) as payroll, app.onehr_admin(${b.companyId}::uuid) as onehr,
               app.onehr_partner_for(${b.companyId}::uuid) as partner`));
    // Non-vacuous: the same predicates are TRUE for HR, so a FALSE below is a refusal, not a broken query.
    expect((await q(a))[0]).toMatchObject({ admin: true, perfcomp: true, payroll: true, onehr: true, partner: false });
    expect((await q(partner))[0]).toEqual({ admin: false, perfcomp: false, payroll: false, onehr: true, partner: true });
  });

  // ───────────────────────────── positive ─────────────────────────────
  it('administers its company OneHR cycle: cycle, participants, overview, progress, reports and panels', async () => {
    const view = await perf.getOnehrCycle(partner, onehrCycleId);
    expect(view, 'a OneHR-native cycle in scope').not.toBeNull();
    expect(view!.reviews.length).toBeGreaterThan(0);
    expect(view!.reviews.map((r) => r.name)).toContain('Partner subject');
    expect(view!.participants.length).toBeGreaterThan(0);
    expect(view!.participants.map((p) => p.name)).toContain('Partner subject');

    const overview = await perf.getAssessmentOverview(partner, onehrCycleId);
    expect(overview.overview!.rows.length).toBeGreaterThan(0);

    const progress = await perf.getAssessmentProgress(partner, onehrCycleId);
    expect(progress.rows.length).toBeGreaterThan(0);
    expect(progress.rows.map((r) => r.name)).toContain('Partner subject');

    const report = await perf.getAssessmentAdminReport(partner, onehrCycleId, { kind: 'participants', groupBy: 'person' });
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows.some((r) => r.includes('Partner subject'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain('7777');

    await perf.assignOnehrPanel(partner, reviewId, await revisionOf(reviewId), [
      { employmentId: manager.employmentId, relationship: 'line_manager' },
      { employmentId: peers[0].employmentId, relationship: 'peer' },
    ]);
    const panel = await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.reviewId, reviewId));
    expect(panel).toHaveLength(2);
    const requests = await owner.db.select().from(schema.peerFeedbackRequest).where(eq(schema.peerFeedbackRequest.reviewId, reviewId));
    expect(requests.map((r) => r.subjectName)).toEqual(['Partner subject', 'Partner subject']);
    expect(requests.every((r) => r.requestedByUserId === partner.userId)).toBe(true);

    const assessors = await perf.getAssessmentAssessorProgress(partner, onehrCycleId);
    expect(assessors.map((p) => p.name).sort()).toEqual(['Partner manager', 'Partner peer 0']);
    // Labels only: the person row's email is not part of the projection the partner reads.
    expect(assessors.every((p) => p.email === null)).toBe(true);

    const records = await perf.getAssessmentRatingRecords(partner, onehrCycleId);
    expect(records.cycle).toBeDefined();
  });

  it('lists OneHR-native cycles in scope only, and never a generic one', async () => {
    const cycles = await perf.listOnehrAdminCycles(partner);
    expect(cycles.map((c) => c.id)).toEqual([onehrCycleId]);
    expect(Object.keys(cycles[0])).not.toContain('pendingComp');
    expect(await perf.isOnehrAdminCycle(partner, onehrCycleId)).toBe(true);
    expect(await perf.isOnehrAdminCycle(partner, genericCycleId)).toBe(false);
    expect(await perf.isOnehrAdminCycle(partner, otherCycleId)).toBe(false);
    // HR still lists both OneHR cycles (non-vacuous: the filter is the partner's scope, not an empty query).
    expect((await perf.listOnehrAdminCycles(a)).map((c) => c.id).sort()).toEqual([onehrCycleId, otherCycleId].sort());
  });

  // ───────────────────────────── negative ─────────────────────────────
  it('reads zero compensation rows and cannot write compensation', async () => {
    const read = (ctx: SessionContext) =>
      withTenant(ctx, (tx) => tx.select().from(schema.compensation).where(eq(schema.compensation.employmentId, subject.employmentId)));
    expect((await read(a)).length).toBeGreaterThan(0);
    expect(await read(partner)).toEqual([]);
    expect(await refusal(setCompensation(partner, { employmentId: subject.employmentId, basicSalary: 9999, effectiveFrom: `${year}-01-01` }))).not.toBe('');
    const after = await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId, subject.employmentId));
    expect(after.some((c) => Number(c.basicSalary) === 9999)).toBe(false);
  });

  it('sees no generic-cycle review, roster or merit, and cannot run generic lifecycle', async () => {
    const reviews = (ctx: SessionContext, cycleId: string) =>
      withTenant(ctx, (tx) => tx.select().from(schema.performanceReview).where(eq(schema.performanceReview.cycleId, cycleId)));
    expect((await reviews(a, genericCycleId)).length).toBeGreaterThan(0);
    expect(await reviews(partner, genericCycleId)).toEqual([]);
    expect((await reviews(partner, onehrCycleId)).length).toBeGreaterThan(0);
    const detail = await perf.cycleDetail(partner, genericCycleId);
    expect(detail?.roster ?? []).toEqual([]);
    expect(await perf.getOnehrCycle(partner, genericCycleId)).toBeNull();

    expect(await refusal(perf.createCycle(partner, { name: 'Partner-made cycle', companyId: b.companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }))).toMatch(/can create a review cycle/);
    expect(await refusal(perf.openCycle(partner, { cycleId: genericDraftId }))).toMatch(/can open a review cycle|not found/i);
    expect(await refusal(perf.closeCycle(partner, { cycleId: onehrCycleId }))).toMatch(/can change a cycle status|not found/i);
    // Merit / pay recommendation actions on a generic review: invisible to the partner, never enacted.
    const [generic] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.cycleId, genericCycleId));
    expect(generic, 'the generic cycle opened at least one review').toBeDefined();
    expect(await refusal(perf.enactCompAction(partner, { reviewId: generic.id }))).toMatch(/not found|not visible|Only an admin/i);
    expect(await refusal(perf.declineCompAction(partner, { reviewId: generic.id }))).toMatch(/not found|not visible|Only an admin/i);
    const [cycle] = await owner.db.select().from(schema.reviewCycle).where(eq(schema.reviewCycle.id, onehrCycleId));
    expect(cycle.status).toBe('open');
  });

  it('cannot turn a generic draft cycle into a OneHR cycle', async () => {
    expect(await refusal(perf.configureOnehrCycle(partner, genericDraftId, null, defaultPolicy(framework)))).toMatch(/Cycle not found/);
    expect(
      await refusal(withTenant(partner, (tx) => tx.insert(schema.onehrCycle).values({ cycleId: genericDraftId, tenantId: b.tenantId, policy: defaultPolicy(framework) }))),
    ).toMatch(/row-level security/);
    expect(await owner.db.select().from(schema.onehrCycle).where(eq(schema.onehrCycle.cycleId, genericDraftId))).toEqual([]);
  });

  it('locks a OneHR cycle row FOR UPDATE but the trigger refuses any change to it', async () => {
    const locked = await withTenant(partner, (tx) => tx.select().from(schema.reviewCycle).where(eq(schema.reviewCycle.id, onehrCycleId)).for('update'));
    expect(locked.map((c) => c.id)).toEqual([onehrCycleId]);
    // A generic cycle is not even lockable for this role.
    expect(await withTenant(partner, (tx) => tx.select().from(schema.reviewCycle).where(eq(schema.reviewCycle.id, genericCycleId)).for('update'))).toEqual([]);
    expect(
      await refusal(withTenant(partner, (tx) => tx.update(schema.reviewCycle).set({ name: 'Renamed by partner' }).where(eq(schema.reviewCycle.id, onehrCycleId)))),
    ).toMatch(/a performance partner administers OneHR assessments but cannot change the review cycle/);
    const [cycle] = await owner.db.select().from(schema.reviewCycle).where(eq(schema.reviewCycle.id, onehrCycleId));
    expect(cycle.name).toBe('Partner OneHR cycle');
    // HR still writes the same row: the trigger only refuses partner-only authority.
    await withTenant(a, (tx) => tx.update(schema.reviewCycle).set({ name: 'Renamed by HR' }).where(eq(schema.reviewCycle.id, onehrCycleId)));
    const [renamed] = await owner.db.select().from(schema.reviewCycle).where(eq(schema.reviewCycle.id, onehrCycleId));
    expect(renamed.name).toBe('Renamed by HR');
  });

  it('cannot write performance_review, and the OneHR writers that need it refuse loudly', async () => {
    const changed = await withTenant(partner, (tx) =>
      tx.update(schema.performanceReview).set({ reviewerEmploymentId: peers[1].employmentId }).where(eq(schema.performanceReview.id, reviewId)).returning({ id: schema.performanceReview.id }),
    );
    expect(changed).toEqual([]);
    // The manager passes every earlier reassignment guard (a real administrative manager, active, not the
    // subject), so what refuses here is the kernel review write itself, surfaced instead of a 0-row update.
    const before = await revisionOf(reviewId);
    expect(await refusal(perf.reassignOnehrReviewer(partner, reviewId, before, manager.employmentId))).toMatch(/Only an HR administrator can reassign the reviewer/);
    expect(await revisionOf(reviewId)).toBe(before);
    const [row] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, reviewId));
    expect(row.reviewerEmploymentId).toBe(manager.employmentId);
    expect(
      await refusal(withTenant(partner, (tx) => tx.insert(schema.performanceReview).values({ tenantId: b.tenantId, cycleId: onehrCycleId, employmentId: peers[1].employmentId, reviewerEmploymentId: manager.employmentId, status: 'self_review' }))),
    ).toMatch(/row-level security/);
  });

  it('reads person only for itself; other people arrive as labels, never as person columns', async () => {
    const people = await withTenant(partner, (tx) => tx.select().from(schema.person));
    expect(people.map((p) => p.id)).toEqual([partnerPerson.personId]);
    const hrPeople = await withTenant(a, (tx) => tx.select().from(schema.person));
    expect(hrPeople.length).toBeGreaterThan(1);

    const labels = (await withTenant(partner, (tx) =>
      tx.execute(sql`select * from app.onehr_person_labels(array[${subject.employmentId}::uuid,${otherEmployee.employmentId}::uuid])`),
    )) as unknown as Record<string, unknown>[];
    expect(labels).toHaveLength(1);
    expect(Object.keys(labels[0]).sort()).toEqual(['employee_code', 'employment_id', 'full_name', 'person_id', 'preferred_name']);
    expect(labels[0]).toMatchObject({ employment_id: subject.employmentId, full_name: 'Partner subject' });
  });

  it('reaches nothing in another company', async () => {
    expect(await refusal(perf.getOnehrCycle(partner, otherCycleId))).toMatch(/Performance administrator access is required/);
    const employments = await withTenant(partner, (tx) => tx.select().from(schema.employment).where(eq(schema.employment.companyId, coB)));
    expect(employments).toEqual([]);
    const hrEmployments = await withTenant(a, (tx) => tx.select().from(schema.employment).where(eq(schema.employment.companyId, coB)));
    expect(hrEmployments.length).toBeGreaterThan(0);
    const own = await withTenant(partner, (tx) => tx.select().from(schema.employment).where(eq(schema.employment.companyId, b.companyId)));
    expect(own.length).toBeGreaterThan(0);
  });

  it('stops at the next request once the grant is revoked, even with a stale session', async () => {
    expect(await perf.getOnehrCycle(partner, onehrCycleId)).not.toBeNull();
    const [grant] = await owner.db.select().from(schema.roleAssignment).where(and(eq(schema.roleAssignment.appUserId, partner.userId!), eq(schema.roleAssignment.role, 'performance_partner')));
    await revokeRole(a, { roleAssignmentId: grant.id });
    expect(await owner.db.select().from(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, partner.userId!))).toEqual([]);
    // `partner` still CLAIMS the grant: the DB reads live role_assignment, so the claim confers nothing.
    expect(await refusal(perf.getOnehrCycle(partner, onehrCycleId))).toMatch(/Performance administrator access is required/);
    expect(await withTenant(partner, (tx) => tx.select().from(schema.employment).where(eq(schema.employment.id, subject.employmentId)))).toEqual([]);
  });

  it('is assignable company-scoped by a group administrator', async () => {
    const [u] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null }).returning({ id: schema.appUser.id });
    await assignRole(a, { appUserId: u.id, role: 'performance_partner', companyId: b.companyId });
    const rows = await owner.db.select().from(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, u.id));
    expect(rows.map((r) => [r.role, r.companyId])).toEqual([['performance_partner', b.companyId]]);
  });

  // ───────────────────────────── equivalence ─────────────────────────────
  it('gives HR administrators exactly the labels the person join gave them', async () => {
    const reviews = await owner.db
      .select({ employmentId: schema.onehrReview.employmentId, name: schema.person.fullName, code: schema.employment.employeeCode })
      .from(schema.onehrReview)
      .innerJoin(schema.employment, eq(schema.employment.id, schema.onehrReview.employmentId))
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .where(eq(schema.onehrReview.cycleId, onehrCycleId))
      .orderBy(schema.onehrReview.employmentId);
    expect(reviews.length).toBeGreaterThan(1);
    const labels = (await withTenant(a, (tx) =>
      tx.execute(sql`select employment_id, full_name, employee_code from app.onehr_person_labels(${sql.raw(`array[${reviews.map((r) => `'${r.employmentId}'::uuid`).join(',')}]`)}) order by employment_id`),
    )) as unknown as { employment_id: string; full_name: string; employee_code: string | null }[];
    expect(labels.map((l) => [l.employment_id, l.full_name, l.employee_code])).toEqual(reviews.map((r) => [r.employmentId, r.name, r.code]));

    // Through the services: HR's cycle view names the same people the owner join does.
    const hrView = await perf.getOnehrCycle(a, onehrCycleId);
    expect(hrView!.reviews.map((r) => r.name).sort()).toEqual(reviews.map((r) => r.name).sort());
    const partnerView = await perf.getOnehrCycle(partner, onehrCycleId);
    expect(partnerView!.reviews.map((r) => r.name).sort()).toEqual(hrView!.reviews.map((r) => r.name).sort());
    const ids = hrView!.participants.map((p) => p.employmentId);
    expect(ids.length).toBeGreaterThan(0);
    const owned = await owner.db.select({ id: schema.employment.id, name: schema.person.fullName }).from(schema.employment)
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId)).where(inArray(schema.employment.id, ids));
    const byId = new Map(owned.map((o) => [o.id, o.name]));
    expect(hrView!.participants.every((p) => p.name === byId.get(p.employmentId))).toBe(true);
  });
});
