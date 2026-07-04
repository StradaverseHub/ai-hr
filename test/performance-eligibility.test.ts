/**
 * Performance Review Cycle — Employee Eligibility Rules Engine.
 *
 * Two layers:
 *  1. Pure unit tests for evaluateEligibility (the five predicates individually, AND-combination,
 *     empty-rules, and the explicit null-handling / service-decision edges).
 *  2. Integration tests (real Tx, owner-role seeding like performance-lifecycle) for createCycle +
 *     openCycle: intern exclusion (the ticket's worked example), null/duplicate assignment guards,
 *     terminatedOn authority, cross-company-scope rejection, concurrent employment, previewEligibleCount
 *     ↔ openCycle parity, and the review-cycle.created domain-event payload/actor shape.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  createCycle,
  evaluateEligibility,
  normalizeEligibilityRules,
  openCycle,
  PerfError,
  previewEligibleCount,
  serviceMonths,
  type EligibilityCandidate,
  type EligibilityRules,
} from '../core/performance';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const AS_OF = '2026-07-01';

// A candidate builder with sane active-full-time defaults; override per test.
const cand = (o: Partial<EligibilityCandidate> = {}): EligibilityCandidate => ({
  hiredOn: '2026-01-01',
  status: 'active',
  employmentType: 'full_time',
  companyId: 'co-1',
  ...o,
});

describe('evaluateEligibility (pure)', () => {
  it('empty rules ⇒ always eligible', () => {
    expect(evaluateEligibility(cand(), null, AS_OF).eligible).toBe(true);
    expect(evaluateEligibility(cand(), {}, AS_OF).eligible).toBe(true);
  });

  it('status predicate: in-set passes, out-of-set fails with reason', () => {
    const rules: EligibilityRules = { statuses: ['active', 'on_leave'] };
    expect(evaluateEligibility(cand({ status: 'active' }), rules, AS_OF).eligible).toBe(true);
    const bad = evaluateEligibility(cand({ status: 'probation' }), rules, AS_OF);
    expect(bad.eligible).toBe(false);
    expect(bad.reasons).toContain('status');
  });

  it('employmentType predicate: excludes interns (worked example)', () => {
    const rules: EligibilityRules = { employmentTypes: ['full_time', 'part_time', 'contract'] };
    expect(evaluateEligibility(cand({ employmentType: 'full_time' }), rules, AS_OF).eligible).toBe(true);
    const intern = evaluateEligibility(cand({ employmentType: 'intern' }), rules, AS_OF);
    expect(intern.eligible).toBe(false);
    expect(intern.reasons).toContain('employmentType');
  });

  it('companyIds predicate: match vs mismatch', () => {
    const rules: EligibilityRules = { companyIds: ['co-A', 'co-B'] };
    expect(evaluateEligibility(cand({ companyId: 'co-A' }), rules, AS_OF).eligible).toBe(true);
    expect(evaluateEligibility(cand({ companyId: 'co-Z' }), rules, AS_OF).eligible).toBe(false);
  });

  it('minServiceMonths boundary: exactly N passes, N-1 fails', () => {
    // hired 2026-01-01, asOf 2026-07-01 = exactly 6 whole months.
    expect(evaluateEligibility(cand({ hiredOn: '2026-01-01' }), { minServiceMonths: 6 }, AS_OF).eligible).toBe(true);
    expect(evaluateEligibility(cand({ hiredOn: '2026-01-02' }), { minServiceMonths: 6 }, AS_OF).eligible).toBe(false);
    expect(evaluateEligibility(cand({ hiredOn: '2026-02-01' }), { minServiceMonths: 6 }, AS_OF).eligible).toBe(false);
  });

  it('hiredBefore boundary: on the cutoff passes, after fails', () => {
    const rules: EligibilityRules = { hiredBefore: '2026-06-30' };
    expect(evaluateEligibility(cand({ hiredOn: '2026-06-30' }), rules, AS_OF).eligible).toBe(true);
    expect(evaluateEligibility(cand({ hiredOn: '2026-07-01' }), rules, AS_OF).eligible).toBe(false);
  });

  it('AND-combination: fails if ANY predicate fails, collects every failing reason', () => {
    const rules: EligibilityRules = {
      statuses: ['active'],
      employmentTypes: ['full_time'],
      minServiceMonths: 6,
      hiredBefore: '2026-06-30',
    };
    expect(evaluateEligibility(cand(), rules, AS_OF).eligible).toBe(true);
    const bad = evaluateEligibility(cand({ status: 'probation', employmentType: 'intern' }), rules, AS_OF);
    expect(bad.eligible).toBe(false);
    expect(bad.reasons).toEqual(expect.arrayContaining(['status', 'employmentType']));
  });

  it('null current assignment: any configured status/type/company predicate EXCLUDES (default)', () => {
    const nullAsg = cand({ status: null, employmentType: null, companyId: null });
    // No such predicate configured ⇒ still eligible (nothing to check).
    expect(evaluateEligibility(nullAsg, { minServiceMonths: 1 }, AS_OF).eligible).toBe(true);
    // Any of the three assignment-backed predicates ⇒ excluded.
    expect(evaluateEligibility(nullAsg, { statuses: ['active'] }, AS_OF).eligible).toBe(false);
    expect(evaluateEligibility(nullAsg, { employmentTypes: ['full_time'] }, AS_OF).eligible).toBe(false);
    expect(evaluateEligibility(nullAsg, { companyIds: ['co-1'] }, AS_OF).eligible).toBe(false);
  });

  it('serviceMonths: whole calendar months, day-of-month aware, never negative', () => {
    expect(serviceMonths('2026-01-01', '2026-07-01')).toBe(6);
    expect(serviceMonths('2026-01-15', '2026-07-01')).toBe(5); // not yet the 15th
    expect(serviceMonths('2026-07-01', '2026-01-01')).toBe(0); // future hire clamps to 0
  });

  it('normalizeEligibilityRules: strips empties/nulls, null when nothing meaningful', () => {
    expect(normalizeEligibilityRules(null)).toBeNull();
    expect(normalizeEligibilityRules({ companyIds: [], statuses: [], minServiceMonths: 0, hiredBefore: null })).toBeNull();
    expect(normalizeEligibilityRules({ statuses: ['active'], employmentTypes: [], minServiceMonths: 6 })).toEqual({
      statuses: ['active'],
      minServiceMonths: 6,
    });
  });
});

describe('eligibility engine — integration (createCycle / openCycle)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  /** Seed a person + employment + a single current assignment with a chosen status/type. Owner-role
   *  (bypasses RLS, like the harness). Returns the employmentId. */
  async function seedEmp(opts: {
    name: string;
    companyId?: string;
    hiredOn?: string;
    status?: 'active' | 'on_leave' | 'probation' | 'offboarding' | 'terminated';
    employmentType?: 'full_time' | 'part_time' | 'contract' | 'intern';
    terminatedOn?: string | null;
    withAssignment?: boolean;
  }): Promise<string> {
    const companyId = opts.companyId ?? base.companyId;
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: base.tenantId, fullName: opts.name, primaryEmail: `${opts.name.toLowerCase().replace(/\s+/g, '')}-${randomUUID().slice(0, 6)}@acme.test` })
      .returning({ id: schema.person.id });
    const [emp] = await owner.db
      .insert(schema.employment)
      .values({
        tenantId: base.tenantId,
        personId: p.id,
        companyId,
        hiredOn: opts.hiredOn ?? '2026-01-01',
        employeeCode: `E-${randomUUID().slice(0, 8)}`,
        terminatedOn: opts.terminatedOn ?? null,
      })
      .returning({ id: schema.employment.id });
    if (opts.withAssignment !== false) {
      await owner.db.insert(schema.assignment).values({
        tenantId: base.tenantId,
        employmentId: emp.id,
        departmentId: base.deptA,
        employmentType: opts.employmentType ?? 'full_time',
        status: opts.status ?? 'active',
        validFrom: opts.hiredOn ?? '2026-01-01',
        validTo: null,
      });
    }
    return emp.id;
  }

  const reviewsFor = (cycleId: string) =>
    owner.db
      .select({ employmentId: schema.performanceReview.employmentId })
      .from(schema.performanceReview)
      .where(eq(schema.performanceReview.cycleId, cycleId))
      .then((rs) => rs.map((r) => r.employmentId));

  it('intern-exclusion (ticket worked example): an active intern is excluded by an employmentTypes rule', async () => {
    const a = adminCtx(base);
    const emp = await seedEmp({ name: 'FT One', employmentType: 'full_time' });
    const intern = await seedEmp({ name: 'Intern One', employmentType: 'intern', status: 'active' });
    const { cycleId } = await createCycle(a, {
      name: 'FY26',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      eligibilityRules: { employmentTypes: ['full_time', 'part_time', 'contract'] },
    });
    await openCycle(a, { cycleId });
    const ids = await reviewsFor(cycleId);
    expect(ids).toContain(emp);
    expect(ids).not.toContain(intern);
  });

  it('null-assignment employee is EXCLUDED under a status rule (explicit default 2a)', async () => {
    const a = adminCtx(base);
    const withAsg = await seedEmp({ name: 'Has Asg', status: 'active' });
    const noAsg = await seedEmp({ name: 'No Asg', withAssignment: false });
    const { cycleId } = await createCycle(a, {
      name: 'FY26',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      eligibilityRules: { statuses: ['active'] },
    });
    await openCycle(a, { cycleId });
    const ids = await reviewsFor(cycleId);
    expect(ids).toContain(withAsg);
    expect(ids).not.toContain(noAsg);
  });

  it('duplicate current-assignment rows ⇒ exactly ONE review (DISTINCT ON guard)', async () => {
    const a = adminCtx(base);
    const emp = await seedEmp({ name: 'Dup', status: 'active' });
    // The assignment_no_overlap EXCLUDE constraint (WHERE superseded_at IS NULL) normally blocks a second
    // open-ended "current" row, so this scenario can only arise if that guarantee were ever bypassed
    // (a stray duplicate mid-transfer). We drop the constraint just for this insert to prove the service's
    // DISTINCT ON latest-row-wins guard collapses the duplicate to ONE review as defense-in-depth, then
    // restore it so the DB is left as migrated.
    await owner.db.execute(sql`ALTER TABLE assignment DROP CONSTRAINT assignment_no_overlap`);
    try {
      await owner.db.insert(schema.assignment).values({
        tenantId: base.tenantId,
        employmentId: emp,
        departmentId: base.deptB,
        employmentType: 'full_time',
        status: 'active',
        validFrom: '2026-03-01',
        validTo: null,
      });
      const { cycleId } = await createCycle(a, { name: 'FY26', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
      await openCycle(a, { cycleId });
      const ids = await reviewsFor(cycleId);
      expect(ids.filter((id) => id === emp)).toHaveLength(1);
    } finally {
      // Remove the overlapping rows for this employment BEFORE re-adding the constraint (else the
      // ADD CONSTRAINT would fail on the very overlap we injected). The next test's resetDb truncates
      // everything anyway; this only keeps the DB self-consistent within this test.
      await owner.db.execute(sql`DELETE FROM assignment WHERE employment_id = ${emp}`);
      await owner.db.execute(
        sql`ALTER TABLE assignment ADD CONSTRAINT assignment_no_overlap EXCLUDE USING gist (employment_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&) WHERE (superseded_at IS NULL)`,
      );
    }
  });

  it('terminatedOn is authoritative over a stale assignment.status (2b), both directions', async () => {
    const a = adminCtx(base);
    // (i) terminatedOn set but assignment.status stale as 'active' ⇒ excluded (WHERE isNull(terminatedOn)).
    const terminatedButActive = await seedEmp({ name: 'Term Active', status: 'active', terminatedOn: '2026-05-01' });
    // (ii) terminatedOn null but assignment.status stale as 'terminated' ⇒ INCLUDED when no status rule
    //      constrains it (employment.terminatedOn — not assignment.status — decides termination).
    const activeButTermStatus = await seedEmp({ name: 'Active TermStatus', status: 'terminated', terminatedOn: null });
    const { cycleId } = await createCycle(a, { name: 'FY26', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await openCycle(a, { cycleId });
    const ids = await reviewsFor(cycleId);
    expect(ids).not.toContain(terminatedButActive);
    expect(ids).toContain(activeButTermStatus);
  });

  it('concurrent employment: one person, two eligible employments ⇒ two independent reviews (documented decision)', async () => {
    const a = adminCtx(base);
    // Two employments for the SAME person, both active/full_time.
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: base.tenantId, fullName: 'Dual Role', primaryEmail: `dual-${randomUUID().slice(0, 6)}@acme.test` })
      .returning({ id: schema.person.id });
    const empIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [emp] = await owner.db
        .insert(schema.employment)
        .values({ tenantId: base.tenantId, personId: p.id, companyId: base.companyId, hiredOn: '2026-01-01', employeeCode: `D-${randomUUID().slice(0, 8)}` })
        .returning({ id: schema.employment.id });
      await owner.db.insert(schema.assignment).values({
        tenantId: base.tenantId,
        employmentId: emp.id,
        departmentId: base.deptA,
        employmentType: 'full_time',
        status: 'active',
        validFrom: '2026-01-01',
        validTo: null,
      });
      empIds.push(emp.id);
    }
    const { cycleId } = await createCycle(a, { name: 'FY26', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await openCycle(a, { cycleId });
    const ids = await reviewsFor(cycleId);
    // Two separate performance_review rows (one per employment role), not deduped to the person.
    expect(ids).toContain(empIds[0]);
    expect(ids).toContain(empIds[1]);
    expect(ids.filter((id) => empIds.includes(id))).toHaveLength(2);
  });

  it('cross-company-scope rejection (2c): a Company-A-scoped partner cannot target Company B', async () => {
    // Build a second company B under the group, and a partner grant scoped to base.companyId (A) only.
    const [coB] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Co B Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: u.id, companyId: base.companyId, role: 'performance_comp_partner' });
    const partnerCtx: SessionContext = {
      tenantId: base.tenantId,
      userId: u.id,
      roles: ['performance_comp_partner'],
      grants: [{ role: 'performance_comp_partner', companyId: base.companyId }],
    };
    // Group-wide cycle (companyId null) with eligibilityRules reaching into Company B ⇒ rejected.
    await expect(
      createCycle(partnerCtx, {
        companyId: null,
        name: 'Sneaky',
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
        eligibilityRules: { companyIds: [coB.id] },
      }),
    ).rejects.toBeInstanceOf(PerfError);
  });

  it('previewEligibleCount matches the count openCycle produces for the same rules', async () => {
    const a = adminCtx(base);
    await seedEmp({ name: 'A', employmentType: 'full_time', status: 'active' });
    await seedEmp({ name: 'B', employmentType: 'full_time', status: 'active' });
    await seedEmp({ name: 'C intern', employmentType: 'intern', status: 'active' });
    const rules: EligibilityRules = { employmentTypes: ['full_time', 'part_time', 'contract'] };
    const { count } = await previewEligibleCount(a, { companyId: base.companyId, eligibilityRules: rules });
    const { cycleId } = await createCycle(a, {
      name: 'FY26',
      companyId: base.companyId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      eligibilityRules: rules,
    });
    const { reviewsSpawned } = await openCycle(a, { cycleId });
    expect(count).toBe(2); // the two full-time employees, not the intern
    expect(reviewsSpawned).toBe(count);
  });

  it('review-cycle.created carries the eligibility summary + lowercase user actor', async () => {
    const a = adminCtx(base);
    const rules: EligibilityRules = { statuses: ['active'], employmentTypes: ['full_time', 'contract'], minServiceMonths: 6, hiredBefore: '2026-06-30' };
    const { cycleId } = await createCycle(a, {
      name: 'FY26',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      eligibilityRules: rules,
    });
    const payload = await latestEventPayload(base.tenantId, cycleId, 'review-cycle.created');
    expect(payload).not.toBeNull();
    expect(payload!.eligibilityRules).toMatchObject({
      statuses: ['active'],
      employmentTypes: ['full_time', 'contract'],
      minServiceMonths: 6,
      hiredBefore: '2026-06-30',
    });
    // Actor shape: lowercase 'user' actor-type with the caller's user id.
    const [ev] = await owner.db
      .select({ actorType: schema.domainEvent.actorType, actorId: schema.domainEvent.actorId })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, cycleId), eq(schema.domainEvent.eventType, 'review-cycle.created')));
    expect(ev.actorType).toBe('user');
    expect(ev.actorId).toBe(base.adminUserId);
  });
});
