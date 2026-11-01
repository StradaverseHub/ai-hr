import {configureRewardFixture as saveRewardPolicy,refreshRewardFixtureBudget} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
/**
 * WP-A1 — performance and Rewards work in the shared task list (bell Task tab, Home, dashboard tile).
 *
 * THE FINDING, AS AN ASSERTION. A line manager's Home said "nothing needs you right now" while
 * /performance said "Reviews awaiting you: 9": listPendingTasks had no performance or Rewards source.
 * The first case pins the manager's performanceReview count to `managerPendingReviews` — the exact
 * queue /performance renders — on one fixture, so the two surfaces cannot disagree again.
 *
 * Every read here runs through the application role (ai_hr_app, RLS on); fixtures are written by the
 * owner connection or by the services themselves.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { isModuleEnabled } from '../core/entitlements';
import { listPendingTasks, pendingApprovalsCount, type InboxModules, type PendingTaskItem } from '../core/approvals-inbox';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { createRewardUnit, decideRewardUnit, getRewardUnit, pendingRewardReviews, pendingRewardTasks, saveRewardEntry } from '../packs/rewards/service';
import { emptyFacts } from '../packs/rewards/model';
import { PACK_TASK_KINDS } from '../lib/assigned-work';
import { HOME_TASK_KINDS } from '../lib/employee-home';
import { closeAll, createAppUser, entitledCtx, harnessSnapshot, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

// Bearer authentication is the only route seam; all pack services and RLS remain real.
let mobileCaller:SessionContext;
vi.mock('../lib/session',async original=>({...await original<typeof import('../lib/session')>(),getMobileSession:async()=>mobileCaller}));
const mobileRead=await import('../app/api/mobile/v2/pack-workspaces/[kind]/[id]/route');
const mobileDecide=await import('../app/api/mobile/v2/pack-workspaces/[kind]/[id]/decision/route');
async function nativeRead(ctx:SessionContext,kind:string,id:string){mobileCaller=ctx;const r=await mobileRead.GET(new Request(`https://hr.test/api/mobile/v2/pack-workspaces/${kind}/${id}`));expect(r.status).toBe(200);return r.json();}
async function nativeDecision(ctx:SessionContext,kind:string,id:string,body:unknown){mobileCaller=ctx;const r=await mobileDecide.POST(new Request(`https://hr.test/api/mobile/v2/pack-workspaces/${kind}/${id}/decision`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));expect(r.status).toBe(200);return r.json();}
const nativeValues=(a:{fields:{key:string;value:unknown}[]})=>Object.fromEntries(a.fields.map(f=>[f.key,f.value]));
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const ALL: InboxModules = { attendance: false, claims: false, performance: true, rewards: true };
const packKinds = new Set<string>(PACK_TASK_KINDS);
const packItems = (rows: PendingTaskItem[]) => rows.filter((row) => packKinds.has(row.kind));
const ofKind = (rows: PendingTaskItem[], kind: string) => rows.filter((row) => row.kind === kind);

let b: Base, a: SessionContext;
const hire = (name: string, companyId = b.companyId, departmentId = b.deptA) =>
  hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@wpa1.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
const as = async (personId: string, role: 'employee' | 'manager'): Promise<SessionContext> =>
  ({ ...a, userId: await createAppUser(b.tenantId, personId, role), personId, roles: [role], grants: undefined });

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'performance', 'active'); await setModule(b.tenantId, 'rewards', 'active');
  a = await entitledCtx(b);
});
afterAll(closeAll);

describe('performance work in the shared task list', () => {
  let subject: { employmentId: string; personId: string }, manager: { employmentId: string; personId: string };
  let self: SessionContext, mgr: SessionContext, matrix: { employmentId: string; ctx: SessionContext }, cycleId: string, reviewId: string;
  const view = (ctx: SessionContext = mgr) => perf.getOnehrReview(ctx, reviewId).then((v) => { if (!v) throw Error('Missing view'); return v; });

  beforeEach(async () => {
    subject = await hire('Assessment subject'); manager = await hire('Assessment manager');
    self = await as(subject.personId, 'employee'); mgr = await as(manager.personId, 'manager');
    const reports = [subject];
    for (let i = 0; i < 3; i++) reports.push(await hire(`Report ${i}`));
    const m = await hire('Matrix moderator'); matrix = { employmentId: m.employmentId, ctx: await as(m.personId, 'employee') };
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    for (const e of [...reports, manager, m]) await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.id, e.employmentId));
    for (const e of reports) await setReportingLine(a, { subordinateEmploymentId: e.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
    ({ cycleId } = await perf.createCycle(a, { name: 'WP-A1 annual assessment', companyId: b.companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }));
    const policy = defaultPolicy(framework);
    policy.profiles = [{ id: randomUUID(), companyId: b.companyId, grade: '12', name: 'Engineering', competencies: [{ id: 'skill-1', principle: 'Technical', text: 'Current skill', future: false }] }];
    await perf.configureOnehrCycle(a, cycleId, null, policy); await perf.openCycle(a, { cycleId });
    const [r] = await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, cycleId), eq(schema.performanceReview.employmentId, subject.employmentId)));
    reviewId = r.id;
  });

  it('native scorecard and competency forms use canonical assignment, reject injection/staleness, and replay once',async()=>{
    const kpiId=randomUUID();
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id:kpiId,title:'Agreed delivery',description:'Full objective description',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}],true);
    await perf.assignAssessmentKpiModerator(a,reviewId,(await view(a)).revision,kpiId,matrix.employmentId);
    expect(await nativeRead(self,'assessmentWork',reviewId)).toMatchObject({outcome:'refused',code:'not_assigned'});
    let read=await nativeRead(matrix.ctx,'assessmentWork',reviewId);expect(JSON.stringify(read)).toContain('Full objective description');
    const cmd={requestId:randomUUID(),action:'setting-approve',values:{remark:'Targets verified'},expected:read.workspace.expected};
    expect(await nativeDecision(matrix.ctx,'assessmentWork',reviewId,{...cmd,values:{...cmd.values,employmentId:subject.employmentId}})).toMatchObject({outcome:'refused',code:'decision_refused'});
    expect(await nativeDecision(matrix.ctx,'assessmentWork',reviewId,cmd)).toMatchObject({outcome:'accepted'});
    expect(await nativeDecision(matrix.ctx,'assessmentWork',reviewId,cmd)).toMatchObject({outcome:'accepted'});
    expect((await view(self)).kpis[0].settingApprovals).toHaveLength(1);
    expect(await nativeDecision(matrix.ctx,'assessmentWork',reviewId,{...cmd,values:{remark:'Different intent'}})).toMatchObject({code:'request_conflict'});
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id:kpiId,actual:2,note:'Delivered two units'}],'Delivered agreed outcomes.');
    read=await nativeRead(matrix.ctx,'assessmentWork',reviewId);const moderation=read.workspace.actions.find((a:any)=>a.id==='moderate');expect(moderation).toBeDefined();
    const values={...nativeValues(moderation),remark:'Verified the submitted outcomes.'};
    const moderated={requestId:randomUUID(),action:'moderate',values,expected:read.workspace.expected};
    expect(await nativeDecision(matrix.ctx,'assessmentWork',reviewId,moderated)).toMatchObject({outcome:'accepted'});
    expect(await nativeDecision(matrix.ctx,'assessmentWork',reviewId,moderated)).toMatchObject({outcome:'accepted'});
    expect((await view(self)).kpis[0].approvalChain?.filter(s=>s.at)).toHaveLength(1);
    await perf.submitOnehrCompetencies(self,reviewId,(await view(self)).revision,{'skill-1':{answer:'no',remark:'Still learning'}},false,'Developing through assigned work.');
    read=await nativeRead(mgr,'performanceReview',reviewId);const competency=read.workspace.actions.find((a:any)=>a.id==='competencies');expect(competency).toBeDefined();
    const c={requestId:randomUUID(),action:'competencies',values:{...nativeValues(competency),'answer:0':'yes','explain:0':'Observed successful delivery',remark:'Observed on assigned work.'},expected:read.workspace.expected};
    expect(await nativeDecision(mgr,'performanceReview',reviewId,{...c,expected:{digest:'0'.repeat(64)}})).toMatchObject({code:'stale_step'});
    expect(await nativeDecision(mgr,'performanceReview',reviewId,c)).toMatchObject({outcome:'accepted'});
    expect(await nativeDecision(mgr,'performanceReview',reviewId,c)).toMatchObject({outcome:'accepted'});
    expect((await view()).competencyStatus).toBe('reviewed');
    await setModule(b.tenantId,'performance','disabled');
    expect(await nativeRead({...mgr,entitlements:harnessSnapshot(b.tenantId)},'performanceReview',reviewId)).toMatchObject({code:'not_assigned'});
  });

  it('native career agreement records the canonical conversation and refuses a forged plan',async()=>{
    await perf.saveOnehrPlan(self,reviewId,null,{career:{aspiration:'Develop facilitation',mobility:'stay',mobilityNote:'Within current unit',targetProfileId:null},goals:[{id:randomUUID(),area:'Facilitation',dueOn:'',onJob:'Facilitate planning',fromOthers:'',formalLearning:'',status:'not_started'}]},true);
    const plan=(await view()).plans[0],read=await nativeRead(mgr,'careerPlan',plan.id);
    expect(JSON.stringify(read)).toContain('Facilitate planning');expect(JSON.stringify(read)).toContain('Within current unit');
    expect(await nativeRead(self,'careerPlan',plan.id)).toMatchObject({code:'not_assigned'});
    expect(await nativeRead(mgr,'careerPlan',randomUUID())).toMatchObject({code:'not_assigned'});
    const a=read.workspace.actions.find((a:any)=>a.id==='agree'),cmd={requestId:randomUUID(),action:'agree',values:{...nativeValues(a),conversation:'Discussed the development plan and agreed next steps.',heldOn:today},expected:read.workspace.expected};
    expect(await nativeDecision(mgr,'careerPlan',plan.id,cmd)).toMatchObject({outcome:'accepted',status:'closed'});
    expect(await nativeDecision(mgr,'careerPlan',plan.id,cmd)).toMatchObject({outcome:'accepted',status:'closed'});
    expect((await view()).plans[0]).toMatchObject({status:'closed',conversation:cmd.values.conversation,conversationHeldOn:today,revision:plan.revision+1});
  });

  it('native department calibration decisions lock the correct person and replay without another revision',async()=>{
    const kpi=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id:kpi,title:'Delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'Agreed');
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id:kpi,actual:2,note:'Delivered'}],'Delivered outcomes.');
    await perf.submitAssessmentModeration(mgr,reviewId,(await view()).revision,[{id:kpi,actual:2,note:'Verified'}],'Verified outcomes.');
    await perf.submitOnehrCompetencies(self,reviewId,(await view(self)).revision,{'skill-1':{answer:'yes',remark:'Delivered'}},false,'Demonstrated through delivery.');
    await perf.submitOnehrCompetencies(mgr,reviewId,(await view()).revision,{'skill-1':{answer:'yes',remark:'Observed'}},true,'Observed delivery.');
    const id=await perf.createOnehrCalibration(a,cycleId,{name:'Mobile department review',companyId:b.companyId,tier:'hod',reviewerUserIds:[mgr.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    const read=await nativeRead(mgr,'calibration',id);expect(read.outcome).toBe('found');
    expect(await nativeRead(self,'calibration',id)).toMatchObject({code:'not_assigned'});
    const action=read.workspace.actions.find((a:any)=>a.id===`save:performance:${reviewId}`);expect(action).toBeDefined();
    const cmd={requestId:randomUUID(),action:action.id,values:{...nativeValues(action),band:'ME',reason:'Verified department delivery'},expected:read.workspace.expected};
    expect(await nativeDecision(mgr,'calibration',id,cmd)).toMatchObject({outcome:'accepted'});
    expect(await nativeDecision(mgr,'calibration',id,cmd)).toMatchObject({outcome:'accepted'});
    const v=await perf.getOnehrCalibration(mgr,id);expect(v.session.revision).toBe(read.workspace.revision+1);expect(v.rows[0].entry.performanceLockedAt).not.toBeNull();
  });

  it('native standard performance review preserves ratings and compensation recommendations and replay',async()=>{
    const {cycleId:standard}=await perf.createCycle(a,{name:'Standard mobile review',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
    await perf.openCycle(a,{cycleId:standard});
    const [r]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,standard),eq(schema.performanceReview.employmentId,subject.employmentId)));
    const read=await nativeRead(mgr,'performanceReview',r.id);expect(read.outcome).toBe('found');
    expect(await nativeRead(self,'performanceReview',r.id)).toMatchObject({code:'not_assigned'});
    const form=read.workspace.actions.find((a:any)=>a.id==='manager-submit');expect(form).toBeDefined();
    const rating=form.fields.find((f:any)=>f.key==='managerRating').options[0].value;
    const cmd={requestId:randomUUID(),action:form.id,expected:read.workspace.expected,values:{...nativeValues(form),managerRating:rating,overallRating:rating,comments:'Verified delivery with the employee',merit:2.5,bonus:1234}};
    expect(await nativeDecision(mgr,'performanceReview',r.id,{...cmd,values:{...cmd.values,managerRating:'999'}})).toMatchObject({code:'decision_refused'});
    expect(await nativeDecision(mgr,'performanceReview',r.id,cmd)).toMatchObject({outcome:'accepted'});
    expect(await nativeDecision(mgr,'performanceReview',r.id,cmd)).toMatchObject({outcome:'accepted'});
    const saved=await perf.reviewForViewer(mgr,r.id);expect(saved).toMatchObject({status:'submitted',managerRating:Number(rating),overallRating:Number(rating),recommendedMeritPct:2.5,recommendedBonus:1234});
  });

  it('the finding: the manager\'s performanceReview tasks are exactly the /performance "Reviews awaiting you" queue', async () => {
    const awaiting = await perf.managerPendingReviews(mgr);
    expect(awaiting.length).toBeGreaterThanOrEqual(4); // non-vacuous: every report is awaiting the manager
    const tasks = await listPendingTasks(mgr, undefined, ALL);
    expect(ofKind(tasks, 'performanceReview').map((t) => t.id).sort()).toEqual(awaiting.map((r) => r.reviewId).sort());
    expect(ofKind(tasks, 'performanceReview').every((t) => t.linkPath === `/performance/review/${t.id}`)).toBe(true);
    // Home's count and the classic tile read the same list.
    expect(await pendingApprovalsCount(mgr, undefined, ALL)).toBe(tasks.filter((t) => t.kind !== 'noticeAcknowledgement').length);
    // The subject's own review is never their own task, and an unrelated employee has none.
    expect(packItems(await listPendingTasks(self, undefined, ALL))).toEqual([]);
  });

  it('a module the caller resolved as off contributes nothing — including a tenant that declined Performance', async () => {
    expect(ofKind(await listPendingTasks(mgr, undefined, ALL), 'performanceReview').length).toBeGreaterThan(0);
    expect(packItems(await listPendingTasks(mgr, undefined, { ...ALL, performance: false, rewards: false }))).toEqual([]);
    await setModule(b.tenantId, 'performance', 'disabled');
    const declined: SessionContext = { ...mgr, entitlements: harnessSnapshot(b.tenantId) };
    const modules: InboxModules = { ...ALL, performance: isModuleEnabled(declined, 'performance'), rewards: isModuleEnabled(declined, 'rewards') };
    expect(modules.performance).toBe(false);
    expect(packItems(await listPendingTasks(declined, undefined, modules))).toEqual([]);
  });

  it('assessment work and a shared career plan reach their assigned reviewer once, without any score', async () => {
    const kpiId = randomUUID();
    await perf.saveOnehrKpis(self, reviewId, (await view(self)).revision, [{ id: kpiId, title: 'Agreed delivery', description: '', weightBp: 10000, unit: 'units', scoring: { mechanism: 'A', method: 'more', rates: [0, 1, 2, 3, 4] }, moderatorEmploymentId: manager.employmentId }], true);
    await perf.assignAssessmentKpiModerator(a, reviewId, (await view(a)).revision, kpiId, matrix.employmentId);
    await perf.saveOnehrPlan(self, reviewId, null, { career: { aspiration: 'Develop facilitation', mobility: 'stay', mobilityNote: '', targetProfileId: null }, goals: [{ id: randomUUID(), area: 'Facilitation', dueOn: '', onJob: 'Facilitate planning', fromOthers: '', formalLearning: '', status: 'not_started' }] }, true);
    const plan = (await view(mgr)).plans[0];
    expect(plan?.status).toBe('shared');

    // The matrix approver owes the scorecard decision and is not the reviewer: assessment work.
    const matrixTasks = await listPendingTasks(matrix.ctx, undefined, ALL);
    expect(ofKind(matrixTasks, 'assessmentWork').map((t) => t.id)).toEqual([reviewId]);
    expect(ofKind(matrixTasks, 'performanceReview')).toEqual([]);
    // The manager already holds this review as a performanceReview, so it is not repeated as assessment
    // work; the shared plan is a separate decision on its own record.
    const managerTasks = await listPendingTasks(mgr, undefined, ALL);
    expect(ofKind(managerTasks, 'assessmentWork')).toEqual([]);
    expect(ofKind(managerTasks, 'performanceReview').map((t) => t.id)).toContain(reviewId);
    expect(ofKind(managerTasks, 'careerPlan')).toEqual([expect.objectContaining({ id: plan!.id, linkPath: `/performance/review/${reviewId}`, subjectName: 'Assessment subject' })]);
    // The subject shares their own plan; it is not their task.
    expect(packItems(await listPendingTasks(self, undefined, ALL))).toEqual([]);

    // Exactly five keys on every projected item; nothing that looks like a band, rating, score or pay.
    for (const item of packItems([...matrixTasks, ...managerTasks])) {
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'id', 'kind', 'linkPath', 'subjectName']);
      expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
    }
    expect(JSON.stringify(packItems(managerTasks))).not.toMatch(/band|rating|score|amount|salary|aspiration|Facilitat/i);
    // Every projected kind is a Home task kind: Home validates kinds and would refuse the whole card.
    for (const kind of PACK_TASK_KINDS) expect(HOME_TASK_KINDS as readonly string[]).toContain(kind);
  });

  it('the company switcher narrows performance tasks; another company and another tenant see none of them', async () => {
    const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' }).returning({ id: schema.company.id });
    const all = ofKind(await listPendingTasks(mgr, undefined, ALL), 'performanceReview');
    expect(all.length).toBeGreaterThan(0);
    expect(ofKind(await listPendingTasks(mgr, [b.companyId], ALL), 'performanceReview').map((t) => t.id).sort()).toEqual(all.map((t) => t.id).sort());
    expect(packItems(await listPendingTasks(mgr, [other.id], ALL))).toEqual([]);

    const foreign = await seedBase();
    await setModule(foreign.tenantId, 'performance', 'active'); await setModule(foreign.tenantId, 'rewards', 'active');
    // The same person and account ids presented under another tenant reach nothing of this tenant's.
    // (listPendingTasks itself refuses such a principal in its leave owner; the pack providers are asked
    // directly so the assertion is about THEIR reads, under the foreign tenant's RLS context.)
    const crossTenant: SessionContext = { ...mgr, tenantId: foreign.tenantId, entitlements: harnessSnapshot(foreign.tenantId) };
    expect(await perf.pendingPerformanceTasks(crossTenant, undefined)).toEqual([]);
    expect(await pendingRewardTasks(crossTenant, undefined)).toEqual([]);
    // A real principal of the other tenant has no task from this one either.
    const stranger = await hireEmployee({ ...a, tenantId: foreign.tenantId, userId: foreign.adminUserId, personId: undefined, roles: ['hr_admin'], entitlements: harnessSnapshot(foreign.tenantId) }, { person: { fullName: 'Foreign manager', primaryEmail: `${randomUUID()}@wpa1.test` }, companyId: foreign.companyId, departmentId: foreign.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    const strangerCtx: SessionContext = { tenantId: foreign.tenantId, userId: await createAppUser(foreign.tenantId, stranger.personId, 'manager'), personId: stranger.personId, roles: ['manager'], entitlements: harnessSnapshot(foreign.tenantId) };
    expect(packItems(await listPendingTasks(strangerCtx, undefined, ALL))).toEqual([]);
  });
});

describe('Rewards work in the shared task list', () => {
  it('a unit at the BG stage is a task for the BG member only, linked to its approval view', async () => {
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Rewards administrator', primaryEmail: `${randomUUID()}@wpa1.test` }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, a.userId!));
    a = { ...a, personId: adminPerson.id };
    const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'HQ', name: 'Headquarters' }).returning();
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    const employee = await hire('Reward Employee');
    await owner.db.update(schema.assignment).set({ businessUnitId: bu.id }).where(eq(schema.assignment.employmentId, employee.employmentId));
    await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, employee.employmentId));
    await setCompensation(a, { employmentId: employee.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    const unitId = await createRewardUnit(a, { name: 'Annual rewards', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    const view = () => getRewardUnit(a, unitId);
    const actors: Record<string, SessionContext> = {};
    for (const role of ['bu', 'bg', 'ctro', 'ec', 'pbp'] as const) {
      const p=await hire(`${role} reviewer`);
      const userId = await createAppUser(b.tenantId, p.personId, 'employee');
      actors[role] = { ...a, userId, personId: p.personId, roles: ['employee'], grants: undefined };
      await setRewardMember(a, unitId, (await view()).unit.revision, userId, role);
    }
    await setRewardMember(a, unitId, (await view()).unit.revision, a.userId!, 'payroll');
    const v = await view();
    await saveRewardPolicy(a, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] } });
    const v2 = await view();
    await saveRewardEntry(a, unitId, v2.unit.revision, v2.rows[0].id, v2.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
    await refreshRewardFixtureBudget(a,unitId);
    expect(packItems(await listPendingTasks(actors.bg, undefined, ALL))).toEqual([]); // draft: nobody's approval yet
    expect(await decideRewardUnit(actors.bu, unitId, (await view()).unit.revision, 'submit', 'Reviewed recommendations')).toBe('bg');

    const bgTasks = ofKind(await listPendingTasks(actors.bg, undefined, ALL), 'rewardReview');
    expect(bgTasks).toEqual([expect.objectContaining({ id: unitId, linkPath: `/rewards/${unitId}?view=approvals` })]);
    // The same population the /approvals Rewards card renders from.
    expect(bgTasks.map((t) => t.id)).toEqual((await pendingRewardReviews(actors.bg, [b.companyId])).map((r) => r.id));
    expect(Object.keys(bgTasks[0]).sort()).toEqual(['createdAt', 'id', 'kind', 'linkPath', 'subjectName']);
    expect(JSON.stringify(bgTasks)).not.toMatch(/5000|budget|salary|amount|bonus/i);
    for (const role of ['bu', 'pbp'] as const) expect(packItems(await listPendingTasks(actors[role], undefined, ALL))).toEqual([]);
    expect(packItems(await listPendingTasks(actors.bg, undefined, { ...ALL, rewards: false }))).toEqual([]);
    const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' }).returning({ id: schema.company.id });
    expect(packItems(await listPendingTasks(actors.bg, [other.id], ALL))).toEqual([]);
    expect(ofKind(await listPendingTasks(actors.bg, [b.companyId], ALL), 'rewardReview').map((t) => t.id)).toEqual([unitId]);
    const read=await nativeRead(actors.bg,'rewardReview',unitId);expect(read.outcome).toBe('found');expect(JSON.stringify(read)).toContain('Reward Employee');
    expect(await nativeRead(actors.pbp,'rewardReview',unitId)).toMatchObject({code:'not_assigned'});
    const cmd={requestId:randomUUID(),action:'approve',values:{reason:'Reviewed recommendations'},expected:read.workspace.expected};
    expect(await nativeDecision(actors.bg,'rewardReview',unitId,{...cmd,values:{reason:'Reviewed recommendations',salary:0}})).toMatchObject({code:'decision_refused'});
    expect(await nativeDecision(actors.bg,'rewardReview',unitId,cmd)).toMatchObject({outcome:'accepted'});
    expect(await nativeDecision(actors.bg,'rewardReview',unitId,cmd)).toMatchObject({outcome:'accepted'});
    expect((await view()).unit.status).toBe('gr');

  });
});
