/**
 * WP-E (CF-08, APR-021 / APR-022) — two-step result release and the leader read, against real RLS as ai_hr_app.
 *
 * Every write is a persona's app-role session through the service. `owner` only reads back and builds fixture
 * state the services under test do not own: the org tree, the line manager's confirmed band, the rating record
 * snapshot that feeds the self and line-manager steps, and the frozen-row RLS probe. Calibration decisions are
 * written by the HR administrator's own session, as generation would. Dates come from todayInKualaLumpur().
 *
 * Org: Holding (business group node) ← Acme (unit, seedBase). Leaders of every subject: line manager `lm`
 * (administrative reporting line), HOD `hod` (HOD assignment), BU CEO `buCeo` (unit seat), BG CEO `bgCeo`
 * (group node seat), group chief `chief` (calibration group seat). `outsider` manages the line manager: a
 * department-tree manager who is none of the subject's leaders.
 *
 * W3-F6 (D-P1-22 E7, ADR-0150): a leader whose unit is left out of the cycle has no leader right on it, per acting
 * employment (D9); the rule is saved and ended through the unit-exclusion service by the group-wide HR administrator.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee, setReportingLine } from '../core/org';
import { performanceReviewReport } from '../core/reporting';
import { dispatchNotifications } from '../core/notifications';
import * as perf from '../packs/performance/service';
import { defaultPolicy, type Policy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';
import { bringBack, exclude, moveTo } from './performance-unit-exclusion-fixture';

const year = Number(todayInKualaLumpur().slice(0, 4));
const BAND = /\b(UA|BE|ME|AE|OU|Low|Mid|High|Super Star|Star|Solid Core|PIP)\b/;
type Hired = { employmentId: string; personId: string };
const LEADERS = ['lm', 'hod', 'buCeo', 'bgCeo', 'chief', 'outsider', 'successor'] as const;
type Leader = (typeof LEADERS)[number];
type Step = { tier: string; band: string | null; state: string; why: string };
type Chain = { role: string; midYear: boolean; frozen: boolean; axes: { axis: 'performance' | 'potential'; steps: Step[]; final: string | null; full: boolean; hasResult: boolean }[]; talent: string | null } | null;

let b: Base, a: SessionContext, holding: string, cycleId: string, gradeId: string;
const P = {} as Record<Leader, Hired>;
const U = {} as Record<Leader, SessionContext>;
let S: Hired[] = [], SU: SessionContext[] = [];

const hire = (name: string) => hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@two-step.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
async function login(person: Hired, role: 'employee' | 'manager' = 'manager'): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, person.personId, role);
  return { tenantId: b.tenantId, userId, personId: person.personId, roles: [role], grants: [{ role, companyId: null }], entitlements: a.entitlements };
}
async function openCycle(name: string, kind: Policy['kind'] = 'year_end') {
  const { cycleId: id } = await perf.createCycle(a, { name, companyId: b.companyId, periodStart: `${year}-01-01`, periodEnd: kind === 'mid_year' ? `${year}-06-30` : `${year}-12-31` });
  const policy = defaultPolicy(framework); policy.kind = kind;
  await perf.configureOnehrCycle(a, id, null, policy);
  await perf.openCycle(a, { cycleId: id });
  return id;
}
async function reviewOf(cycle: string, e: Hired) {
  const [r] = await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, cycle), eq(schema.performanceReview.employmentId, e.employmentId)));
  expect(r, 'the opened cycle has a review for the fixture person').toBeDefined();
  return r.id;
}
async function assignHod(subjects: Hired[], hod: Hired) {
  const input = { subjectEmploymentIds: subjects.map((s) => s.employmentId), hodEmploymentId: hod.employmentId };
  const preview = await perf.previewHodChange(a, input);
  return perf.applyHodChange(a, { ...input, fingerprint: preview.fingerprint, acknowledged: true });
}
const seatBu = (holder: Hired) => perf.appointLeaderSeat(a, { seatType: 'bu_ceo', companyId: b.companyId, holderEmploymentId: holder.employmentId });
type Decision = { review: string; emp: string; performance: string | null; potential: string | null; performanceNote?: string; potentialNote?: string };
/** A confirmed calibration decision at one tier, written by the HR administrator (session locks on both axes). */
async function decide(cycle: string, tier: 'hod' | 'bu' | 'bg' | 'group' | 'final', rows: Decision[]) {
  return withTenant(a, async (tx) => {
    const now = new Date();
    const [s] = await tx.insert(schema.onehrCalibration).values({ tenantId: b.tenantId, cycleId: cycle, companyId: b.companyId, name: `${tier} scope`, tier, reviewerUserIds: [], performanceLockedAt: tier === 'final' ? null : now, potentialLockedAt: tier === 'final' ? null : now }).returning();
    for (const r of rows) await tx.insert(schema.onehrCalibrationEntry).values({ tenantId: b.tenantId, sessionId: s.id, reviewId: r.review, employmentId: r.emp, performance: r.performance, potential: r.potential, performanceNote: r.performanceNote ?? '', potentialNote: r.potentialNote ?? '' });
    return s.id;
  });
}
/** People with a result on all three components (an HR final-tier band resolves without a lock), led by every leader. */
async function bulkCycle(name: string, extra: number) {
  const people = [...S];
  for (let i = 0; i < extra; i++) {
    const p = await hire(`${name} person ${i}`);
    await owner.db.update(schema.employment).set({ gradeId }).where(eq(schema.employment.id, p.employmentId));
    await setReportingLine(a, { subordinateEmploymentId: p.employmentId, managerEmploymentId: P.lm.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
    people.push(p);
  }
  await assignHod(people.slice(S.length), P.hod);
  const cycle = await openCycle(name);
  const reviews = await Promise.all(people.map((p) => reviewOf(cycle, p)));
  await decide(cycle, 'final', people.map((p, i) => ({ review: reviews[i], emp: p.employmentId, performance: 'ME', potential: 'Mid' })));
  return { cycle, people, reviews };
}
const releaseRows = (reviewIds: string[]) => owner.db.select().from(schema.assessmentRelease).where(inArray(schema.assessmentRelease.reviewId, reviewIds)).orderBy(asc(schema.assessmentRelease.reviewId));
const ledger = (reviewIds: string[]) => owner.db.select().from(schema.assessmentReleaseNotice).where(inArray(schema.assessmentReleaseNotice.reviewId, reviewIds)).orderBy(asc(schema.assessmentReleaseNotice.reviewId), asc(schema.assessmentReleaseNotice.component), asc(schema.assessmentReleaseNotice.recipientEmploymentId));
const events = (eventType: string) => owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, eventType))).orderBy(asc(schema.domainEvent.sequence));
const chainOf = (ctx: SessionContext, review: string) => withTenant(ctx, async (tx) => (await tx.execute<{ v: Chain }>(sql`select app.onehr_leader_result(${review}::uuid) as v`))[0].v);
const roleOf = (ctx: SessionContext, review: string) => withTenant(ctx, async (tx) => (await tx.execute<{ v: string | null }>(sql`select app.onehr_leader_role(${review}::uuid) as v`))[0].v);
const shape = (chain: Chain, axis: 'performance' | 'potential') => chain!.axes.find((x) => x.axis === axis)!.steps.map((s) => `${s.tier}:${s.state}:${s.band ?? '-'}`);
const whys = (chain: Chain) => chain!.axes.flatMap((x) => x.steps.filter((s) => s.why).map((s) => `${x.axis}.${s.tier}`)).sort();
const release = (reviewIds: string[], result: perf.ReleaseResult, step: perf.ReleaseStep, action: 'release' | 'revoke' = 'release', ctx = a, cycle = cycleId) =>
  perf.releaseOnehrResults(ctx, { cycleId: cycle, reviewIds, result, step, action });

