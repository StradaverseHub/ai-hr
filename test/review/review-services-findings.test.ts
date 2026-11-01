/** REVIEW draft (would live at test/review/security-services-findings.test.ts). Each `REVIEW <severity>` test is
 * expected to FAIL on the current code (claude/teras-review HEAD 7d57fc6a4) and pass once the finding is fixed.
 * Static draft: not run locally (verification runs on GitHub Actions). */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../../db/schema';
import {withTenant} from '../../db/client';
import {terasOutcomeFollowup,terasOutcomeRecord} from '../../db/teras-schema';
import {nativeToolProvider} from '../../core/harness/tools';
import {setWorkerSwitch,workerRunGate} from '../../core/agent-registry/controls';
import {listWorkers} from '../../core/agent-registry/views';
import {setMandateStopSwitch} from '../../core/mandates/mandates';
import {recommendLeaveDecision,recordRecommendationDecision} from '../../core/recommenders/leave-decision';
import {newRunId,writeOutcomeRecord} from '../../core/outcome-record/record';
import {prepareSuggestedProposal} from '../../core/proposals/suggested';
import {decideLeave,requestLeave} from '../../packs/leave/service';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,setModule} from '../harness';
import {buildMatrix,nextWorkday,type Matrix} from './review-actors';

let m:Matrix;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();m=await buildMatrix();});
afterEach(()=>vi.unstubAllEnvs());

describe('explainers worker switch',()=>{
 it('fixed H1: with the explainers worker switched off (the default), the harness does not offer the explainer tools',async()=>{
  // The registry reports the switch off and the gate closed...
  expect(await workerRunGate(m.groupAdmin.ctx,'explainers')).toMatchObject({run:false});
  const row=(await listWorkers(m.groupAdmin.ctx)).find(worker=>worker.id==='explainers')!;
  expect(row.switch.on).toBe(false);
  // ...and core/explainers/capabilities.ts terasCapabilitiesFor reads that gate, so core/harness/tools.ts binds none of them.
  const offered=(await nativeToolProvider(m.employee.ctx,{companyId:m.b.companyId},false)).bindings.map(binding=>binding.name);
  for(const name of ['explain_payslip_statutory','explain_leave_entitlement','explain_attendance_day'])expect(offered,name).not.toContain(name);
 });
 it('fixed H1: switched on, the explainers are offered; the tenant stop switch withdraws them again',async()=>{
  const names=['explain_payslip_statutory','explain_leave_entitlement','explain_attendance_day'];
  // The explainers switch belongs to the assistant module: enable it and re-resolve both callers' entitlements.
  await setModule(m.b.tenantId,'assistant','active');
  const entitlements=(await entitledCtx(m.b)).entitlements;
  const admin={...m.groupAdmin.ctx,entitlements},employee={...m.employee.ctx,entitlements};
  const offered=async()=>(await nativeToolProvider(employee,{companyId:m.b.companyId},false)).bindings.map(binding=>binding.name);
  await setWorkerSwitch(admin,{workerId:'explainers',enabled:true});
  const on=await offered();
  // Each explainer is offered where its module is enabled for the employee; at least the leave one is.
  expect(on).toContain('explain_leave_entitlement');
  await setMandateStopSwitch(admin,true);
  expect(await workerRunGate(admin,'explainers')).toMatchObject({run:false,reasons:['stopped']});
  const stopped=await offered();
  for(const name of names)expect(stopped,name).not.toContain(name);
 });
});

describe('approvals chooser from a model suggestion',()=>{
 it('fixed M2: the "choose" list names only requests the caller is assigned to decide, never a visible-but-unassigned one',async()=>{
  vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
  // Two pending requests from the manager's reports. The colleague's current step is re-pointed to an HR
  // administrator, so the manager still SEES it (RLS: own report) but may not decide it.
  const assigned=(await requestLeave(m.employee.ctx,{employmentId:m.employee.employmentId,leaveTypeId:m.b.annualLeaveTypeId,startDate:nextWorkday(4),endDate:nextWorkday(4),durationType:'full_day',reason:'Fictional assigned'})).leaveRequestId;
  const unassigned=(await requestLeave(m.colleague.ctx,{employmentId:m.colleague.employmentId,leaveTypeId:m.b.annualLeaveTypeId,startDate:nextWorkday(5),endDate:nextWorkday(5),durationType:'full_day',reason:'Fictional unassigned'})).leaveRequestId;
  await owner.db.execute(sql`update public.leave_approval_step set approver_kind='hr_admin' where leave_request_id=${unassigned}::uuid`);
  const outcome=await prepareSuggestedProposal(m.manager.ctx,'approvals.leave.decide',{},'Please approve the leave');
  // Only one request is assigned, so no choice should be offered at all; and never one naming the colleague.
  expect(outcome?.kind).not.toBe('choose');
  if(outcome?.kind==='choose')expect(outcome.pending.map(row=>row.applicant)).not.toContain('Fictional Matrix Colleague');
  expect(assigned).toBeTruthy();
 });
});

