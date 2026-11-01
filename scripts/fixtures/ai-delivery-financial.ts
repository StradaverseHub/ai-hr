/** Explicit fictional fixture phase only. No import-time effects, model calls or target confirmations.
 * Parent must independently admit the complete local reservation and brand-new disposable target.
 * Every monetary value below is a fictional human input; native engines own all derived figures. */
import {randomUUID} from 'node:crypto';
import {and,eq,inArray} from 'drizzle-orm';
import {aiDeliveryFixtureCalendar,type AiDeliveryFixtureContext} from './ai-delivery-fixture-context';
import * as s from '../../db/schema';
import {withTenant} from '../../db/client';
import {createBusinessUnit,createJobGrade} from '../../core/admin';
import {setEmploymentAssignment,setEmploymentGrade} from '../../core/workforce-commands';
import {setCompensation} from '../../core/comp';
import {requirePackFor} from '../../localization/registry';
import {seedPayComponentCatalog,listPayComponents,setEmploymentPayComponent,upsertPayComponent,createBatch,generatePayslips,closeBatch,createAdditionalRun,upsertPayrollCycle,prepareReviewedPayrollCloseTx} from '../../packs/payroll/service';
import {createClaimType,saveClaimDraft,submitClaim} from '../../packs/claims/service';
import * as performance from '../../packs/performance/service';
import {defaultPolicy} from '../../packs/performance/onehr/model';
import framework from '../../packs/performance/onehr/framework.json';
import {createRewardUnit,getRewardUnit,saveRewardPolicy,saveRewardEntry,previewRewardAccessChange,saveRewardAccessChange,decideRewardAccessRequest,decideRewardUnit,getRewardUnitGovernance,previewRewardSeniorMembership,saveRewardSeniorMembership,confirmRewardGovernance,saveRewardUnitInputs} from '../../packs/rewards/service';
import {REWARD_POLICY_GRADES} from '../../packs/rewards/policy-grid-validation';
import {emptyFacts,type RewardRole} from '../../packs/rewards/model';
const refuse=():never=>{throw Error('Fictional financial fixture prerequisites could not be confirmed. Preserve partial setup; do not retry automatically.');};
export type AiDeliveryFinancialFixture={
 releasedBatchId:string;closeBatchId:string;rewardBatchId:string;bonusCycleId:string;additionalRunPeriod:string;
 claimTypeId:string;claims:readonly{userId:string;draftId:string;pendingId:string}[];
 standardCycleId:string;onehrCycleId:string;performance:readonly{userId:string;standardReviewId:string;onehrReviewId:string;onehrPlanId:string}[];
 rewardUnitId:string;rewardRevision:number;payComponentId:string;
};
export async function populateAiDeliveryFinancial(c:AiDeliveryFixtureContext):Promise<AiDeliveryFinancialFixture>{
 const admin=c.bootstrapCtx,actors=[c.actors.operator,c.actors.self,...c.actors.reviewers,c.actors.peer,c.actors.manager],year=Number(c.today.slice(0,4)),effectiveFrom=`${year-1}-01-01`,{releasedPeriod}=aiDeliveryFixtureCalendar(c.today);
 if(c.period!==c.today.slice(0,7)||new Set(actors.map(a=>a.employmentId)).size!==actors.length)return refuse();
 const subjects=await c.owner.db.select({id:s.employment.id,personId:s.employment.personId,hiredOn:s.employment.hiredOn,companyId:s.employment.companyId}).from(s.employment).where(eq(s.employment.companyId,c.companyId));
 for(const actor of actors){const actual=subjects.find(e=>e.id===actor.employmentId);if(!actual||actual.personId!==actor.personId||actual.hiredOn>releasedPeriod+'-01')return refuse();}
 const grade=await createJobGrade(admin,{code:'JG12',name:'Fictional browser grade 12'}),unit=await createBusinessUnit(admin,{companyId:c.companyId,code:'AI_BROWSER_FIN',name:'Fictional browser financial unit'});
 for(const[index,actor]of actors.entries()){
  await setEmploymentGrade(admin,{employmentId:actor.employmentId,gradeId:grade.id});
  // BU authority follows an actual current assignment. Native own-person masking still hides the
  // operator's own reward; all other decision-makers stay outside this selected cohort.
  if([c.actors.self.employmentId,c.actors.operator.employmentId].includes(actor.employmentId))await setEmploymentAssignment(admin,{employmentId:actor.employmentId,effectiveDate:c.today,departmentId:c.departmentId,businessUnitId:unit.id});
  await setCompensation(admin,{employmentId:actor.employmentId,basicSalary:3000+index*100,monthlyAllowance:0,effectiveFrom});
  await requirePackFor('MY').statutory.set(admin,{personId:actor.personId,icNumber:`91070703${String(index+1).padStart(4,'0')}`,epfNumber:`FIC-EPF-${index+1}`,socsoNumber:`FIC-SOCSO-${index+1}`});
 }
 await seedPayComponentCatalog(admin);const basic=(await listPayComponents(admin)).find(item=>item.code==='BASIC');if(!basic)return refuse();
 for(const[index,actor]of actors.entries())await setEmploymentPayComponent(admin,{employmentId:actor.employmentId,componentId:basic.id,amount:3000+index*100,effectiveFrom});
 await upsertPayComponent(admin,{label:'Fictional browser stored allowance',code:'AI_BROWSER_ALLOWANCE',name:'Fictional browser stored allowance',kind:'allowance',includedInEpf:true,includedInSocsoEis:true,includedInPcb:true,includedInHrdfBase:false,isNonPayable:false,prorates:true,roundingMethod:'none'});
 const allowance=(await listPayComponents(admin)).find(item=>item.code==='AI_BROWSER_ALLOWANCE');if(!allowance)return refuse();
 for(const actor of actors)await setEmploymentPayComponent(admin,{employmentId:actor.employmentId,componentId:allowance.id,amount:100,effectiveFrom});
 const released=await createBatch(admin,{companyId:c.companyId,payPeriod:releasedPeriod});await generatePayslips(admin,{batchId:released.batchId});await closeBatch(admin,{batchId:released.batchId});
 const slips=await c.owner.db.select({id:s.payslip.id,employmentId:s.payslip.employmentId,net:s.payslip.netPay,statutory:s.payslip.statutory}).from(s.payslip).where(eq(s.payslip.batchId,released.batchId));
 for(const actor of actors)if(!slips.some(row=>row.employmentId===actor.employmentId&&row.net!==null))return refuse();
 const current=await createBatch(admin,{companyId:c.companyId,payPeriod:c.period});await generatePayslips(admin,{batchId:current.batchId});
 const bonus=await upsertPayrollCycle(admin,{companyId:c.companyId,name:'Fictional browser bonus',code:'AI_BROWSER_BONUS',runType:'bonus'});
 const rewardBatch=await createAdditionalRun(admin,{companyId:c.companyId,payPeriod:c.period,runType:'bonus',payrollCycleId:bonus.id,paymentDate:c.today});
 const claimType=await createClaimType(admin,{code:'AI_BROWSER_EXPENSE',name:'Fictional human expense',defaultTaxable:false,requiresReceipt:false,maxReceiptAgeDays:365});
 const claims:AiDeliveryFinancialFixture['claims'][number][]=[];
 for(const actor of [c.actors.operator,c.actors.self,...c.actors.reviewers]){
  const draft=await saveClaimDraft(actor.ctx,{employmentId:actor.employmentId,claimTypeId:claimType.id,amount:25,incurredOn:c.today,description:'Fictional human entered draft, not submitted.'});
  const pending=await submitClaim(actor.ctx,{employmentId:actor.employmentId,claimTypeId:claimType.id,amount:30,incurredOn:c.today,description:'Separate fictional pending expense.'});claims.push({userId:actor.userId,draftId:draft.id,pendingId:pending.id});
 }
 // Leave actual acknowledgement effects for explicit later human confirmation.
 const standard=await performance.createCycle(admin,{companyId:c.companyId,name:'Fictional released standard review',periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});await performance.openCycle(admin,{cycleId:standard.cycleId});await performance.releaseCycle(admin,{cycleId:standard.cycleId});
 const modern=await performance.createCycle(admin,{companyId:c.companyId,name:'Fictional OneHR career conversation',periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});await performance.configureOnehrCycle(admin,modern.cycleId,null,defaultPolicy(framework));await performance.openCycle(admin,{cycleId:modern.cycleId});
 const reviews=await c.owner.db.select({id:s.performanceReview.id,cycleId:s.performanceReview.cycleId,employmentId:s.performanceReview.employmentId}).from(s.performanceReview).where(inArray(s.performanceReview.cycleId,[standard.cycleId,modern.cycleId]));
 const performanceRows:AiDeliveryFinancialFixture['performance'][number][]=[];
 for(const actor of [c.actors.operator,c.actors.self,...c.actors.reviewers]){
  const old=reviews.find(r=>r.cycleId===standard.cycleId&&r.employmentId===actor.employmentId),review=reviews.find(r=>r.cycleId===modern.cycleId&&r.employmentId===actor.employmentId);if(!old||!review)return refuse();
  await performance.saveOnehrPlan(actor.ctx,review.id,null,{career:{aspiration:'Fictional facilitation development',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:randomUUID(),area:'Fictional facilitation',dueOn:'',onJob:'Human fixture workshop',fromOthers:'',formalLearning:'',status:'not_started'}]},true);
  let[plan]=await c.owner.db.select().from(s.onehrPlan).where(and(eq(s.onehrPlan.employmentId,actor.employmentId),eq(s.onehrPlan.planYear,year+1)));if(!plan)return refuse();
  await performance.reviewOnehrPlan(c.actors.manager.ctx,plan.id,plan.revision,'Fictional agreed goals','Fictional recorded career conversation',true,undefined,c.today);
  [plan]=await c.owner.db.select().from(s.onehrPlan).where(eq(s.onehrPlan.id,plan.id));if(plan?.status!=='closed'||plan.acknowledgedAt!==null)return refuse();
  performanceRows.push({userId:actor.userId,standardReviewId:old.id,onehrReviewId:review.id,onehrPlanId:plan.id});
 }
 const rewardId=await createRewardUnit(admin,{name:'Fictional approved browser reward',year,companyId:c.companyId,businessUnitId:unit.id,snapshotDate:c.today});
 const memberships:readonly[RewardRole,typeof c.actors.operator][]=[['bu',c.actors.operator],['bg',c.actors.reviewers[0]],['ctro',c.actors.reviewers[1]],['ec',c.actors.peer],['payroll',c.actors.operator]];
 // This fixture is human-authored prerequisite setup, not the later selected browser target effect.
 // Legacy membership setters now only propose: exercise the real independent approval owner.
 const checker=c.actors.manager.ctx;
 if(!checker.userId||checker.userId===admin.userId||memberships.some(([,actor])=>actor.userId===checker.userId))return refuse();
 // Establish a real independent GR checker before the first BU read. The checker is the
 // request target, so a different existing global HR reviewer approves that access request.
 const checkerPreview=await previewRewardAccessChange(admin,{unitId:rewardId,revision:(await getRewardUnit(admin,rewardId)).unit.revision,before:null,after:{userId:checker.userId,role:'gr'}});
 const {digest:checkerDigest,...checkerInput}=checkerPreview,checkerRequest=await saveRewardAccessChange(admin,checkerInput,checkerDigest);
 if(!checkerRequest.pending||(await decideRewardAccessRequest(c.actors.reviewers[0].ctx,checkerRequest.requestId,true)).status!=='approved')return refuse();
 const selection={employmentIds:[],adoptLegacy:false},governance=await getRewardUnitGovernance(admin,rewardId),selectionPreview=await previewRewardSeniorMembership(admin,rewardId,governance.revision,selection);
 await saveRewardSeniorMembership(admin,rewardId,governance.revision,selection,selectionPreview.digest);
 await confirmRewardGovernance(checker,rewardId,(await getRewardUnitGovernance(checker,rewardId)).revision,'selection');
 for(const[role,actor]of memberships){
  const preview=await previewRewardAccessChange(admin,{unitId:rewardId,revision:(await getRewardUnit(admin,rewardId)).unit.revision,before:null,after:{userId:actor.userId,role}});
  const {digest,...input}=preview,request=await saveRewardAccessChange(admin,input,digest);
  if(!request.pending||(await decideRewardAccessRequest(checker,request.requestId,true)).status!=='approved')return refuse();
  if(!(await getRewardUnit(actor.ctx,rewardId)).roles.includes(role))return refuse();
 }
 const operatorReview=await getRewardUnit(c.actors.operator.ctx,rewardId);
 if(operatorReview.rows.some(row=>row.source.personId===c.actors.operator.personId))return refuse();
 let reward=await getRewardUnit(admin,rewardId);
 const ranges=Object.fromEntries(REWARD_POLICY_GRADES.filter(grade=>grade!=='23').map(grade=>[grade,[100000,500000,1000000] as [number,number,number]]));
 ranges['12']=[300000,500000,700000];
 await saveRewardPolicy(admin,rewardId,reward.unit.revision,{...reward.unit.policy,effectiveFrom:c.today,ranges,bonusMatrix:{...reward.unit.policy.bonusMatrix,'23':[0,5000,40000,50000,60000]}});
 reward=await getRewardUnit(admin,rewardId);if(!reward.rows.length)return refuse();
 for(const row of reward.rows)await saveRewardEntry(admin,rewardId,(await getRewardUnit(admin,rewardId)).unit.revision,row.id,row.recommendation,{...emptyFacts(),reviewed:true,talent:'SCORE',performance:'ME'});
 await saveRewardUnitInputs(admin,rewardId,(await getRewardUnit(admin,rewardId)).unit.revision,{forecastCents:null,actualCents:100,targetCents:100,targetMonthsBp:20000,multiplierBp:null,branchRatings:{}},'Fictional human approved unit budget inputs');
 reward=await getRewardUnit(admin,rewardId);const revision=reward.unit.revision;await decideRewardUnit(c.actors.operator.ctx,rewardId,revision,'submit','Fictional human fixture recommendations');
 const actorFor:Partial<Record<RewardRole,typeof c.actors.operator>>={bg:c.actors.reviewers[0],gr:{...c.actors.operator,ctx:admin},ctro:c.actors.reviewers[1],ec:c.actors.peer};
 for(const role of reward.route.slice(1)){const actor=actorFor[role];if(!actor)return refuse();await decideRewardUnit(actor.ctx,rewardId,revision,'approve','Fictional human fixture review');}
 reward=await getRewardUnit(admin,rewardId);if(reward.unit.status!=='approved')return refuse();
 return {releasedBatchId:released.batchId,closeBatchId:current.batchId,rewardBatchId:rewardBatch.batchId,bonusCycleId:bonus.id,additionalRunPeriod:c.period,claimTypeId:claimType.id,claims,standardCycleId:standard.cycleId,onehrCycleId:modern.cycleId,performance:performanceRows,rewardUnitId:rewardId,rewardRevision:reward.unit.revision,payComponentId:allowance.id};
}
/** Run AFTER later Attendance/TOIL phases, which may legitimately invalidate current payroll. */
export async function finalizeAiDeliveryFinancial(c:AiDeliveryFixtureContext,fixture:AiDeliveryFinancialFixture){
 const [batch]=await c.owner.db.select({status:s.payrollBatch.status}).from(s.payrollBatch).where(and(eq(s.payrollBatch.id,fixture.closeBatchId),eq(s.payrollBatch.companyId,c.companyId)));if(batch?.status!=='processed')return refuse();
 const ids=await c.owner.db.select({id:s.payslip.employmentId}).from(s.payslip).where(eq(s.payslip.batchId,fixture.closeBatchId));if(!ids.length)return refuse();
 await generatePayslips(c.bootstrapCtx,{batchId:fixture.closeBatchId,reprocessSubset:{employmentIds:ids.map(row=>row.id),reason:'Fictional browser fixture refresh after native attendance and TOIL setup.'}});
 const ready=await withTenant(c.bootstrapCtx,tx=>prepareReviewedPayrollCloseTx(tx,c.bootstrapCtx,fixture.closeBatchId));
 return {closeBatchId:fixture.closeBatchId,review:ready.review,state:'prepared_not_closed' as const};
}