/**
 * One fully calibrated subject: the line manager confirmed ME; the rating record holds the self band BE and the
 * line manager's 360 band Mid; HOD, BU CEO and BG CEO decisions are confirmed, each with its own reason.
 */
async function calibrated(cycle: string, person: Hired) {
  const review = await reviewOf(cycle, person);
  await owner.db.update(schema.onehrReview).set({ managerPerformance: 'ME' }).where(eq(schema.onehrReview.reviewId, review));
  await owner.db.insert(schema.assessmentRatingRecord).values({ reviewId: review, tenantId: b.tenantId, lastEvent: 'admin_capture', recordedBy: b.adminUserId,
    snapshot: { selfBand: 'BE', managerBand: 'ME', valid: true, computedPotential: 'Mid', competencyStatus: null, potential360Pct: 50, competencySelf: null, competencyMax: null, configuration: { weight360: 4000, lowMaxPct: 40, midMaxPct: 74.29 } } });
  await decide(cycle, 'hod', [{ review, emp: person.employmentId, performance: 'AE', potential: 'Mid', performanceNote: 'HOD performance reason', potentialNote: 'HOD potential reason' }]);
  await decide(cycle, 'bu', [{ review, emp: person.employmentId, performance: 'AE', potential: 'High', performanceNote: 'BU performance reason', potentialNote: 'BU potential reason' }]);
  await decide(cycle, 'bg', [{ review, emp: person.employmentId, performance: 'OU', potential: 'High', performanceNote: 'BG performance reason', potentialNote: 'BG potential reason' }]);
  return review;
}
async function freeze(review: string) {
  return perf.freezeOnehrReview(a, review, (await perf.getOnehrReview(a, review))!.revision);
}

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'performance', 'active'); await setModule(b.tenantId, 'notifications', 'active');
  a = await entitledCtx(b);
  ({ id: holding } = await createCompany(a, { legalName: 'Holding Group Bhd' }));
  await owner.db.update(schema.company).set({ parentCompanyId: holding }).where(eq(schema.company.id, b.companyId));
  for (const name of LEADERS) P[name] = await hire(`Leader ${name}`);
  S = [];
  for (let i = 0; i < 4; i++) S.push(await hire(`Subject ${i}`));
  const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
  gradeId = grade.id;
  await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.tenantId, b.tenantId));
  for (const s of S) await setReportingLine(a, { subordinateEmploymentId: s.employmentId, managerEmploymentId: P.lm.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
  await setReportingLine(a, { subordinateEmploymentId: P.lm.employmentId, managerEmploymentId: P.outsider.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
  await assignHod(S, P.hod);
  await seatBu(P.buCeo);
  await perf.appointLeaderSeat(a, { seatType: 'bg_ceo', companyId: holding, holderEmploymentId: P.bgCeo.employmentId });
  const groupId = await perf.createCalibrationGroup(a, { name: 'Group calibration' });
  await perf.addCalibrationGroupMembers(a, groupId, { employmentIds: S.map((s) => s.employmentId) });
  await perf.appointLeaderSeat(a, { seatType: 'group_chief', calibrationGroupId: groupId, holderEmploymentId: P.chief.employmentId });
  for (const name of LEADERS) U[name] = await login(P[name]);
  // The subjects sign in too: a person without a live login is never notified (app.onehr_release_people).
  SU = [];
  for (const s of S) SU.push(await login(s, 'employee'));
  cycleId = await openCycle('Annual assessment');
});
afterAll(closeAll);

describe('the release contracts', () => {
  it('REA-BC-CAL-044: release three to leaders reaches each leader once with a count; leaders read the whole chain; nobody is told twice', async () => {
    const { cycle, reviews } = await bulkCycle('Bulk annual', 46);
    expect(reviews).toHaveLength(50);
    const out = await release(reviews, 'three', 'leaders', 'release', a, cycle);
    expect(out).toEqual({ done: { performance: 50, potential: 50, talent: 50 }, noResult: {}, leadersFirst: {}, stillWithEmployee: {}, notAllowed: 0, notified: { leaders: 3, people: 0 } });
    const rows = await releaseRows(reviews);
    expect(rows).toHaveLength(50);
    for (const r of rows) {
      expect([r.performanceLeaderReleasedAt, r.potentialLeaderReleasedAt, r.talentLeaderReleasedAt].every((d) => d instanceof Date)).toBe(true);
      expect([r.performanceReleasedAt, r.potentialReleasedAt, r.talentReleasedAt]).toEqual([null, null, null]);
    }
    const told = await events('onehr.results-to-leader');
    expect(told.map((e) => e.subjectEmploymentId).sort()).toEqual([P.lm, P.hod, P.buCeo].map((p) => p.employmentId).sort());
    expect(told.map((e) => (e.payload as { count: number }).count)).toEqual([50, 50, 50]);
    const book = await ledger(reviews);
    expect(book).toHaveLength(50 * 3 * 3);
    expect(new Set(book.map((r) => `${r.reviewId}|${r.component}|${r.recipientEmploymentId}`)).size).toBe(450);
    expect(new Set(book.map((r) => r.step))).toEqual(new Set(['leaders']));
    // REA-BC-CAL-048: the same release again writes no row and tells nobody.
    const again = await release(reviews, 'three', 'leaders', 'release', a, cycle);
    expect(again.notified).toEqual({ leaders: 0, people: 0 });
    expect((await ledger(reviews)).length).toBe(450);
    expect((await events('onehr.results-to-leader')).length).toBe(3);
    expect((await releaseRows(reviews)).map((r) => r.performanceLeaderReleasedAt?.getTime())).toEqual(rows.map((r) => r.performanceLeaderReleasedAt?.getTime()));
    const chain = await chainOf(U.buCeo, reviews[0]);
    expect(chain!.axes.map((x) => [x.axis, x.full, x.final])).toEqual([['performance', true, 'ME'], ['potential', true, 'Mid']]);
    expect(chain!.talent).toBe('Solid Core');
  }, 180_000);

  it('REA-BC-CAL-045: release to employees skips and counts people not yet with leaders; person notices name what is ready, never a band', async () => {
    const { cycle, reviews } = await bulkCycle('Mixed annual', 10);
    const withLeaders = reviews.slice(0, 4), notYet = reviews.slice(4);
    expect(notYet).toHaveLength(10);
    await release(withLeaders, 'three', 'leaders', 'release', a, cycle);
    const out = await release(reviews, 'three', 'employees', 'release', a, cycle);
    expect(out).toMatchObject({ done: { performance: 4, potential: 4, talent: 4 }, leadersFirst: { performance: 10, potential: 10, talent: 10 }, noResult: {}, notified: { leaders: 0, people: 4 } });
    const rows = await releaseRows(reviews);
    expect(rows.filter((r) => r.performanceReleasedAt).map((r) => r.reviewId).sort()).toEqual([...withLeaders].sort());
    expect(rows.filter((r) => notYet.includes(r.reviewId))).toEqual([]);
    const told = await events('onehr.results-to-person');
    expect(told).toHaveLength(4);
    for (const e of told) {
      expect(Object.keys(e.payload as object).sort()).toEqual(['cycleId', 'kinds']);
      expect((e.payload as { kinds: string[] }).kinds).toEqual(['performance', 'potential', 'talent']);
      expect(JSON.stringify(e.payload)).not.toMatch(BAND);
    }
    await dispatchNotifications(a);
    const notices = await owner.db.select().from(schema.notification).where(eq(schema.notification.kind, 'performance.update'));
    const toPeople = notices.filter((n) => S.some((s) => s.employmentId === n.recipientEmploymentId));
    expect(toPeople).toHaveLength(4);
    for (const n of notices) expect(`${n.title} ${n.body}`).not.toMatch(BAND);
    expect(toPeople[0].body).toContain('your performance band, your potential band and your talent status');
  }, 120_000);

  it('REA-BC-CAL-046: revoking leaders only is refused for a person still released to them; revoking both clears both', async () => {
    const review = await reviewOf(cycleId, S[0]);
    await decide(cycleId, 'final', [{ review, emp: S[0].employmentId, performance: 'ME', potential: 'Mid' }]);
    await release([review], 'performance', 'leaders');
    await release([review], 'performance', 'employees');
    const [before] = await releaseRows([review]);
    const refused = await release([review], 'performance', 'leaders', 'revoke');
    expect(refused).toMatchObject({ stillWithEmployee: { performance: 1 }, done: {} });
    const [unchanged] = await releaseRows([review]);
    expect(unchanged.performanceLeaderReleasedAt?.getTime()).toBe(before.performanceLeaderReleasedAt?.getTime());
    expect(unchanged.performanceReleasedAt).not.toBeNull();
    expect(await release([review], 'performance', 'both', 'revoke')).toMatchObject({ done: { performance: 1 } });
    const [cleared] = await releaseRows([review]);
    expect([cleared.performanceLeaderReleasedAt, cleared.performanceReleasedAt]).toEqual([null, null]);
    expect(await events('onehr.results-to-leader')).toHaveLength(3);
    expect((await events('onehr.result-revoked')).map((e) => (e.payload as { step: string }).step)).toEqual(['both']);
  });

  it('REA-BC-CAL-047 / 049: no resolvable band and a 360 report below the minimum are skipped and counted; nothing is written', async () => {
    const reviews = await Promise.all(S.map((s) => reviewOf(cycleId, s)));
    expect(await release(reviews, 'three', 'leaders')).toMatchObject({ done: {}, noResult: { performance: 4, potential: 4, talent: 4 } });
    expect(await release(reviews, 'feedback', 'employees')).toMatchObject({ done: {}, noResult: { feedback: 4 } });
    // Release 1 never carries the 360 report: the request names nothing to do.
    expect(await release(reviews, 'feedback', 'leaders')).toEqual({ done: {}, noResult: {}, leadersFirst: {}, stillWithEmployee: {}, notAllowed: 0, notified: { leaders: 0, people: 0 } });
    expect(await releaseRows(reviews)).toEqual([]);
    expect(await ledger(reviews)).toEqual([]);
  });

  it('REA-BC-CAL-048: a revoke and re-release keeps the ledger, so nobody is told again', async () => {
    const review = await reviewOf(cycleId, S[0]);
    await decide(cycleId, 'final', [{ review, emp: S[0].employmentId, performance: 'ME', potential: 'Mid' }]);
    await release([review], 'three', 'both');
    const book = await ledger([review]);
    expect(book.map((r) => `${r.component}:${r.step}`).sort()).toEqual(['performance:leaders', 'performance:leaders', 'performance:leaders', 'performance:person', 'potential:leaders', 'potential:leaders', 'potential:leaders', 'potential:person', 'talent:leaders', 'talent:leaders', 'talent:leaders', 'talent:person']);
    await release([review], 'three', 'both', 'revoke');
    expect(await release([review], 'three', 'both')).toMatchObject({ done: { performance: 1, potential: 1, talent: 1 }, notified: { leaders: 0, people: 0 } });
    expect(await ledger([review])).toHaveLength(book.length);
    expect(await events('onehr.results-to-person')).toHaveLength(1);
  });

  it('REA-BC-CAL-051: before step 1 a BU CEO reads up to their own step, later steps hidden; BG CEO and group chief read it all at once', async () => {
    const review = await calibrated(cycleId, S[0]);
    const bu = await chainOf(U.buCeo, review);
    expect(bu!.role).toBe('bu');
    expect(shape(bu, 'performance')).toEqual(['self:set:BE', 'lm:moved:ME', 'hod:moved:AE', 'bu:kept:AE', 'bg:hidden:-']);
    expect(shape(bu, 'potential')).toEqual(['self:none:-', 'lm:set:Mid', 'hod:kept:Mid', 'bu:moved:High', 'bg:hidden:-']);
    expect(bu!.axes.map((x) => [x.full, x.final])).toEqual([[false, null], [false, null]]);
    expect(bu!.talent).toBeNull();
    expect(shape(await chainOf(U.lm, review), 'performance')).toEqual(['self:set:BE', 'lm:moved:ME', 'hod:hidden:-', 'bu:hidden:-', 'bg:hidden:-']);
    expect(shape(await chainOf(U.hod, review), 'performance')).toEqual(['self:set:BE', 'lm:moved:ME', 'hod:moved:AE', 'bu:hidden:-', 'bg:hidden:-']);
    for (const ctx of [U.bgCeo, U.chief]) {
      const full = await chainOf(ctx, review);
      expect(shape(full, 'performance')).toEqual(['self:set:BE', 'lm:moved:ME', 'hod:moved:AE', 'bu:kept:AE', 'bg:moved:OU']);
      expect(full!.axes.map((x) => [x.full, x.final])).toEqual([[true, 'OU'], [true, 'High']]);
      expect(full!.talent).toBe('Super Star');
    }
    expect([await roleOf(U.bgCeo, review), await roleOf(U.chief, review), await roleOf(U.hod, review), await roleOf(U.lm, review)]).toEqual(['bg', 'group', 'hod', 'lm']);
    const led = await perf.listOnehrLedPeople(U.buCeo, { cycleId });
    expect(led.tabs.map((t) => t.key)).toEqual(['bu']);
    expect(led.people.find((p) => p.reviewId === review)).toMatchObject({ role: 'bu', summary: { performance: 'AE', potential: 'High', full: false, talent: null }, release: { key: 'inCalibration' } });
  });

  it('REA-BC-CAL-051 (Mid-Year): the chain ends at the HOD, and a BU CEO reads up to the HOD before step 1', async () => {
    const mid = await openCycle('Mid-year check', 'mid_year');
    const review = await reviewOf(mid, S[1]);
    await decide(mid, 'hod', [{ review, emp: S[1].employmentId, performance: 'AE', potential: null, performanceNote: 'HOD reason' }]);
    await decide(mid, 'bu', [{ review, emp: S[1].employmentId, performance: 'OU', potential: null, performanceNote: 'Unit reason' }]);
    const chain = await chainOf(U.buCeo, review);
    expect(chain!.midYear).toBe(true);
    expect(chain!.axes.find((x) => x.axis === 'performance')!.steps.map((s) => s.tier)).toEqual(['self', 'lm', 'hod']);
    expect(chain!.axes.find((x) => x.axis === 'performance')).toMatchObject({ full: false, final: null });
  });
});

describe('who reads what', () => {
  it('a leader outside the chain reads nothing of the person: no role, no chain, no row, not in their list', async () => {
    const review = await calibrated(cycleId, S[0]);
    await freeze(review);
    await release([review], 'three', 'leaders');
    expect(await roleOf(U.outsider, review)).toBeNull();
    expect(await chainOf(U.outsider, review)).toBeNull();
    // The outsider manages the line manager (their own direct report), never the subject.
    const led = await perf.listOnehrLedPeople(U.outsider, { cycleId });
    expect(led.people.length).toBeGreaterThan(0);
    expect(led.people.map((p) => p.reviewId)).not.toContain(review);
    expect(led.people.map((p) => p.name)).toEqual(['Leader lm']);
    expect(await perf.getOnehrLedPerson(U.outsider, review)).toBeNull();
    expect(await withTenant(U.outsider, (tx) => tx.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId, review)))).toEqual([]);
    expect(await withTenant(U.outsider, (tx) => tx.select().from(schema.assessmentRelease))).toEqual([]);
  });

  it('an ended seat loses the leader read and the release reach at once; the successor gets both with no rewrite', async () => {
    const review = await calibrated(cycleId, S[0]);
    const [seat] = await perf.listLeaderSeats(a, { seatType: 'bu_ceo', liveOnly: true });
    await perf.endLeaderSeat(a, seat.id, { validTo: todayInKualaLumpur() });
    expect(await roleOf(U.buCeo, review)).toBeNull();
    expect(await chainOf(U.buCeo, review)).toBeNull();
    const reach = async () => withTenant(a, (tx) => tx.execute<{ leader_role: string; employment_id: string }>(sql`select leader_role, employment_id from app.onehr_release_leaders(array[${review}::uuid]) order by leader_role, employment_id`));
    expect((await reach()).map((r) => r.leader_role)).toEqual(['hod', 'lm']);
    await seatBu(P.successor);
    expect(await roleOf(U.successor, review)).toBe('bu');
    expect((await reach()).map((r) => [r.leader_role, r.employment_id])).toEqual([['bu', P.successor.employmentId], ['hod', P.hod.employmentId], ['lm', P.lm.employmentId]]);
    await release([review], 'three', 'leaders');
    expect((await events('onehr.results-to-leader')).map((e) => e.subjectEmploymentId).sort()).toEqual([P.successor, P.hod, P.lm].map((p) => p.employmentId).sort());
  });

  it('a person never sees a component before step 2', async () => {
    const review = await calibrated(cycleId, S[0]);
    await freeze(review);
    const self = SU[0];
    const card = async () => withTenant(self, async (tx) => (await tx.execute<{ v: { result: Record<string, unknown> } | null }>(sql`select app.onehr_result_card(${review}::uuid) as v`))[0].v);
    await release([review], 'three', 'leaders');
    expect((await perf.getOnehrReview(self, review))!.result).toMatchObject({ performance: null, potential: null, talent: null });
    expect((await card())!.result).toMatchObject({ performance: null, potential: null, talent: null });
    await release([review], 'performance', 'employees');
    expect((await perf.getOnehrReview(self, review))!.result).toMatchObject({ performance: 'OU', potential: null, talent: null });
    expect((await card())!.result).toMatchObject({ performance: 'OU', potential: null });
    expect(await withTenant(self, (tx) => tx.select().from(schema.assessmentReleaseNotice))).toEqual([]);
    const toLeaders = await events('onehr.result-released-to-leaders');
    expect(toLeaders).toHaveLength(3);
    expect(toLeaders.every((e) => e.subjectEmploymentId === null)).toBe(true);
  });

  it('E-1: a line manager reads frozen bands only once they are released to leaders, in the review and in the performance report', async () => {
    const review = await calibrated(cycleId, S[0]);
    await freeze(review);
    // The frozen row stays readable to the manager under RLS (the frozen-guards rely on it): the projection masks it.
    expect(await withTenant(U.lm, (tx) => tx.select({ id: schema.onehrResult.id }).from(schema.onehrResult).where(eq(schema.onehrResult.reviewId, review)))).toHaveLength(1);
    const viewed = async () => (await perf.getOnehrReview(U.lm, review))!;
    const reported = async () => (await performanceReviewReport(U.lm, {})).find((r) => r.assessmentResultId && r.name === 'Subject 0');
    expect((await viewed()).manager).toBe(true);
    expect((await viewed()).result).toMatchObject({ performance: null, potential: null, talent: null });
    expect(await reported()).toMatchObject({ performanceBand: null, potentialBand: null, talentCategory: null });
    expect((await perf.getOnehrReview(a, review))!.result).toMatchObject({ performance: 'OU', potential: 'High', talent: 'Super Star' });
    await release([review], 'performance', 'leaders');
    expect((await viewed()).result).toMatchObject({ performance: 'OU', potential: null, talent: null });
    expect(await reported()).toMatchObject({ performanceBand: 'OU', potentialBand: null, talentCategory: null });
    await release([review], 'three', 'leaders');
    expect((await viewed()).result).toMatchObject({ performance: 'OU', potential: 'High', talent: 'Super Star' });
    // Home and task projections carry no band at all for the manager.
    expect(JSON.stringify(await perf.performanceWorkspace(U.lm))).not.toMatch(/"(OU|Super Star)"/);
    expect(JSON.stringify(await perf.pendingPerformanceTasks(U.lm, undefined))).not.toMatch(/"(OU|Super Star)"/);
  });

  it('E-2: tier reasons reach a leader for the steps hidden from them only after step 1', async () => {
    const review = await calibrated(cycleId, S[0]);
    expect(whys(await chainOf(U.lm, review))).toEqual([]);
    expect(whys(await chainOf(U.buCeo, review))).toEqual(['performance.bu', 'performance.hod', 'potential.bu', 'potential.hod']);
    expect(JSON.stringify(await chainOf(U.buCeo, review))).not.toContain('BG performance reason');
    await release([review], 'three', 'leaders');
    const lm = await chainOf(U.lm, review);
    expect(whys(lm)).toEqual(['performance.bg', 'performance.bu', 'performance.hod', 'potential.bg', 'potential.bu', 'potential.hod']);
    expect(lm!.axes[0].steps.find((s) => s.tier === 'bg')!.why).toBe('BG performance reason');
    expect(whys(await chainOf(U.buCeo, review))).toContain('performance.bg');
    // The person's own projection never carries a reason.
    const self = SU[0];
    expect(JSON.stringify(await perf.getOnehrReview(self, review))).not.toMatch(/HOD performance reason|BU performance reason|BG performance reason/);
  });
});

