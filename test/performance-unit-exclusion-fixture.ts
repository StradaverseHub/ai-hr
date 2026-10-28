/**
 * D-P1-22 (ADR-0150): the shared fixture behind the cycle exclusion rule tests. Every write under test runs through
 * a persona's ai_hr_app session (the service or a direct statement in that session); `owner` only builds the org
 * tree, moves people between departments and reads back. Dates come from todayInKualaLumpur().
 *
 * Org. Company A (seedBase's company) has departments X (the one left out), Y and Xc (a child of X: a rule on X never
 * covers it, D2); company B has department Z. The cycle is group-wide, year-end, grade 12 everywhere, with two
 * technical competencies for company A.
 *   M2 (Y) <- M1 (Y) <- M0 (X)          administrative lines, manager on the left
 *   M0 <- S (Y), Q (X), P (Xc)          S's stored reviewer is M0 (taken when the cycle opens)
 *   M1 <- C (Y), R (Y), F (Y)           C's and F's stored reviewer is M1
 *   M2 <- A (Y)                          A is a matrix KPI approver in the cases that need one
 *   T (X) has no manager. Dual is one person with E1 (A·X) and E2 (B·Z).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { expect } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee, setReportingLine } from '../core/org';
import * as perf from '../packs/performance/service';
import { defaultPolicy, kpiSchema, type KPI } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

export const year = Number(todayInKualaLumpur().slice(0, 4));
export type Hired = { employmentId: string; personId: string };
export const BASE_PEOPLE = ['M2', 'M1', 'M0', 'S', 'C', 'R', 'F', 'A', 'Q', 'P', 'T', 'E1', 'E2'] as const;
export type BaseName = (typeof BASE_PEOPLE)[number];

export type Fixture = {
  b: Base; a: SessionContext; companyB: string;
  dept: { X: string; Y: string; Xc: string; Z: string };
  P: Record<string, Hired>; U: Record<string, SessionContext>;
  cycleId: string;
  hire: (name: string, companyId: string, departmentId: string, personId?: string) => Promise<Hired>;
  line: (subordinate: Hired, manager: Hired) => Promise<unknown>;
  login: (person: Hired, role?: 'employee' | 'manager') => Promise<SessionContext>;
  scoped: (person: Hired | null, role: 'hr_admin' | 'performance_partner', companyId: string | null) => Promise<SessionContext>;
};

/** Builds the org and opens the cycle. `beforeOpen` adds people and lines that must exist when reviews are created. */
export async function buildFixture(beforeOpen?: (f: Omit<Fixture, 'cycleId'>) => Promise<void>): Promise<Fixture> {
  await resetDb();
  const b = await seedBase();
  await setModule(b.tenantId, 'performance', 'active');
  const a = await entitledCtx(b);
  const { id: companyB } = await createCompany(a, { legalName: 'Second Unit Sdn Bhd' });
  const X = (await createDepartment(a, { companyId: b.companyId, name: 'Left out' })).id;
  const Y = (await createDepartment(a, { companyId: b.companyId, name: 'Taking part' })).id;
  const Xc = (await createDepartment(a, { companyId: b.companyId, name: 'Left out child', parentDepartmentId: X })).id;
  const Z = (await createDepartment(a, { companyId: companyB, name: 'Second unit dept' })).id;
  const hire = (name: string, companyId: string, departmentId: string, personId?: string) =>
    hireEmployee(a, { person: personId ? { id: personId } : { fullName: name, primaryEmail: `${randomUUID()}@unit-exclusion.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
  const line = (subordinate: Hired, manager: Hired) =>
    setReportingLine(a, { subordinateEmploymentId: subordinate.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
  const login = async (person: Hired, role: 'employee' | 'manager' = 'manager'): Promise<SessionContext> => {
    const userId = await createAppUser(b.tenantId, person.personId, role);
    return { tenantId: b.tenantId, userId, personId: person.personId, roles: [role], grants: [{ role, companyId: null }], entitlements: a.entitlements };
  };
  const scoped = async (person: Hired | null, role: 'hr_admin' | 'performance_partner', companyId: string | null): Promise<SessionContext> => {
    const [u] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: person?.personId ?? null }).returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId, role });
    return { tenantId: b.tenantId, userId: u.id, personId: person?.personId ?? undefined, roles: [role], grants: [{ role, companyId }], entitlements: a.entitlements };
  };
  const P: Record<string, Hired> = {};
  const U: Record<string, SessionContext> = {};
  const homes: Record<BaseName, [string, string]> = {
    M2: [b.companyId, Y], M1: [b.companyId, Y], M0: [b.companyId, X], S: [b.companyId, Y], C: [b.companyId, Y], R: [b.companyId, Y], F: [b.companyId, Y],
    A: [b.companyId, Y], Q: [b.companyId, X], P: [b.companyId, Xc], T: [b.companyId, X], E1: [b.companyId, X], E2: [companyB, Z],
  };
  for (const name of BASE_PEOPLE) {
    const [companyId, departmentId] = homes[name];
    P[name] = await hire(`Person ${name}`, companyId, departmentId, name === 'E2' ? P.E1.personId : undefined);
  }
  await line(P.M1, P.M2); await line(P.M0, P.M1);
  for (const n of ['S', 'Q', 'P'] as const) await line(P[n], P.M0);
  for (const n of ['C', 'R', 'F'] as const) await line(P[n], P.M1);
  await line(P.A, P.M2);
  const partial = { b, a, companyB, dept: { X, Y, Xc, Z }, P, U, hire, line, login, scoped };
  if (beforeOpen) await beforeOpen(partial);
  const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
  await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.tenantId, b.tenantId));
  const { cycleId } = await perf.createCycle(a, { name: 'Unit exclusion cycle', companyId: null, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` });
  const policy = defaultPolicy(framework);
  policy.profiles = [{ id: randomUUID(), companyId: b.companyId, grade: '12', name: 'Engineering', competencies: [{ id: 'skill-1', principle: 'Technical', text: 'Current skill', future: false }, { id: 'skill-2', principle: 'Technical', text: 'Future skill', future: true }] }];
  await perf.configureOnehrCycle(a, cycleId, null, policy);
  await perf.openCycle(a, { cycleId });
  for (const name of Object.keys(P)) if (name !== 'E2' && !U[name]) U[name] = await login(P[name]);
  U.E2 = U.E1; // one person, one login
  return { ...partial, cycleId };
}

/** The opened cycle's review for an employment. */
export async function reviewOf(cycleId: string, e: Hired): Promise<string> {
  const [r] = await owner.db.select({ id: schema.performanceReview.id }).from(schema.performanceReview)
    .where(and(eq(schema.performanceReview.cycleId, cycleId), eq(schema.performanceReview.employmentId, e.employmentId)));
  expect(r, 'the opened cycle has a review for the fixture person').toBeDefined();
  return r.id;
}
export async function revisionOf(reviewId: string): Promise<number> {
  const [r] = await owner.db.select({ revision: schema.onehrReview.revision }).from(schema.onehrReview).where(eq(schema.onehrReview.reviewId, reviewId));
  return r.revision;
}
export async function kpisOf(reviewId: string): Promise<KPI[]> {
  const [r] = await owner.db.select({ kpis: schema.onehrReview.kpis }).from(schema.onehrReview).where(eq(schema.onehrReview.reviewId, reviewId));
  return kpiSchema.array().parse(r.kpis);
}
/** A value of one expression in the persona's session. */
export async function valueAs<T>(ctx: SessionContext, query: SQL): Promise<T> {
  const [row] = await withTenant(ctx, (tx) => tx.execute<{ v: T }>(sql`select (${query}) as v`));
  return row.v;
}
export const flagAs = (ctx: SessionContext, query: SQL) => valueAs<boolean | null>(ctx, query).then((v) => !!v);
/** The refusal's own text through drizzle's `cause` chain, so a refusal cannot pass on an unrelated error. */
export async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const parts: string[] = [];
    let cur: unknown = e;
    while (cur instanceof Error) { parts.push(cur.message); cur = (cur as { cause?: unknown }).cause; }
    return parts.join(' | ');
  }
  throw new Error('expected the operation to be refused, but it succeeded');
}
/** Preview then save through the service (the persona must be a tenant-wide HR administrator to save). */
export async function exclude(ctx: SessionContext, cycleId: string, companyId: string, departmentId: string | null) {
  const preview = await perf.previewUnitExclusion(ctx, cycleId, { companyId, departmentId });
  const saved = await perf.saveUnitExclusion(ctx, cycleId, { companyId, departmentId, digest: preview.digest, revision: preview.revision });
  return { preview, saved };
}
export async function cycleRevision(cycleId: string): Promise<number> {
  const [c] = await owner.db.select({ revision: schema.onehrCycle.revision }).from(schema.onehrCycle).where(eq(schema.onehrCycle.cycleId, cycleId));
  return c.revision;
}
export async function bringBack(ctx: SessionContext, cycleId: string, ruleId: string) {
  return perf.endUnitExclusion(ctx, ruleId, { revision: await cycleRevision(cycleId) });
}
/** Moves the employment's assignment in force to another department of the same company, today (fixture). */
export async function moveTo(e: Hired, departmentId: string) {
  await owner.db.update(schema.assignment).set({ departmentId }).where(and(eq(schema.assignment.employmentId, e.employmentId), isNull(schema.assignment.supersededAt)));
}
export async function terminateToday(e: Hired) {
  await owner.db.update(schema.employment).set({ terminatedOn: todayInKualaLumpur() }).where(eq(schema.employment.id, e.employmentId));
}
/** A KPI line that passes the real kpiSchema. `chain` defaults to the single moderator, nobody acted. */
export function kpiLine(p: { title: string; moderator: string; chain?: { employmentId: string; at: string | null }[]; hrOwned?: boolean; source?: 'line' | 'matrix'; setting?: KPI['setting']; actual?: number | null; weightBp?: number; locked?: boolean }): KPI {
  return kpiSchema.parse({
    id: randomUUID(), title: p.title, description: '', weightBp: p.weightBp ?? 2500, unit: 'units', scoring: { mechanism: 'A', method: 'more', rates: [0, 50, 100, 150, 200] },
    moderatorEmploymentId: p.moderator, moderatorSource: p.source ?? 'line',
    approvalChain: (p.chain ?? [{ employmentId: p.moderator, at: null }]).map((s) => ({ employmentId: s.employmentId, actual: s.at ? 100 : null, remark: s.at ? 'Checked.' : '', at: s.at })),
    setting: p.setting ?? (p.hrOwned ? 'approved' : 'draft'), settingApprovals: [], settingRemark: '', actual: p.actual ?? null, note: '', approvedActual: null, moderationRemark: '', locked: !!p.locked,
    ...(p.hrOwned ? { hrOwned: true } : {}),
  });
}
/** Writes KPI lines as the cycle administrator (the database guard admits HR's matrix and company lines). */
export async function setKpis(a: SessionContext, reviewId: string, kpis: KPI[], resultsSubmitted = false) {
  await withTenant(a, (tx) => tx.update(schema.onehrReview).set({ kpis, ...(resultsSubmitted ? { resultsSubmittedAt: new Date() } : {}) }).where(eq(schema.onehrReview.reviewId, reviewId)));
}
/** Every rule row of the cycle, oldest first (owner read-back). */
export async function rulesOf(cycleId: string) {
  return owner.db.select().from(schema.assessmentUnitExclusion).where(eq(schema.assessmentUnitExclusion.cycleId, cycleId)).orderBy(asc(schema.assessmentUnitExclusion.createdAt), asc(schema.assessmentUnitExclusion.id));
}
export const participatesAs = (ctx: SessionContext, reviewId: string) => flagAs(ctx, sql`app.assessment_review_participates(${reviewId}::uuid)`);
export const effectiveEmployment = (a: SessionContext, reviewId: string) => valueAs<string | null>(a, sql`app.onehr_effective_reviewer_employment(${reviewId}::uuid)`);