describe('recommendation agreement follow-ups',()=>{
 let recordId:string,requestId:string;
 beforeEach(async()=>{
  await setWorkerSwitch(m.groupAdmin.ctx,{workerId:'approver_recommendation',enabled:true});
  requestId=(await requestLeave(m.employee.ctx,{employmentId:m.employee.employmentId,leaveTypeId:m.b.annualLeaveTypeId,startDate:nextWorkday(3),endDate:nextWorkday(3),durationType:'full_day',reason:'Fictional follow-up'})).leaveRequestId;
  const result=await recommendLeaveDecision(m.manager.ctx,{leaveRequestId:requestId});
  if(result.kind!=='recommendation'||!result.recommendation.recordId)throw Error('fixture: expected a recorded recommendation');
  // Agreement is only recorded for recommend_approve; the fixture is built so every check passes.
  expect(result.recommendation.verdict).toBe('recommend_approve');
  recordId=result.recommendation.recordId;
 });
 it('fixed M4: a group administrator cannot append a decision to another approver\'s recommendation record',async()=>{
  // Even after the approver really decided, the record's asker alone appends.
  await decideLeave(m.manager.ctx,{leaveRequestId:requestId,decision:'approved'});
  const appended=await recordRecommendationDecision(m.groupAdmin.ctx,{recordId,decision:'rejected'}).catch(()=>null);
  expect(appended).toBeNull();
  const rows=await owner.db.select().from(terasOutcomeFollowup).where(eq(terasOutcomeFollowup.recordId,recordId));
  expect(rows).toHaveLength(0);
 });
 it('fixed M4: one recommendation carries at most one agreement decision (metrics cannot be inflated by repeats)',async()=>{
  // The follow-up is bound to the native decision, so the approver decides first.
  await decideLeave(m.manager.ctx,{leaveRequestId:requestId,decision:'approved'});
  await recordRecommendationDecision(m.manager.ctx,{recordId,decision:'approved'});
  await recordRecommendationDecision(m.manager.ctx,{recordId,decision:'approved'}).catch(()=>null);
  await recordRecommendationDecision(m.manager.ctx,{recordId,decision:'approved'}).catch(()=>null);
  const rows=await owner.db.select().from(terasOutcomeFollowup).where(eq(terasOutcomeFollowup.recordId,recordId));
  expect(rows).toHaveLength(1);
  const metrics=(await listWorkers(m.groupAdmin.ctx)).find(worker=>worker.id==='approver_recommendation')!.metrics;
  expect(metrics.decided).toBe(1);
 });
 it('fixed M4: the database refuses a forged or repeated decision follow-up, whoever writes it',async()=>{
  const forged=()=>withTenant(m.manager.ctx,tx=>tx.insert(terasOutcomeFollowup).values({tenantId:m.b.tenantId,recordId,kind:'decision',decision:'accepted',humanInvolvement:'decided',byUserId:m.manager.ctx.userId!}));
  // Before any native decision, even the asker cannot append one: the policy binds it to a decided approval step.
  await expect(forged()).rejects.toThrow();
  await decideLeave(m.manager.ctx,{leaveRequestId:requestId,decision:'approved'});
  // A follow-up that contradicts the native decision is refused too.
  await expect(withTenant(m.manager.ctx,tx=>tx.insert(terasOutcomeFollowup).values({tenantId:m.b.tenantId,recordId,kind:'decision',decision:'rejected',humanInvolvement:'decided',byUserId:m.manager.ctx.userId!}))).rejects.toThrow();
  // Straight inserts under each role's own RLS: a group administrator (not the asker) is refused at the policy...
  await expect(withTenant(m.groupAdmin.ctx,tx=>tx.insert(terasOutcomeFollowup).values({tenantId:m.b.tenantId,recordId,kind:'decision',decision:'rejected',humanInvolvement:'decided',byUserId:m.groupAdmin.ctx.userId!}))).rejects.toThrow();
  // ...and the asker gets one decision row at most (unique index), however it is written.
  await forged();
  await expect(forged()).rejects.toThrow();
  expect(await owner.db.select().from(terasOutcomeFollowup).where(eq(terasOutcomeFollowup.recordId,recordId))).toHaveLength(1);
 });
});

describe('outcome record free text',()=>{
 it('fixed L-trace: the outcome record refuses free text in `trace`, as it does in `outcome`',async()=>{
  const now=new Date(),free='Fictional question text about a named colleague\'s medical leave and salary';
  const attempt=writeOutcomeRecord(m.employee.ctx,{runId:newRunId(),runKind:'turn',startedAt:now,finishedAt:now,authority:{kind:'person',askedByUserId:m.employee.ctx.userId!},
   agentIdentity:'teras.assistant',reads:[],checks:[],replay:{model:null,provider:null,instructionSet:null,specVersion:null,specDigest:null,toolCatalogue:null},
   outcomeKind:'answered',outcome:{mode:'answer'},humanInvolvement:'none',notice:'not_applicable',trace:{question:free,nested:{reply:free.repeat(50)}}});
  await expect(attempt).rejects.toThrow();
  const stored=await owner.db.select({trace:terasOutcomeRecord.trace}).from(terasOutcomeRecord).where(eq(terasOutcomeRecord.tenantId,m.b.tenantId));
  expect(JSON.stringify(stored)).not.toContain('medical');
 });
});

describe('grantor-manager definer function',()=>{
 it('fixed L-manager: a manager whose employment ends in the future may still revoke a report\'s mandate (terminated_on IS NULL is too strict)',async()=>{
  // Fixture note: teras_is_grantor_manager requires mgr.terminated_on IS NULL, while My Team (core/my-team-scope.ts)
  // treats a manager as current until terminated_on > today. Give the manager a future termination date.
  await owner.db.update(schema.employment).set({terminatedOn:'2099-12-31'}).where(eq(schema.employment.id,m.manager.employmentId));
  const [row]=await withTenant(m.manager.ctx,tx=>tx.execute(sql`select app.teras_is_grantor_manager(${m.employee.personId}::uuid) as manager`)) as unknown as {manager:boolean}[];
  expect(row.manager).toBe(true);
 });
});

void randomUUID;void setModule;