describe('W3-F6: leader-off while a unit is out of the cycle (D-P1-22 E7)', () => {
  type Visible = { performance: boolean; potential: boolean; talent: boolean };
  const visibleTo = (ctx: SessionContext, review: string) => withTenant(ctx, async (tx) => (await tx.execute<{ v: Visible | null }>(sql`select app.onehr_frozen_visible(${review}::uuid) as v`))[0].v);
  const reach = async (review: string) => (await withTenant(a, (tx) => tx.execute<{ leader_role: string; employment_id: string }>(sql`select leader_role, employment_id from app.onehr_release_leaders(array[${review}::uuid]) order by leader_role, employment_id`))).map((r) => [r.leader_role, r.employment_id]);
  const ledReviews = async (ctx: SessionContext) => (await perf.listOnehrLedPeople(ctx, { cycleId })).people.map((p) => p.reviewId);
  const ledTabs = async (ctx: SessionContext) => (await perf.listOnehrLedPeople(ctx, { cycleId })).tabs.map((t) => t.key).sort();
  const NONE: Visible = { performance: false, potential: false, talent: false }, ALL: Visible = { performance: true, potential: true, talent: true };
  const leftOut = async () => (await createDepartment(a, { companyId: b.companyId, name: 'Left out' })).id;

  it('an HOD, BU CEO and BG CEO whose unit is out have no leader role, notice or led row; an administrator in that unit is not stopped; Bring back restores every right', async () => {
    const review = await calibrated(cycleId, S[0]);
    await freeze(review);
    const out = await leftOut();
    const inUnit = await hireEmployee(a, { person: { fullName: 'HR administrator in the unit', primaryEmail: `${randomUUID()}@two-step.test` }, companyId: b.companyId, departmentId: out, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    const hr: SessionContext = { ...a, userId: await createAppUser(b.tenantId, inUnit.personId, 'hr_admin'), personId: inUnit.personId, roles: ['hr_admin'] };
    const excluded = [U.hod, U.buCeo, U.bgCeo];
    expect([await roleOf(U.hod, review), await roleOf(U.buCeo, review), await roleOf(U.bgCeo, review)], 'non-vacuous: each leader before the rule').toEqual(['hod', 'bu', 'bg']);
    expect(await ledReviews(U.hod), 'non-vacuous: the HOD lists the person before the rule').toContain(review);
    for (const p of [P.hod, P.buCeo, P.bgCeo]) await moveTo(p, out);
    const { saved } = await exclude(a, cycleId, b.companyId, out);
    expect(await withTenant(a, async (tx) => (await tx.execute<{ v: boolean }>(sql`select app.assessment_unit_out(${cycleId}::uuid, ${inUnit.employmentId}::uuid) as v`))[0].v), 'the administrator is in the left-out unit').toBe(true);
    for (const ctx of excluded) {
      expect(await roleOf(ctx, review)).toBeNull();
      expect(await chainOf(ctx, review)).toBeNull();
      expect(await perf.getOnehrLedPerson(ctx, review)).toBeNull();
      const led = await perf.listOnehrLedPeople(ctx, { cycleId });
      expect([led.cycles, led.people]).toEqual([[], []]);
      expect(await perf.hasLedPeople(ctx)).toBe(false);
    }
    expect([await roleOf(U.lm, review), await roleOf(U.chief, review)], 'leaders who take part keep their roles').toEqual(['lm', 'group']);
    expect(await reach(review), 'release 1 reaches only the line manager').toEqual([['lm', P.lm.employmentId]]);
    // The administrator in the left-out unit releases; only the line manager is told and written to the ledger.
    expect(await release([review], 'three', 'leaders', 'release', hr)).toMatchObject({ done: { performance: 1, potential: 1, talent: 1 }, notAllowed: 0, notified: { leaders: 1, people: 0 } });
    expect((await events('onehr.results-to-leader')).map((e) => e.subjectEmploymentId)).toEqual([P.lm.employmentId]);
    expect([...new Set((await ledger([review])).map((r) => r.recipientEmploymentId))]).toEqual([P.lm.employmentId]);
    await dispatchNotifications(a);
    const delivered = await owner.db.select({ to: schema.notification.recipientEmploymentId, title: schema.notification.title }).from(schema.notification).where(eq(schema.notification.kind, 'performance.update'));
    expect(delivered.filter((n) => n.title === 'Results released to you').map((n) => n.to), 'no release notice reaches an excluded leader').toEqual([P.lm.employmentId]);
    // Released to leaders, the frozen bands still stay masked for the excluded leaders; the administrators read them all.
    for (const ctx of excluded) expect(await visibleTo(ctx, review)).toEqual(NONE);
    expect(await visibleTo(U.lm, review)).toEqual(ALL);
    for (const admin of [a, hr]) {
      expect(await visibleTo(admin, review)).toEqual(ALL);
      expect((await perf.getOnehrReview(admin, review))!.result).toMatchObject({ performance: 'OU', potential: 'High', talent: 'Super Star' });
    }
    await bringBack(a, cycleId, saved.ruleId);
    expect([await roleOf(U.hod, review), await roleOf(U.buCeo, review), await roleOf(U.bgCeo, review)]).toEqual(['hod', 'bu', 'bg']);
    expect(await reach(review)).toEqual([['bu', P.buCeo.employmentId], ['hod', P.hod.employmentId], ['lm', P.lm.employmentId]]);
    for (const ctx of excluded) {
      expect(await visibleTo(ctx, review)).toEqual(ALL);
      expect(await ledReviews(ctx)).toContain(review);
    }
    // The same release again now tells the HOD and the BU CEO, once; the line manager is not told twice.
    expect((await release([review], 'three', 'leaders')).notified).toEqual({ leaders: 2, people: 0 });
    expect((await events('onehr.results-to-leader')).map((e) => e.subjectEmploymentId).sort()).toEqual([P.lm, P.hod, P.buCeo].map((p) => p.employmentId).sort());
  }, 120_000);

  it('per acting employment (D9): a right held through the employment that takes part stays; one held through the left-out employment goes', async () => {
    const review = await calibrated(cycleId, S[0]);
    const out = await leftOut();
    // The BU CEO's person also holds a second live employment, in the left-out department, and heads the subject's department through it.
    const second = await hireEmployee(a, { person: { id: P.buCeo.personId }, companyId: b.companyId, departmentId: out, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    await assignHod([S[0]], second);
    expect(await reach(review), 'non-vacuous: both rights before the rule').toEqual([['bu', P.buCeo.employmentId], ['hod', second.employmentId], ['lm', P.lm.employmentId]]);
    expect(await ledTabs(U.buCeo)).toEqual(['bu', 'dept']);
    const { saved } = await exclude(a, cycleId, b.companyId, out);
    expect(await roleOf(U.buCeo, review), 'the seat is held through the employment that takes part').toBe('bu');
    expect(await reach(review)).toEqual([['bu', P.buCeo.employmentId], ['lm', P.lm.employmentId]]);
    expect(await ledTabs(U.buCeo)).toEqual(['bu']);
    expect(await chainOf(U.buCeo, review)).toMatchObject({ role: 'bu' });
    // The seat moves to the left-out employment: the person still has an employment that takes part, but it acts for nothing.
    expect(await seatBu(second)).toMatchObject({ unchanged: false });
    expect((await perf.listLeaderSeats(a, { seatType: 'bu_ceo', liveOnly: true })).map((x) => x.holderEmploymentId)).toEqual([second.employmentId]);
    expect(await roleOf(U.buCeo, review)).toBeNull();
    expect(await reach(review)).toEqual([['lm', P.lm.employmentId]]);
    expect(await ledReviews(U.buCeo)).toEqual([]);
    await bringBack(a, cycleId, saved.ruleId);
    expect(await roleOf(U.buCeo, review)).toBe('bu');
    expect(await reach(review)).toEqual([['bu', second.employmentId], ['hod', second.employmentId], ['lm', P.lm.employmentId]]);
  }, 120_000);

  it('E1: a person whose unit is out leaves What you led and its counts unless their result is frozen; Bring back returns them', async () => {
    const frozen = await calibrated(cycleId, S[0]);
    await freeze(frozen);
    const working = await calibrated(cycleId, S[1]);
    const out = await leftOut();
    const counts = async (ctx: SessionContext) => {
      const led = await perf.listOnehrLedPeople(ctx, { cycleId });
      return { cycle: led.cycles.find((c) => c.id === cycleId)?.people ?? 0, tabs: Object.fromEntries(led.tabs.map((t) => [t.key, t.n])) };
    };
    const before = { lm: await counts(U.lm), bu: await counts(U.buCeo) };
    expect(before, 'non-vacuous: the four subjects (and, for the BU CEO, the leaders) before the rule').toMatchObject({ lm: { cycle: 4, tabs: { direct: 4 } }, bu: { tabs: { bu: before.bu.cycle } } });
    for (const ctx of [U.lm, U.buCeo]) expect(await ledReviews(ctx)).toEqual(expect.arrayContaining([frozen, working]));
    expect((await chainOf(U.lm, working))!.axes.map((x) => x.axis), 'non-vacuous: the working result is read before the rule').toEqual(['performance', 'potential']);
    for (const s of [S[0], S[1]]) await moveTo(s, out);
    const { saved } = await exclude(a, cycleId, b.companyId, out);
    for (const ctx of [U.lm, U.buCeo]) {
      const led = await ledReviews(ctx);
      expect(led, 'the frozen result stays (D7)').toContain(frozen);
      expect(led, 'no review of their own (E1)').not.toContain(working);
    }
    expect(await counts(U.lm)).toEqual({ cycle: 3, tabs: { direct: 3 } });
    expect(await counts(U.buCeo)).toEqual({ cycle: before.bu.cycle - 1, tabs: { bu: before.bu.cycle - 1 } });
    // The leader still leads them, but there is no working result to read: no step, no band.
    const chain = await chainOf(U.lm, working);
    expect(chain).toMatchObject({ role: 'lm', frozen: false, axes: [], talent: null });
    expect(JSON.stringify(chain)).not.toMatch(BAND);
    expect((await chainOf(U.lm, frozen))!.frozen).toBe(true);
    await bringBack(a, cycleId, saved.ruleId);
    expect({ lm: await counts(U.lm), bu: await counts(U.buCeo) }).toEqual(before);
    for (const ctx of [U.lm, U.buCeo]) expect(await ledReviews(ctx)).toEqual(expect.arrayContaining([frozen, working]));
    expect((await chainOf(U.lm, working))!.axes.map((x) => x.axis)).toEqual(['performance', 'potential']);
  }, 120_000);
});

describe('the release writer', () => {
  it('counts people outside the request: another cycle, another tenant, the administrator themself', async () => {
    const other = await openCycle('Other annual');
    const inOther = await reviewOf(other, S[0]);
    const b2 = await seedBase(); await setModule(b2.tenantId, 'performance', 'active');
    const a2 = await entitledCtx(b2);
    const foreigner = await hireEmployee(a2, { person: { fullName: 'Foreign person', primaryEmail: `${randomUUID()}@two-step.test` }, companyId: b2.companyId, departmentId: b2.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    // Every person opened into a cycle needs a grade that matches exactly one leadership framework track (frameworkFor),
    // as the first tenant's fixture gives every employment in beforeEach.
    const [foreignGrade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b2.tenantId, code: '12', name: 'Grade 12' }).returning();
    await owner.db.update(schema.employment).set({ gradeId: foreignGrade.id }).where(eq(schema.employment.tenantId, b2.tenantId));
    const { cycleId: foreignCycle } = await perf.createCycle(a2, { name: 'Foreign annual', companyId: b2.companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` });
    await perf.configureOnehrCycle(a2, foreignCycle, null, defaultPolicy(framework)); await perf.openCycle(a2, { cycleId: foreignCycle });
    const [foreignReview] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.employmentId, foreigner.employmentId));
    const own = await reviewOf(cycleId, S[1]);
    const selfAdmin: SessionContext = { ...a, userId: await createAppUser(b.tenantId, S[1].personId, 'hr_admin'), personId: S[1].personId, roles: ['hr_admin'] };
    for (const r of [inOther, own]) await decide(r === inOther ? other : cycleId, 'final', [{ review: r, emp: r === inOther ? S[0].employmentId : S[1].employmentId, performance: 'ME', potential: 'Mid' }]);
    const out = await release([inOther, foreignReview.id, own], 'three', 'leaders', 'release', selfAdmin);
    expect(out).toMatchObject({ notAllowed: 3, done: {} });
    expect(await releaseRows([inOther, foreignReview.id, own])).toEqual([]);
    await expect(perf.releaseOnehrResult(selfAdmin, own, 'performance', true)).rejects.toThrow(/another administrator/);
    await expect(release([own], 'three', 'leaders', 'release', U.lm)).rejects.toThrow(/administrator/);
  });

  it('serialises a concurrent revoke from leaders and release to employees: one is refused, the row stays consistent', async () => {
    const review = await reviewOf(cycleId, S[0]);
    await decide(cycleId, 'final', [{ review, emp: S[0].employmentId, performance: 'ME', potential: 'Mid' }]);
    await release([review], 'performance', 'leaders');
    const [toEmployees, revokeLeaders] = await Promise.all([release([review], 'performance', 'employees'), release([review], 'performance', 'leaders', 'revoke')]);
    const refusals = (toEmployees.leadersFirst.performance ?? 0) + (revokeLeaders.stillWithEmployee.performance ?? 0);
    expect(refusals).toBe(1);
    const [row] = await releaseRows([review]);
    expect(row.performanceReleasedAt !== null && row.performanceLeaderReleasedAt === null).toBe(false);
    expect(row.performanceReleasedAt === null ? 'revoked first' : 'released first').toBe(toEmployees.leadersFirst.performance ? 'revoked first' : 'released first');
  });

  it('the notice ledger is append-only, administrator-only and carries no band', async () => {
    const review = await reviewOf(cycleId, S[0]);
    await decide(cycleId, 'final', [{ review, emp: S[0].employmentId, performance: 'ME', potential: 'Mid' }]);
    await release([review], 'three', 'both');
    const book = await ledger([review]);
    expect(book.length).toBeGreaterThan(0);
    expect(Object.keys(book[0]).sort()).toEqual(['component', 'eventId', 'id', 'notifiedAt', 'notifiedBy', 'recipientEmploymentId', 'reviewId', 'step', 'tenantId']);
    expect(JSON.stringify(book)).not.toMatch(BAND);
    const [grants] = await owner.client`select string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.role_table_grants where table_name='performance_assessment_release_notice' and grantee='ai_hr_app'`;
    expect(grants.p).toBe('INSERT,SELECT');
    const [rls] = await owner.client`select relrowsecurity, relforcerowsecurity from pg_class where oid='performance_assessment_release_notice'::regclass`;
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await expect(withTenant(a, (tx) => tx.execute(sql`update performance_assessment_release_notice set step='person' where review_id=${review}::uuid`))).rejects.toThrow();
    await expect(withTenant(a, (tx) => tx.execute(sql`delete from performance_assessment_release_notice where review_id=${review}::uuid`))).rejects.toThrow();
    await expect(owner.client`delete from performance_assessment_release_notice where review_id=${review}::uuid`).rejects.toThrow(/append-only/);
    expect(await withTenant(U.lm, (tx) => tx.select().from(schema.assessmentReleaseNotice))).toEqual([]);
    const leaderEvent = (await events('onehr.results-to-leader')).find((e) => e.subjectEmploymentId === P.buCeo.employmentId)!;
    expect(Object.keys(leaderEvent.payload as object).sort()).toEqual(['both', 'count', 'cycleId', 'moved', 'units']);
    expect(leaderEvent.payload).toMatchObject({ count: 1, both: true, moved: 0, units: ['Acme Sdn Bhd'] });
    expect(JSON.stringify((await events('onehr.results-to-leader')).map((e) => e.payload))).not.toMatch(BAND);
  });

  it('the per-person panel releases both steps at once and announces one notice per person per action', async () => {
    const review = await reviewOf(cycleId, S[0]);
    await decide(cycleId, 'final', [{ review, emp: S[0].employmentId, performance: 'ME', potential: 'Mid' }]);
    await perf.releaseOnehrResult(a, review, 'performance', true);
    const [row] = await releaseRows([review]);
    expect(row.performanceLeaderReleasedAt).toBeInstanceOf(Date);
    expect(row.performanceReleasedAt).toBeInstanceOf(Date);
    expect(await events('onehr.results-to-person')).toHaveLength(1);
    await perf.releaseOnehrResult(a, review, 'performance', false);
    const [revoked] = await releaseRows([review]);
    expect([revoked.performanceLeaderReleasedAt, revoked.performanceReleasedAt]).toEqual([null, null]);
    expect(await events('onehr.results-to-person')).toHaveLength(1);
  });
});
