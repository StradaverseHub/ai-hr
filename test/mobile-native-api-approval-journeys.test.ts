// @vitest-environment jsdom
/** Isolated migrated CI database. No simulator account, staging rows, tokens or provider calls.
 * Real API routes -> shipped mobile form -> explicit confirmation -> canonical owner -> real receipt replay.
 * The Node project owns the DB lifecycle; jsdom supplies only the native view/OS-dialog test ports.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { requestLeave, decideLeave, requestLeaveCancellation } from '../packs/leave/service';
import { createClaimType, setClaimPolicy, submitClaim } from '../packs/claims/service';
import { submitResignation } from '../core/offboarding';
import { createNotice, publishNotice } from '../core/notice';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { createRewardUnit, decideRewardUnit, getRewardUnit, saveRewardEntry } from '../packs/rewards/service';
import { emptyFacts } from '../packs/rewards/model';
import { configureRewardFixture, refreshRewardFixtureBudget } from './rewards-governance-fixture';
import { setRewardMember } from './rewards-access-fixture';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { nativeApiJourney, type Family } from './helpers/mobile-approval-api-journey';
import type { PackAction } from '../lib/mobile-api/v2/pack-workspaces';

let caller: SessionContext;
vi.mock('../lib/session', async original => ({ ...await original<typeof import('../lib/session')>(), getMobileSession: async () => caller }));
const routes = {
  tasks: { read: await import('../app/api/mobile/v2/tasks/[kind]/[id]/route'), write: await import('../app/api/mobile/v2/tasks/[kind]/[id]/decision/route') },
  'request-workspaces': { read: await import('../app/api/mobile/v2/request-workspaces/[kind]/[id]/route'), write: await import('../app/api/mobile/v2/request-workspaces/[kind]/[id]/decision/route') },
  'review-workspaces': { read: await import('../app/api/mobile/v2/review-workspaces/[kind]/[id]/route'), write: await import('../app/api/mobile/v2/review-workspaces/[kind]/[id]/decision/route') },
  'pack-workspaces': { read: await import('../app/api/mobile/v2/pack-workspaces/[kind]/[id]/route'), write: await import('../app/api/mobile/v2/pack-workspaces/[kind]/[id]/decision/route') },
};
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const day = (n: number) => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const monday = (() => { let n = 8; while (new Date(day(n) + 'T12:00:00Z').getUTCDay() !== 1) n++; return day(n); })();
let b: Base, root: SessionContext;
type Person = Awaited<ReturnType<typeof hire>>;
let employee: Person, manager: Person, hr: Person, outsider: Person;
async function hire(name: string, role: 'employee' | 'manager' | 'hr_admin' = 'employee') {
  const p = await hireEmployee(root, { person: { fullName: name, primaryEmail: randomUUID() + '@native-journey.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
  const ctx: SessionContext = { tenantId: b.tenantId, userId: await createAppUser(b.tenantId, p.personId, role), personId: p.personId, roles: [role], grants: [{ role, companyId: b.companyId }], entitlements: harnessSnapshot(b.tenantId) };
  return { ...p, ctx };
}
beforeAll(migrateTestDb);
beforeEach(async () => {
  await resetDb(); b = await seedBase();
  for (const module of ['attendance', 'claims', 'toil', 'performance', 'rewards']) await setModule(b.tenantId, module, 'active');
  root = { ...adminCtx(b), grants: [{ role: 'hr_admin', companyId: null }] };
  employee = await hire('Synthetic API employee'); manager = await hire('Synthetic API manager', 'manager'); hr = await hire('Synthetic API HR', 'hr_admin'); outsider = await hire('Synthetic unassigned colleague');
  await setReportingLine(root, { subordinateEmploymentId: employee.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
});
afterEach(cleanup);
afterAll(closeAll);
async function read(ctx: SessionContext, family: Family, kind: string, id: string) {
  caller = ctx;
  const r = await routes[family].read.GET(new Request(`https://hr.test/api/mobile/v2/${family}/${kind}/${id}`));
  expect(r.status).toBe(200); return r.json();
}
async function journey(ctx: SessionContext, family: Family, kind: string, id: string) {
  expect(await read(outsider.ctx, family, kind, id)).toMatchObject({ outcome: 'refused', code: 'not_assigned' });
  const reply = await read(ctx, family, kind, id);
  expect(reply.outcome).toBe('found');
  const f = nativeApiJourney({ family, kind, id, reply, loseFirstReply: true, decide: async body => {
    caller = ctx;
    const r = await routes[family].write.POST(new Request(`https://hr.test/api/mobile/v2/${family}/${kind}/${id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    expect(r.status).toBe(200); return r.json();
  } });
  return { ...f, reply };
}
async function press(name: string) {
  await waitFor(() => expect(screen.getByRole('button', { name, exact: true })).toBeTruthy(), { timeout: 10000 });
  const button = screen.getByRole('button', { name, exact: true }) as HTMLButtonElement;
  expect(button.disabled).toBe(false); fireEvent.click(button);
}
function fillPack(action: PackAction, values: Record<string, unknown>) {
  for (const f of action.fields) {
    if (!(f.key in values)) continue;
    const value = values[f.key];
    if (f.kind === 'choice') {
      const option = f.options!.find(o => o.value === String(value)); expect(option, f.key).toBeDefined();
      const group = screen.getAllByText(f.label, { exact: true }).map(n => n.parentElement!).find(n => within(n).queryByRole('button', { name: option!.label, exact: true }));
      expect(group, f.label).toBeDefined(); fireEvent.click(within(group!).getByRole('button', { name: option!.label, exact: true }));
    } else if (f.kind === 'boolean') {
      if (value !== f.value) fireEvent.click(screen.getByRole('button', { name: `${f.value === true ? '✓ ' : ''}${f.label}`, exact: true }));
    } else fireEvent.change(screen.getByLabelText(f.label), { target: { value: String(value) } });
  }
}
async function submitPack(f: Awaited<ReturnType<typeof journey>>, actionId: string, values: Record<string, unknown>) {
  const action = f.reply.workspace.actions.find((a: PackAction) => a.id === actionId) as PackAction;
  expect(action).toBeDefined(); await press(action.label); fillPack(action, values); await press('confirmAction');
  await f.confirm(); expect(f.answers[0]).toMatchObject({ outcome: 'accepted' });
  expect(f.sent[0]).toMatchObject({ action: actionId, values, expected: f.reply.workspace.expected });
}

describe('the eleven formerly fixture-blocked native approval kinds', () => {
  it('leaveCancellation: the native form cancels approved dates once despite a lost answer', async () => {
    await setLeaveApprovalPolicy(root, { companyId: b.companyId, levels: ['direct_manager'] as never });
    await owner.db.insert(s.leaveLedger).values({ tenantId: b.tenantId, employmentId: employee.employmentId, leaveTypeId: b.annualLeaveTypeId, entryType: 'accrual', days: '60', effectiveOn: today });
    const leave = await requestLeave(employee.ctx, { employmentId: employee.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: monday, endDate: monday, today });
    await decideLeave(manager.ctx, { leaveRequestId: leave.leaveRequestId, decision: 'approved', deciderEmploymentId: manager.employmentId });
    const { cancellationRequestId: id } = await requestLeaveCancellation(employee.ctx, { leaveRequestId: leave.leaveRequestId, cancelDates: [monday], today });
    const f = await journey(manager.ctx, 'tasks', 'leaveCancellation', id); await press('approvalApprove'); await f.confirm();
    expect(f.answers[0]).toEqual({ outcome: 'accepted', status: 'approved' });
    expect((await owner.db.select().from(s.leaveCancellationRequest).where(eq(s.leaveCancellationRequest.id, id)))[0].status).toBe('approved');
  });
  it('claim: the native form approves the recorded currency/amount exactly once', async () => {
    const { id: type } = await createClaimType(root, { code: 'API_JOURNEY', name: 'Synthetic transport', defaultTaxable: false, requiresReceipt: false });
    await setClaimPolicy(root, { claimTypeId: type, annualBudget: 1000, perClaimCap: 1000, effectiveFrom: `${year - 2}-01-01` });
    const { id } = await submitClaim(employee.ctx, { employmentId: employee.employmentId, claimTypeId: type, amount: 42.5, incurredOn: today, description: 'Synthetic verified transport' });
    const f = await journey(manager.ctx, 'tasks', 'claim', id);
    expect(f.reply.task).toMatchObject({ amount: '42.50', currency: 'MYR' }); await press('approvalApprove'); await f.confirm();
    expect((await owner.db.select().from(s.claimRequest).where(eq(s.claimRequest.id, id)))[0]).toMatchObject({ status: 'approved', amount: '42.50' });
  });
  it('resignation: the confirmed fixed last day survives API validation and receipt replay', async () => {
    const { requestId: id } = await submitResignation(employee.ctx, { employmentId: employee.employmentId, lastWorkingDay: day(60), reason: 'Synthetic employment outcome test' });
    const f = await journey(hr.ctx, 'request-workspaces', 'resignation', id); expect(screen.getByText(new RegExp(day(60)))).toBeTruthy();
    await press('approvalApprove'); await f.confirm(); expect(f.answers[0]).toEqual({ outcome: 'accepted', status: 'accepted' });
    expect((await owner.db.select().from(s.employment).where(eq(s.employment.id, employee.employmentId)))[0].terminatedOn).toBe(day(60));
  });
  it.each(['managerReview', 'hrReview'] as const)('%s: the shipped recommendation/advisory form uses its actual stage', async kind => {
    const [r] = await owner.db.insert(s.employmentReview).values({ tenantId: b.tenantId, employmentId: employee.employmentId, personId: employee.personId, managerEmploymentId: manager.employmentId, reviewType: 'probation', status: kind === 'managerReview' ? 'pending_manager' : 'pending_hr', endDate: monday, dueDate: today }).returning();
    const initial = (await owner.db.select().from(s.employment).where(eq(s.employment.id, employee.employmentId)))[0];
    const f = await journey(kind === 'managerReview' ? manager.ctx : hr.ctx, 'review-workspaces', kind, r.id);
    await press(kind === 'managerReview' ? f.reviewCopy.recommend_extend : f.reviewCopy.extend);
    fireEvent.change(screen.getByLabelText(f.reviewCopy.comments), { target: { value: 'Synthetic reviewed observation' } });
    if (kind === 'hrReview') fireEvent.change(screen.getByLabelText(f.reviewCopy.extension), { target: { value: day(60) } });
    await press(f.reviewCopy.submit); await f.confirm();
    expect(f.answers[0]).toEqual({ outcome: 'accepted', status: kind === 'managerReview' ? 'pending_hr' : 'completed' });
    expect((await owner.db.select().from(s.employment).where(eq(s.employment.id, employee.employmentId)))[0]).toEqual(initial);
  });
  it('noticeAcknowledgement: full versioned text reaches only its recipient, then records once', async () => {
    const body = 'Synthetic complete notice.\n\nThe second paragraph must remain visible.';
    const { id: notice } = await createNotice(root, { title: 'Synthetic mobile notice', body, startOn: today, endOn: day(30), targetMode: 'individual', employmentIds: [employee.employmentId], requiresAcknowledgement: true });
    await publishNotice(root, notice); const [n] = await owner.db.select().from(s.notice).where(eq(s.notice.id, notice));
    const f = await journey(employee.ctx, 'request-workspaces', 'noticeAcknowledgement', `${notice}:${employee.employmentId}:${n.contentVersion}`);
    expect(screen.getByText(/The second paragraph must remain visible/)).toBeTruthy(); await press(f.requestCopy.acknowledge); await f.confirm();
    expect(f.answers[0]).toEqual({ outcome: 'accepted', status: 'acknowledged' });
  });
});

async function performanceFixture(onehr = true) {
  const [grade] = await owner.db.insert(s.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Synthetic grade' }).returning();
  for (const who of [employee, manager]) await owner.db.update(s.employment).set({ gradeId: grade.id }).where(eq(s.employment.id, who.employmentId));
  const { cycleId } = await perf.createCycle(root, { name: 'Synthetic mobile journey', companyId: b.companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` });
  if (onehr) {
    const policy = defaultPolicy(framework);
    policy.profiles = [{ id: randomUUID(), companyId: b.companyId, grade: '12', name: 'Synthetic skills', competencies: [{ id: 'skill-1', principle: 'Technical', text: 'Complete observable competency statement', future: false }] }];
    await perf.configureOnehrCycle(root, cycleId, null, policy);
  }
  await perf.openCycle(root, { cycleId });
  const [record] = await owner.db.select().from(s.performanceReview).where(and(eq(s.performanceReview.cycleId, cycleId), eq(s.performanceReview.employmentId, employee.employmentId)));
  const view = async (ctx = manager.ctx) => { const v = await perf.getOnehrReview(ctx, record.id); if (!v) throw Error('Missing synthetic review'); return v; };
  return { cycleId, id: record.id, view };
}
describe('real pack workspaces through the shipped native form', () => {
  it('performanceReview: ratings and decimal recommendations reach their canonical owner', async () => {
    const p = await performanceFixture(false), f = await journey(manager.ctx, 'pack-workspaces', 'performanceReview', p.id);
    await submitPack(f, 'manager-submit', { managerRating: '3', overallRating: '3', comments: 'Synthetic verified delivery', merit: 2.5, bonus: 1234 });
    expect(await perf.reviewForViewer(manager.ctx, p.id)).toMatchObject({ status: 'submitted', managerRating: 3, overallRating: 3, recommendedMeritPct: 2.5, recommendedBonus: 1234 });
  });
  it('assessmentWork: assigned KPI approval is recorded once through the actual dynamic fields', async () => {
    const p = await performanceFixture(), kpi = randomUUID(), moderator = await hire('Synthetic matrix moderator');
    await perf.saveOnehrKpis(employee.ctx, p.id, (await p.view(employee.ctx)).revision, [{ id: kpi, title: 'Verified delivery', description: 'Full synthetic objective facts', weightBp: 10000, unit: 'units', scoring: { mechanism: 'A', method: 'more', rates: [0, 1, 2, 3, 4] }, moderatorEmploymentId: manager.employmentId }], true);
    await perf.assignAssessmentKpiModerator(root, p.id, (await p.view(root)).revision, kpi, moderator.employmentId);
    const f = await journey(moderator.ctx, 'pack-workspaces', 'assessmentWork', p.id); expect(screen.getByText(/Full synthetic objective facts/)).toBeTruthy();
    await submitPack(f, 'setting-approve', { remark: 'Synthetic targets verified by assigned reviewer' });
    expect((await p.view(employee.ctx)).kpis[0].settingApprovals).toHaveLength(1);
  });
  it('careerPlan: conversation and calendar date close the selected plan once', async () => {
    const p = await performanceFixture();
    await perf.saveOnehrPlan(employee.ctx, p.id, null, { career: { aspiration: 'Develop facilitation', mobility: 'stay', mobilityNote: 'Within synthetic unit', targetProfileId: null }, goals: [{ id: randomUUID(), area: 'Facilitation', dueOn: '', onJob: 'Facilitate synthetic planning', fromOthers: '', formalLearning: '', status: 'not_started' }] }, true);
    const plan = (await p.view()).plans[0], f = await journey(manager.ctx, 'pack-workspaces', 'careerPlan', plan.id);
    await submitPack(f, 'agree', { conversation: 'Synthetic development conversation and agreed next steps.', heldOn: today });
    expect((await p.view()).plans[0]).toMatchObject({ status: 'closed', conversationHeldOn: today, revision: plan.revision + 1 });
  });
  it('calibration: selecting an actual person and band locks only the intended entry once', async () => {
    const p = await performanceFixture(), kpi = randomUUID();
    await perf.saveOnehrKpis(employee.ctx, p.id, (await p.view(employee.ctx)).revision, [{ id: kpi, title: 'Synthetic delivery', description: '', weightBp: 10000, unit: 'units', scoring: { mechanism: 'A', method: 'more', rates: [0, 1, 2, 3, 4] }, moderatorEmploymentId: manager.employmentId }], true);
    await perf.approveOnehrScorecard(manager.ctx, p.id, (await p.view()).revision, true, 'Synthetic agreement');
    await perf.submitOnehrResults(employee.ctx, p.id, (await p.view(employee.ctx)).revision, [{ id: kpi, actual: 2, note: 'Delivered two synthetic units' }], 'Synthetic outcomes');
    await perf.submitAssessmentModeration(manager.ctx, p.id, (await p.view()).revision, [{ id: kpi, actual: 2, note: 'Verified two units' }], 'Synthetic review');
    await perf.submitOnehrCompetencies(employee.ctx, p.id, (await p.view(employee.ctx)).revision, { 'skill-1': { answer: 'yes', remark: 'Delivered' } }, false, 'Synthetic demonstrated work');
    await perf.submitOnehrCompetencies(manager.ctx, p.id, (await p.view()).revision, { 'skill-1': { answer: 'yes', remark: 'Observed' } }, true, 'Synthetic observed work');
    const id = await perf.createOnehrCalibration(root, p.cycleId, { name: 'Synthetic department calibration', companyId: b.companyId, tier: 'hod', reviewerUserIds: [manager.ctx.userId!], reviewIds: [p.id], pbtAchievement: null, mode: 'after' });
    const f = await journey(manager.ctx, 'pack-workspaces', 'calibration', id);
    await submitPack(f, `save:performance:${p.id}`, { band: 'ME', reason: 'Synthetic verified department delivery' });
    const result = await perf.getOnehrCalibration(manager.ctx, id); expect(result.session.revision).toBe(f.reply.workspace.revision + 1); expect(result.rows[0].entry.performanceLockedAt).not.toBeNull();
  });
  it('rewardReview: the assigned BG form advances to GR once and preserves real doer/checker setup', async () => {
    const [admin] = await owner.db.insert(s.person).values({ tenantId: b.tenantId, fullName: 'Synthetic Rewards administrator', primaryEmail: randomUUID() + '@native-journey.test' }).returning();
    await owner.db.update(s.appUser).set({ personId: admin.id }).where(eq(s.appUser.id, root.userId!)); root = { ...root, personId: admin.id };
    const [bu] = await owner.db.insert(s.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'SYNTHETIC', name: 'Synthetic business unit' }).returning();
    const [grade] = await owner.db.insert(s.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Synthetic grade' }).returning();
    await owner.db.update(s.assignment).set({ businessUnitId: bu.id }).where(eq(s.assignment.employmentId, employee.employmentId));
    await owner.db.update(s.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(s.employment.id, employee.employmentId));
    await setCompensation(root, { employmentId: employee.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    const id = await createRewardUnit(root, { name: 'Synthetic annual rewards', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    const view = () => getRewardUnit(root, id), actors: Record<string, SessionContext> = {};
    for (const role of ['bu', 'bg', 'ctro', 'ec', 'pbp'] as const) {
      const who = await hire(`Synthetic ${role} reviewer`); await owner.db.update(s.assignment).set({ businessUnitId: bu.id }).where(eq(s.assignment.employmentId, who.employmentId)); actors[role] = who.ctx;
      await setRewardMember(root, id, (await view()).unit.revision, who.ctx.userId!, role);
    }
    await setRewardMember(root, id, (await view()).unit.revision, root.userId!, 'payroll');
    const v = await view(); await configureRewardFixture(root, id, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] } });
    const v2 = await view(); await saveRewardEntry(root, id, v2.unit.revision, v2.rows[0].id, v2.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' }); await refreshRewardFixtureBudget(root, id);
    expect(await decideRewardUnit(actors.bu, id, (await view()).unit.revision, 'submit', 'Synthetic reviewed recommendations')).toBe('bg');
    const f = await journey(actors.bg, 'pack-workspaces', 'rewardReview', id); await submitPack(f, 'approve', { reason: 'Synthetic reviewed recommendations' });
    expect((await view()).unit.status).toBe('gr');
  });
});
