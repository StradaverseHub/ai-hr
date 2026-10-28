/**
 * P1 parity render fixture (WP-0): OneHR performance journey with PM and TM on, calibration at every tier
 * (HOD, BU, BG, Group, final; plus an open Group session for the Beta cohort), Career Plans, and Rewards
 * units at every stage, all FICTIONAL.
 *
 * It builds on scripts/dev-fixture-onehr.ts: that fixture runs first (in a child process, so its own
 * process.exit ends only itself) and its manifest is embedded under `base`. Everything P1 adds lives in
 * its own companies and logins (`p1-fixture:<key>`), so the two never share a roster.
 *
 * Usage, on a PRIVATE database (never the shared ai_hr_dev):
 *   export DATABASE_URL=…/ai_hr_dev_<you> MIGRATION_DATABASE_URL=…/ai_hr_dev_<you>  # env wins over --env-file
 *   pnpm db:migrate && pnpm db:seed
 *   perl -e 'alarm 900; exec @ARGV' node --env-file=.env.local --import tsx scripts/dev-fixture-p1.ts > p1.json
 * (macOS has no `timeout`; the perl alarm is the watchdog.) The script ends itself with process.exit:
 * db/client.ts opens pools at import, keyed by connection string, so returning from main would leave Node
 * alive on an idle pool. Re-running prints the manifest of the fixture already built; reseed to rebuild.
 *
 * Sign-in: the dev identity switcher. Set the cookie `dev_user=<userId>` (lib/session.ts) or pick the
 * person at /login. db/seed.ts seeds no per-user password, and middleware.ts skips the SHARE_PASSWORD gate
 * under NODE_ENV=development, so there is no password to supply.
 *
 * Every workflow transition goes through the kernel or pack services. Logins (app_user + base role) are
 * inserted directly, as in dev-fixture-onehr.ts: no service mints a login without an identity provider.
 * Never run by deploy; refuses real authentication, a non-demo production, or a non-demo tenant.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { DEMO_TENANT_ID, demoSeedRefusal } from '../db/seed-guard';
import { resolveEntitlementsTx } from '../core/entitlements';
import { assignRole, createBusinessUnit, createCompany, createDepartment, setCompanyParent, updateDepartment } from '../core/admin';
import { hireEmployee, setEmploymentInfo, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import * as perf from '../packs/performance/service';
import { defaultPolicy, pmBands, potentialBands, talentColumn, type PMBand, type PotentialBand } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import * as rw from '../packs/rewards/service';
import * as payroll from '../packs/payroll/service';
import { todayInKualaLumpur } from '../lib/hr-date';

const refusal = demoSeedRefusal(process.env);
if (refusal) throw Error(refusal);
const owner = createDb(process.env.MIGRATION_DATABASE_URL!);
const tenantId = DEMO_TENANT_ID;
const KEY = 'p1-fixture:';
const CYCLE = 'P1 annual (dev fixture)';
const REWARD_CYCLE = 'P1 rewards (dev fixture)';
const today = todayInKualaLumpur();
const year = Number(today.slice(0, 4));
const hiredOn = `${year - 2}-01-01`;

type Persona = SessionContext & { key: string; employmentId?: string };
const people = new Map<string, Persona>();
let entitlements: SessionContext['entitlements'];
let admin: Persona;

/** A login for an existing person. Base roles only; scoped grants go through assignRole. */
async function login(key: string, personId: string, role: 'employee' | 'manager' | 'hr_admin', employmentId?: string): Promise<Persona> {
  const [u] = await owner.db.insert(s.appUser).values({ tenantId, personId, workosUserId: KEY + key, onboardedAt: new Date() }).returning();
  await owner.db.insert(s.roleAssignment).values({ tenantId, appUserId: u.id, role });
  const p: Persona = { tenantId, userId: u.id, personId, roles: [role], entitlements, key, employmentId };
  people.set(key, p);
  return p;
}

async function hire(key: string, name: string, at: { companyId: string; departmentId: string; businessUnitId: string }, role: 'employee' | 'manager', gradeId: string) {
  const h = await hireEmployee(admin, { person: { fullName: name, primaryEmail: `p1-${key}@demo.test` }, companyId: at.companyId, departmentId: at.departmentId, businessUnitId: at.businessUnitId, gradeId, employmentType: 'full_time', hiredOn });
  return login(key, h.personId, role, h.employmentId);
}

