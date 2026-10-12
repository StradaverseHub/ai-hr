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

vi.mock('../lib/ai',async importActual=>({...await importActual<typeof import('../lib/ai')>(),generateDraft:vi.fn()}));
vi.mock('../core/ai-config',async importActual=>({...await importActual<typeof import('../core/ai-config')>(),resolveActiveAiConfig:vi.fn()}));
import { generateDraft } from '../lib/ai';
import { resolveActiveAiConfig } from '../core/ai-config';

const year=Number(todayInKualaLumpur().slice(0,4));
describe('OneHR native workflow and Rewards boundary with real RLS',()=>{
  let b:Base,a:SessionContext,subject:{employmentId:string;personId:string},manager:{employmentId:string;personId:string},self:SessionContext,mgr:SessionContext,cycleId:string,reviewId:string;
  let peers:{employmentId:string;ctx:SessionContext}[];
  const hire=(name:string)=>hireEmployee(a,{person:{fullName:name,primaryEmail:`${randomUUID()}@onehr.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
  const view=(ctx:SessionContext=mgr)=>perf.getOnehrReview(ctx,reviewId).then(v=>{if(!v)throw Error('Missing view');return v;});
  beforeEach(async()=>{
    vi.mocked(generateDraft).mockReset().mockResolvedValue('{"items":[0]}');vi.mocked(resolveActiveAiConfig).mockReset().mockResolvedValue(null);
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
    expect(await withTenant(self,tx=>tx.select().from(schema.peerFeedbackRequest).where(eq(schema.peerFeedbackRequest.reviewId,reviewId)))).toEqual([]);
    expect(await withTenant(self,tx=>tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'onehr.panel-assigned')))).toEqual([]);
    expect(await withTenant(self,tx=>tx.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'peer-feedback-request.created')))).toEqual([]);
    const attachment=await perf.addPerformanceAttachment(self,{reviewId,stageKind:null,fileName:'delivery.txt',mimeType:'text/plain',content:Buffer.from('Verified release evidence.')});
    expect((await perf.getPerformanceAttachment(mgr,attachment.id))?.content.toString()).toBe('Verified release evidence.');
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
  it('preserves the opening company and grade after the native employment changes company',async()=>{
    const sessionId=await perf.createOnehrCalibration(a,cycleId,{name:'Original company cohort',companyId:b.companyId,tier:'bu',reviewerUserIds:[a.userId!],reviewIds:[reviewId],pbtAchievement:100,mode:'after'});
    const [destination]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Destination company'}).returning();
    // Entity transfer changes the existing employment company; it does not create a second employment.
    await owner.db.update(schema.employment).set({companyId:destination.id,gradeId:null}).where(eq(schema.employment.id,subject.employmentId));
    await complete();
    const c=await perf.getOnehrCalibration(a,sessionId);await perf.lockOnehrCalibration(a,sessionId,c.session.revision,'');
    await expect(withTenant(a,tx=>tx.update(schema.onehrReview).set({companyId:destination.id}).where(eq(schema.onehrReview.reviewId,reviewId)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/snapshot is immutable/)})});
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    const [stored]=await owner.db.select().from(schema.onehrReview).where(eq(schema.onehrReview.reviewId,reviewId));
    expect(stored).toMatchObject({companyId:b.companyId,grade:'12'});expect((await view(self)).grade).toBe('12');
  });
  it('audits active deadline changes without allowing assessment rules or frozen inputs to reopen',async()=>{
    const closed={pm_setting:{opensAt:null,closesAt:new Date(Date.now()-60_000).toISOString()}};
    await expect(perf.updateOnehrWindows(self,cycleId,1,closed,'Close setting')).rejects.toThrow(/administrator/);
    await expect(perf.updateOnehrWindows(a,cycleId,1,closed,'')).rejects.toThrow();
    await perf.updateOnehrWindows(a,cycleId,1,closed,'Setting cutoff reached');
    const kpi={id:randomUUID(),title:'A deadline-controlled objective',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId};
    await expect(perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[kpi])).rejects.toThrow(/closed/);
    await expect(perf.updateOnehrWindows(a,cycleId,1,{},'Stale request')).rejects.toThrow(/changed/);
    await perf.updateOnehrWindows(a,cycleId,2,{},'Extend setting for approved correction');
    await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[kpi]);
    const configured=await perf.getOnehrCycle(a,cycleId);
    await expect(withTenant(a,tx=>tx.update(schema.onehrCycle).set({policy:{...configured!.policy,lowMaxPct:1}}).where(eq(schema.onehrCycle.cycleId,cycleId)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/immutable/)})});
    await complete();await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    const frozen=(await view(a)).result!;await perf.updateOnehrWindows(a,cycleId,3,{},'Reconfirm schedule');
    expect((await view(a)).result?.digest).toBe(frozen.digest);
    await expect(perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[kpi])).rejects.toThrow(/finalized/);
    const history=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,cycleId),eq(schema.domainEvent.eventType,'onehr.windows-updated')));
    expect(history).toHaveLength(3);expect(history.some(e=>(e.payload as {previous?:unknown;reason?:string}).reason==='Extend setting for approved correction')).toBe(true);
    await owner.db.update(schema.reviewCycle).set({status:'closed'}).where(eq(schema.reviewCycle.id,cycleId));
    await expect(perf.updateOnehrWindows(a,cycleId,4,{},'Reopen closed period')).rejects.toThrow(/read-only/);
  });
  it('keeps Group outside BG cutoffs and lets only HR reopen unfinalized calibration in reverse tier order',async()=>{
    await complete();
    await perf.updateOnehrWindows(a,cycleId,1,{tb_bgceo:{opensAt:null,closesAt:new Date(Date.now()-60_000).toISOString()}},'BG cutoff reached');
    const make=(name:string,tier:'bu'|'bg'|'group',mode:'after'|'replace'='after')=>perf.createOnehrCalibration(a,cycleId,{name,companyId:b.companyId,tier,reviewerUserIds:[a.userId!,mgr.userId!],reviewIds:[reviewId],pbtAchievement:100,mode});
    const bu=await make('BU','bu');await perf.lockOnehrCalibration(a,bu,1,'');
    const bg=await make('BG','bg');await expect(perf.lockOnehrCalibration(a,bg,1,'')).rejects.toThrow(/closed/);
    const group=await make('Group','group','replace');
    await perf.saveOnehrCalibration(a,group,1,{reviewId,performance:'ME',potential:'High',performanceNote:'',potentialNote:'',promotion:true,specialReward:true});
    await perf.lockOnehrCalibration(a,group,(await perf.getOnehrCalibration(a,group)).session.revision,'');
    await expect(perf.unlockOnehrCalibration(mgr,group,(await perf.getOnehrCalibration(mgr,group)).session.revision,'Reconsider')).rejects.toThrow(/administrator/);
    await expect(perf.unlockOnehrCalibration(a,bu,(await perf.getOnehrCalibration(a,bu)).session.revision,'Reconsider')).rejects.toThrow(/later calibration tiers/);
    await perf.unlockOnehrCalibration(a,group,(await perf.getOnehrCalibration(a,group)).session.revision,'Correct the group decision','performance',reviewId);
    let reopened=await perf.getOnehrCalibration(a,group);expect(reopened.rows[0].entry).toMatchObject({performanceLockedAt:null,promotion:false,specialReward:false});expect(reopened.rows[0].entry.potentialLockedAt).toBeTruthy();
    await perf.unlockOnehrCalibration(a,bu,(await perf.getOnehrCalibration(a,bu)).session.revision,'Review the underlying BU performance','performance');
    await perf.lockOnehrCalibration(a,bu,(await perf.getOnehrCalibration(a,bu)).session.revision,'','performance');
    await perf.saveOnehrCalibration(a,group,reopened.session.revision,{reviewId,axis:'performance',performance:'AE',potential:null,performanceNote:'Reconsidered verified delivery',potentialNote:'',confirmTalentDecisions:true,promotion:true});
    reopened=await perf.getOnehrCalibration(a,group);await perf.lockOnehrCalibration(a,group,reopened.session.revision,'','performance',reviewId);
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);const frozen=(await view(a)).result!;expect(frozen.performance).toBe('AE');
    await expect(perf.unlockOnehrCalibration(a,group,(await perf.getOnehrCalibration(a,group)).session.revision,'Change a frozen result','performance',reviewId)).rejects.toThrow(/Finalized/);
    expect((await view(a)).result?.digest).toBe(frozen.digest);
    const audit=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,group),eq(schema.domainEvent.eventType,'onehr.calibration-reopened')));expect(audit).toHaveLength(1);expect(audit[0].payload).toMatchObject({reason:'Correct the group decision',axis:'performance'});
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
    const goalId=randomUUID(),input={career:{aspiration:'Develop leadership',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:goalId,area:'Facilitation',dueOn:`${year+1}-06-01`,onJob:'Facilitate planning',fromOthers:'',formalLearning:'',status:'not_started'}]};
    await perf.saveOnehrPlan(self,reviewId,null,input);
    const draft=(await view(self)).plans[0];expect(draft.status).toBe('draft');
    expect((await view(mgr)).plans).toEqual([]);expect((await view(a)).plans).toEqual([]);
    expect(await withTenant(mgr,tx=>tx.select().from(schema.onehrPlan).where(eq(schema.onehrPlan.id,draft.id)))).toEqual([]);
    await perf.saveOnehrPlan(self,reviewId,draft.revision,input,true);
    const plan=(await view()).plans[0];expect(plan.planYear).toBe(year+1);
    await expect(withTenant(self,tx=>tx.update(schema.onehrPlan).set({career:{aspiration:'Rewrite after sharing'}}).where(eq(schema.onehrPlan.id,plan.id)))).rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/definitions are immutable/)})});
    await expect(perf.reviewOnehrPlan(mgr,plan.id,plan.revision,'Agreed','',true)).rejects.toThrow(/conversation/);
    await perf.reviewOnehrPlan(mgr,plan.id,plan.revision,'Agreed','Discussed development and mobility',true);
    await perf.updateOnehrGoalProgress(self,plan.id,(await view()).plans[0].revision,goalId,'in_progress');
    await expect(perf.saveOnehrPlan(self,reviewId,(await view()).plans[0].revision,{career:{aspiration:'Changed',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[]})).rejects.toThrow(/locked/);
    await perf.acknowledgeOnehrPlan(self,plan.id,(await view()).plans[0].revision);expect((await view()).plans[0].acknowledgedAt).not.toBeNull();
    await owner.db.update(schema.reviewCycle).set({status:'closed'}).where(eq(schema.reviewCycle.id,cycleId));
    await expect(perf.saveOnehrPlan(self,reviewId,(await view(self)).plans[0].revision,input)).rejects.toThrow(/read-only/);
    await expect(perf.reviewOnehrPlan(mgr,plan.id,(await view()).plans[0].revision,'Rewrite','Another conversation',true)).rejects.toThrow(/read-only/);
    await perf.updateOnehrGoalProgress(self,plan.id,(await view()).plans[0].revision,goalId,'done');expect((await view(self)).plans[0].goals).toMatchObject([{status:'done'}]);
  });
  it('uses the previous year-end plan for mid-year review without reopening authoring',async()=>{
    const {cycleId:previous}=await perf.createCycle(a,{name:'Previous year-end',companyId:b.companyId,periodStart:`${year-1}-01-01`,periodEnd:`${year-1}-12-31`});
    await perf.configureOnehrCycle(a,previous,null);await perf.openCycle(a,{cycleId:previous});
    const [prior]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,previous),eq(schema.onehrReview.employmentId,subject.employmentId)));
    const input={career:{aspiration:'Agreed annual development',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:randomUUID(),area:'Coaching',dueOn:`${year}-12-31`,onJob:'Coach a colleague',fromOthers:'',formalLearning:'',status:'not_started'}]};
    await perf.saveOnehrPlan(self,prior.reviewId,null,input,true);
    const plan=(await perf.getOnehrReview(mgr,prior.reviewId))!.plans[0];await perf.reviewOnehrPlan(mgr,plan.id,plan.revision,'Agreed','Annual career conversation',true);
    const {cycleId:mid}=await perf.createCycle(a,{name:'Mid-year check-in',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-06-30`});
    const policy=defaultPolicy(framework);policy.kind='mid_year';await perf.configureOnehrCycle(a,mid,null,policy);await perf.openCycle(a,{cycleId:mid});
    const [current]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,mid),eq(schema.onehrReview.employmentId,subject.employmentId)));
    const currentView=(await perf.getOnehrReview(self,current.reviewId))!;expect(currentView.planYear).toBe(year);expect(currentView.plans[0].id).toBe(plan.id);
    await expect(perf.saveOnehrPlan(self,current.reviewId,currentView.plans[0].revision,input)).rejects.toThrow(/year-end/);
    await perf.reviewOnehrPlan(mgr,plan.id,currentView.plans[0].revision,'Mid-year progress reviewed','Mid-year career check-in',false,current.reviewId);
    const reviewed=(await perf.getOnehrReview(self,current.reviewId))!.plans[0];expect(reviewed.status).toBe('closed');expect(reviewed.conversation).toBe('Mid-year career check-in');
    await perf.updateOnehrGoalProgress(self,plan.id,reviewed.revision,input.goals[0].id,'in_progress');
    expect((await perf.getOnehrReview(self,current.reviewId))!.plans[0].goals).toMatchObject([{status:'in_progress',area:'Coaching'}]);
    const {cycleId:disabled}=await perf.createCycle(a,{name:'Development disabled',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-06-30`});
    const disabledPolicy={...policy,modules:{...policy.modules,idp:false}};await perf.configureOnehrCycle(a,disabled,null,disabledPolicy);await perf.openCycle(a,{cycleId:disabled});
    const [disabledReview]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,disabled),eq(schema.onehrReview.employmentId,subject.employmentId)));
    await expect(perf.reviewOnehrPlan(mgr,plan.id,reviewed.revision+1,'Bypass disabled module','Conversation',false,disabledReview.reviewId)).rejects.toThrow(/disabled/);
  });
  it('records quarterly KPI status without numeric ratings or Rewards facts',async()=>{
    const {cycleId:quarter}=await perf.createCycle(a,{name:'Quarterly check-in',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-03-31`});
    const policy=defaultPolicy(framework);policy.kind='quarterly';policy.modules={pm:true,tm:false,idp:false,evidence:false};await perf.configureOnehrCycle(a,quarter,null,policy);await perf.openCycle(a,{cycleId:quarter});
    const [quarterReview]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,quarter),eq(schema.onehrReview.employmentId,subject.employmentId)));reviewId=quarterReview.reviewId;
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Quarterly delivery',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}],true);
    await expect(perf.saveOnehrKpiCheckIn(self,reviewId,(await view(self)).revision,id,'at_risk','Pending agreement')).rejects.toThrow(/Agree the KPI/);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'');
    await expect(perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:''}])).rejects.toThrow(/Quarterly/);
    await expect(perf.confirmOnehrPerformance(mgr,reviewId,(await view()).revision,'ME','')).rejects.toThrow(/does not produce/);
    await expect(perf.saveOnehrKpiCheckIn(mgr,reviewId,(await view()).revision,id,'on_track','')).rejects.toThrow(/not assigned/);
    await expect(perf.freezeOnehrReview(a,reviewId,(await view(a)).revision)).rejects.toThrow(/every quarterly/);
    await perf.saveOnehrKpiCheckIn(self,reviewId,(await view(self)).revision,id,'at_risk','Dependency needs support');
    const first=(await view(self)).revision;await perf.saveOnehrKpiCheckIn(self,reviewId,first,id,'on_track','Dependency resolved');
    await expect(perf.saveOnehrKpiCheckIn(self,reviewId,first,id,'off_track','Stale')).rejects.toThrow(/changed/);
    expect((await view(mgr)).kpis[0].checkIn).toMatchObject({answer:'on_track',note:'Dependency resolved',userId:self.userId});
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);expect((await view(a)).result).toMatchObject({performance:null,potential:null,talent:null});
    const history=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,reviewId),eq(schema.domainEvent.eventType,'onehr.kpi-checkin-saved'))).orderBy(schema.domainEvent.occurredAt,schema.domainEvent.id);expect(history).toHaveLength(2);expect(history.some(e=>(e.payload as {previous?:{answer:string}}).previous?.answer==='at_risk')).toBe(true);
    const [bu]=await owner.db.insert(schema.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'QUARTER',name:'Quarterly test unit'}).returning();await owner.db.update(schema.assignment).set({businessUnitId:bu.id}).where(eq(schema.assignment.employmentId,subject.employmentId));
    await setCompensation(a,{employmentId:subject.employmentId,basicSalary:5000,effectiveFrom:`${year-2}-01-01`});
    const unitId=await createRewardUnit(a,{name:'Annual rewards without quarterly ratings',year,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:todayInKualaLumpur()});const reward=await getRewardUnit(a,unitId);expect(reward.rows).toHaveLength(1);expect(reward.rows[0].source.onehr).toBeNull();
    await expect(importOnehrRewardResults(a,unitId,reward.unit.revision)).rejects.toThrow(/No finalized OneHR/);
  });
  it('keeps private evidence private, preserves shared evidence and accepts explicit corrections',async()=>{
    const id=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Delivered a milestone',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]});
    expect((await view()).evidence).toEqual([]);await perf.changeOnehrEvidenceState(self,id,'shared');expect((await view()).evidence).toHaveLength(1);
    await expect(withTenant(self,tx=>tx.update(schema.onehrEvidence).set({body:'Rewrite history'}).where(eq(schema.onehrEvidence.id,id)))) .rejects.toMatchObject({cause:expect.objectContaining({message:expect.stringMatching(/new entry/)})});
    await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Correction: milestone completed later',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:id,links:[]});expect((await view()).evidence).toHaveLength(2);
  });
  it('imports frozen results into Rewards with provenance and new verification, without changing compensation',async()=>{
    await complete();await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    // A later development-only record must not hide the annual assessment from Rewards.
    const {cycleId:developmentCycle}=await perf.createCycle(a,{name:'Development-only record',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
    const developmentPolicy=defaultPolicy(framework);developmentPolicy.modules={pm:false,tm:false,idp:true,evidence:true};
    await perf.configureOnehrCycle(a,developmentCycle,null,developmentPolicy);await perf.openCycle(a,{cycleId:developmentCycle});
    const [developmentReview]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,developmentCycle),eq(schema.onehrReview.employmentId,subject.employmentId)));
    await perf.freezeOnehrReview(a,developmentReview.reviewId,developmentReview.revision);
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
  it('keeps a reviewer’s own calibration hidden even inside an assigned mixed cohort',async()=>{
    const [other]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,peers[0].employmentId)));
    const sid=await perf.createOnehrCalibration(a,cycleId,{name:'Mixed own cohort',companyId:b.companyId,tier:'group',reviewerUserIds:[self.userId!],reviewIds:[reviewId,other.reviewId],pbtAchievement:null,mode:'replace'});
    const c=await perf.getOnehrCalibration(self,sid);expect(c.canLockCohort).toBe(false);expect(c.rows.map(r=>r.entry.reviewId)).toEqual([other.reviewId]);
    expect((await withTenant(self,tx=>tx.select().from(schema.onehrCalibrationEntry).where(eq(schema.onehrCalibrationEntry.sessionId,sid)))).map(r=>r.reviewId)).toEqual([other.reviewId]);
    await expect(perf.saveOnehrCalibration(self,sid,c.session.revision,{reviewId,performance:'OU',potential:'High',performanceNote:'Own rating',potentialNote:''})).rejects.toThrow(/cannot be calibrated/);
    await expect(perf.lockOnehrCalibration(self,sid,c.session.revision,'')).rejects.toThrow(/own calibration/);
  });
  it('confirms reward nominations when the two assessment axes are locked separately',async()=>{
    await complete();
    const bu=await perf.createOnehrCalibration(a,cycleId,{name:'BU baseline',companyId:b.companyId,tier:'bu',reviewerUserIds:[a.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    await perf.lockOnehrCalibration(a,bu,(await perf.getOnehrCalibration(a,bu)).session.revision,'');
    const bg=await perf.createOnehrCalibration(a,cycleId,{name:'BG nominations',companyId:b.companyId,tier:'bg',reviewerUserIds:[a.userId!],reviewIds:[reviewId],pbtAchievement:null,mode:'after'});
    await perf.lockOnehrCalibration(a,bg,(await perf.getOnehrCalibration(a,bg)).session.revision,'','performance');
    await perf.saveOnehrCalibration(a,bg,(await perf.getOnehrCalibration(a,bg)).session.revision,{reviewId,axis:'potential',performance:null,potential:'High',performanceNote:'',potentialNote:'',confirmTalentDecisions:true,promotion:true,specialReward:true});
    await perf.lockOnehrCalibration(a,bg,(await perf.getOnehrCalibration(a,bg)).session.revision,'','potential');
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);
    const [f]=await owner.db.select().from(schema.onehrResult).where(eq(schema.onehrResult.reviewId,reviewId));expect(f.result).toMatchObject({performance:'ME',potential:'High',promotion:true,specialReward:true,pip:false});
  });
  it('uses individually locked Group replacements without requiring an unused BG tier',async()=>{
    await complete();
    const [pending]=await owner.db.select().from(schema.onehrReview).where(and(eq(schema.onehrReview.cycleId,cycleId),eq(schema.onehrReview.employmentId,peers[0].employmentId)));
    const sid=await perf.createOnehrCalibration(a,cycleId,{name:'Group replacement',companyId:b.companyId,tier:'group',reviewerUserIds:[a.userId!],reviewIds:[reviewId,pending.reviewId],pbtAchievement:null,mode:'replace'});
    let c=await perf.getOnehrCalibration(a,sid);await perf.saveOnehrCalibration(a,sid,c.session.revision,{reviewId,performance:'AE',potential:'High',performanceNote:'Cross-company evidence reviewed',potentialNote:''});
    c=await perf.getOnehrCalibration(a,sid);await perf.lockOnehrCalibration(a,sid,c.session.revision,'','both',reviewId);
    expect((await perf.getOnehrCalibration(a,sid)).session.lockedAt).toBeNull();
    await perf.freezeOnehrReview(a,reviewId,(await view(a)).revision);expect((await view(a)).result?.performance).toBe('AE');
  });
  it('gives matrix moderators only their assigned KPI lines and revokes access with the edge',async()=>{
    const matrix=peers[0];
    await setReportingLine(a,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:matrix.employmentId,lineType:'functional',validFrom:`${year}-01-01`});
    const id=randomUUID(),managerId=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Matrix objective',description:'',weightBp:5000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:matrix.employmentId},{id:managerId,title:'Manager-only objective',description:'',weightBp:5000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:manager.employmentId}],true);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'');await perf.approveOnehrScorecard(matrix.ctx,reviewId,(await view(matrix.ctx)).revision,true,'');await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Delivery'},{id:managerId,actual:2,note:'Manager-only evidence'}]);
    const attachment=await perf.addPerformanceAttachment(self,{reviewId,stageKind:null,fileName:'private-evidence.txt',mimeType:'text/plain',content:Buffer.from('Evidence for the assigned assessment manager.')});
    expect(await perf.getPerformanceAttachment(matrix.ctx,attachment.id)).toBeNull();expect(await perf.listAttachmentsForReview(matrix.ctx,reviewId)).toEqual([]);
    expect(await withTenant(matrix.ctx,tx=>tx.select().from(schema.performanceAttachment).where(eq(schema.performanceAttachment.reviewId,reviewId)))).toEqual([]);
    const matrixView=await view(matrix.ctx);expect(matrixView.moderator).toBe(true);expect(matrixView.policy.modules).toEqual({pm:true,tm:false,idp:false,evidence:false});expect(matrixView.competencies).toEqual([]);expect(matrixView.peers).toEqual([]);
    expect(matrixView.kpis.map(k=>k.id)).toEqual([id]);
    await perf.moderateOnehrKpi(matrix.ctx,reviewId,matrixView.revision,id,2,'');
    await perf.moderateOnehrKpi(mgr,reviewId,(await view(mgr)).revision,managerId,2,'');
    await perf.confirmOnehrPerformance(mgr,reviewId,(await view(mgr)).revision,'ME','Private overall assessment');
    expect(await view(matrix.ctx)).toMatchObject({managerPerformance:null,managerScore:null,managerRemark:''});
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

  it('drafts only from authorized current evidence and records indices without evidence text',async()=>{
    vi.mocked(resolveActiveAiConfig).mockResolvedValue({provider:'anthropic',model:'fixture',apiKey:'fixture-not-a-key'});
    await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Private evidence must stay private.',occurredOn:todayInKualaLumpur(),state:'draft',supersedesId:null,links:[]});
    const old=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Outdated milestone claim.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]});
    await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Corrected milestone evidence.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:old,links:[]});
    const before=await view(mgr);expect(await perf.draftOnehrNarrative(mgr,reviewId,'Verified delivery.')).toBe('Verified delivery.');
    const prompt=vi.mocked(generateDraft).mock.calls[0][1].prompt;expect(prompt).toContain('Corrected milestone evidence.');expect(prompt).not.toMatch(/Private evidence|Outdated milestone/);
    expect((await view(mgr)).revision).toBe(before.revision);expect(await owner.db.select().from(schema.payrollInput)).toEqual([]);
    const [proposal]=await owner.db.select().from(schema.agentProposal);expect(proposal).toMatchObject({proposalType:'onehr_narrative',proposal:{items:[0]},adjudication:'accepted',decision:null});expect(JSON.stringify(proposal)).not.toContain('Verified delivery.');
  });
  it('silently discards a draft if evidence is retracted while the provider runs',async()=>{
    vi.mocked(resolveActiveAiConfig).mockResolvedValue({provider:'anthropic',model:'fixture',apiKey:'fixture-not-a-key'});
    const id=await perf.addOnehrEvidence(self,reviewId,{kind:'delivery',body:'Evidence about delivery.',occurredOn:todayInKualaLumpur(),state:'shared',supersedesId:null,links:[]});
    vi.mocked(generateDraft).mockImplementationOnce(async()=>{await perf.changeOnehrEvidenceState(self,id,'retracted');return '{"items":[1]}';});
    expect(await perf.draftOnehrNarrative(mgr,reviewId,'Prepare a draft.')).toBe('');
    const [proposal]=await owner.db.select().from(schema.agentProposal);expect(proposal).toMatchObject({adjudication:'rejected',decision:null});
  });

  it('requires every KPI approver to act in order and carries each confirmed value forward',async()=>{
    await setModule(b.tenantId,'notifications','active');a=await entitledCtx(b);
    const matrix=peers[0];await setReportingLine(a,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:matrix.employmentId,lineType:'functional',validFrom:`${year}-01-01`});
    const id=randomUUID();await perf.saveOnehrKpis(self,reviewId,(await view(self)).revision,[{id,title:'Ordered approval',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,1,2,3,4]},moderatorEmploymentId:matrix.employmentId,approverEmploymentIds:[matrix.employmentId,manager.employmentId]}],true);
    await expect(perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'')).rejects.toThrow(/your turn/);
    await dispatchNotifications(a);let notifications=await owner.db.select().from(schema.notification);expect(notifications.filter(n=>n.kind==='performance.review-task').map(n=>n.recipientEmploymentId)).toEqual([matrix.employmentId]);
    expect((await view(matrix.ctx)).canApproveSettingIds).toEqual([id]);
    await perf.approveOnehrScorecard(matrix.ctx,reviewId,(await view(matrix.ctx)).revision,true,'Targets verified');
    expect((await view(self)).kpis[0].setting).toBe('proposed');
    await expect(perf.reassignOnehrReviewer(a,reviewId,(await view(a)).revision,manager.employmentId)).rejects.toThrow(/assessment begins/);
    await expect(perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Delivered'}])).rejects.toThrow(/approved scorecard/);
    await perf.approveOnehrScorecard(mgr,reviewId,(await view()).revision,true,'');
    expect((await view(self)).kpis[0].settingApprovals?.map(s=>s.employmentId)).toEqual([matrix.employmentId,manager.employmentId]);
    await dispatchNotifications(a);notifications=await owner.db.select().from(schema.notification);expect(notifications.some(n=>n.kind==='performance.review-task'&&n.recipientEmploymentId===manager.employmentId)).toBe(true);
    await perf.submitOnehrResults(self,reviewId,(await view(self)).revision,[{id,actual:2,note:'Delivered'}]);
    await expect(perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,2,'')).rejects.toThrow(/another moderator/);
    await perf.moderateOnehrKpi(matrix.ctx,reviewId,(await view(matrix.ctx)).revision,id,3,'Verified an additional outcome');expect((await view()).kpis[0].locked).toBe(false);
    await expect(perf.confirmOnehrPerformance(mgr,reviewId,(await view()).revision,'AE','')).rejects.toThrow(/every KPI/);
    await expect(perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,2,'')).rejects.toThrow(/Explain/);
    await perf.moderateOnehrKpi(mgr,reviewId,(await view()).revision,id,3,'Confirmed preceding value');expect((await view()).kpis[0].locked).toBe(true);
    await perf.confirmOnehrPerformance(mgr,reviewId,(await view()).revision,'AE','');expect((await view()).managerPerformance).toBe('AE');
  });

});
