/** ADR-0170 §3.5 step 5 — approver recommendations for a leave decision, on fictional data.
 *
 *  1. The verdict is code with two values (owner decision, 2 November 2026): recommend approve only when all
 *     four native checks pass, needs review otherwise. A blocking failure is needs review naming the failed
 *     rule with its rule version. No input, type or signed proposal can carry a reject.
 *  2. Off by default (the worker switch), halted by the tenant-wide stop switch, and only for a request
 *     assigned to the caller.
 *  3. Each computation writes one outcome record with each check's rule version; the approver's choice is
 *     appended as agreement or disagreement, and the registry's rates read it.
 *  4. The signed proposal carries the recommendation; a recommendation's own failed check never enters the
 *     proposal's checks. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {decideLeave,requestLeave} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {listOutcomeRecords} from '../core/outcome-record/record';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {listWorkers} from '../core/agent-registry/views';
import {ProposalRecommendation,issueProposal,verifyProposal} from '../core/proposals/proposal';
import {RECOMMENDATION_CHECKS,RECOMMENDATION_RESULTS,RECOMMENDATION_VERDICTS} from '../core/semantic-model/entities-recommend';
import {renderProposalCard} from '../core/proposals/card';
import {RECOMMENDER_AGENT_IDENTITY,evaluateLeaveDecision,failedRules,leaveDecisionChecks,recommendLeaveDecision,recommendationText,recordRecommendationDecision,
 type LeaveDecisionFacts,type RecommendationCheck,type RecommendationVerdict} from '../core/recommenders/leave-decision';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const today='2026-11-02';
const facts=(over:Partial<LeaveDecisionFacts>={}):LeaveDecisionFacts=>({request:{startDate:'2026-11-10',endDate:'2026-11-10',days:1,hasDocument:false},balanceNow:5,
 ownLeave:{complete:true,overlappingApproved:0,overlappingPending:0},othersAway:0,
 leaveType:{allowNegativeBalance:false,maxNegativeBalance:null,requiresDocument:false,mandatoryAfterDays:null},policyVersion:'leave_type:fixture@v1',today,...over});
const results=(checks:readonly RecommendationCheck[])=>Object.fromEntries(checks.map(check=>[check.check,[check.result,check.blocking]]));

describe('the verdict is code',()=>{
 it('recommends approve only when all four checks pass',()=>{
  const checks=leaveDecisionChecks(facts());
  expect(results(checks)).toEqual({balance_covers:['pass',false],own_overlap:['pass',false],team_coverage:['pass',false],policy_limits:['pass',false]});
  expect(evaluateLeaveDecision(checks)).toBe('recommend_approve');
  expect(checks.find(check=>check.check==='balance_covers')!.ruleVersion).toBe('leave_type:fixture@v1');
 });
 it('defaults to needs review when any check is missing, absent or unusual',()=>{
  for(const missing of [{balanceNow:null},{ownLeave:null},{ownLeave:{complete:false,overlappingApproved:0,overlappingPending:0}},{othersAway:null},{leaveType:null},{policyVersion:null}] as Partial<LeaveDecisionFacts>[]){
   const checks=leaveDecisionChecks(facts(missing));
   expect(checks.some(check=>check.result==='missing'),JSON.stringify(missing)).toBe(true);
   expect(evaluateLeaveDecision(checks),JSON.stringify(missing)).toBe('needs_review');
  }
  const all=leaveDecisionChecks(facts());
  // A check that never ran counts as missing, even when every other check passed.
  for(const name of ['balance_covers','own_overlap','team_coverage','policy_limits'])expect(evaluateLeaveDecision(all.filter(check=>check.check!==name)),name).toBe('needs_review');
  expect(evaluateLeaveDecision([...all,all[0]])).toBe('needs_review');
  expect(evaluateLeaveDecision([])).toBe('needs_review');
  // Unusual: others away, a pending overlap, a permitted negative balance, a backdated start.
  expect(evaluateLeaveDecision(leaveDecisionChecks(facts({othersAway:2})))).toBe('needs_review');
  expect(evaluateLeaveDecision(leaveDecisionChecks(facts({ownLeave:{complete:true,overlappingApproved:0,overlappingPending:1}})))).toBe('needs_review');
  expect(evaluateLeaveDecision(leaveDecisionChecks(facts({balanceNow:0,leaveType:{allowNegativeBalance:true,maxNegativeBalance:3,requiresDocument:false,mandatoryAfterDays:null}})))).toBe('needs_review');
  expect(evaluateLeaveDecision(leaveDecisionChecks(facts({request:{startDate:'2026-10-30',endDate:'2026-10-30',days:1,hasDocument:false}})))).toBe('needs_review');
 });
 it('a blocking failure with every check read needs review and names the failed rule with its version',()=>{
  const short=leaveDecisionChecks(facts({balanceNow:0.5}));
  expect(results(short).balance_covers).toEqual(['fail',true]);expect(evaluateLeaveDecision(short)).toBe('needs_review');
  expect(failedRules(short)).toEqual([{check:'balance_covers',blocking:true,ruleVersion:'leave_type:fixture@v1'}]);
  expect(recommendationText({verdict:'needs_review',checks:short})).toContain('A leave rule would refuse this request as it stands; you decide.');
  const floor=leaveDecisionChecks(facts({balanceNow:0,leaveType:{allowNegativeBalance:true,maxNegativeBalance:0.5,requiresDocument:false,mandatoryAfterDays:null}}));
  expect(evaluateLeaveDecision(floor)).toBe('needs_review');expect(failedRules(floor).map(rule=>rule.check)).toEqual(['balance_covers']);
  const overlap=leaveDecisionChecks(facts({ownLeave:{complete:true,overlappingApproved:1,overlappingPending:0}}));
  expect(evaluateLeaveDecision(overlap)).toBe('needs_review');
  expect(failedRules(overlap)).toEqual([{check:'own_overlap',blocking:true,ruleVersion:'leave_decision_recommender:v1'}]);
  expect(failedRules(leaveDecisionChecks(facts()))).toEqual([]);
  // The same blocking failure with another check missing or unusual: a person reviews it.
  expect(evaluateLeaveDecision(leaveDecisionChecks(facts({balanceNow:0.5,othersAway:null})))).toBe('needs_review');
  expect(evaluateLeaveDecision(leaveDecisionChecks(facts({balanceNow:0.5,othersAway:1})))).toBe('needs_review');
  // A missing required document fails, but the leave engine admitted the request: needs review, not reject.
  const document=leaveDecisionChecks(facts({leaveType:{allowNegativeBalance:false,maxNegativeBalance:null,requiresDocument:true,mandatoryAfterDays:null}}));
  expect(results(document).policy_limits).toEqual(['fail',false]);expect(evaluateLeaveDecision(document)).toBe('needs_review');
  expect(results(leaveDecisionChecks(facts({request:{startDate:'2026-11-10',endDate:'2026-11-12',days:3,hasDocument:false},
   leaveType:{allowNegativeBalance:false,maxNegativeBalance:null,requiresDocument:false,mandatoryAfterDays:2}}))).policy_limits).toEqual(['fail',false]);
  expect(results(leaveDecisionChecks(facts({balanceNow:1}))).balance_covers).toEqual(['pass',false]);
 });
 it('can never produce reject: not in the type, the model, the schema, or any check combination',()=>{
  expect(RECOMMENDATION_VERDICTS).toEqual(['recommend_approve','needs_review']);
  // @ts-expect-error reject is not a verdict
  const reject:RecommendationVerdict='recommend_reject';expect(RECOMMENDATION_VERDICTS).not.toContain(reject);
  // Every combination of the four checks, each with every result and both blocking values (8^4 = 4096), plus
  // each check absent or duplicated.
  const options=RECOMMENDATION_CHECKS.map(check=>RECOMMENDATION_RESULTS.flatMap(result=>[false,true].map(blocking=>({check,owner:'core/read.ts#listLeaveRequests',ruleVersion:'fixture@v1',result,blocking}))));
  let seen=0;
  const walk=(index:number,picked:RecommendationCheck[])=>{
   if(index===options.length){seen++;const verdict=evaluateLeaveDecision(picked);
    expect(RECOMMENDATION_VERDICTS).toContain(verdict);
    expect(verdict==='recommend_approve').toBe(picked.every(check=>check.result==='pass'));
    if(picked.some(check=>check.result==='fail'))expect(failedRules(picked).length).toBeGreaterThan(0);
    for(const subset of [picked.slice(1),[...picked,picked[0]]])expect(evaluateLeaveDecision(subset)).toBe('needs_review');
    return;}
   for(const option of options[index])walk(index+1,[...picked,option]);
  };
  walk(0,[]);expect(seen).toBe(4096);
  // The signed proposal's schema refuses a reject, and an approve that names a failed rule.
  const checks=leaveDecisionChecks(facts()).map(check=>({...check}));
  const base={recommenderVersion:'leave_decision_recommender:v1',recordId:null,checks,failedRules:[]};
  expect(ProposalRecommendation.safeParse({...base,verdict:'recommend_approve'}).success).toBe(true);
  expect(ProposalRecommendation.safeParse({...base,verdict:'recommend_reject'}).success).toBe(false);
  expect(ProposalRecommendation.safeParse({...base,verdict:'recommend_approve',failedRules:[{check:'balance_covers',blocking:true,ruleVersion:null}]}).success).toBe(false);
 });
 it('words the result deterministically, naming no person or figure',()=>{
  const text=recommendationText({verdict:'needs_review',checks:leaveDecisionChecks(facts({othersAway:3}))});
  expect(text).toMatch(/^Needs your review/);expect(text).toContain('Others you can see are away');expect(text).not.toMatch(/\d/);
 });
});

describe('the proposal carries the recommendation',()=>{
 afterEach(()=>vi.unstubAllEnvs());
 it('signs a recommendation whose own check failed while the proposal checks still pass',()=>{
  vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
  const tenantId=randomUUID(),userId=randomUUID(),personId=randomUUID(),now=new Date();
  const checks=leaveDecisionChecks(facts({balanceNow:0}));
  const proposal=issueProposal({what:{action:'approvals.leave.decide',contractVersion:1,entity:'leave_approval_step',effect:'decide',selectors:{startDate:'2026-11-10',decision:'rejected'},reviewedDigest:'a'.repeat(64)},
   forWhom:{tenantId,subject:'assigned_request',subjectId:randomUUID()},authority:{kind:'person',tenantId,userId,personId},
   checks:[{check:'ai_controls_unpaused',owner:'core/assistant-action-pause.ts#assertAssistantActionUnpaused',ruleVersion:null,result:'pass'}],
   review:{route:'/assistant/approvals',href:`/assistant/approvals?review=${randomUUID()}`,reference:randomUUID()},
   recommendation:{verdict:evaluateLeaveDecision(checks),recommenderVersion:'leave_decision_recommender:v1',recordId:randomUUID(),checks:checks.map(check=>({...check})),
    failedRules:failedRules(checks).map(rule=>({...rule}))},
   createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+600_000).toISOString()});
  const caller={tenantId,userId,personId,roles:['manager']} as SessionContext;
  const verified=verifyProposal(JSON.parse(JSON.stringify(proposal)),caller,now);
  expect(verified.ok).toBe(true);
  expect(proposal.body.recommendation).toMatchObject({verdict:'needs_review',failedRules:[{check:'balance_covers',blocking:true,ruleVersion:'leave_type:fixture@v1'}]});
  expect(proposal.body.checks.every(check=>check.result!=='fail')).toBe(true);
  // Turning it into an approve while a rule failed is refused by the schema; any other edit breaks the signature.
  const approve=JSON.parse(JSON.stringify(proposal));approve.body.recommendation.verdict='recommend_approve';
  expect(verifyProposal(approve,caller,now)).toEqual({ok:false,reason:'malformed'});
  const tampered=JSON.parse(JSON.stringify(proposal));tampered.body.recommendation.failedRules[0].blocking=false;
  expect(verifyProposal(tampered,caller,now)).toEqual({ok:false,reason:'signature'});
  expect(renderProposalCard(JSON.parse(JSON.stringify(proposal)),caller,now).ok).toBe(true);
 });
});

let b:Base,hr:SessionContext,manager:SessionContext,otherManager:SessionContext,applicant:{employmentId:string;personId:string;ctx:SessionContext},
 colleague:{employmentId:string},requestId:string,date:string;
async function login(name:string,role:'employee'|'manager'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:hired.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{...hired,ctx:{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext};
}
const recommend=(ctx:SessionContext)=>recommendLeaveDecision(ctx,{leaveRequestId:requestId});

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 hr=(await login('Fictional Registry Administrator','hr_admin')).ctx;
 const boss=await login('Fictional Recommending Manager','manager');manager=boss.ctx;
 const other=await login('Fictional Unassigned Approver','manager');otherManager=other.ctx;
 applicant=await login('Fictional Leave Applicant','employee');
 colleague=await login('Fictional Team Colleague','employee');
 for(const report of [applicant.employmentId,colleague.employmentId])
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:report,managerEmploymentId:boss.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));date=next.toISOString().slice(0,10);
 requestId=(await requestLeave(applicant.ctx,{employmentId:applicant.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional recommendation reason'})).leaveRequestId;
});

describe('approver recommendations on fictional data',()=>{
 it('is off by default and records nothing until an administrator switches the worker on',async()=>{
  expect(await recommend(manager)).toEqual({kind:'unavailable',reason:'switched_off'});
  expect(await listOutcomeRecords(manager)).toHaveLength(0);
  await expect(setWorkerSwitch(manager,{workerId:'approver_recommendation',enabled:true})).rejects.toMatchObject({reason:'not_administrator'});
  await setWorkerSwitch(hr,{workerId:'approver_recommendation',enabled:true});
  const result=await recommend(manager);
  expect(result.kind).toBe('recommendation');if(result.kind!=='recommendation')return;
  expect(result.recommendation).toMatchObject({kind:'teras.recommendation',action:'approvals.leave.decide',verdict:'recommend_approve',recommenderVersion:'leave_decision_recommender:v1'});
  const policy=`leave_type:${b.annualLeaveTypeId}@v1`;
  expect(result.recommendation.checks.map(check=>[check.check,check.result,check.ruleVersion])).toEqual([
   ['balance_covers','pass',policy],['own_overlap','pass','leave_decision_recommender:v1'],['team_coverage','pass','leave_decision_recommender:v1'],['policy_limits','pass',policy]]);
  // One outcome record, readable by the approver, holding verdict and check names, never the applicant.
  const [record]=await listOutcomeRecords(manager);
  expect(record).toMatchObject({id:result.recommendation.recordId,runKind:'turn',authorityKind:'person',askedByUserId:manager.userId,agentIdentity:RECOMMENDER_AGENT_IDENTITY,
   outcomeKind:'suggested',humanInvolvement:'none',notice:'not_given',outcome:{action:'approvals.leave.decide',verdict:'recommend_approve',leaveRequestId:requestId}});
  expect(record.checks).toContainEqual({check:'balance_covers',owner:'core/read.ts#listLeaveRequests',ruleVersion:policy,result:'pass'});
  expect(JSON.stringify(record)).not.toContain('Fictional Leave Applicant');expect(JSON.stringify(record)).not.toContain('Fictional recommendation reason');
  expect(await listOutcomeRecords(applicant.ctx)).toHaveLength(0);
 });

 it('needs review when a colleague is away, and recommends reject when the balance falls below the floor',async()=>{
  await setWorkerSwitch(hr,{workerId:'approver_recommendation',enabled:true});
  const [away]=await owner.db.insert(schema.leaveRequest).values({tenantId:b.tenantId,employmentId:colleague.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date,days:'1',status:'approved'}).returning({id:schema.leaveRequest.id});
  await owner.db.insert(schema.leaveRequestDate).values({tenantId:b.tenantId,leaveRequestId:away.id,subjectEmploymentId:colleague.employmentId,leaveDate:date,days:'1',status:'approved'});
  const review=await recommend(manager);
  expect(review.kind==='recommendation'&&review.recommendation.verdict).toBe('needs_review');
  expect(review.kind==='recommendation'&&review.recommendation.checks.find(check=>check.check==='team_coverage')!.result).toBe('unusual');
  // Coverage restored, balance below what the type allows: every check read, one blocking failure, still needs review.
  await owner.db.delete(schema.leaveRequestDate).where(eq(schema.leaveRequestDate.leaveRequestId,away.id));
  await owner.db.delete(schema.leaveRequest).where(eq(schema.leaveRequest.id,away.id));
  await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:applicant.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'adjustment',days:'-10',effectiveOn:todayInKualaLumpur()});
  // The fixture type must not permit a negative balance, so the floor is zero.
  await owner.db.update(schema.leaveType).set({allowNegativeBalance:false,maxNegativeBalance:null}).where(eq(schema.leaveType.id,b.annualLeaveTypeId));
  const reject=await recommend(manager);
  expect(reject.kind==='recommendation'&&Object.fromEntries(reject.recommendation.checks.map(check=>[check.check,check.result])))
   .toEqual({balance_covers:'fail',own_overlap:'pass',team_coverage:'pass',policy_limits:'pass'});
  expect(reject.kind==='recommendation'&&reject.recommendation.verdict).toBe('needs_review');
  expect(reject.kind==='recommendation'&&reject.recommendation.failedRules).toEqual([{check:'balance_covers',blocking:true,ruleVersion:expect.stringMatching(new RegExp(`^leave_type:${b.annualLeaveTypeId}@v\\d+$`))}]);
  const records=await listOutcomeRecords(manager);
  expect(records[0].outcome).toMatchObject({verdict:'needs_review',failedRules:['balance_covers:blocking']});
  expect(records[0].checks).toContainEqual(expect.objectContaining({check:'balance_covers',result:'fail'}));
 });

 it('serves only the assigned approver, and the stop switch halts it',async()=>{
  await setWorkerSwitch(hr,{workerId:'approver_recommendation',enabled:true});
  expect(await recommend(otherManager)).toEqual({kind:'unavailable',reason:'not_assigned'});
  expect(await recommend(applicant.ctx)).toEqual({kind:'unavailable',reason:'not_assigned'});
  await setMandateStopSwitch(hr,true);
  expect(await recommend(manager)).toEqual({kind:'unavailable',reason:'stopped'});
  // No recommendation was recorded; the administrator's switch change has its own record (worker-control.switch).
  expect((await listOutcomeRecords(hr)).filter(record=>record.agentIdentity===RECOMMENDER_AGENT_IDENTITY)).toHaveLength(0);
  expect((await listOutcomeRecords(hr)).map(record=>record.agentIdentity)).toEqual(['worker-control.switch']);
 });

 it('appends the approver\'s choice as agreement, which the registry reports as a rate',async()=>{
  await setWorkerSwitch(hr,{workerId:'approver_recommendation',enabled:true});
  const result=await recommend(manager);if(result.kind!=='recommendation')throw Error('expected a recommendation');
  const before=(await listWorkers(hr)).find(row=>row.id==='approver_recommendation')!;
  expect(before.metrics).toMatchObject({measured:false,acceptanceRate:null,reversalRate:null});
  expect(before.lastRunAt).toBeInstanceOf(Date);
  // Agreement is bound to the native decision: nothing is recorded before the approver decides, nor for a decision
  // that differs from the one they made.
  await expect(recordRecommendationDecision(manager,{recordId:result.recommendation.recordId!,decision:'approved'})).resolves.toBeNull();
  await decideLeave(manager,{leaveRequestId:requestId,decision:'approved'});
  await expect(recordRecommendationDecision(manager,{recordId:result.recommendation.recordId!,decision:'rejected'})).resolves.toBeNull();
  await recordRecommendationDecision(manager,{recordId:result.recommendation.recordId!,decision:'approved'});
  const [record]=await listOutcomeRecords(manager);
  expect(record).toMatchObject({decision:'accepted',effectiveHumanInvolvement:'decided'});
  const after=(await listWorkers(hr)).find(row=>row.id==='approver_recommendation')!;
  expect(after.metrics).toMatchObject({measured:true,acceptanceRate:1,reversalRate:0,decided:1});
  // Another login cannot append to the approver's record.
  await expect(recordRecommendationDecision(otherManager,{recordId:result.recommendation.recordId!,decision:'rejected'})).resolves.toBeNull();
 });
});