function must<T>(v: T | undefined | null, what: string): T { if (v == null) throw Error(`Fixture: ${what} missing.`); return v; }

// ── Performance cohort: who is in which journey state (also printed in the manifest). ───────────────────
const CALIBRATED_A = ['a1', 'a2', 'a3', 'a4', 'a5'] as const;
const CALIBRATED_B = ['b1', 'b2', 'b3'] as const;
/** HOD department-review bands: one person in every Talent Box column (low/mid/high) and row (Low/Mid/High). */
const HOD_BANDS: Record<(typeof CALIBRATED_A)[number], [PMBand, PotentialBand]> = {
  a1: ['OU', 'High'], a2: ['AE', 'Mid'], a3: ['ME', 'Mid'], a4: ['BE', 'Low'], a5: ['ME', 'High'],
};
const REVIEW_STATES: Record<string, string> = {
  a1: 'manager rating confirmed; competencies done; calibrated HOD, BU, BG, Group and final; Career Plan reviewed (closed)',
  a2: 'manager rating confirmed; competencies done; calibrated HOD, BU, BG, Group; Career Plan shared, awaiting reviewer',
  a3: 'manager rating confirmed; competencies done; calibrated HOD, BU, BG, Group; Career Plan draft',
  a4: 'manager rating confirmed; competencies done; calibrated HOD, BU, BG, Group',
  a5: 'manager rating confirmed; competencies done; calibrated HOD, BU, BG, Group',
  a6: 'scorecard proposed, awaiting the line manager (mgr-a)',
  a7: 'scorecard proposed, awaiting the line manager (mgr-a)',
  a8: 'scorecard proposed, awaiting the line manager (mgr-a)',
  a9: 'results submitted, awaiting the line manager moderation (mgr-a)',
  b1: 'manager rating confirmed; in HOD Beta and BU Beta (both open) and BG (unit Beta open); in the open Group session (group-chief-open)',
  b2: 'manager rating confirmed; in HOD Beta and BU Beta (both open) and BG (unit Beta open); in the open Group session (group-chief-open)',
  b3: 'manager rating confirmed; in HOD Beta and BU Beta (both open) and BG (unit Beta open); in the open Group session (group-chief-open)',
  b4: 'scorecard draft saved, not proposed',
  b5: 'not started',
};
const REWARD_STAGES = ['draft', 'bg', 'gr', 'ctro', 'ec', 'approved', 'posted', 'returned'] as const;
type RewardStage = (typeof REWARD_STAGES)[number];
/** Seats every reward unit carries. The fixture administrator also holds gr (creator) and payroll (posting). */
const SEATS = ['bu', 'bg', 'gr', 'ctro', 'ec', 'pbp', 'payroll'] as const;

