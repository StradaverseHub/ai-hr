import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import * as perf from '../packs/performance/service';
import { defaultPolicy, type KPI } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { createRewardUnit, getRewardUnit, importOnehrRewardResults, setRewardMember } from '../packs/rewards/service';
import { adminCtx, closeAll, createAppUser, entitledCtx, harnessSnapshot, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { dispatchNotifications } from '../core/notifications';
import { todayInKualaLumpur } from '../lib/hr-date';

const year=Number(todayInKualaLumpur().slice(0,4));
describe('OneHR native workflow and Rewards boundary with real RLS',()=>{
  let b:Base,a:SessionContext,subject:{employmentId:string;personId:string},manager:{employmentId:string;personId:string},self:SessionContext,mgr:SessionContext,cycleId:string,reviewId:string;
  let peers:{employmentId:string;ctx:SessionContext}[];
  const hire=(name:string)=>hireEmployee(a,{person:{fullName:name,primaryEmail:`${randomUUID()}@onehr.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
  const view=(ctx:SessionContext=mgr)=>perf.getOnehrReview(ctx,reviewId).then(v=>{if(!v)throw Error('Missing view');return v;});
  beforeEach(async()=>{
    await resetDb();b=await seedBase();a=adminCtx(b);await setModule(b.tenantId,'performance','active');await setModule(b.tenantId,'rewards','active');a=await entitledCtx(b);
    subject=await hire('Assessment subject');manager=await hire('Assessment manager');
    const ctx=async(personId:string,role:'employee'|'manager'):Promise<SessionContext>=>({...a,userId:await createAppUser(b.tenantId,personId,role),personId,roles:[role],grants:undefined});
    self=await ctx(subject.personId,'employee');mgr=await ctx(manager.personId,'manager');
    peers=[];for(let i=0;i<4;i++){const h=await hire(`Peer ${i}`);peers.push({employmentId:h.employmentId,ctx:await ctx(h.personId,'employee')});}
    const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Grade 12'}).returning();
    for(const e of [subject,manager,...peers])await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.id,e.employmentId));
    for(const e of [subject,...peers])await setReportingLine(a,{subordinateEmploymentId:e.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
    ({cycleId}=await perf.createCycle(a,{name:'Native OneHR annual',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`}));
    const policy=defaultPolicy(framework);policy.modules.evidence=true;policy.profiles=[{id:randomUUID(),companyId:b.companyId,grade:'12',name:'Engineering',competencies:[{id:'skill-1',principle:'Technical',text:'Current skill',future:false},{id:'skill-2',principle:'Technical',text:'Future skill',future:true}]}];
    await perf.configureOnehrCycle(a,cycleId,null,policy);await perf.openCycle(a,{cycleId});
    const [r]=await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,subject.employmentId)));reviewId=r.id;
  });
  afterAll(closeAll);
  async function complete(){
    const id=randomUUID(),scoring={mechanism:'A' as const,method:'more' as const,rates:[0,50,100,150,200] as [number,number,number,number,number]};
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Deliver agreed outcomes',description:'Evidence-led delivery',weightBp:10000,unit:'units',scoring,moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'Agreed objectives');
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:100,note:'Completed outcomes'}]);
    await perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,100,'Verified');
    await perf.confirmOnehrPerformance(mgr,reviewId,(await view()).revision,'ME','');
    await perf.submitOnehrCompetencies(self,reviewId,(await view(self)).revision,{'skill-1':{answer:'no',remark:''},'skill-2':{answer:'no',remark:''}});
    await perf.submitOnehrCompetencies(mgr,reviewId,(await view()).revision,{'skill-1':{answer:'yes',remark:'Observed delivery'},'skill-2':{answer:'yes',remark:'Observed future skill'}},true);
    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));
    for(let i=0;i<peers.length;i++){
      const requests=await perf.onehrAssignments(peers[i].ctx);const request=requests.feedback.find(r=>r.subject==='Assessment subject')!;const card=await perf.getOnehrFeedback(peers[i].ctx,request.id);
      const answer=i<2?'yes':'no';await perf.submitOnehrFeedback(peers[i].ctx,request.id,Object.fromEntries(card.statements.map(s=>[s.id,answer])),answer==='yes'?'Consistently observed these behaviours':'');
    }
  }
  it('runs the complete assessment and releases only explicitly selected frozen components',async()=>{
    await complete();expect((await view()).potential).toBe('High');
    expect((await view(self)).competencies.map(c=>c.self)).toEqual(['no','no']);
    expect((await view(self)).peers).toEqual([]);expect((await view(self)).potential).toBeNull();
    expect(await withTenant(self,tx=>tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'onehr.panel-assigned')))).toEqual([]);
    const frozenId=await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    expect((await view(self)).result).toMatchObject({id:frozenId,performance:null,potential:null,talent:null});
    expect(await withTenant(self,tx=>tx.select().from(schema.onehrResult))).toEqual([]);
    await perf.releaseOnehrResult(a,reviewId,'performance',true);expect((await view(self)).result).toMatchObject({performance:'ME',potential:null,talent:null});
    await perf.releaseOnehrResult(a,reviewId,'talent',true);expect((await view(self)).result?.talent).toBe('Star');
    await perf.releaseOnehrResult(a,reviewId,'feedback',true);const own=await view(self);expect(own.feedbackReport).toHaveLength(7);expect(JSON.stringify(own.feedbackReport)).not.toMatch(/employmentId|requestId|count|relationship/);
    await perf.releaseOnehrResult(a,reviewId,'performance',false);expect((await view(self)).result?.performance).toBeNull();
    await expect(perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[])).rejects.toThrow(/finalized/);
    await expect(withTenant(a,tx=>tx.update(schema.onehrResult).set({digest:'tampered'}).where(eq(schema.onehrResult.id,frozenId)))) .rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/immutable/)})});
    await expect(perf.configureOnehrCycle(a,cycleId,1,defaultPolicy(framework))).rejects.toThrow(/fixed/);
  });
  it('rejects stale submissions, self approvals, legacy bypasses, and cross-tenant requests',async()=>{
    const first=await view(self);await perf.saveOnehrKpis(self,reviewId,first.revision,[],false);
    await expect(perf.saveOnehrKpis(self,reviewId,first.revision,[],false)).rejects.toThrow(/changed/);
    await expect(perf.approveOnehrScorecard(self,reviewId,(await view(self)).revision,true,'')).rejects.toThrow(/not assigned/);
    await expect(perf.submitManagerReview(mgr,{reviewId,managerRating:5,overallRating:5})).rejects.toThrow(/OneHR/);
    await expect(perf.releaseCycle(a,{cycleId})).rejects.toThrow(/OneHR/);
    const other=await seedBase();await setModule(other.tenantId,'performance','active');expect(await perf.getOnehrReview(await entitledCtx(other),reviewId)).toBeNull();
    await expect(perf.closeCycle(a,{cycleId})).rejects.toThrow(/Finalize every/);
  });
  it('calibrates through live assigned scopes, bans self calibration, and revokes stale reviewer access',async()=>{
    await complete();const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Calibrator',primaryEmail:`${randomUUID()}@onehr.test`}).returning();
    const userId=await createAppUser(b.tenantId,p.id,'employee'),calibrator={...self,userId,personId:p.id};
    const sessionId=await perf.createOnehrCalibration(a,cycleId,{name:'BU cohort',companyId:b.companyId,tier:'bu',reviewerUserIds:[userId],reviewIds:[reviewId],pbtAchievement:100,mode:'after'});
    let v=await perf.getOnehrCalibration(calibrator,sessionId);expect(v.rows[0].managerPotential).toBe('High');
    await expect(perf.saveOnehrCalibration(calibrator,sessionId,v.session.revision,{reviewId,performance:'AE',potential:'High',performanceNote:'',potentialNote:''})).rejects.toThrow(/Explain/);
    await perf.saveOnehrCalibration(calibrator,sessionId,v.session.revision,{reviewId,performance:'AE',potential:'High',performanceNote:'Additional audited outcomes',potentialNote:''});
    v=await perf.getOnehrCalibration(calibrator,sessionId);await perf.lockOnehrCalibration(calibrator,sessionId,v.session.revision,'');
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);expect((await view(a)).result?.performance).toBe('AE');
    await owner.db.update(schema.onehrCalibration).set({reviewerUserIds:[]}).where(eq(schema.onehrCalibration.id,sessionId));await expect(perf.getOnehrCalibration(calibrator,sessionId)).rejects.toThrow(/removed/);
  });
  it('preserves plan definitions after sharing, requires a career conversation to close, and audits year-round progress',async()=>{
    const goalId=randomUUID();await perf.saveOnehrPlan(self,reviewId,null,{career:{aspiration:'Develop leadership',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:goalId,area:'Facilitation',dueOn:`${year+1}-06-01`,onJob:'Facilitate planning',fromOthers:'',formalLearning:'',status:'not_started'}]},true);
    const plan=(await view()).plans[0];expect(plan.planYear).toBe(year+1);
    await expect(perf.reviewOnehrPlan(mgr,plan.id,plan.revision,'Agreed','',true)).rejects.toThrow(/conversation/);
    await perf.reviewOnehrPlan(mgr,plan.id,plan.revision,'Agreed','Discussed development and mobility',true);
    await perf.updateOnehrGoalProgress(self,plan.id,(await view()).plans[0].revision,goalId,'in_progress');
    await expect(perf.saveOnehrPlan(self,reviewId,(await view()).plans[0].revision,{career:{aspiration:'Changed',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[]})).rejects.toThrow(/locked/);
    await perf.acknowledgeOnehrPlan(self,plan.id,(await view()).plans[0].revision);expect((await view()).plans[0].acknowledgedAt).not.toBeNull();
  });
  it('keeps private evidence private, preserves shared evidence and accepts explicit corrections',async()=>{
    const id=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Delivered a milestone',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]});
    expect((await view()).evidence).toEqual([]);await perf.changeOnehrEvidenceState(self,id,'shared');expect((await view()).evidence).toHaveLength(1);
    await expect(withTenant(self,tx=>tx.update(schema.onehrEvidence).set({body:'Rewrite history'}).where(eq(schema.onehrEvidence.id,id)))) .rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/new entry/)})});
    await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Correction: milestone completed later',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:id,links:[]});expect((await view()).evidence).toHaveLength(2);
  });
  it('imports frozen results into Rewards with provenance and new verification, without changing compensation',async()=>{
    await complete();await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    const [bu]=await owner.db.insert(schema.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'HQ',name:'Headquarters'}).returning();
    await owner.db.update(schema.assignment).set({businessUnitId:bu.id}).where(eq(schema.assignment.employmentId,subject.employmentId));
    await setCompensation(a,{employmentId:subject.employmentId,basicSalary:5000,effectiveFrom:`${year-2}-01-01`});
    const unitId=await createRewardUnit(a,{name:'Annual rewards',year,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:todayInKualaLumpur()});let reward=await getRewardUnit(a,unitId);
    expect(reward.rows[0].source.onehr?.reviewId).toBe(reviewId);expect(reward.rows[0].facts.performance).toBeNull();
    await expect(importOnehrRewardResults(self,unitId,reward.unit.revision)).rejects.toThrow();
    await importOnehrRewardResults(a,unitId,reward.unit.revision);reward=await getRewardUnit(a,unitId);expect(reward.rows[0].facts).toMatchObject({performance:'ME',talent:'STAR',reviewed:false,pipCase:false});
    const [comp]=await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId,subject.employmentId));expect(Number(comp.basicSalary)).toBe(5000);
    expect(await owner.db.select().from(schema.payrollInput)).toEqual([]);
  });
  it('locks independent calibration axes and passes through unchanged bands',async()=>{
    await complete();
    const sessionId=await perf.createOnehrCalibration(a,cycleId,{name:'Independent axes',companyId:b.companyId,tier:'bu',reviewerUserIds:[a.userId!],reviewIds:[reviewId],pbtAchievement:100,mode:'after'});
    let c=await perf.getOnehrCalibration(a,sessionId);
    await perf.lockOnehrCalibration(a,sessionId,c.session.revision,'','performance');
    c=await perf.getOnehrCalibration(a,sessionId);expect(c.session.performanceLockedAt).not.toBeNull();expect(c.session.potentialLockedAt).toBeNull();expect(c.rows[0].currentPerformance).toBe('ME');
    await expect(perf.saveOnehrCalibration(a,sessionId,c.session.revision,{reviewId,axis:'performance',performance:'AE',potential:null,performanceNote:'Changed after lock',potentialNote:''})).rejects.toThrow(/locked/);
    await expect(perf.freezeOnehrReview(a,reviewId,(await view(a)).revision)).rejects.toThrow(/Lock every/);
    await perf.lockOnehrCalibration(a,sessionId,c.session.revision,'','potential');
    c=await perf.getOnehrCalibration(a,sessionId);expect(c.session.lockedAt).not.toBeNull();
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);expect((await view(a)).result?.performance).toBe('ME');
  });
  it('gives matrix moderators only their assigned KPI lines and revokes access with the edge',async()=>{
    const matrix=peers[0];
    await setReportingLine(a,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:matrix.employmentId,lineType:'functional',validFrom:`${year}-01-01`});
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Matrix objective',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:matrix.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'');await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Delivery'}]);
    const matrixView=await view(matrix.ctx);expect(matrixView.moderator).toBe(true);expect(matrixView.policy.modules).toEqual({pm:true,tm:false,idp:false,evidence:false});expect(matrixView.competencies).toEqual([]);expect(matrixView.peers).toEqual([]);
    await perf.moderateOnehrKpi(matrix.ctx,reviewId,matrixView.revision,id,2,'');
    await owner.db.update(schema.reportingLine).set({validTo:`${year}-01-01`}).where(and(eq(schema.reportingLine.managerEmploymentId,matrix.employmentId),eq(schema.reportingLine.lineType,'functional')));
    expect(await perf.getOnehrReview(matrix.ctx,reviewId)).toBeNull();
  });
  it('allows a reviewer to decline and a manager to replace an unsubmitted panel member',async()=>{
    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));
    const request=(await perf.onehrAssignments(peers[0].ctx)).feedback[0];await perf.declineOnehrFeedback(peers[0].ctx,request.id);
    expect((await perf.onehrAssignments(peers[0].ctx)).feedback).toEqual([]);await expect(perf.getOnehrFeedback(peers[0].ctx,request.id)).rejects.toThrow(/removed/);
    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,[{employmentId:manager.employmentId,relationship:'line_manager'},...peers.slice(1).map(p=>({employmentId:p.employmentId,relationship:'peer'}))]);
    expect((await perf.onehrAssignments(mgr)).feedback.some(r=>r.subject==='Assessment subject')).toBe(true);
  });
  it('keeps endorsements append-only and snapshots evidence provenance at finalization',async()=>{
    const id=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Delivered the release.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]});
    await expect(perf.respondOnehrEvidence(self,id,'endorse','Own endorsement')).rejects.toThrow(/another author/);
    await perf.respondOnehrEvidence(mgr,id,'endorse','Verified delivery');await perf.respondOnehrEvidence(mgr,id,'dispute','A correction is needed');
    expect((await view(self)).evidence[0].responses.map(r=>r.stance)).toEqual(['endorse','dispute']);
    await expect(withTenant(self,tx=>tx.update(schema.onehrEvidence).set({responses:[]}).where(eq(schema.onehrEvidence.id,id)))) .rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/append-only/)})});
    await complete();await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    const [f]=await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId));expect((f.result as {provenance:{evidence:unknown[]}}).provenance.evidence).toHaveLength(1);
    const [panel]=await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.reviewId,reviewId));
    await expect(withTenant(a,tx=>tx.update(schema.onehrPanel).set({remark:'Restate frozen evidence'}).where(eq(schema.onehrPanel.requestId,panel.requestId)))) .rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/immutable/)})});
  });

  it('routes native feedback tasks and released-result updates without disclosing assessment content',async()=>{
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);
    await perf.assignOnehrPanel(mgr,reviewId,(await view()).revision,peers.map(p=>({employmentId:p.employmentId,relationship:'peer'})));
    await dispatchNotifications(a);
    let notices=await owner.db.select().from(schema.notification);expect(notices.filter(n=>n.kind==='performance.feedback-request')).toHaveLength(4);
    expect(new Set(notices.filter(n=>n.kind==='performance.feedback-request').map(n=>n.recipientEmploymentId))).toEqual(new Set(peers.map(p=>p.employmentId)));
    await complete();await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);await perf.releaseOnehrResult(a,reviewId,'performance',true);await dispatchNotifications(a);
    notices=await owner.db.select().from(schema.notification);expect(notices.some(n=>n.kind==='performance.update'&&n.recipientEmploymentId===subject.employmentId)).toBe(true);
    expect(notices.map(n=>`${n.title} ${n.body}`).join(' ')).not.toMatch(/Assessment subject|ME|High|Star|5000/);
  });
  it('rejects AI access before contacting a provider or recording a proposal',async()=>{
    await expect(perf.draftOnehrNarrative(peers[0].ctx,reviewId,'Invent a pay award')).rejects.toThrow(/Only the employee/);
    expect(await owner.db.select().from(schema.agentProposal)).toEqual([]);
  });

  it('requires every KPI approver to act in order and carries each confirmed value forward',async()=>{
    const matrix=peers[0];await setReportingLine(a,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:matrix.employmentId,lineType:'functional',validFrom:`${year}-01-01`});
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Ordered approval',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:matrix.employmentId,approverEmploymentIds:[matrix.employmentId,manager.employmentId]}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'');await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Delivered'}]);
    await expect(perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,2,'')).rejects.toThrow(/another moderator/);
    await perf.moderateOnehrKpi(matrix.ctx,reviewId,(await view(matrix.ctx)).revision,id,3,'Verified an additional outcome');expect((await view()).kpis[0].locked).toBe(false);
    await expect(perf.confirmOnehrPerformance(mgr,reviewId,(await view()).revision,'AE','')).rejects.toThrow(/every KPI/);
    await expect(perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,2,'')).rejects.toThrow(/Explain/);
    await perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,3,'Confirmed preceding value');expect((await view()).kpis[0].locked).toBe(true);
    await perf.confirmOnehrPerformance(mgr,reviewId,(await view()).revision,'AE','');expect((await view()).managerPerformance).toBe('AE');
  });

});
