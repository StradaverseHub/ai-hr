/**
 * Reproducible local/demo OneHR assessment and Rewards fixture.
 * Run after db:seed with node --env-file=.env.local --import tsx scripts/dev-fixture-onehr.ts.
 * Own fictional company isolates the roster; native services perform every workflow transition.
 * Never run by deploy. Refuses real authentication, non-demo production, or a non-demo tenant.
 * Re-running returns the existing fixture; reseed to reconstruct it after changing workflow code.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { DEMO_TENANT_ID, demoSeedRefusal } from '../db/seed-guard';
import { resolveEntitlementsTx } from '../core/entitlements';
import { createCompany } from '../core/admin';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { createRewardUnit, getRewardUnit, importOnehrRewardResults } from '../packs/rewards/service';
import { todayInKualaLumpur } from '../lib/hr-date';

const refusal=demoSeedRefusal(process.env);if(refusal)throw Error(refusal);
const owner=createDb(process.env.MIGRATION_DATABASE_URL!);
const tenantId=DEMO_TENANT_ID,companyName='OneHR native (dev fixture)',cycleName='OneHR annual (dev fixture)';
async function main(){
 const [tenant]=await owner.db.select().from(s.tenant).where(eq(s.tenant.id,tenantId));if(!tenant)throw Error('Run db:seed first.');
 const [existing]=await owner.db.select().from(s.reviewCycle).where(and(eq(s.reviewCycle.tenantId,tenantId),eq(s.reviewCycle.name,cycleName)));
 if(existing){await manifest(existing.id);return;}
 for(const moduleCode of ['performance','rewards']){
  const [module]=await owner.db.select().from(s.tenantModule).where(and(eq(s.tenantModule.tenantId,tenantId),eq(s.tenantModule.moduleCode,moduleCode),isNull(s.tenantModule.companyId)));
  if(module)await owner.db.update(s.tenantModule).set({status:'active'}).where(eq(s.tenantModule.id,module.id));
  else await owner.db.insert(s.tenantModule).values({tenantId,moduleCode,status:'active'});
 }
 const entitlements=await owner.db.transaction(tx=>resolveEntitlementsTx(tx,tenantId));
 const a:SessionContext={tenantId,userId:'22222222-2222-2222-2222-222222222222',roles:['hr_admin'],entitlements};
 const {id:companyId}=await createCompany(a,{legalName:companyName,companyLabel:'ONEHR-DEV'});
 const [bu]=await owner.db.insert(s.businessUnit).values({tenantId,companyId,code:'ONEHR',name:'OneHR fixture team'}).returning();
 const [dept]=await owner.db.insert(s.department).values({tenantId,companyId,businessUnitId:bu.id,name:'OneHR fixture department'}).returning();
 let [grade]=await owner.db.select().from(s.jobGrade).where(and(eq(s.jobGrade.tenantId,tenantId),eq(s.jobGrade.code,'12'),isNull(s.jobGrade.archivedAt)));
 if(!grade)[grade]=await owner.db.insert(s.jobGrade).values({tenantId,code:'12',name:'OneHR source grade 12'}).returning();
 const year=Number(todayInKualaLumpur().slice(0,4));
 async function hire(key:string,name:string,role:'employee'|'manager'){
  const h=await hireEmployee(a,{person:{fullName:name,primaryEmail:`onehr-${key}@demo.test`},companyId,departmentId:dept.id,gradeId:grade.id,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
  await owner.db.update(s.assignment).set({businessUnitId:bu.id}).where(eq(s.assignment.employmentId,h.employmentId));
  const [u]=await owner.db.insert(s.appUser).values({tenantId,personId:h.personId,workosUserId:`onehr-fixture:${key}`,onboardedAt:new Date()}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId,appUserId:u.id,role});
  return {...h,ctx:{tenantId,personId:h.personId,userId:u.id,roles:[role],entitlements} satisfies SessionContext};
 }
 const manager=await hire('manager','OneHR Manager','manager'),subject=await hire('subject','OneHR Employee','employee');
 const peers=[];for(let i=0;i<4;i++)peers.push(await hire(`peer-${i}`,`OneHR Peer ${i+1}`,'employee'));
 for(const h of [subject,...peers])await setReportingLine(a,{subordinateEmploymentId:h.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
 const {cycleId}=await perf.createCycle(a,{name:cycleName,companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
 const policy=defaultPolicy(framework);policy.modules.evidence=true;policy.profiles=[{id:randomUUID(),companyId,grade:'12',name:'Fixture engineering profile',competencies:[{id:'fixture-current',principle:'Technical',text:'Delivers reliable software',future:false},{id:'fixture-future',principle:'Technical',text:'Coaches others in engineering',future:true}]}];
 await perf.configureOnehrCycle(a,cycleId,null,policy);await perf.openCycle(a,{cycleId});
 const [review]=await owner.db.select().from(s.onehrReview).where(and(eq(s.onehrReview.cycleId,cycleId),eq(s.onehrReview.employmentId,subject.employmentId)));
 const rid=review.reviewId,kid=randomUUID();
 const view=async(ctx:SessionContext)=>{const v=await perf.getOnehrReview(ctx,rid);if(!v)throw Error('Fixture review missing.');return v;};
 await perf.saveOnehrKpis(subject.ctx,rid,(await view(subject.ctx)).revision,[{id:kid,title:'Deliver agreed milestones',description:'Delivery verified against accepted release evidence.',weightBp:10000,unit:'milestones',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}],true);
 await perf.approveOnehrScorecard(manager.ctx,rid,(await view(manager.ctx)).revision,true,'Objectives agreed');
 await perf.submitOnehrResults(subject.ctx,rid,(await view(subject.ctx)).revision,[{id:kid,actual:2,note:'Completed the agreed release.'}]);
 await perf.moderateOnehrKpi(manager.ctx,rid,(await view(manager.ctx)).revision,kid,2,'Verified delivery');
 await perf.confirmOnehrPerformance(manager.ctx,rid,(await view(manager.ctx)).revision,'ME','');
 const answers={'fixture-current':{answer:'yes',remark:''},'fixture-future':{answer:'yes',remark:''}};
 await perf.submitOnehrCompetencies(subject.ctx,rid,(await view(subject.ctx)).revision,answers);
 await perf.submitOnehrCompetencies(manager.ctx,rid,(await view(manager.ctx)).revision,answers,true);
 await perf.assignOnehrPanel(manager.ctx,rid,(await view(manager.ctx)).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));
 for(let i=0;i<peers.length;i++){
  const req=(await perf.onehrAssignments(peers[i].ctx)).feedback.find(f=>f.subject==='OneHR Employee')!;
  const card=await perf.getOnehrFeedback(peers[i].ctx,req.id),answer=i<2?'yes':'no';
  await perf.submitOnehrFeedback(peers[i].ctx,req.id,Object.fromEntries(card.statements.map(st=>[st.id,answer])),answer==='yes'?'Observed consistently in the release.':'');
 }
 await perf.addOnehrEvidence(subject.ctx,rid,{kind:'delivery',body:'Completed two agreed milestones and verified release acceptance.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[{kind:'kpi',id:kid}]});
 await perf.addPerformanceAttachment(subject.ctx,{reviewId:rid,stageKind:null,fileName:'delivery-evidence.txt',mimeType:'text/plain',content:Buffer.from('Fictional demo: two agreed milestones accepted and verified.')});
 await perf.saveOnehrPlan(subject.ctx,rid,null,{career:{aspiration:'Build coaching skills',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:randomUUID(),area:'Coaching',dueOn:`${year+1}-06-01`,onJob:'Lead a retrospective each month',fromOthers:'Observe a mentor',formalLearning:'Practice coaching skills',status:'not_started'}]},true);
 const plan=(await view(manager.ctx)).plans[0];await perf.reviewOnehrPlan(manager.ctx,plan.id,plan.revision,'Agreed development activities','Discussed career goals and support.',true);
 const sid=await perf.createOnehrCalibration(a,cycleId,{name:'Group fixture confirmation',companyId,tier:'group',reviewerUserIds:[a.userId!],reviewIds:[rid],pbtAchievement:100,mode:'replace'});
 await perf.saveOnehrCalibration(a,sid,(await perf.getOnehrCalibration(a,sid)).session.revision,{reviewId:rid,performance:'ME',potential:'High',performanceNote:'',potentialNote:'',promotion:true,specialReward:true});
 await perf.lockOnehrCalibration(a,sid,(await perf.getOnehrCalibration(a,sid)).session.revision,'','both',rid);
 await perf.freezeOnehrReview(a,rid,(await view(a)).revision);
 for(const c of ['performance','potential','talent','feedback'] as const)await perf.releaseOnehrResult(a,rid,c,true);
 await setCompensation(a,{employmentId:subject.employmentId,basicSalary:5000,effectiveFrom:`${year-2}-01-01`});
 const uid=await createRewardUnit(a,{name:'OneHR rewards (dev fixture)',year,companyId,businessUnitId:bu.id,snapshotDate:todayInKualaLumpur()});
 await importOnehrRewardResults(a,uid,(await getRewardUnit(a,uid)).unit.revision);
 // Leave a second assessment's peer cards pending so the actual rater screen can be verified.
 const [pendingReview]=await owner.db.select().from(s.onehrReview).where(and(eq(s.onehrReview.cycleId,cycleId),eq(s.onehrReview.employmentId,peers[0].employmentId)));
 await perf.assignOnehrPanel(manager.ctx,pendingReview.reviewId,pendingReview.revision,[subject,...peers.slice(1)].map(p=>({employmentId:p.employmentId,relationship:'peer'})));
 await perf.createOnehrCalibration(a,cycleId,{name:'BU fixture calibration',companyId,tier:'bu',reviewerUserIds:[a.userId!],reviewIds:[pendingReview.reviewId],pbtAchievement:100,mode:'after'});
 const {cycleId:draftCycleId}=await perf.createCycle(a,{name:'OneHR draft (dev fixture)',companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
 await perf.configureOnehrCycle(a,draftCycleId,null,policy);
 await manifest(cycleId);
}
async function manifest(cycleId:string){
 const users=await owner.db.select({id:s.appUser.id,key:s.appUser.workosUserId,personId:s.appUser.personId}).from(s.appUser).where(eq(s.appUser.tenantId,tenantId));
 const rows=await owner.db.select({reviewId:s.onehrReview.reviewId,name:s.person.fullName}).from(s.onehrReview).innerJoin(s.employment,eq(s.employment.id,s.onehrReview.employmentId)).innerJoin(s.person,eq(s.person.id,s.employment.personId)).where(eq(s.onehrReview.cycleId,cycleId));
 const cohorts=await owner.db.select({id:s.onehrCalibration.id,name:s.onehrCalibration.name}).from(s.onehrCalibration).where(eq(s.onehrCalibration.cycleId,cycleId));
 const units=await owner.db.select({id:s.rewardUnit.id}).from(s.rewardUnit).innerJoin(s.rewardCycle,eq(s.rewardCycle.id,s.rewardUnit.cycleId)).where(and(eq(s.rewardUnit.tenantId,tenantId),eq(s.rewardCycle.name,'OneHR rewards (dev fixture)')));
 const feedback=await owner.db.select({id:s.onehrPanel.requestId,reviewId:s.onehrPanel.reviewId,peerEmploymentId:s.onehrPanel.peerEmploymentId}).from(s.onehrPanel).innerJoin(s.onehrReview,eq(s.onehrReview.reviewId,s.onehrPanel.reviewId)).where(and(eq(s.onehrReview.cycleId,cycleId),isNull(s.onehrPanel.submittedAt)));
 const [draft]=await owner.db.select({id:s.reviewCycle.id}).from(s.reviewCycle).where(and(eq(s.reviewCycle.tenantId,tenantId),eq(s.reviewCycle.name,'OneHR draft (dev fixture)')));
 console.log(JSON.stringify({cycleId,draftCycleId:draft?.id,feedback,users:users.filter(u=>u.key.startsWith('onehr-fixture:')),reviews:rows,calibration:cohorts,rewards:units},null,2));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