async function build() {
  entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, tenantId));
  const [adminPerson] = await owner.db.insert(s.person).values({ tenantId, fullName: 'P1 Administrator', primaryEmail: 'p1-admin@demo.test' }).returning();
  admin = await login('admin', adminPerson.id, 'hr_admin');
  const a = admin;
  let [grade] = await owner.db.select().from(s.jobGrade).where(and(eq(s.jobGrade.tenantId, tenantId), eq(s.jobGrade.code, '12')));
  if (!grade) [grade] = await owner.db.insert(s.jobGrade).values({ tenantId, code: '12', name: 'Grade 12' }).returning();

  // ── Org: a holding company (the BG) over two operating companies; a department tree in Alpha. ─────────
  const company = async (legalName: string, companyLabel: string) => (await createCompany(a, { legalName, companyLabel })).id;
  const H = await company('P1 Holdings (dev fixture)', 'P1-HOLD');
  const A = await company('P1 Alpha (dev fixture)', 'P1-ALPHA');
  const B = await company('P1 Beta (dev fixture)', 'P1-BETA');
  await setCompanyParent(a, { companyId: A, parentCompanyId: H });
  await setCompanyParent(a, { companyId: B, parentCompanyId: H });
  const unit = async (companyId: string, code: string, name: string) => (await createBusinessUnit(a, { companyId, code, name })).id;
  const buH = await unit(H, 'P1H', 'P1 Holdings office'), buA = await unit(A, 'P1A', 'P1 Alpha unit'), buB = await unit(B, 'P1B', 'P1 Beta unit');
  const dH = (await createDepartment(a, { companyId: H, name: 'P1 Holdings leadership', businessUnitId: buH })).id;
  const divA = (await createDepartment(a, { companyId: A, name: 'P1 Alpha division', businessUnitId: buA })).id;
  const engA = (await createDepartment(a, { companyId: A, name: 'P1 Alpha engineering', parentDepartmentId: divA, businessUnitId: buA })).id;
  const dB = (await createDepartment(a, { companyId: B, name: 'P1 Beta operations', businessUnitId: buB })).id;
  const atH = { companyId: H, departmentId: dH, businessUnitId: buH };
  const atDivA = { companyId: A, departmentId: divA, businessUnitId: buA }, atEngA = { companyId: A, departmentId: engA, businessUnitId: buA };
  const atB = { companyId: B, departmentId: dB, businessUnitId: buB };

  // Calibration reviewers and the partner sit in the holding company, outside the cycle's eligibility.
  const hod = await hire('hod', 'P1 Department Reviewer', atH, 'manager', grade.id);
  const buceo = await hire('bu-ceo', 'P1 BU Reviewer', atH, 'manager', grade.id);
  const bgceo = await hire('bg-ceo', 'P1 BG Reviewer', atH, 'manager', grade.id);
  const chief = await hire('group-chief', 'P1 Group Reviewer', atH, 'manager', grade.id);
  const chiefOpen = await hire('group-chief-open', 'P1 Open Group Reviewer', atH, 'manager', grade.id);
  const partner = await hire('perf-partner', 'P1 Performance Partner', atH, 'employee', grade.id);
  await assignRole(a, { appUserId: partner.userId!, role: 'performance_partner', companyId: A });

  // Department tree: the division head sees the engineering department through the tree but reviews no one.
  const deptHead = await hire('dept-head', 'P1 Division Head', atDivA, 'manager', grade.id);
  const mgrA = await hire('mgr-a', 'P1 Line Manager A', atEngA, 'manager', grade.id);
  await updateDepartment(a, { id: divA, name: 'P1 Alpha division', headEmploymentId: deptHead.employmentId });
  await updateDepartment(a, { id: engA, name: 'P1 Alpha engineering', headEmploymentId: mgrA.employmentId });
  const mgrB = await hire('mgr-b', 'P1 Line Manager B', atB, 'manager', grade.id);
  for (let i = 1; i <= 9; i++) {
    const p = await hire(`a${i}`, `P1 Alpha Employee ${i}`, atEngA, 'employee', grade.id);
    await setReportingLine(a, { subordinateEmploymentId: p.employmentId!, managerEmploymentId: mgrA.employmentId!, lineType: 'administrative', validFrom: hiredOn });
  }
  for (let i = 1; i <= 5; i++) {
    const p = await hire(`b${i}`, `P1 Beta Employee ${i}`, atB, 'employee', grade.id);
    await setReportingLine(a, { subordinateEmploymentId: p.employmentId!, managerEmploymentId: mgrB.employmentId!, lineType: 'administrative', validFrom: hiredOn });
  }

  // ── Cycle: year-end, PM + TM + IDP on, one competency profile per operating company. ──────────────────
  const { cycleId } = await perf.createCycle(a, { companyId: null, name: CYCLE, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, eligibilityRules: { companyIds: [A, B] } });
  const policy = defaultPolicy(framework);
  policy.modules = { pm: true, tm: true, idp: true, evidence: false };
  // Advisory curve: a five-person cohort spread across every Talent Box column cannot meet the reference
  // curve, so the BU reviewer locks with a recorded override reason instead (strict mode forbids one).
  policy.curveStrict = false;
  policy.profiles = [A, B].map(companyId => ({ id: randomUUID(), companyId, grade: '12', name: 'P1 delivery profile', competencies: [
    { id: 'p1-current', principle: 'Technical', text: 'Delivers reliable work to the agreed standard', future: false },
    { id: 'p1-future', principle: 'Technical', text: 'Coaches colleagues to improve their work', future: true },
  ] }));
  await perf.configureOnehrCycle(a, cycleId, null, policy);
  await perf.openCycle(a, { cycleId });
  const reviewOf = async (p: Persona) => must((await owner.db.select().from(s.onehrReview).where(and(eq(s.onehrReview.cycleId, cycleId), eq(s.onehrReview.employmentId, p.employmentId!))))[0], `review for ${p.key}`).reviewId;
  const rev = async (ctx: SessionContext, rid: string) => must(await perf.getOnehrReview(ctx, rid), 'review view').revision;
  const kpi = (title: string, moderator: Persona) => ({ id: randomUUID(), title, description: 'Fictional measure agreed for the fixture.', weightBp: 10000, unit: 'milestones', scoring: { mechanism: 'A' as const, method: 'more' as const, rates: [0, 1, 2, 3, 4] }, moderatorEmploymentId: moderator.employmentId! });
  const answers = { 'p1-current': { answer: 'yes', remark: '' }, 'p1-future': { answer: 'yes', remark: '' } };

  async function rated(key: string, manager: Persona, actual: number, competencies: boolean) {
    const p = people.get(key)!, rid = await reviewOf(p), k = kpi('Deliver the agreed milestones', manager);
    await perf.saveOnehrKpis(p, rid, await rev(p, rid), [k], true);
    await perf.approveOnehrScorecard(manager, rid, await rev(manager, rid), true, 'Objectives agreed.');
    await perf.submitOnehrResults(p, rid, await rev(p, rid), [{ id: k.id, actual, note: 'Fictional delivery record.' }], 'Delivered the agreed milestones this year.');
    await perf.moderateOnehrKpi(manager, rid, await rev(manager, rid), k.id, actual, 'Verified.');
    // The confirmed band must equal the calculated one; try each band and keep the one the service accepts.
    let confirmed: PMBand | null = null;
    for (const band of pmBands) {
      try { await perf.confirmOnehrPerformance(manager, rid, await rev(manager, rid), band, ''); confirmed = band; break; }
      catch (e) { if (!/calculated/i.test((e as Error).message)) throw e; }
    }
    must(confirmed, `confirmed band for ${key}`);
    if (competencies) {
      await perf.submitOnehrCompetencies(p, rid, await rev(p, rid), answers, false, 'Consistent delivery this year.');
      await perf.submitOnehrCompetencies(manager, rid, await rev(manager, rid), answers, true, 'Consistent delivery this year.');
    }
    return rid;
  }
  const rid: Record<string, string> = {};
  for (const [i, key] of CALIBRATED_A.entries()) rid[key] = await rated(key, mgrA, [2, 3, 2, 1, 4][i], true);
  for (const [i, key] of CALIBRATED_B.entries()) rid[key] = await rated(key, mgrB, [2, 3, 1][i], false);
  // Three scorecards awaiting the line manager's approval, and one result awaiting moderation.
  for (const key of ['a6', 'a7', 'a8']) {
    const p = people.get(key)!, r = await reviewOf(p);
    await perf.saveOnehrKpis(p, r, await rev(p, r), [kpi('Deliver the agreed milestones', mgrA)], true);
  }
  {
    const p = people.get('a9')!, r = await reviewOf(p), k = kpi('Deliver the agreed milestones', mgrA);
    await perf.saveOnehrKpis(p, r, await rev(p, r), [k], true);
    await perf.approveOnehrScorecard(mgrA, r, await rev(mgrA, r), true, 'Objectives agreed.');
    await perf.submitOnehrResults(p, r, await rev(p, r), [{ id: k.id, actual: 2, note: 'Fictional delivery record.' }], 'Delivered the agreed milestones this year.');
  }
  { const p = people.get('b4')!, r = await reviewOf(p); await perf.saveOnehrKpis(p, r, await rev(p, r), [kpi('Draft operations measure', mgrB)], false); }

  // ── Career Plans (next plan year): reviewed and closed, shared awaiting the reviewer, draft. ──────────
  const plan = (area: string) => ({ career: { aspiration: 'Grow into a senior specialist role', mobility: 'stay' as const, mobilityNote: '', targetProfileId: null }, goals: [{ id: randomUUID(), area, dueOn: `${year + 1}-06-30`, onJob: 'Lead one delivery review each month', fromOthers: 'Pair with an experienced colleague', formalLearning: 'Complete a structured course', status: 'not_started' as const }] });
  for (const [key, share] of [['a1', true], ['a2', true], ['a3', false]] as const) {
    const p = people.get(key)!;
    await perf.saveOnehrPlan(p, rid[key], null, plan(key === 'a3' ? 'Stakeholder communication' : 'Technical leadership'), share);
  }
  {
    const [p1] = await owner.db.select().from(s.onehrPlan).where(eq(s.onehrPlan.employmentId, people.get('a1')!.employmentId!));
    await perf.reviewOnehrPlan(mgrA, p1.id, p1.revision, 'Agreed the development goals and the support needed.', 'Discussed career direction and the next steps.', true);
  }

  // ── Calibration, every tier. Reviewers are granted per session through reviewerUserIds. ─────────────
  const crev = async (ctx: SessionContext, sid: string) => (await perf.getOnehrCalibration(ctx, sid)).session.revision;
  const ids = (keys: readonly string[]) => keys.map(k => rid[k]);
  const reason = 'Fixture cohort is too small to follow the reference curve.';
  const hodA = await perf.createOnehrCalibration(a, cycleId, { name: 'P1 HOD Alpha', companyId: A, tier: 'hod', reviewerUserIds: [hod.userId!], reviewIds: ids(CALIBRATED_A), pbtAchievement: null, mode: 'after' });
  await perf.createOnehrCalibration(a, cycleId, { name: 'P1 HOD Beta', companyId: B, tier: 'hod', reviewerUserIds: [hod.userId!], reviewIds: ids(CALIBRATED_B), pbtAchievement: null, mode: 'after' });
  for (const key of CALIBRATED_A) {
    const [performance, potential] = HOD_BANDS[key];
    await perf.saveOnehrCalibration(hod, hodA, await crev(hod, hodA), { reviewId: rid[key], axis: 'both', performance, potential, performanceNote: 'Department review of the year.', potentialNote: 'Department view of readiness.' });
  }
  await perf.lockOnehrCalibration(hod, hodA, await crev(hod, hodA), '', 'both');
  const buAlpha = await perf.createOnehrCalibration(a, cycleId, { name: 'P1 BU Alpha', companyId: A, tier: 'bu', reviewerUserIds: [buceo.userId!], reviewIds: ids(CALIBRATED_A), pbtAchievement: 100, mode: 'after' });
  await perf.createOnehrCalibration(a, cycleId, { name: 'P1 BU Beta', companyId: B, tier: 'bu', reviewerUserIds: [buceo.userId!], reviewIds: ids(CALIBRATED_B), pbtAchievement: 100, mode: 'after' });
  await perf.lockOnehrCalibration(buceo, buAlpha, await crev(buceo, buAlpha), reason, 'both');
  const bg = await perf.createOnehrCalibration(a, cycleId, { name: 'P1 BG Talent Box', companyId: H, tier: 'bg', reviewerUserIds: [bgceo.userId!], reviewIds: ids([...CALIBRATED_A, ...CALIBRATED_B]), pbtAchievement: null, mode: 'after' });
  await perf.lockOnehrCalibration(bgceo, bg, await crev(bgceo, bg), reason, 'both', undefined, A);
  // Invariant the render check relies on: the BG Talent Box shows someone in every column and every row.
  const box = (await perf.getOnehrCalibration(bgceo, bg)).rows.map(r => ({ pm: r.entry.performance ?? r.currentPerformance, pot: r.entry.potential ?? r.currentPotential }));
  const columns = new Set(box.map(c => c.pm && talentColumn(c.pm))), rows = new Set(box.map(c => c.pot));
  if (!['low', 'mid', 'high'].every(c => columns.has(c as never)) || !potentialBands.every(b => rows.has(b))) throw Error(`Fixture: Talent Box coverage incomplete: ${JSON.stringify(box)}`);
  const group = await perf.createOnehrCalibration(a, cycleId, { name: 'P1 Group', companyId: null, tier: 'group', reviewerUserIds: [chief.userId!], reviewIds: ids(CALIBRATED_A), pbtAchievement: null, mode: 'after' });
  await perf.lockOnehrCalibration(chief, group, await crev(chief, group), reason, 'both');
  // An OPEN Group Talent Box (the session above is locked): the Beta cohort, rated by their line manager and
  // still open at HOD, BU and BG, so the Group reviewer can move each of them. Its own reviewer keeps the
  // locked Group session's to-do counts unchanged.
  await perf.createOnehrCalibration(a, cycleId, { name: 'P1 Group (open)', companyId: null, tier: 'group', reviewerUserIds: [chiefOpen.userId!], reviewIds: ids(CALIBRATED_B), pbtAchievement: null, mode: 'after' });
  // Final tier: HR decides a1's final band from the locked BG and Group calls (creates the final scope).
  const queue = await perf.getAssessmentFinalBands(a, group);
  const row = must(queue.rows.find(r => r.reviewId === rid.a1), 'a1 final-band row');
  await perf.decideAssessmentFinalBands(a, group, queue.sourceDigest, { action: 'decide', reviewId: rid.a1, band: must(row.suggestion?.band ?? row.group ?? row.bg, 'a1 suggested band'), reason: 'Final band confirmed after both calls.' });

  // ── Rewards: one company, one business unit per stage, one reward cycle. ──────────────────────────────
  const R = await company('P1 Rewards (dev fixture)', 'P1-RWD');
  const dR = (await createDepartment(a, { companyId: R, name: 'P1 Rewards department' })).id;
  const buSeats = await unit(R, 'P1R-SEATS', 'P1 Rewards leadership');
  const seat: Record<string, Persona> = {};
  for (const role of SEATS) seat[role] = await hire(`rw-${role}`, `P1 Rewards ${role.toUpperCase()} seat`, { companyId: R, departmentId: dR, businessUnitId: buSeats }, 'manager', grade.id);
  const stageUnit: Record<string, string> = {};
  let rewardCycleId: string | undefined;
  for (const [i, stage] of REWARD_STAGES.entries()) {
    const businessUnitId = await unit(R, `P1R-${stage.toUpperCase()}`, `P1 Rewards ${stage} unit`);
    for (const n of [1, 2]) {
      const p = await hire(`rw-${stage}-${n}`, `P1 Rewards ${stage} employee ${n}`, { companyId: R, departmentId: dR, businessUnitId }, 'employee', grade.id);
      await setEmploymentInfo(a, { employmentId: p.employmentId!, confirmationDate: `${year - 2}-04-01` });
      await setCompensation(a, { employmentId: p.employmentId!, basicSalary: 5000 + 1000 * ((i + n) % 3), effectiveFrom: hiredOn });
    }
    const uid = await rw.createRewardUnit(a, { name: REWARD_CYCLE, year, companyId: R, businessUnitId, snapshotDate: today, ...(rewardCycleId ? { cycleId: rewardCycleId } : {}) });
    rewardCycleId ??= must((await owner.db.select().from(s.rewardUnit).where(eq(s.rewardUnit.id, uid)))[0], 'reward unit').cycleId;
    stageUnit[stage] = uid;
  }
  const urev = async (ctx: SessionContext, uid: string) => (await rw.getRewardUnit(ctx, uid)).unit.revision;
  const gr = seat.gr;
  for (const stage of REWARD_STAGES) {
    const uid = stageUnit[stage];
    for (const role of SEATS) await rw.setRewardMember(a, uid, await urev(a, uid), seat[role].userId!, role);
    await rw.setRewardMember(a, uid, await urev(a, uid), a.userId!, 'payroll');
    const current = (await rw.getRewardUnit(gr, uid)).unit.policy;
    await rw.saveRewardPolicy(gr, uid, await urev(gr, uid), { ...current, patActual: 100, patTarget: 100, ranges: { '12': [300000, 600000, 1200000] } });
    // Group Rewards verifies the classification. On the unit that will be posted, employee 1 is a BG direct report.
    const v = await rw.getRewardUnit(gr, uid);
    const rows = v.rows.map(r => ({ employmentId: r.source.employmentId, facts: { ...r.facts, talent: 'SCORE' as const, performance: 'ME' as const, confidentiality: (stage === 'posted' && r.source.name.endsWith(' 1') ? 'bg' : 'standard') as 'bg' | 'standard', reviewed: true } }));
    await rw.importRewardFacts(gr, uid, await urev(gr, uid), rows);
  }
  const ok = 'Fixture review: the flagged items were checked.';
  const route: [keyof typeof seat, 'submit' | 'approve'][] = [['bu', 'submit'], ['bg', 'approve'], ['gr', 'approve'], ['ctro', 'approve'], ['ec', 'approve']];
  const steps: Record<RewardStage, number> = { draft: 0, bg: 1, gr: 2, ctro: 3, ec: 4, approved: 5, posted: 5, returned: 1 };
  for (const stage of REWARD_STAGES) {
    const uid = stageUnit[stage];
    for (const [role, action] of route.slice(0, steps[stage])) await rw.decideRewardUnit(seat[role], uid, await urev(seat[role], uid), action, ok, true);
  }
  await rw.decideRewardUnit(seat.bg, stageUnit.returned, await urev(seat.bg, stageUnit.returned), 'return', 'Returned: please revisit the merit split for this unit.');
  {
    const uid = stageUnit.posted;
    await payroll.createBatch(a, { companyId: R, payPeriod: today.slice(0, 7) });
    const choices = await rw.rewardPayrollChoices(a, uid);
    await rw.postRewardUnit(a, uid, await urev(a, uid), choices[0]?.id);
    // Off-cycle, originated by the BG seat for its direct report on the posted unit.
    const entry = must((await rw.getRewardUnit(seat.bg, uid)).rows.find(r => r.facts.confidentiality === 'bg'), 'BG direct report entry');
    await rw.createOffcycleReview(seat.bg, uid, { kind: 'adhoc', entryIds: [entry.id], effectiveFrom: `${year + 1}-03-01`, exceptionReason: '' });
  }
}

async function manifest(base: unknown) {
  const users = await owner.db.select({ userId: s.appUser.id, key: s.appUser.workosUserId, personId: s.appUser.personId, name: s.person.fullName, email: s.person.primaryEmail })
    .from(s.appUser).innerJoin(s.person, eq(s.person.id, s.appUser.personId)).where(and(eq(s.appUser.tenantId, tenantId), like(s.appUser.workosUserId, `${KEY}%`))).orderBy(asc(s.appUser.workosUserId));
  const userIds = users.map(u => u.userId), personIds = users.map(u => u.personId!);
  const grants = userIds.length ? await owner.db.select({ userId: s.roleAssignment.appUserId, role: s.roleAssignment.role, companyId: s.roleAssignment.companyId }).from(s.roleAssignment).where(inArray(s.roleAssignment.appUserId, userIds)) : [];
  const employments = personIds.length ? await owner.db.select({ id: s.employment.id, personId: s.employment.personId, companyId: s.employment.companyId }).from(s.employment).where(inArray(s.employment.personId, personIds)) : [];
  const companies = await owner.db.select({ id: s.company.id, label: s.company.companyLabel, name: s.company.legalName }).from(s.company).where(and(eq(s.company.tenantId, tenantId), like(s.company.companyLabel, 'P1-%'))).orderBy(asc(s.company.companyLabel));
  const label = (id: string | null) => companies.find(c => c.id === id)?.label ?? null;
  const keyOfPerson = (personId: string | null) => users.find(u => u.personId === personId)?.key?.slice(KEY.length) ?? null;
  const keyOfUser = (id: string) => users.find(u => u.userId === id)?.key?.slice(KEY.length) ?? id;
  const [cycle] = await owner.db.select().from(s.reviewCycle).where(and(eq(s.reviewCycle.tenantId, tenantId), eq(s.reviewCycle.name, CYCLE)));
  const reviews = cycle ? await owner.db.select({ reviewId: s.onehrReview.reviewId, personId: s.employment.personId }).from(s.onehrReview).innerJoin(s.employment, eq(s.employment.id, s.onehrReview.employmentId)).where(eq(s.onehrReview.cycleId, cycle.id)) : [];
  const sessions = cycle ? await owner.db.select().from(s.onehrCalibration).where(eq(s.onehrCalibration.cycleId, cycle.id)).orderBy(asc(s.onehrCalibration.createdAt), asc(s.onehrCalibration.id)) : [];
  const plans = reviews.length ? await owner.db.select({ id: s.onehrPlan.id, reviewId: s.onehrPlan.reviewId, status: s.onehrPlan.status, personId: s.employment.personId }).from(s.onehrPlan).innerJoin(s.employment, eq(s.employment.id, s.onehrPlan.employmentId)).where(inArray(s.onehrPlan.reviewId, reviews.map(r => r.reviewId))).orderBy(asc(s.onehrPlan.id)) : [];
  const units = await owner.db.select({ id: s.rewardUnit.id, status: s.rewardUnit.status, kind: s.rewardUnit.kind, parent: s.rewardUnit.parentUnitId, offcycle: s.rewardUnit.offcycle, code: s.businessUnit.code })
    .from(s.rewardUnit).innerJoin(s.rewardCycle, eq(s.rewardCycle.id, s.rewardUnit.cycleId)).innerJoin(s.businessUnit, eq(s.businessUnit.id, s.rewardUnit.businessUnitId))
    .where(and(eq(s.rewardUnit.tenantId, tenantId), eq(s.rewardCycle.name, REWARD_CYCLE))).orderBy(asc(s.rewardUnit.createdAt), asc(s.rewardUnit.id));
  const rewardUnits: Record<string, unknown> = {};
  for (const u of units) {
    const stage = u.kind === 'annual' ? (u.code ?? '').replace('P1R-', '').toLowerCase() : 'offcycle-bg-origin';
    const returned = stage === 'returned' ? (await owner.db.select({ reason: s.rewardDecision.reason, fromStage: s.rewardDecision.fromStage }).from(s.rewardDecision).where(and(eq(s.rewardDecision.unitId, u.id), eq(s.rewardDecision.action, 'return'))))[0] ?? null : undefined;
    rewardUnits[stage] = { unitId: u.id, status: u.status, kind: u.kind, parentUnitId: u.parent, bgOrigin: (u.offcycle as { bgOrigin?: boolean } | null)?.bgOrigin ?? null, url: `/rewards/${u.id}`, ...(returned !== undefined ? { returned } : {}) };
  }
  const reviewByKey: Record<string, string> = {};
  for (const r of reviews) { const k = keyOfPerson(r.personId); if (k) reviewByKey[k] = r.reviewId; }
  return {
    fixture: 'P1 parity render fixture (scripts/dev-fixture-p1.ts)',
    signIn: {
      method: 'dev identity switcher: cookie dev_user=<userId> (lib/session.ts), or choose the person at /login',
      password: null,
      passwordSource: 'none: db/seed.ts seeds no per-user password; middleware.ts skips the SHARE_PASSWORD gate under NODE_ENV=development',
    },
    personas: users.map(u => ({
      key: u.key!.slice(KEY.length), name: u.name, email: u.email, userId: u.userId,
      roles: grants.filter(g => g.userId === u.userId).map(g => g.companyId ? `${g.role}@${label(g.companyId)}` : g.role).sort(),
      employment: employments.filter(e => e.personId === u.personId).map(e => ({ employmentId: e.id, company: label(e.companyId) }))[0] ?? null,
    })),
    companies,
    performance: cycle ? {
      cycleId: cycle.id, cycleUrl: `/performance/${cycle.id}`,
      lineManagerHome: { persona: 'mgr-a', url: '/performance', awaiting: ['a6', 'a7', 'a8', 'a9'] },
      reviews: Object.fromEntries(Object.entries(REVIEW_STATES).map(([k, state]) => [k, { reviewId: reviewByKey[k] ?? null, state, url: reviewByKey[k] ? `/performance/review/${reviewByKey[k]}` : null }])),
      talentBoxHodBands: Object.fromEntries(Object.entries(HOD_BANDS).map(([k, [pm, pot]]) => [k, { performance: pm, potential: pot }])),
      calibration: sessions.map(x => ({
        tier: x.tier, name: x.name, sessionId: x.id, url: `/performance/assessment/calibration/${x.id}`, company: label(x.companyId), mode: x.mode,
        reviewers: (x.reviewerUserIds as string[]).map(keyOfUser), locked: !!x.lockedAt, performanceLocked: !!x.performanceLockedAt, potentialLocked: !!x.potentialLockedAt,
        ...(x.tier === 'group' ? { finalBandsUrl: `/performance/assessment/calibration/${x.id}?view=final-bands` } : {}),
      })),
      careerPlans: plans.sort((x, y) => String(keyOfPerson(x.personId)).localeCompare(String(keyOfPerson(y.personId)))).map(p => ({ persona: keyOfPerson(p.personId), planId: p.id, status: p.status, reviewId: p.reviewId, url: `/performance/review/${p.reviewId}`, reviewer: 'mgr-a' })),
      idpScopeCheck: { persona: 'dept-head', note: 'Head of P1 Alpha division, the parent department of a1-a9; not their line manager and not a plan reviewer.' },
    } : null,
    rewards: { cycle: REWARD_CYCLE, listUrl: '/rewards', units: rewardUnits, seats: Object.fromEntries(SEATS.map(r => [r, `rw-${r}`])), payrollAndPosting: 'admin' },
    base,
  };
}

async function main() {
  const [tenant] = await owner.db.select().from(s.tenant).where(eq(s.tenant.id, tenantId));
  if (!tenant) throw Error('Run db:seed first.');
  // The OneHR base fixture first, in its own process: it ends itself with process.exit.
  const baseScript = fileURLToPath(new URL('./dev-fixture-onehr.ts', import.meta.url));
  const base: unknown = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', baseScript], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20 }).toString());
  const [existing] = await owner.db.select({ id: s.appUser.id }).from(s.appUser).where(and(eq(s.appUser.tenantId, tenantId), eq(s.appUser.workosUserId, `${KEY}admin`)));
  if (!existing) await build();
  console.log(JSON.stringify(await manifest(base), null, 2));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
